import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	type TaskLookupCandidate,
	type TaskLookupCandidatePreview,
	type TaskLookupConversation,
	type TaskLookupExecutorSettings,
	type TaskLookupScope,
	taskLookupConversationQueries,
} from "@/runtime/task-lookup-conversation-query";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import {
	readTaskLookupConversationUpdateGeneration,
	subscribeToTaskLookupConversationUpdates,
} from "@/stores/task-lookup-conversation-update-store";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

function readQuestionDrafts(): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(readLocalStorageItem(LocalStorageKey.TaskLookupQuestionDrafts) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

function saveQuestionDraft(key: string, text: string) {
	const drafts = readQuestionDrafts();
	if (text) drafts[key] = text;
	else delete drafts[key];
	writeLocalStorageItem(LocalStorageKey.TaskLookupQuestionDrafts, JSON.stringify(drafts));
}

export function useTaskLookupWorkbench({
	workspaceId,
	includeAllProjectsByDefault,
	streamSnapshotGeneration,
}: {
	workspaceId: string | null;
	includeAllProjectsByDefault: boolean;
	streamSnapshotGeneration: number;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [conversationId, setConversationId] = useState<string | null>(() =>
		readLocalStorageItem(LocalStorageKey.TaskLookupConversationSelection),
	);
	const [conversation, setConversation] = useState<TaskLookupConversation | null>(null);
	const [conversations, setConversations] = useState<TaskLookupConversation[]>([]);
	const [scope, setScope] = useState<TaskLookupScope>({ projectIds: [], columnIds: [] });
	const draftKeyRef = useRef(conversationId ?? `new:${workspaceId ?? ""}`);
	const [draftQuestion, setDraftQuestionState] = useState(() => readQuestionDrafts()[draftKeyRef.current] ?? "");
	const draftQuestionRef = useRef(draftQuestion);
	draftQuestionRef.current = draftQuestion;
	const setDraftQuestion = useCallback((text: string) => {
		draftQuestionRef.current = text;
		setDraftQuestionState(text);
		saveQuestionDraft(draftKeyRef.current, text);
	}, []);
	const setQuestionDraftForConversation = useCallback(
		(draftConversationId: string | null, text: string) => {
			const key = draftConversationId ?? `new:${workspaceId ?? ""}`;
			if (key === draftKeyRef.current) setDraftQuestion(text);
			else saveQuestionDraft(key, text);
		},
		[setDraftQuestion, workspaceId],
	);
	const [selectedCandidate, setSelectedCandidate] = useState<TaskLookupCandidate | null>(null);
	const [candidatePreview, setCandidatePreview] = useState<TaskLookupCandidatePreview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
	const [historyReadErrorMessage, setHistoryReadErrorMessage] = useState<string | null>(null);
	const [executorSettingsReadErrorMessage, setExecutorSettingsReadErrorMessage] = useState<string | null>(null);
	const [isPending, setIsPending] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [executorSettings, setExecutorSettings] = useState<TaskLookupExecutorSettings | null>(null);
	const [refreshRequest, setRefreshRequest] = useState(0);
	const actionPendingRef = useRef(false);
	const scopeLoadedForConversationIdRef = useRef<string | null>(null);
	const updateGeneration = useSyncExternalStore(
		subscribeToTaskLookupConversationUpdates,
		readTaskLookupConversationUpdateGeneration,
	);
	const contextWorkspaceId = conversation?.contextWorkspaceId ?? workspaceId;
	const adoptConversation = useCallback((next: TaskLookupConversation) => {
		draftKeyRef.current = next.conversationId;
		scopeLoadedForConversationIdRef.current = next.conversationId;
		setConversationId(next.conversationId);
		setConversation(next);
		setScope(next.scope);
		writeLocalStorageItem(LocalStorageKey.TaskLookupConversationSelection, next.conversationId);
	}, []);
	useEffect(() => {
		if (!isOpen) return;
		let abandoned = false;
		setIsLoading(true);
		void Promise.allSettled([
			taskLookupConversationQueries.list(),
			conversationId ? taskLookupConversationQueries.get(conversationId) : Promise.resolve(null),
		])
			.then(([historyResult, activeResult]) => {
				if (abandoned) return;
				if (historyResult.status === "fulfilled") setConversations(historyResult.value);
				const failed = [historyResult, activeResult].find((result) => result.status === "rejected");
				setHistoryReadErrorMessage(
					failed?.status === "rejected"
						? String(failed.reason instanceof Error ? failed.reason.message : failed.reason)
						: null,
				);
				const active = activeResult.status === "fulfilled" ? activeResult.value : null;
				if (active && scopeLoadedForConversationIdRef.current !== active.conversationId) {
					scopeLoadedForConversationIdRef.current = active.conversationId;
					setScope(active.scope);
				}
				if (active)
					setConversation((previous) =>
						previous?.conversationId === active.conversationId && previous.revision > active.revision
							? previous
							: active,
					);
			})
			.catch((error: unknown) => {
				if (!abandoned) setHistoryReadErrorMessage(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!abandoned) setIsLoading(false);
			});
		return () => {
			abandoned = true;
		};
	}, [isOpen, conversationId, updateGeneration, streamSnapshotGeneration, refreshRequest]);
	useEffect(() => {
		if (!isOpen || !contextWorkspaceId) return;
		let abandoned = false;
		setExecutorSettings(null);
		setExecutorSettingsReadErrorMessage(null);
		void taskLookupConversationQueries
			.getSettings(contextWorkspaceId)
			.then((settings) => {
				if (!abandoned) setExecutorSettings(settings);
			})
			.catch((error: unknown) => {
				if (!abandoned) setExecutorSettingsReadErrorMessage(error instanceof Error ? error.message : String(error));
			});
		return () => {
			abandoned = true;
		};
	}, [isOpen, contextWorkspaceId]);
	const defaultScope = useCallback(
		() => ({ projectIds: includeAllProjectsByDefault || !workspaceId ? [] : [workspaceId], columnIds: [] }),
		[workspaceId, includeAllProjectsByDefault],
	);
	const createConversation = useCallback(
		async (nextScope: TaskLookupScope) => {
			if (!workspaceId) throw new Error("请先选择一个可用项目。");
			const next = await taskLookupConversationQueries.create({ contextWorkspaceId: workspaceId, scope: nextScope });
			adoptConversation(next);
			if (draftQuestionRef.current) saveQuestionDraft(next.conversationId, draftQuestionRef.current);
			setSelectedCandidate(null);
			setCandidatePreview(null);
			setPreviewError(null);
			return next;
		},
		[workspaceId, adoptConversation],
	);
	const performAction = useCallback(async (action: () => Promise<void>) => {
		if (actionPendingRef.current) return;
		actionPendingRef.current = true;
		setIsPending(true);
		setActionErrorMessage(null);
		try {
			await action();
		} catch (error) {
			setActionErrorMessage(error instanceof Error ? error.message : String(error));
		} finally {
			actionPendingRef.current = false;
			setIsPending(false);
			setRefreshRequest((value) => value + 1);
		}
	}, []);
	const submitQuestion = useCallback(async () => {
		const questionText = draftQuestion.trim();
		if (!questionText) return;
		const submittedDraftKey = draftKeyRef.current;
		await performAction(async () => {
			const active = conversation ?? (await createConversation(scope));
			const updated = await taskLookupConversationQueries.submit({
				conversationId: active.conversationId,
				questionText,
				requestId: createRandomUuidV4WithInsecureContextFallback(),
				scope,
			});
			adoptConversation(updated);
			if (draftQuestionRef.current === draftQuestion) setDraftQuestion("");
			else saveQuestionDraft(updated.conversationId, draftQuestionRef.current);
			if (submittedDraftKey !== updated.conversationId) saveQuestionDraft(submittedDraftKey, "");
		});
	}, [draftQuestion, scope, conversation, createConversation, performAction, adoptConversation, setDraftQuestion]);
	const resubmitQuestion = useCallback(
		async (turn: TaskLookupConversation["turns"][number]) => {
			if (!conversation) return;
			await performAction(async () => {
				adoptConversation(
					await taskLookupConversationQueries.submit({
						conversationId: conversation.conversationId,
						requestId: createRandomUuidV4WithInsecureContextFallback(),
						questionText: turn.questionText,
						questionImages: turn.questionImages ?? [],
						scope: turn.scope,
						...(turn.status === "running" && !turn.executionOwnerRuntimeProcessInstanceId
							? { explicitlyRecoveredUnownedTurnId: turn.turnId }
							: {}),
					}),
				);
			});
		},
		[conversation, performAction, adoptConversation],
	);
	const open = useCallback(
		(seed?: { questionText: string; scope: TaskLookupScope }) => {
			setIsOpen(true);
			if (!seed) {
				if (!conversationId) setScope(defaultScope());
				return;
			}
			setDraftQuestionState(seed.questionText);
			draftQuestionRef.current = seed.questionText;
			setScope(seed.scope);
			void performAction(async () => {
				const next = await createConversation(seed.scope);
				setDraftQuestion(seed.questionText);
				if (!seed.questionText.trim()) return;
				adoptConversation(
					await taskLookupConversationQueries.submit({
						conversationId: next.conversationId,
						questionText: seed.questionText,
						scope: seed.scope,
						requestId: createRandomUuidV4WithInsecureContextFallback(),
					}),
				);
				setDraftQuestion("");
			});
		},
		[conversationId, defaultScope, createConversation, performAction, adoptConversation],
	);
	const selectConversation = useCallback(
		(next: TaskLookupConversation) => {
			adoptConversation(next);
			setSelectedCandidate(null);
			setCandidatePreview(null);
			setPreviewError(null);
			setDraftQuestion(readQuestionDrafts()[next.conversationId] ?? "");
		},
		[adoptConversation, setDraftQuestion],
	);
	const selectCandidate = useCallback((candidate: TaskLookupCandidate) => {
		setSelectedCandidate(candidate);
		setCandidatePreview(null);
		setPreviewError(null);
	}, []);
	useEffect(() => {
		if (!selectedCandidate || !conversationId || !isOpen) return;
		let abandoned = false;
		void taskLookupConversationQueries
			.preview(conversationId, selectedCandidate)
			.then((preview) => {
				if (!abandoned) setCandidatePreview(preview);
			})
			.catch((error: unknown) => {
				if (!abandoned) setPreviewError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			abandoned = true;
		};
	}, [selectedCandidate, conversationId, isOpen, streamSnapshotGeneration]);
	return {
		isOpen,
		open,
		close: () => setIsOpen(false),
		conversation,
		conversations,
		scope,
		setScope,
		draftQuestion,
		setDraftQuestion,
		setQuestionDraftForConversation,
		selectedCandidate,
		selectCandidate,
		candidatePreview,
		previewError,
		errorMessage: actionErrorMessage ?? historyReadErrorMessage ?? executorSettingsReadErrorMessage,
		isPending,
		isLoading,
		executorSettings,
		contextWorkspaceId,
		isRunning: conversation?.turns.some((turn) => turn.status === "running") ?? false,
		submitQuestion,
		resubmitQuestion,
		selectConversation,
		startNewConversation: () =>
			performAction(async () => {
				await createConversation(defaultScope());
				setDraftQuestion("");
			}),
		cancelTurn: () =>
			performAction(async () => {
				if (conversationId) adoptConversation(await taskLookupConversationQueries.cancel(conversationId));
			}),
		saveExecutorSettings: (settings: TaskLookupExecutorSettings) =>
			performAction(async () => {
				if (contextWorkspaceId)
					setExecutorSettings(await taskLookupConversationQueries.saveSettings(contextWorkspaceId, settings));
			}),
		refresh: () => {
			setActionErrorMessage(null);
			setRefreshRequest((value) => value + 1);
		},
	};
}
export type TaskLookupWorkbenchController = ReturnType<typeof useTaskLookupWorkbench>;
