import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTaskConversationHistoryPage } from "@/runtime/task-conversation-history-query";
import type { RuntimeTaskConversationHistoryPageResponse } from "@/runtime/types";

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
}) {
	const identity = JSON.stringify([input.workspaceId, input.workspaceTaskId, input.taskConversationSessionId]);
	const identityRef = useRef(identity);
	identityRef.current = identity;
	const requestGenerationRef = useRef(0);
	const inFlightRef = useRef(false);
	const [state, setState] = useState<TaskConversationHistoryReadState>({
		identity,
		page: null,
		isLoading: true,
		error: null,
	});
	const read = useCallback(
		async (cursor: string | null) => {
			const generation = ++requestGenerationRef.current;
			inFlightRef.current = true;
			setState((current) => ({
				identity,
				page: cursor && current.identity === identity ? current.page : null,
				isLoading: true,
				error: null,
			}));
			try {
				if (!input.workspaceId) throw new Error("尚未选择项目，无法读取会话历史。");
				const page = await fetchTaskConversationHistoryPage(input.workspaceId, {
					workspaceTaskId: input.workspaceTaskId,
					taskConversationSessionId: input.taskConversationSessionId,
					cursor,
				});
				if (identityRef.current !== identity || requestGenerationRef.current !== generation) return;
				setState((current) => {
					if (cursor && page.availability === "unavailable")
						return { ...current, isLoading: false, error: page.notice };
					return {
						identity,
						page:
							cursor && current.page
								? {
										...page,
										messages: [...page.messages, ...current.page.messages],
										availability:
											page.availability === "partially_available" ||
											current.page.availability === "partially_available"
												? "partially_available"
												: page.availability,
										notice: page.notice ?? current.page.notice,
									}
								: page,
						isLoading: false,
						error: null,
					};
				});
			} catch (error) {
				if (identityRef.current !== identity || requestGenerationRef.current !== generation) return;
				setState((current) => ({
					...current,
					isLoading: false,
					error: error instanceof Error ? error.message : "会话历史读取失败。",
				}));
			} finally {
				if (identityRef.current === identity && requestGenerationRef.current === generation)
					inFlightRef.current = false;
			}
		},
		[identity, input.workspaceId, input.workspaceTaskId, input.taskConversationSessionId],
	);
	useEffect(() => {
		void read(null);
		return () => {
			requestGenerationRef.current++;
			inFlightRef.current = false;
		};
	}, [read]);
	const current = state.identity === identity ? state : { identity, page: null, isLoading: true, error: null };
	const cursor = current.page?.nextCursor;
	const loadOlder = useCallback(async () => {
		if (cursor && !inFlightRef.current) await read(cursor);
	}, [cursor, read]);
	return { ...current, refresh: () => read(null), loadOlder };
}
