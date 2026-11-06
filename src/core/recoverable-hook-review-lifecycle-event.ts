import {
	type RuntimeHookIngestRequest,
	type RuntimeTaskSessionSummary,
	runtimeHookIngestRequestSchema,
} from "./api-contract";

export type RecoverableHookReviewLifecycleEvent = RuntimeHookIngestRequest & {
	event: "to_review";
	hookEventDeliveryIdempotencyKey: string;
	hookRuntimeSessionIncarnationId: string;
	hookEventCapturedAtEpochMs: number;
};

export function resolveHookReviewLifecyclePromptSubmissionOrdering(
	summary: RuntimeTaskSessionSummary,
	capturedAtEpochMs: number,
	unacceptedPromptSubmissionIdObservedBeforeAdmission: string | null | undefined,
): "compatible" | "superseded" | "unknown" {
	const submission = summary.agentConversationPromptSubmissionAcceptance;
	if (!submission || submission.attemptedAtMs < capturedAtEpochMs) return "compatible";
	if (submission.attemptedAtMs > capturedAtEpochMs) return "superseded";
	// 旧记录没有受理前的身份观测；同毫秒只能保留未知，不能补造先后关系。
	if (unacceptedPromptSubmissionIdObservedBeforeAdmission === undefined) return "unknown";
	return unacceptedPromptSubmissionIdObservedBeforeAdmission !== null &&
		submission.submissionId === unacceptedPromptSubmissionIdObservedBeforeAdmission &&
		submission.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId
		? "compatible"
		: "superseded";
}

export function projectRecoverableHookReviewLifecycleEvent(input: unknown): RecoverableHookReviewLifecycleEvent | null {
	const parsed = runtimeHookIngestRequestSchema.safeParse(input);
	if (!parsed.success) return null;
	const request = parsed.data;
	if (
		request.event !== "to_review" ||
		!request.hookEventDeliveryIdempotencyKey ||
		!request.hookRuntimeSessionIncarnationId ||
		request.hookEventCapturedAtEpochMs === undefined ||
		request.hookEventFiredInsideSubagentContext ||
		request.submittedPromptText !== undefined ||
		request.agentRaisedUserQuestion ||
		request.agentRaisedToolPermission ||
		request.agentRaisedUserQuestionResolvedInAgentTerminal ||
		!request.metadata?.source ||
		!/^(stop|afteragent|agent-turn-complete)$/iu.test(request.metadata.hookEventName ?? "") ||
		request.metadata.toolName ||
		request.metadata.notificationType
	)
		return null;
	// 只保留生命周期语义；finalMessage、工具参数与 CLI 遥测不能进入恢复存储。
	return {
		workspaceId: request.workspaceId,
		taskId: request.taskId,
		event: "to_review",
		metadata: { source: request.metadata.source, hookEventName: request.metadata.hookEventName },
		hookEventCapturedAtEpochMs: request.hookEventCapturedAtEpochMs,
		hookEventDeliveryIdempotencyKey: request.hookEventDeliveryIdempotencyKey,
		hookRuntimeSessionIncarnationId: request.hookRuntimeSessionIncarnationId,
		...(request.hookEventDeliveryHostedSessionKey
			? { hookEventDeliveryHostedSessionKey: request.hookEventDeliveryHostedSessionKey }
			: {}),
		...(request.notificationCandidateId ? { notificationCandidateId: request.notificationCandidateId } : {}),
		...(request.agentNativeConversationSessionIdentity
			? { agentNativeConversationSessionIdentity: request.agentNativeConversationSessionIdentity }
			: {}),
	};
}
