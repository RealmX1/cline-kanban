import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTaskConversationHistoryPage } from "@/runtime/task-conversation-history-query";
import type {
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
} from "@/runtime/types";

const nativeHistoryScanPollMilliseconds = 2_000;
// 前台为两轮目录扫描预留自动重查时间，其他会话排队仍可能更久。
const maximumNativeHistoryScanRetries = Math.ceil(
	(90_000 * 2 + nativeHistoryScanPollMilliseconds) / nativeHistoryScanPollMilliseconds,
);

interface TaskConversationHistoryReadState {
	identity: string;
	page: RuntimeTaskConversationHistoryPageResponse | null;
	isLoading: boolean;
	error: string | null;
}

export function useTaskConversationHistory(input: {
	workspaceId: string | null;
	workspaceTaskId: string;
	taskConversationSessionId: string;
	transcriptReadConsistency?: RuntimeTaskConversationHistoryPageRequest["transcriptReadConsistency"];
	nativeTranscriptBindingKey?: string;
}) {
	const identity = JSON.stringify([
		input.workspaceId,
		input.workspaceTaskId,
		input.taskConversationSessionId,
		input.transcriptReadConsistency,
	]);
	const identityRef = useRef(identity);
	identityRef.current = identity;
	const requestGenerationRef = useRef(0);
	const inFlightRef = useRef(false);
	const requestAbortRef = useRef<AbortController | null>(null);
	const bindingKeyRef = useRef(input.nativeTranscriptBindingKey);
	bindingKeyRef.current = input.nativeTranscriptBindingKey;
	const lastAttemptedBindingKeyRef = useRef(input.nativeTranscriptBindingKey);
	const pendingNativeHistoryScanReadRef = useRef<{ cursor: string | null; preserveLoadedHistory: boolean } | null>(
		null,
	);
	const [state, setState] = useState<TaskConversationHistoryReadState>({
		identity,
		page: null,
		isLoading: true,
		error: null,
	});
	const read = useCallback(
		async (cursor: string | null, preserveLoadedHistory = false) => {
			pendingNativeHistoryScanReadRef.current = { cursor, preserveLoadedHistory };
			requestAbortRef.current?.abort();
			const controller = new AbortController();
			requestAbortRef.current = controller;
			const generation = ++requestGenerationRef.current;
			const isCurrentRequest = () =>
				!controller.signal.aborted &&
				identityRef.current === identity &&
				requestGenerationRef.current === generation;
			lastAttemptedBindingKeyRef.current = bindingKeyRef.current;
			inFlightRef.current = true;
			setState((current) => ({
				identity,
				page: current.identity === identity ? current.page : null,
				isLoading: true,
				error: null,
			}));
			try {
				if (!input.workspaceId) throw new Error("尚未选择项目，无法读取会话历史。");
				let page: RuntimeTaskConversationHistoryPageResponse | null = null;
				const maximumRetries = input.transcriptReadConsistency === "stable_snapshot" ? 2 : 0;
				for (let attempt = 0; attempt <= maximumRetries; attempt++) {
					try {
						page = await fetchTaskConversationHistoryPage(input.workspaceId, {
							workspaceTaskId: input.workspaceTaskId,
							taskConversationSessionId: input.taskConversationSessionId,
							cursor,
							...(input.transcriptReadConsistency
								? { transcriptReadConsistency: input.transcriptReadConsistency }
								: {}),
						});
						if (!isCurrentRequest()) return false;
						if (
							page.availability !== "unavailable" ||
							page.unavailabilityReason !== "source_unavailable" ||
							attempt === maximumRetries
						)
							break;
					} catch (error) {
						if (!isCurrentRequest()) return false;
						if (attempt === maximumRetries) throw error;
					}
					await new Promise<void>((resolve) => {
						const complete = () => {
							controller.signal.removeEventListener("abort", cancel);
							resolve();
						};
						const timer = window.setTimeout(complete, 250 * (attempt + 1));
						const cancel = () => {
							window.clearTimeout(timer);
							complete();
						};
						controller.signal.addEventListener("abort", cancel, { once: true });
					});
					if (!isCurrentRequest()) return false;
				}
				if (!page || !isCurrentRequest()) return false;
				const receivedPage = page;
				if (receivedPage.nativeHistoryLookup?.status !== "scanning") pendingNativeHistoryScanReadRef.current = null;
				setState((current) => {
					if (receivedPage.availability === "unavailable" && current.page?.messages.length)
						return {
							...current,
							isLoading: false,
							error: receivedPage.nativeHistoryLookup?.status === "scanning" ? null : receivedPage.notice,
							page: { ...current.page, nativeHistoryLookup: receivedPage.nativeHistoryLookup },
						};
					const loadedReadOnlySourceChanged =
						receivedPage.nativeHistorySource === "verified_read_only" &&
						current.page?.nativeHistorySource === "verified_read_only";
					if (
						preserveLoadedHistory &&
						current.page?.messages.length &&
						(receivedPage.nativeHistorySource !== current.page.nativeHistorySource || loadedReadOnlySourceChanged)
					) {
						return {
							...current,
							page: { ...current.page, nativeHistoryLookup: receivedPage.nativeHistoryLookup },
							isLoading: false,
							error: "历史读取来源已切换，已保留当前页面。刷新后可读取新的权威来源。",
						};
					}
					return {
						identity,
						page:
							cursor && current.page
								? {
										...receivedPage,
										messages: [...receivedPage.messages, ...current.page.messages],
										availability:
											receivedPage.availability === "partially_available" ||
											current.page.availability === "partially_available"
												? "partially_available"
												: receivedPage.availability,
										notice: receivedPage.notice ?? current.page.notice,
									}
								: receivedPage,
						isLoading: false,
						error: null,
					};
				});
				return receivedPage.availability !== "unavailable";
			} catch (error) {
				if (!isCurrentRequest()) return false;
				setState((current) => ({
					...current,
					isLoading: false,
					error: error instanceof Error ? error.message : "会话历史读取失败。",
				}));
				return false;
			} finally {
				if (identityRef.current === identity && requestGenerationRef.current === generation)
					inFlightRef.current = false;
			}
		},
		[
			identity,
			input.workspaceId,
			input.workspaceTaskId,
			input.taskConversationSessionId,
			input.transcriptReadConsistency,
		],
	);
	useEffect(() => {
		void read(null);
		return () => {
			requestAbortRef.current?.abort();
			requestGenerationRef.current++;
			inFlightRef.current = false;
		};
	}, [read]);
	const current = state.identity === identity ? state : { identity, page: null, isLoading: true, error: null };
	useEffect(() => {
		if (
			!current.isLoading &&
			(current.page?.unavailabilityReason === "binding_pending" ||
				current.page?.nativeHistorySource === "verified_read_only" ||
				current.page?.nativeHistoryLookup) &&
			lastAttemptedBindingKeyRef.current !== input.nativeTranscriptBindingKey
		)
			void read(null, Boolean(current.page?.messages.length));
	}, [current.isLoading, current.page, input.nativeTranscriptBindingKey, read]);
	const nativeHistoryScanRetryRef = useRef({ identity, attempts: 0 });
	useEffect(() => {
		if (nativeHistoryScanRetryRef.current.identity !== identity) {
			nativeHistoryScanRetryRef.current = { identity, attempts: 0 };
		}
		if (current.isLoading) return;
		if (current.page?.nativeHistoryLookup?.status !== "scanning") {
			nativeHistoryScanRetryRef.current.attempts = 0;
			return;
		}
		if (nativeHistoryScanRetryRef.current.attempts >= maximumNativeHistoryScanRetries) {
			setState((current) => ({
				...current,
				error: "自动重查已达到等待上限。后台扫描仍可能在运行，可以刷新后继续核对。",
			}));
			return;
		}
		const retry = window.setTimeout(() => {
			const pendingRead = pendingNativeHistoryScanReadRef.current;
			if (inFlightRef.current || !pendingRead) return;
			nativeHistoryScanRetryRef.current.attempts++;
			void read(pendingRead.cursor, pendingRead.preserveLoadedHistory);
		}, nativeHistoryScanPollMilliseconds);
		return () => window.clearTimeout(retry);
	}, [current.isLoading, current.page, identity, read]);
	const cursor = current.page?.nextCursor;
	const loadOlder = useCallback(async () => {
		if (cursor && !inFlightRef.current) await read(cursor);
	}, [cursor, read]);
	return {
		...current,
		refresh: () => {
			nativeHistoryScanRetryRef.current.attempts = 0;
			return read(null);
		},
		loadOlder,
	};
}
