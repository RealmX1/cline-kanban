import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTaskConversationHistoryPage } from "@/runtime/task-conversation-history-query";
import type {
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
} from "@/runtime/types";

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
	const [state, setState] = useState<TaskConversationHistoryReadState>({
		identity,
		page: null,
		isLoading: true,
		error: null,
	});
	const read = useCallback(
		async (cursor: string | null) => {
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
				setState((current) => {
					if (receivedPage.availability === "unavailable" && current.page?.messages.length)
						return { ...current, isLoading: false, error: receivedPage.notice };
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
			current.page?.unavailabilityReason === "binding_pending" &&
			lastAttemptedBindingKeyRef.current !== input.nativeTranscriptBindingKey
		)
			void read(null);
	}, [current.isLoading, current.page?.unavailabilityReason, input.nativeTranscriptBindingKey, read]);
	const cursor = current.page?.nextCursor;
	const loadOlder = useCallback(async () => {
		if (cursor && !inFlightRef.current) await read(cursor);
	}, [cursor, read]);
	return { ...current, refresh: () => read(null), loadOlder };
}
