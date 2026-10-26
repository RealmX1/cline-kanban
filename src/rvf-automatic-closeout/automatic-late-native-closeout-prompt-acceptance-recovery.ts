import { stat } from "node:fs/promises";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	RvfAutomaticCloseoutRecord,
	RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse,
} from "../core/rvf-automatic-closeout-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import {
	assertCodexNativeConversationLoadedByCurrentHost,
	readCodexConversationTurnHistoryPage,
	readCodexConversationTurns,
} from "./codex-native-conversation-prefix";
import { getRvfAutomaticCloseoutStorePath, updateRvfAutomaticCloseoutRecords } from "./rvf-automatic-closeout-store";
import { readRvfCloseoutSkillEvidenceSourceAvailabilityFingerprint } from "./rvf-closeout-skill-attachment-snapshot-store";
import { isRvfCloseoutEligibleForLateNativeAcceptanceVerification } from "./rvf-late-native-closeout-acceptance-recovery-eligibility";

export type AutomaticLateNativePromptAcceptanceRecoveryTrigger =
	| "background_sweep"
	| "status_query"
	| "execution_report";
export function isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(record: RvfAutomaticCloseoutRecord) {
	return (
		isRvfCloseoutEligibleForLateNativeAcceptanceVerification(record) &&
		(record.status === "paused" ||
			((record.promptDeliveryAttempts?.[0]?.purpose === "inspect_existing_state" ||
				record.promptDeliveryAttempts?.[0]?.executionRequiresReadOnlyInspection === true) &&
				["submitting_closeout_prompt", "closeout_prompt_submitted"].includes(record.status)) ||
			(record.lateNativePromptAcceptanceRecoveryReceipt !== undefined &&
				record.status === "closeout_prompt_submitted" &&
				record.automaticRecoveryProgress?.kind === "machine_waiting" &&
				!record.stageExecutionClaims?.some((claim) => claim.status === "claimed"))) &&
		record.explicitStopRequestedAt === undefined &&
		record.runId !== null &&
		record.handoffSha256 !== null &&
		record.restoredTranscriptPath !== null
	);
}
export async function readRvfLateNativeCloseoutRecoveryEvidenceFingerprint(
	record: RvfAutomaticCloseoutRecord,
	summary: RuntimeTaskSessionSummary,
) {
	return readRvfCloseoutRecoveryEvidenceFingerprintForPurpose(record, summary, "native_acceptance_verification");
}
export async function readRvfCloseoutNativeSessionRestoreEvidenceFingerprint(
	record: RvfAutomaticCloseoutRecord,
	summary: RuntimeTaskSessionSummary,
) {
	return readRvfCloseoutRecoveryEvidenceFingerprintForPurpose(record, summary, "native_session_restore");
}
async function readRvfCloseoutRecoveryEvidenceFingerprintForPurpose(
	record: RvfAutomaticCloseoutRecord,
	summary: RuntimeTaskSessionSummary,
	purpose: "native_acceptance_verification" | "native_session_restore",
) {
	const verifiesNativeAcceptance = purpose === "native_acceptance_verification";
	// 启动自身产生的代际、端点、转录增长和实际展开快照不能刷新同次启动预算。
	const evidenceRecord = verifiesNativeAcceptance
		? record
		: {
				...record,
				skillAttachmentEvidenceHistory: (record.skillAttachmentEvidenceHistory ?? []).filter(
					(entry) => entry.phase !== "accepted_native_expansion",
				),
			};
	const ledger = await readTaskMessageInjectionLedger(
		getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId)),
	);
	const delivery = findTaskMessageInjectionRecord(
		ledger,
		record.conversationSessionId,
		record.promptDeliveryIdempotencyKey,
	);
	const identity = summary.agentNativeConversationSessionIdentity;
	const handoffMetadata = await stat(record.handoffPath ?? "").catch(() => null);
	const metadata = await stat(record.restoredTranscriptPath ?? "").catch(() => null);
	const endpointMetadata = await stat(summary.codexNativeSessionControlEndpoint?.socketPath ?? "").catch(() => null);
	return JSON.stringify([
		delivery?.terminal_delivery_status,
		delivery?.terminal_delivery_failure_reason,
		delivery?.terminal_delivery_status_updated_at,
		delivery?.prompt_sha256,
		delivery?.task_id,
		delivery?.attempt_id,
		delivery?.source,
		delivery?.message_id,
		delivery?.created_at,
		delivery?.agent_idle_gate_passed_at,
		delivery?.codex_native_prompt_delivery_operation && [
			delivery.codex_native_prompt_delivery_operation.workspaceId,
			delivery.codex_native_prompt_delivery_operation.conversationSessionId,
			delivery.codex_native_prompt_delivery_operation.workingDirectoryPath,
			delivery.codex_native_prompt_delivery_operation.actualSendAttemptCount,
			delivery.codex_native_prompt_delivery_operation.sendPhase,
			delivery.codex_native_prompt_delivery_operation.clientUserMessageId,
			delivery.codex_native_prompt_delivery_operation.nativeSessionId,
			delivery.codex_native_prompt_delivery_operation.promptSha256,
			delivery.codex_native_prompt_delivery_operation.returnedTurnId,
			delivery.codex_native_prompt_delivery_operation.previousTurnId,
			delivery.codex_native_prompt_delivery_operation.historicalAcceptanceEvidence,
		],
		delivery?.nativeCompactionAwareConfirmation,
		handoffMetadata && [handoffMetadata.ino, handoffMetadata.size, handoffMetadata.mtimeMs],
		record.conversationSessionId,
		record.runId,
		record.handoffSha256,
		record.promptDeliveryIdempotencyKey,
		record.restoredTranscriptPath,
		verifiesNativeAcceptance ? summary.runtimeSessionIncarnationId : "native_session_restore",
		verifiesNativeAcceptance ? summary.startedAt : summary.codexConfigurationWriterBinding?.launchConfigurationDigest,
		identity?.nativeSessionId,
		identity?.transcriptPath,
		verifiesNativeAcceptance
			? endpointMetadata
				? [endpointMetadata.dev, endpointMetadata.ino, endpointMetadata.ctimeMs]
				: Boolean(summary.codexNativeSessionControlEndpoint)
			: summary.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings,
		verifiesNativeAcceptance
			? metadata
				? [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs]
				: "transcript_missing"
			: null,
		evidenceRecord.skillAttachmentEvidenceHistory?.map((entry) => entry.snapshotSha256),
		record.skillInstallationVersionReferences?.map((entry) => [
			entry.promptDeliveryIdempotencyKey,
			entry.instructionSha256,
			entry.gitVersion,
		]),
		await readRvfCloseoutSkillEvidenceSourceAvailabilityFingerprint(evidenceRecord),
	]);
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
		const baseFingerprint = await readRvfLateNativeCloseoutRecoveryEvidenceFingerprint(record, summary);
		const storePath = getRvfAutomaticCloseoutStorePath(record.workspaceId);
		let probe = record.automaticRecoveryProgress?.nativeControlCapabilityProbe;
		if (
			probe?.evidenceFingerprint === baseFingerprint &&
			probe.status === "unavailable" &&
			record.automaticRecoveryProgress?.verificationAttemptCount === 3 &&
			probe.nextProbeAtMs <= Date.now()
		) {
			const probeReserved = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
				const current = records.find(
					(entry) =>
						entry.taskId === record.taskId && entry.receipt.decision_token === record.receipt.decision_token,
				);
				const currentProgress = current?.automaticRecoveryProgress;
				const currentProbe = currentProgress?.nativeControlCapabilityProbe;
				if (
					!current ||
					!isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(current) ||
					!currentProbe ||
					!currentProgress ||
					currentProbe.nextProbeAtMs > Date.now() ||
					currentProbe.evidenceFingerprint !== baseFingerprint
				)
					return { records, value: false };
				return {
					records: records.map((entry) =>
						entry === current
							? {
									...current,
									automaticRecoveryProgress: {
										...currentProgress,
										nativeControlCapabilityProbe: { ...currentProbe, nextProbeAtMs: Date.now() + 60_000 },
									},
								}
							: entry,
					),
					value: true,
				};
			});
			if (!probeReserved) return;
			let ready = false;
			const endpoint = summary.codexNativeSessionControlEndpoint;
			if (
				endpoint &&
				endpoint.workspaceId === record.workspaceId &&
				endpoint.conversationSessionId === summary.taskId &&
				endpoint.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
				resolveSessionFacets(summary).liveness === "live"
			) {
				try {
					await withRunningCodexAppServerControlSocketConnection(
						async (port) => {
							await assertCodexNativeConversationLoadedByCurrentHost(port, identity.nativeSessionId);
							const failedCursor = probe?.failedNativeTurnHistoryPageReadCursor;
							if (failedCursor === undefined) {
								// 未知失败页时验证完整读取能力，不能把首页可读误判为循环/缺页已恢复。
								await readCodexConversationTurns(port, identity.nativeSessionId);
							} else {
								try {
									await readCodexConversationTurnHistoryPage(port, identity.nativeSessionId, failedCursor);
								} catch (error) {
									if (
										failedCursor !== null ||
										!(error instanceof Error) ||
										!error.message.includes("list_turns is not supported yet")
									)
										throw error;
									await readCodexConversationTurns(port, identity.nativeSessionId);
								}
							}
						},
						{ socketPath: endpoint.socketPath, requestTimeoutMs: 2_000 },
					);
					ready = true;
				} catch {
					/* 轻量能力仍不可用；保留原完整核验预算。 */
				}
			}
			if (!ready) return;
			probe = {
				...probe,
				status: "ready",
				recoveryGeneration: probe.recoveryGeneration + 1,
				nextProbeAtMs: Date.now() + 60_000,
			};
		}
		const fingerprint = JSON.stringify([
			baseFingerprint,
			probe?.evidenceFingerprint === baseFingerprint ? probe.recoveryGeneration : 0,
		]);
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
					...(probe ? { nativeControlCapabilityProbe: probe } : {}),
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
						...(result.reasonCode === "native_control_unavailable"
							? {
									nativeControlCapabilityProbe: {
										evidenceFingerprint: baseFingerprint,
										nextProbeAtMs: Date.now() + 60_000,
										status: "unavailable" as const,
										recoveryGeneration:
											probe?.evidenceFingerprint === baseFingerprint ? probe.recoveryGeneration : 0,
										...("failedNativeTurnHistoryPageReadCursor" in result
											? {
													failedNativeTurnHistoryPageReadCursor:
														result.failedNativeTurnHistoryPageReadCursor,
												}
											: {}),
									},
								}
							: {}),
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
