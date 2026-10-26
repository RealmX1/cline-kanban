import { createHash } from "node:crypto";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";

export function rvfCloseoutReceiptSha256(record: RvfAutomaticCloseoutRecord) {
	return createHash("sha256")
		.update(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(record.receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
				),
			),
		)
		.digest("hex");
}

export function boundRvfCloseoutGoalCompletion(record: RvfAutomaticCloseoutRecord) {
	const observation = record.existingCloseoutGoalCompletionReconciliation;
	const binding = observation?.binding;
	return binding &&
		binding.workspaceId === record.workspaceId &&
		binding.taskId === record.taskId &&
		binding.decisionToken === record.receipt.decision_token &&
		binding.runId === record.runId &&
		binding.runDirectory === record.runDirectory &&
		binding.handoffSha256 === record.handoffSha256 &&
		binding.receiptSha256 === rvfCloseoutReceiptSha256(record)
		? observation
		: undefined;
}

export function completedRvfCloseoutStage(record: RvfAutomaticCloseoutRecord, stage: "land" | "base_branch_sync") {
	const accepted = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
	if (accepted?.outcome === "completed" && accepted.commitSha) return accepted;
	return boundRvfCloseoutGoalCompletion(record)?.verifiedStages.find((entry) => entry.stage === stage);
}

// 历史事实只终止本 run；不判断当前候选审查覆盖，也不授予新的执行权限。
export function resolveRvfCloseoutSchedulingDecision(record: RvfAutomaticCloseoutRecord) {
	const observation = boundRvfCloseoutGoalCompletion(record);
	const remainingStages = (["land", "base_branch_sync"] as const).filter(
		(stage) => !completedRvfCloseoutStage(record, stage),
	);
	const completed = record.status === "completed" || remainingStages.length === 0;
	const externallyConsumed =
		Boolean(observation?.externalConsumption) ||
		record.independentBackupRouteSuppressionObservation?.reason === "original_run_consumed_by_backup_route";
	const stopped = record.explicitStopRequestedAt !== undefined;
	const unclassifiedOrConflictingStage = remainingStages.some((stage) => {
		const result = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
		return (
			result?.blockedReasonKind === "evidence_conflict" ||
			result?.blockedReasonKind === "user_restriction" ||
			(result?.outcome === "blocked" && result.blockedReasonKind !== "machine_precondition")
		);
	});
	const recoveryExecutionAllowed =
		!completed &&
		!externallyConsumed &&
		!stopped &&
		!unclassifiedOrConflictingStage &&
		observation?.verdict !== "evidence_conflict" &&
		(record.automaticRecoveryProgress?.nativeSessionRestoreAttempted === true ||
			remainingStages.some((stage) => {
				const result = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
				return result?.blockedReasonKind === "machine_precondition";
			}));
	// 首条正常投递沿用原激活资格；后台发现未完不能把它误转成历史失败恢复。
	const initialCloseoutDeliveryPending =
		["restoring_pre_review_conversation", "restored_pre_review_conversation", "submitting_closeout_prompt"].includes(
			record.status,
		) &&
		!record.landExecutionResult &&
		!record.baseBranchSyncExecutionResult &&
		!record.promptDeliveryAttempts?.length &&
		!record.automaticRecoveryProgress &&
		!record.lateNativePromptAcceptanceRecoveryReceipt &&
		!record.stageExecutionClaims?.length &&
		!observation?.verifiedStages.length;
	return {
		completed,
		externallyConsumed,
		stopped,
		suppressAllScheduling: completed || externallyConsumed || stopped,
		remainingStages,
		recoveryExecutionAllowed,
		requiresBackgroundReconciliationOnly:
			unclassifiedOrConflictingStage ||
			observation?.verdict === "evidence_conflict" ||
			(observation?.recovery.discoveryComplete === false && !initialCloseoutDeliveryPending),
	};
}

export function sameRvfCloseoutObservationBinding(
	current: RvfAutomaticCloseoutRecord,
	original: RvfAutomaticCloseoutRecord,
) {
	return (
		current.workspaceId === original.workspaceId &&
		current.taskId === original.taskId &&
		current.runId === original.runId &&
		current.runDirectory === original.runDirectory &&
		current.handoffPath === original.handoffPath &&
		current.handoffSha256 === original.handoffSha256 &&
		rvfCloseoutReceiptSha256(current) === rvfCloseoutReceiptSha256(original)
	);
}
