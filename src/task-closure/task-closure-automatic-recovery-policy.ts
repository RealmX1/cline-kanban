import type { TaskClosureAutomaticRecoveryState } from "../core/task-closure-contract";
import { getThisRuntimeProcessInstanceId } from "../state/runtime-process-instance-heartbeat-registry";
import { readTaskClosureRecoveryEvidence } from "./task-closure-failure-recovery-evidence";
import {
	assertTaskClosureLifecycleNotCancelled,
	type TaskClosureOperation,
	writeTaskClosureAutomaticAttemptReceipt,
	writeTaskClosureOperation,
} from "./task-closure-operation-store";

export type TaskClosureFailureClassification = NonNullable<TaskClosureAutomaticRecoveryState["failureClassification"]>;
export class TaskClosureRecoveryPrerequisiteError extends Error {
	constructor(
		readonly classification: TaskClosureFailureClassification,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export function getTaskClosureAutomaticRecoveryState(operation: TaskClosureOperation) {
	const reopening =
		operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)
			? operation.reopening
			: null;
	const target = reopening ?? operation.progress;
	if (!target.automaticRecovery) {
		const legacyError = reopening?.lastError ?? operation.progress.lastError;
		target.automaticRecovery = {
			automaticAttemptCount: reopening ? 0 : operation.progress.attemptCount,
			maximumAutomaticAttemptCount: Math.max(3, reopening ? 0 : operation.progress.attemptCount),
			repairSupplementConsumed: false,
			pendingSideEffect: null,
			failureClassification: legacyError ? classifyTaskClosureFailure(new Error(legacyError)) : null,
			failureRecoveryEvidenceFingerprint: legacyError ? "legacy_failure_without_recovery_evidence" : null,
			minimumRequiredAvailableStorageBytes: null,
			lastFailureAtEpochMs: legacyError ? Date.now() : null,
			lastFailureMessage: legacyError ?? undefined,
		};
	}
	operation.schemaVersion = 2;
	return target.automaticRecovery;
}

export function classifyTaskClosureFailure(error: unknown, depth = 0): TaskClosureFailureClassification {
	if (error instanceof Error && error.cause && depth < 4) {
		const nested = classifyTaskClosureFailure(error.cause, depth + 1);
		if (["insufficient_storage_space", "storage_limit_exceeded", "temporary_io_failure"].includes(nested))
			return nested;
	}
	if (error instanceof TaskClosureRecoveryPrerequisiteError) return error.classification;
	const code = error && typeof error === "object" && "code" in error ? error.code : null;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOSPC" || /\bENOSPC\b|No space left on device/iu.test(message)) return "insufficient_storage_space";
	if (code === "KANBAN_SNAPSHOT_PAYLOAD_LIMIT_EXCEEDED") return "storage_limit_exceeded";
	if (code === "KANBAN_RESTORATION_WORKSPACE_CONTAINS_UNPRESERVED_WORK")
		return "restoration_workspace_contains_unpreserved_work";
	if (["ENOENT", "EACCES", "EPERM"].includes(String(code))) return "source_working_state_changed";
	if (["EAGAIN", "EBUSY", "EMFILE", "ENFILE"].includes(String(code))) return "temporary_io_failure";
	if (/所属.*尚未确认停止|所属.*等待退出/u.test(message)) return "owned_process_exit_unconfirmed";
	if (/复制期间来源|来源 Git 状态发生变化/u.test(message)) return "source_working_state_changed";
	if (/来源任务存在尚未解决的 Git 冲突|来源包含 Git 子模块/u.test(message)) return "source_working_state_changed";
	if (/not a git repository|bad object HEAD|ambiguous argument ['"]HEAD/iu.test(message))
		return "source_working_state_changed";
	if (/来源文件发生变化：/u.test(message)) return "archive_restoration_verification_failed";
	if (/快照校验失败|归档.*损坏|归档 HEAD/u.test(message)) return "archive_payload_integrity_failed";
	return "unclassified_failure";
}

export async function isTaskClosureAutomaticRecoveryEligible(operation: TaskClosureOperation): Promise<boolean> {
	const state = getTaskClosureAutomaticRecoveryState(operation);
	if (!state.failureClassification)
		return state.pendingSideEffect === null || state.automaticAttemptCount < state.maximumAutomaticAttemptCount;
	const evidence = await readTaskClosureRecoveryEvidence(operation, state.failureClassification);
	if (!evidence.prerequisiteSatisfied) return false;
	const changed = evidence.fingerprint !== state.failureRecoveryEvidenceFingerprint;
	if (state.failureClassification === "source_working_state_changed") {
		if (state.observedRecoveryEvidenceFingerprint !== evidence.fingerprint) {
			state.observedRecoveryEvidenceFingerprint = evidence.fingerprint;
			state.observedRecoveryEvidenceFirstSeenAtEpochMs = Date.now();
			return false;
		}
		if (Date.now() - (state.observedRecoveryEvidenceFirstSeenAtEpochMs ?? Date.now()) < 15_000) return false;
		return state.automaticAttemptCount < state.maximumAutomaticAttemptCount;
	}
	if (state.automaticAttemptCount >= state.maximumAutomaticAttemptCount) {
		return !state.repairSupplementConsumed && changed && evidence.provesRelevantRepair;
	}
	if (state.failureClassification === "temporary_io_failure") {
		return (
			Date.now() >=
			(state.lastFailureAtEpochMs ?? Date.now()) + (state.automaticAttemptCount <= 1 ? 30_000 : 120_000)
		);
	}
	if (["insufficient_storage_space", "owned_process_exit_unconfirmed"].includes(state.failureClassification))
		return true;
	return changed;
}

export async function beginTaskClosureAutomaticSideEffect(
	operation: TaskClosureOperation,
	sideEffect: NonNullable<TaskClosureAutomaticRecoveryState["pendingSideEffect"]>,
	continueSuccessfulAttempt = false,
) {
	await assertTaskClosureLifecycleNotCancelled(operation);
	const state = getTaskClosureAutomaticRecoveryState(operation);
	const continuation =
		continueSuccessfulAttempt &&
		state.automaticAttemptCount > 0 &&
		state.failureClassification === null &&
		state.pendingSideEffect !== sideEffect;
	if (!continuation && !(await isTaskClosureAutomaticRecoveryEligible(operation)))
		throw new TaskClosureRecoveryPrerequisiteError(
			"recovery_evidence_unavailable",
			"结案操作等待相关恢复证据，未重复执行。",
		);
	if (!continuation) {
		if (state.automaticAttemptCount >= state.maximumAutomaticAttemptCount) {
			if (!state.failureClassification || state.repairSupplementConsumed)
				throw new TaskClosureRecoveryPrerequisiteError(
					"recovery_evidence_unavailable",
					"本请求的自动重操作次数已用尽。",
				);
			const evidence = await readTaskClosureRecoveryEvidence(operation, state.failureClassification);
			if (
				!evidence.provesRelevantRepair ||
				!evidence.prerequisiteSatisfied ||
				evidence.fingerprint === state.failureRecoveryEvidenceFingerprint
			)
				throw new TaskClosureRecoveryPrerequisiteError(
					"recovery_evidence_unavailable",
					"尚未证实相关修复，未补发次数。",
				);
			state.repairSupplementConsumed = true;
			state.maximumAutomaticAttemptCount = Math.max(4, state.automaticAttemptCount + 1);
		}
		state.automaticAttemptCount += 1;
	}
	state.pendingSideEffect = sideEffect;
	operation.lastAttemptRuntimeInstanceId = getThisRuntimeProcessInstanceId();
	state.failureClassification = null;
	state.failureRecoveryEvidenceFingerprint = null;
	delete state.observedRecoveryEvidenceFingerprint;
	delete state.observedRecoveryEvidenceFirstSeenAtEpochMs;
	await writeTaskClosureOperation(operation);
	await writeTaskClosureAutomaticAttemptReceipt(operation, "started");
}

export async function completeTaskClosureAutomaticSideEffect(
	operation: TaskClosureOperation,
	completedSideEffect?: NonNullable<TaskClosureAutomaticRecoveryState["pendingSideEffect"]>,
) {
	const state = getTaskClosureAutomaticRecoveryState(operation);
	if (completedSideEffect) state.pendingSideEffect = completedSideEffect;
	await writeTaskClosureAutomaticAttemptReceipt(operation, "completed");
	state.pendingSideEffect = null;
	state.failureClassification = null;
	state.failureRecoveryEvidenceFingerprint = null;
	state.lastFailureAtEpochMs = null;
	delete state.observedRecoveryEvidenceFingerprint;
	delete state.observedRecoveryEvidenceFirstSeenAtEpochMs;
	delete state.lastFailureMessage;
}

export async function recordTaskClosureAutomaticFailure(operation: TaskClosureOperation, error: unknown) {
	if (
		error instanceof TaskClosureRecoveryPrerequisiteError &&
		error.classification === "recovery_evidence_unavailable"
	)
		return;
	const state = getTaskClosureAutomaticRecoveryState(operation);
	if (state.failureClassification !== null) return;
	const classification = classifyTaskClosureFailure(error);
	state.failureClassification = classification;
	state.lastFailureMessage = error instanceof Error ? error.message : String(error);
	state.lastFailureAtEpochMs = Date.now();
	try {
		state.failureRecoveryEvidenceFingerprint = (
			await readTaskClosureRecoveryEvidence(operation, state.failureClassification)
		).fingerprint;
	} catch {
		state.failureRecoveryEvidenceFingerprint = "recovery_evidence_currently_unavailable";
	}
	operation.progress.recoveryCondition =
		state.automaticAttemptCount >= state.maximumAutomaticAttemptCount
			? "总自动次数已用尽；仅在相关修复确证后允许一次补试，检查证据不会补发次数。"
			: "等待与本次失败相关的恢复证据；重启和普通空间波动不会触发重做。";
	await writeTaskClosureAutomaticAttemptReceipt(operation, "failed", {
		classification: state.failureClassification,
		message: error instanceof Error ? error.message : String(error),
	});
}
