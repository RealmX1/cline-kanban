import {
	type RvfAutomaticCloseoutRecord,
	rvfLateNativeCloseoutRecoverableDeliveryFailureReasonSchema,
} from "../core/rvf-automatic-closeout-contract";

export function isRecoverableRvfLateNativeCloseoutPauseReason(reason: string | null | undefined) {
	const prefix = "收尾投递失败：";
	return Boolean(
		reason?.startsWith(prefix) &&
			rvfLateNativeCloseoutRecoverableDeliveryFailureReasonSchema.safeParse(reason.slice(prefix.length)).success,
	);
}

// 显式补证和后台扫描共用资格；历史凭据允许完成后重验，不授予新的执行权限。
export function isRvfCloseoutEligibleForLateNativeAcceptanceVerification(record: RvfAutomaticCloseoutRecord) {
	const receipt = record.lateNativePromptAcceptanceRecoveryReceipt;
	const inspection =
		record.promptDeliveryAttempts?.[0]?.purpose === "inspect_existing_state" ||
		record.promptDeliveryAttempts?.[0]?.executionRequiresReadOnlyInspection === true;
	return (
		isRecoverableRvfLateNativeCloseoutPauseReason(receipt?.previousPauseReason ?? record.pauseReason) &&
		(receipt
			? ["closeout_prompt_submitted", "completed"].includes(record.status) ||
				(inspection && record.status === "submitting_closeout_prompt")
			: record.status === "paused" ||
				(inspection && ["submitting_closeout_prompt", "closeout_prompt_submitted"].includes(record.status)))
	);
}
