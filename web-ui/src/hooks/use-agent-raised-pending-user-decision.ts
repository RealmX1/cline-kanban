import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { discardBrowserAnswerDraftsForTaskExceptPendingDecision } from "@/hooks/use-agent-raised-pending-user-decision-answer-draft";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentRaisedPendingUserDecision,
	RuntimePendingUserDecisionQuestionAnswerDraft,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

export type PendingUserDecisionQuestionAnswerDraft = RuntimePendingUserDecisionQuestionAnswerDraft;

export function useAgentRaisedPendingUserDecision(input: {
	workspaceId: string | null;
	taskId: string;
	runtimeSessionLatestHookActivity: RuntimeTaskHookActivity | null;
	runtimeSessionPromptSubmissionAcceptance?: RuntimeTaskSessionSummary["agentConversationPromptSubmissionAcceptance"];
}) {
	const queryIdentity = `${input.workspaceId ?? ""}\u0000${input.taskId}`;
	const latestQueryIdentityRef = useRef(queryIdentity);
	latestQueryIdentityRef.current = queryIdentity;
	const refreshRequestSequenceRef = useRef(0);
	const [decisionResult, setDecisionResult] = useState<{
		queryIdentity: string;
		decision: RuntimeAgentRaisedPendingUserDecision | null;
		transcriptRecoveryNotice?: string | null;
	}>({ queryIdentity, decision: null });
	const [isLoading, setIsLoading] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const decision = decisionResult.queryIdentity === queryIdentity ? decisionResult.decision : null;
	const transcriptRecoveryNotice =
		decisionResult.queryIdentity === queryIdentity ? (decisionResult.transcriptRecoveryNotice ?? null) : null;

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
				const pendingDecision = response.decisions.find((candidate) => candidate.taskId === input.taskId) ?? null;
				discardBrowserAnswerDraftsForTaskExceptPendingDecision(
					input.workspaceId,
					input.taskId,
					pendingDecision?.recordedAnswerQuestionAnswers === null ? pendingDecision.decisionId : null,
				);
				setDecisionResult({
					queryIdentity,
					decision: pendingDecision,
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
		// Hook ingest 先把 durable decision 落盘，再经 applyHookActivity 发出 task_sessions_updated。
		// latestHookActivity 是当前会话已有的、事件驱动且有界的实时信号；它不会像 workspace/Git
		// metadata version 那样漏掉纯会话更新，也无需引入轮询。
		void refresh();
	}, [refresh, input.runtimeSessionLatestHookActivity, input.runtimeSessionPromptSubmissionAcceptance]);

	useEffect(() => {
		if (!decision?.recordedAnswerQuestionAnswers || typeof decision.answerDeliveryNextReconciliationAt !== "number")
			return;
		const timer = setTimeout(
			() => void refresh(),
			Math.max(1000, decision.answerDeliveryNextReconciliationAt - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [
		decision?.decisionId,
		decision?.answerDeliveryNextReconciliationAt,
		decision?.recordedAnswerQuestionAnswers,
		refresh,
	]);

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
				if (response.delivered) {
					toast.success("答案已送达 agent，可在「问答记录」里回看。");
				} else {
					// 不自动重试：面板会回显已保存的答案与未送达原因，并提供「重试投递」。
					toast.warning("答案已保存，送达待确认，可在问题面板重新核验。");
				}
				await refresh();
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
				// 失败多半是面板手里的记录已不是最新（例如同一问题在终端里已答完）：重新拉取，让面板如实反映账本，
				// 而不是停在一个再怎么点都不会成功的旧状态上。
				await refresh();
				return false;
			} finally {
				setIsSubmitting(false);
			}
		},
		[decision, input.workspaceId, refresh],
	);

	const reconcileDelivery = useCallback(async () => {
		if (!input.workspaceId || !decision || isSubmitting) return false;
		setIsSubmitting(true);
		try {
			const response = await getRuntimeTrpcClient(
				input.workspaceId,
			).runtime.reconcileAgentRaisedPendingUserDecisionAnswerDelivery.mutate({ decisionId: decision.decisionId });
			if (!response.ok) throw new Error(response.error ?? "无法核验答案送达");
			if (response.delivered) toast.success("已核实答案送达。");
			else toast.info("暂未取得送达证据，已保留答案与核验进度。");
			await refresh();
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			setIsSubmitting(false);
		}
	}, [input.workspaceId, decision, isSubmitting, refresh]);
	const confirmHandled = useCallback(async () => {
		if (!input.workspaceId || !decision || isSubmitting) return false;
		setIsSubmitting(true);
		try {
			const response = await getRuntimeTrpcClient(
				input.workspaceId,
			).runtime.confirmAgentRaisedPendingUserDecisionAnswerHandled.mutate({ decisionId: decision.decisionId });
			if (!response.ok) throw new Error(response.error ?? "无法确认问题已处理");
			toast.success("已记录你在终端确认处理，可在问答记录中回看。");
			await refresh();
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
			await refresh();
			return false;
		} finally {
			setIsSubmitting(false);
		}
	}, [input.workspaceId, decision, isSubmitting, refresh]);

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
			await refresh();
			return false;
		} finally {
			setIsSubmitting(false);
		}
	}, [decision, input.workspaceId, queryIdentity, refresh]);

	return {
		decision,
		isLoading,
		isSubmitting,
		answer,
		dismiss,
		reconcileDelivery,
		confirmHandled,
		refresh,
		transcriptRecoveryNotice,
	};
}
