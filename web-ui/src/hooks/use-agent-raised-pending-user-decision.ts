import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentRaisedPendingUserDecision, RuntimeTaskHookActivity } from "@/runtime/types";

export interface PendingUserDecisionQuestionAnswerDraft {
	decisionQuestionId: string;
	selectedOptionIds: string[];
	freeformText: string | null;
}

export function useAgentRaisedPendingUserDecision(input: {
	workspaceId: string | null;
	taskId: string;
	runtimeSessionLatestHookActivity: RuntimeTaskHookActivity | null;
}) {
	const queryIdentity = `${input.workspaceId ?? ""}\u0000${input.taskId}`;
	const latestQueryIdentityRef = useRef(queryIdentity);
	latestQueryIdentityRef.current = queryIdentity;
	const refreshRequestSequenceRef = useRef(0);
	const [decisionResult, setDecisionResult] = useState<{
		queryIdentity: string;
		decision: RuntimeAgentRaisedPendingUserDecision | null;
	}>({ queryIdentity, decision: null });
	const [isLoading, setIsLoading] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const decision = decisionResult.queryIdentity === queryIdentity ? decisionResult.decision : null;

	const refresh = useCallback(async () => {
		const refreshRequestSequence = refreshRequestSequenceRef.current + 1;
		refreshRequestSequenceRef.current = refreshRequestSequence;
		if (!input.workspaceId) {
			setDecisionResult({ queryIdentity, decision: null });
			setIsLoading(false);
			return;
		}
		setIsLoading(true);
		try {
			const response = await getRuntimeTrpcClient(
				input.workspaceId,
			).runtime.listAgentRaisedPendingUserDecisions.query({
				taskId: input.taskId,
			});
			if (
				latestQueryIdentityRef.current === queryIdentity &&
				refreshRequestSequenceRef.current === refreshRequestSequence
			) {
				setDecisionResult({
					queryIdentity,
					decision: response.decisions.find((candidate) => candidate.taskId === input.taskId) ?? null,
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
		// Hook ingest 先把 durable decision 落盘，再经 applyHookActivity 发出 task_sessions_updated。
		// latestHookActivity 是当前会话已有的、事件驱动且有界的实时信号；它不会像 workspace/Git
		// metadata version 那样漏掉纯会话更新，也无需引入轮询。
		void refresh();
	}, [refresh, input.runtimeSessionLatestHookActivity]);

	const answer = useCallback(
		async (orderedQuestionAnswers: PendingUserDecisionQuestionAnswerDraft[]) => {
			if (!input.workspaceId || !decision) {
				return false;
			}
			setIsSubmitting(true);
			try {
				const firstAnswer = orderedQuestionAnswers[0];
				const response = await getRuntimeTrpcClient(
					input.workspaceId,
				).runtime.answerAgentRaisedPendingUserDecision.mutate({
					decisionId: decision.decisionId,
					selectedOptionIds: firstAnswer?.selectedOptionIds ?? [],
					freeformText: firstAnswer?.freeformText ?? null,
					orderedQuestionAnswers,
				});
				if (!response.ok) {
					throw new Error(response.error ?? "无法提交待答问题");
				}
				if (!response.delivered) {
					toast.warning("答案已保存；会话恢复后将自动重试投递。");
				}
				await refresh();
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				setIsSubmitting(false);
			}
		},
		[decision, input.workspaceId, refresh],
	);

	const dismiss = useCallback(async () => {
		if (!input.workspaceId || !decision) {
			return false;
		}
		setIsSubmitting(true);
		try {
			const response = await getRuntimeTrpcClient(
				input.workspaceId,
			).runtime.dismissAgentRaisedPendingUserDecision.mutate({
				decisionId: decision.decisionId,
			});
			if (!response.ok) {
				throw new Error(response.error ?? "无法取消待答问题");
			}
			setDecisionResult({ queryIdentity, decision: null });
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			setIsSubmitting(false);
		}
	}, [decision, input.workspaceId, queryIdentity]);

	return { decision, isLoading, isSubmitting, answer, dismiss };
}
