import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentRaisedUserDecisionHistoryEntry } from "@/runtime/types";

// 问答记录只在用户展开时拉取：服务端会流式扫描该 task 的 Claude 转录做回填，不该在每次打开任务时付这笔 IO。
// 展开期间，待答问题变化（新问题出现 / 刚被作答或取消）时重新拉取，让刚了结的那一条立刻出现在记录里。
export function useAgentRaisedUserDecisionHistory(input: {
	workspaceId: string | null;
	taskId: string;
	isHistoryVisible: boolean;
	pendingUserDecisionIdentityForRefresh: string | null;
}) {
	const queryIdentity = `${input.workspaceId ?? ""}\u0000${input.taskId}`;
	const latestQueryIdentityRef = useRef(queryIdentity);
	latestQueryIdentityRef.current = queryIdentity;
	const refreshRequestSequenceRef = useRef(0);
	const [historyResult, setHistoryResult] = useState<{
		queryIdentity: string;
		historyEntries: RuntimeAgentRaisedUserDecisionHistoryEntry[] | null;
		transcriptRecoveryNotice?: string | null;
	}>({ queryIdentity, historyEntries: null });
	const [isLoading, setIsLoading] = useState(false);
	const historyEntries = historyResult.queryIdentity === queryIdentity ? historyResult.historyEntries : null;
	const transcriptRecoveryNotice =
		historyResult.queryIdentity === queryIdentity ? (historyResult.transcriptRecoveryNotice ?? null) : null;

	const refresh = useCallback(async () => {
		const refreshRequestSequence = refreshRequestSequenceRef.current + 1;
		refreshRequestSequenceRef.current = refreshRequestSequence;
		if (!input.workspaceId) {
			setHistoryResult({ queryIdentity, historyEntries: [] });
			return;
		}
		setIsLoading(true);
		try {
			const response = await getRuntimeTrpcClient(
				input.workspaceId,
			).runtime.listAgentRaisedUserDecisionHistoryForTask.query({ taskId: input.taskId });
			if (
				latestQueryIdentityRef.current === queryIdentity &&
				refreshRequestSequenceRef.current === refreshRequestSequence
			) {
				setHistoryResult({
					queryIdentity,
					historyEntries: response.historyEntries,
					transcriptRecoveryNotice: response.transcriptRecoveryNotice ?? null,
				});
			}
		} catch (error) {
			if (latestQueryIdentityRef.current === queryIdentity) {
				toast.error(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (
				latestQueryIdentityRef.current === queryIdentity &&
				refreshRequestSequenceRef.current === refreshRequestSequence
			) {
				setIsLoading(false);
			}
		}
	}, [input.taskId, input.workspaceId, queryIdentity]);

	useEffect(() => {
		if (input.isHistoryVisible) {
			void refresh();
		}
	}, [input.isHistoryVisible, input.pendingUserDecisionIdentityForRefresh, refresh]);

	return { historyEntries, isLoading, refresh, transcriptRecoveryNotice };
}
