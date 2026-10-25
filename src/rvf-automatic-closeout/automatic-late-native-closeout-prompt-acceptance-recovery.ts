import { stat } from "node:fs/promises";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	RvfAutomaticCloseoutRecord,
	RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse,
} from "../core/rvf-automatic-closeout-contract";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";
import { getRvfAutomaticCloseoutStorePath, updateRvfAutomaticCloseoutRecords } from "./rvf-automatic-closeout-store";
import { readRvfCloseoutSkillEvidenceSourceAvailabilityFingerprint } from "./rvf-closeout-skill-attachment-snapshot-store";

export type AutomaticLateNativePromptAcceptanceRecoveryTrigger =
	| "background_sweep"
	| "status_query"
	| "execution_report";
export function isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(record: RvfAutomaticCloseoutRecord) {
	return (
		(record.status === "paused" ||
			((record.promptDeliveryAttempts?.[0]?.purpose === "inspect_existing_state" ||
				record.promptDeliveryAttempts?.[0]?.executionRequiresReadOnlyInspection === true) &&
				["submitting_closeout_prompt", "closeout_prompt_submitted"].includes(record.status)) ||
			(record.lateNativePromptAcceptanceRecoveryReceipt !== undefined &&
				record.status === "closeout_prompt_submitted" &&
				record.automaticRecoveryProgress?.kind === "machine_waiting" &&
				!record.stageExecutionClaims?.some((claim) => claim.status === "claimed"))) &&
		(record.pauseReason === "收尾投递失败：submit_confirmation_budget_exhausted" ||
			record.lateNativePromptAcceptanceRecoveryReceipt?.previousPauseReason ===
				"收尾投递失败：submit_confirmation_budget_exhausted") &&
		record.explicitStopRequestedAt === undefined &&
		record.runId !== null &&
		record.handoffSha256 !== null &&
		record.restoredTranscriptPath !== null
	);
}
// 预算在 workspace JSON 短锁内预留，跨 service、进程及重启共用；不会修改原失败账本。
export function createAutomaticLateNativeCloseoutPromptAcceptanceRecovery() {
	return async (input: {
		record: RvfAutomaticCloseoutRecord;
		summary: RuntimeTaskSessionSummary;
		trigger: AutomaticLateNativePromptAcceptanceRecoveryTrigger;
		recover: () => Promise<RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse>;
	}) => {
		const { record, summary } = input;
		if (!isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(record)) return;
		const identity = summary.agentNativeConversationSessionIdentity;
		if (
			summary.taskId !== record.conversationSessionId ||
			identity?.nativeSessionId !== record.restoredNativeSessionId
		)
			return;
		const metadata = await stat(record.restoredTranscriptPath ?? "").catch(() => null);
		const endpointMetadata = await stat(summary.codexNativeSessionControlEndpoint?.socketPath ?? "").catch(
			() => null,
		);
		const fingerprint = JSON.stringify([
			record.conversationSessionId,
			record.runId,
			record.handoffSha256,
			record.promptDeliveryIdempotencyKey,
			record.restoredTranscriptPath,
			summary.runtimeSessionIncarnationId,
			summary.startedAt,
			identity.nativeSessionId,
			identity.transcriptPath,
			endpointMetadata
				? [endpointMetadata.dev, endpointMetadata.ino, endpointMetadata.ctimeMs]
				: Boolean(summary.codexNativeSessionControlEndpoint),
			metadata ? [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs] : "transcript_missing",
			record.skillAttachmentEvidenceHistory?.map((entry) => entry.snapshotSha256),
			record.skillInstallationVersionReferences?.map((entry) => [
				entry.promptDeliveryIdempotencyKey,
				entry.instructionSha256,
				entry.gitVersion,
			]),
			await readRvfCloseoutSkillEvidenceSourceAvailabilityFingerprint(record),
		]);
		const storePath = getRvfAutomaticCloseoutStorePath(record.workspaceId);
		const reserved = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
			const current = records.find(
				(entry) => entry.taskId === record.taskId && entry.receipt.decision_token === record.receipt.decision_token,
			);
			if (!current || !isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(current))
				return { records, value: false };
			const previous = current.automaticRecoveryProgress;
			const same = previous?.evidenceFingerprint === fingerprint;
			if (same && (previous.verificationAttemptCount >= 3 || previous.nextVerificationAtMs > Date.now()))
				return { records, value: false };
			const updated: RvfAutomaticCloseoutRecord = {
				...current,
				automaticRecoveryProgress: {
					...previous,
					kind: "machine_waiting",
					reasonCode: "native_prompt_acceptance_not_proven",
					nativePromptAcceptanceVerificationReasonCode: "native_prompt_acceptance_not_proven",
					nextAutomaticAction: "collect_native_acceptance_evidence",
					evidenceFingerprint: fingerprint,
					verificationAttemptCount: same ? previous.verificationAttemptCount + 1 : 1,
					nextVerificationAtMs: Date.now() + 15_000,
				},
			};
			return { records: records.map((entry) => (entry === current ? updated : entry)), value: true };
		});
		if (!reserved) return;
		const result = await input.recover();
		await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
			records: records.map((current) => {
				if (
					current.taskId !== record.taskId ||
					current.receipt.decision_token !== record.receipt.decision_token ||
					current.explicitStopRequestedAt !== undefined ||
					current.automaticRecoveryProgress?.evidenceFingerprint !== fingerprint
				)
					return current;
				const success = result.status === "recovered" || result.status === "already_recovered";
				return {
					...current,
					automaticRecoveryProgress: {
						...current.automaticRecoveryProgress,
						kind: success ? ("settled" as const) : ("machine_waiting" as const),
						reasonCode: result.reasonCode,
						nativePromptAcceptanceVerificationReasonCode: result.reasonCode,
						nextAutomaticAction: success ? ("none" as const) : ("await_changed_evidence" as const),
						verificationAttemptCount:
							result.status === "blocked" ? 3 : current.automaticRecoveryProgress.verificationAttemptCount,
					},
				};
			}),
			value: undefined,
		}));
		appendDiagnosticEventToRotatingJsonlJournal("rvf-late-native-closeout-prompt-acceptance-automatic-recovery", {
			workspaceId: record.workspaceId,
			taskId: record.taskId,
			decisionToken: record.receipt.decision_token,
			runId: record.runId,
			trigger: input.trigger,
			outcome: result.status,
			reasonCode: result.reasonCode,
		});
	};
}
