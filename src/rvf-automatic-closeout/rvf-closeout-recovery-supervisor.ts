import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type { RvfCloseoutDeliveryAttempt } from "../core/rvf-automatic-closeout-recovery-contract";
import { MODAL_USER_DECISION_TURN_KINDS, resolveSessionFacets } from "../core/session-activity";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import { readCodexNativeCloseoutCandidateText } from "./codex-native-closeout-user-message-content";
import { readCodexConversationTurns } from "./codex-native-conversation-prefix";
import {
	normalRvfCloseoutReconciliationContext,
	recordIndependentBackupRouteSuppressionObservation,
	withNormalRvfCloseoutMutation,
} from "./independent-backup-route-ownership";
import { inspectRvfCompletionEvidence } from "./inspect-rvf-completion-evidence";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";
import {
	hasRvfCloseoutStageResultBlockingAutomaticExecution,
	resolveRvfCloseoutActiveDelivery,
} from "./rvf-closeout-execution-stage-recovery";
import {
	appendRvfCloseoutSkillEvidence,
	captureRvfCloseoutAcceptedSkillSnapshot,
} from "./rvf-closeout-skill-attachment-snapshot-store";
import { readRvfCloseoutWorkspaceStateDigest } from "./rvf-closeout-workspace-state-digest";
import { verifyRvfCloseoutContinuationNativeAcceptance } from "./verify-rvf-closeout-continuation-native-acceptance";

interface RecoverySupervisorDependencies {
	workspaceId: string;
	rvfHome: string;
	isStopped: (record: RvfAutomaticCloseoutRecord) => boolean;
	getMainSummary: () => Promise<RuntimeTaskSessionSummary>;
	isContinuationSuppressed: (summary: RuntimeTaskSessionSummary) => Promise<boolean>;
	hasBackgroundWork: (summary: RuntimeTaskSessionSummary) => Promise<boolean>;
	assertNoPendingUserInput: (record: RvfAutomaticCloseoutRecord) => Promise<void>;
	isInputBoxEmpty: (summary: RuntimeTaskSessionSummary) => Promise<boolean>;
	restoreSameNativeSession: (record: RvfAutomaticCloseoutRecord, summary: RuntimeTaskSessionSummary) => Promise<void>;
	enqueueContinuation: (
		record: RvfAutomaticCloseoutRecord,
		attempt: RvfCloseoutDeliveryAttempt,
		guard: () => Promise<void>,
	) => Promise<void>;
}
export function remainingRvfCloseoutStages(record: RvfAutomaticCloseoutRecord) {
	return (["land", "base_branch_sync"] as const).filter((stage) => {
		const result = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
		return result?.outcome !== "completed" && !hasRvfCloseoutStageResultBlockingAutomaticExecution(result);
	});
}
export function remainingRvfCloseoutVerificationStages(record: RvfAutomaticCloseoutRecord) {
	return (["land", "base_branch_sync"] as const).filter((stage) => {
		const result = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
		return (
			result?.outcome !== "completed" &&
			(!hasRvfCloseoutStageResultBlockingAutomaticExecution(result) || result?.blockedReasonKind === undefined)
		);
	});
}
function hasUnclassifiedHistoricalStageBlock(record: RvfAutomaticCloseoutRecord) {
	return [record.landExecutionResult, record.baseBranchSyncExecutionResult].some(
		(result) => result?.outcome === "blocked" && result.blockedReasonKind === undefined,
	);
}
export async function advanceRvfCloseoutAutomaticRecovery(
	deps: RecoverySupervisorDependencies,
	original: RvfAutomaticCloseoutRecord,
) {
	if (
		!original.runId ||
		!original.runDirectory ||
		!original.handoffSha256 ||
		original.automaticCloseoutIneligibleReason ||
		["captured_review_start_boundary", "awaiting_rvf_completion", "completed"].includes(original.status)
	)
		return;
	return withNormalRvfCloseoutMutation(
		original.receipt.worktree,
		original.runDirectory,
		() => advanceNormalRvfCloseoutAutomaticRecovery(deps, original),
		(reason, controlDirectory) =>
			recordIndependentBackupRouteSuppressionObservation(
				getRvfAutomaticCloseoutStorePath(deps.workspaceId),
				original,
				reason,
				controlDirectory,
			),
		normalRvfCloseoutReconciliationContext(getRvfAutomaticCloseoutStorePath(deps.workspaceId), original),
	);
}
async function advanceNormalRvfCloseoutAutomaticRecovery(
	deps: RecoverySupervisorDependencies,
	original: RvfAutomaticCloseoutRecord,
) {
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	await withRvfAutomaticCloseoutRecordOperationLock(
		storePath,
		original.receipt.decision_token,
		async (assertOwned) => {
			let record = (await readRvfAutomaticCloseoutRecords(storePath)).find(
				(entry) =>
					entry.taskId === original.taskId && entry.receipt.decision_token === original.receipt.decision_token,
			);
			if (!record || deps.isStopped(record)) return;
			const refresh = async () => {
				const current = (await readRvfAutomaticCloseoutRecords(storePath)).find(
					(entry) =>
						entry.taskId === original.taskId && entry.receipt.decision_token === original.receipt.decision_token,
				);
				if (!current || current.runId !== original.runId || current.handoffSha256 !== original.handoffSha256)
					throw new Error("自动恢复绑定已改变。");
				record = current;
				return current;
			};
			const guard = async () => {
				assertOwned();
				if (deps.isStopped(await refresh())) throw new Error("自动恢复被明确停止。");
			};
			const save = async (patch: Partial<RvfAutomaticCloseoutRecord>) => {
				await guard();
				record = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
					assertOwned();
					const current = records.find(
						(entry) =>
							entry.taskId === original.taskId &&
							entry.receipt.decision_token === original.receipt.decision_token,
					);
					if (
						!current ||
						deps.isStopped(current) ||
						current.runId !== original.runId ||
						current.handoffSha256 !== original.handoffSha256
					)
						throw new Error("自动恢复写入前绑定或停止状态改变。");
					const updated = { ...current, ...patch };
					return { records: records.map((entry) => (entry === current ? updated : entry)), value: updated };
				});
			};
			const progress = async (
				reasonCode: string,
				action: NonNullable<RvfAutomaticCloseoutRecord["automaticRecoveryProgress"]>["nextAutomaticAction"],
				kind: NonNullable<RvfAutomaticCloseoutRecord["automaticRecoveryProgress"]>["kind"] = "machine_waiting",
			) => {
				if (!record) return;
				await save({
					automaticRecoveryProgress: {
						evidenceFingerprint: "",
						verificationAttemptCount: 0,
						nextVerificationAtMs: 0,
						...record.automaticRecoveryProgress,
						nativePromptAcceptanceVerificationReasonCode:
							record.automaticRecoveryProgress?.nativePromptAcceptanceVerificationReasonCode ??
							record.automaticRecoveryProgress?.reasonCode,
						kind,
						reasonCode,
						nextAutomaticAction: action,
					},
				});
			};
			if (!remainingRvfCloseoutVerificationStages(record).length) {
				if (record.automaticRecoveryProgress?.kind === "machine_waiting")
					await progress("no_remaining_authorized_stage", "none", "settled");
				return;
			}
			const delivery = resolveRvfCloseoutActiveDelivery(record);
			const ledger = await readTaskMessageInjectionLedger(
				getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(deps.workspaceId)),
			);
			const injected = findTaskMessageInjectionRecord(
				ledger,
				delivery.conversationSessionId,
				delivery.idempotencyKey,
			);
			if (
				(injected?.terminal_delivery_status === "delivered_and_submit_confirmed" ||
					(!delivery.continuation && record.lateNativePromptAcceptanceRecoveryReceipt !== undefined) ||
					delivery.continuation?.status === "confirmed") &&
				!record.skillAttachmentEvidenceHistory?.some(
					(entry) =>
						entry.phase === "accepted_native_expansion" &&
						entry.promptDeliveryIdempotencyKey === delivery.idempotencyKey,
				)
			) {
				const transcript = await stat(record.restoredTranscriptPath ?? "").catch(() => null);
				const fingerprint = JSON.stringify([
					delivery.idempotencyKey,
					record.restoredNativeSessionId,
					record.restoredTranscriptPath,
					transcript ? [transcript.dev, transcript.ino, transcript.size, transcript.mtimeMs] : "missing",
				]);
				const previousBudget = record.acceptedSkillSnapshotObservationBudget;
				const sameEvidence = previousBudget?.fingerprint === fingerprint;
				if (!sameEvidence || (previousBudget.count < 3 && previousBudget.nextAttemptAtMs <= Date.now())) {
					await save({
						acceptedSkillSnapshotObservationBudget: {
							fingerprint,
							count: sameEvidence ? previousBudget.count + 1 : 1,
							nextAttemptAtMs: Date.now() + 15_000,
						},
					});
					try {
						const reference = await captureRvfCloseoutAcceptedSkillSnapshot(record, {
							idempotencyKey: delivery.idempotencyKey,
							promptSha256: delivery.continuation?.promptSha256 ?? injected?.prompt_sha256 ?? "",
							createdAt: delivery.continuation
								? new Date(delivery.continuation.createdAt).toISOString()
								: (injected?.created_at ?? ""),
						});
						if (reference)
							await save({ skillAttachmentEvidenceHistory: appendRvfCloseoutSkillEvidence(record, reference) });
					} catch {
						/* 原生展开可能尚未落盘；不撤销真实投递确认。 */
					}
				}
			}
			const needsRecovery =
				hasUnclassifiedHistoricalStageBlock(record) ||
				(record.status === "paused" && record.pauseReason?.startsWith("收尾投递失败：")) ||
				injected?.terminal_delivery_status === "delivered_and_submit_confirmed" ||
				record.lateNativePromptAcceptanceRecoveryReceipt !== undefined ||
				record.promptDeliveryAttempts?.length ||
				record.automaticRecoveryProgress?.kind === "machine_waiting" ||
				[record.landExecutionResult, record.baseBranchSyncExecutionResult].some(
					(result) => result?.blockedReasonKind === "machine_precondition",
				);
			if (!needsRecovery) return;
			const completion = await inspectRvfCompletionEvidence(record, deps.rvfHome);
			if (!completion || completion.runId !== record.runId || completion.handoffSha256 !== record.handoffSha256)
				return;
			const summary = await deps.getMainSummary();
			if (
				summary.taskId !== delivery.conversationSessionId ||
				summary.agentNativeConversationSessionIdentity?.nativeSessionId !== delivery.nativeSessionId ||
				(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
			)
				return;
			if (await deps.isContinuationSuppressed(summary)) return;
			const facets = resolveSessionFacets(summary);
			if (facets.userTurnKind && MODAL_USER_DECISION_TURN_KINDS.has(facets.userTurnKind)) {
				await progress("pending_user_decision", "await_changed_evidence", "human_decision_pending");
				return;
			}
			await deps.assertNoPendingUserInput(record);
			if (facets.liveness !== "live" || !summary.codexNativeSessionControlEndpoint) {
				const restoreAttemptCount =
					record.automaticRecoveryProgress?.nativeSessionRestoreAttemptCount ??
					(record.automaticRecoveryProgress?.nativeSessionRestoreAttempted ? 1 : 0);
				if (
					["none", "exited"].includes(facets.liveness) &&
					restoreAttemptCount < 3 &&
					(record.automaticRecoveryProgress?.nextNativeSessionRestoreAttemptAtMs ?? 0) <= Date.now()
				) {
					await progress("native_control_unavailable", "restore_same_native_session");
					await save({
						automaticRecoveryProgress: {
							evidenceFingerprint: "",
							verificationAttemptCount: 0,
							nextVerificationAtMs: 0,
							kind: "machine_waiting",
							reasonCode: "native_control_unavailable",
							nextAutomaticAction: "restore_same_native_session",
							...record.automaticRecoveryProgress,
							nativeSessionRestoreAttempted: true,
							nativeSessionRestoreAttemptCount: restoreAttemptCount + 1,
							nextNativeSessionRestoreAttemptAtMs: Date.now() + 15_000,
						},
					});
					await guard();
					await deps.restoreSameNativeSession(record, summary);
				}
				if (restoreAttemptCount >= 3)
					await progress("native_control_restore_budget_exhausted", "await_changed_evidence");
				return;
			}
			const endpoint = summary.codexNativeSessionControlEndpoint;
			if (
				endpoint.workspaceId !== deps.workspaceId ||
				endpoint.conversationSessionId !== summary.taskId ||
				endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
			)
				return;
			if (facets.turnOwner !== "user" || (await deps.hasBackgroundWork(summary))) return;
			if (!(await deps.isInputBoxEmpty(summary))) {
				await progress("terminal_input_box_not_confirmed_empty", "await_changed_evidence");
				return;
			}
			if (record.stageExecutionClaims?.some((claim) => claim.status === "claimed")) {
				await progress("stage_execution_still_claimed", "verify_existing_execution");
				return;
			}
			const readContinuationEnqueueEvidenceFingerprint = async () => {
				const [transcript, endpointMetadata] = await Promise.all([
					stat(summary.agentNativeConversationSessionIdentity?.transcriptPath ?? "").catch(() => null),
					stat(endpoint.socketPath).catch(() => null),
				]);
				return JSON.stringify([
					"enqueue_continuation",
					summary.runtimeSessionIncarnationId,
					summary.agentNativeConversationSessionIdentity?.nativeSessionId,
					transcript ? [transcript.dev, transcript.ino, transcript.size, transcript.mtimeMs] : null,
					endpointMetadata ? [endpointMetadata.dev, endpointMetadata.ino, endpointMetadata.ctimeMs] : true,
				]);
			};
			if (delivery.continuation) {
				if (delivery.continuation.status === "prepared") {
					const fingerprint = await readContinuationEnqueueEvidenceFingerprint();
					const previous = delivery.continuation.observationBudget;
					const same = previous?.fingerprint === fingerprint;
					if (same && (previous.count >= 3 || previous.nextAttemptAtMs > Date.now())) return;
					await save({
						promptDeliveryAttempts: [
							{
								...delivery.continuation,
								observationBudget: {
									fingerprint,
									count: same ? previous.count + 1 : 1,
									nextAttemptAtMs: Date.now() + 15_000,
								},
							},
						],
					});
					await guard();
					await deps.enqueueContinuation(record, delivery.continuation, guard);
					return;
				}
				if (injected?.terminal_delivery_status === "delivered_and_submit_confirmed") {
					await save({
						status: "closeout_prompt_submitted",
						promptDeliveryAttempts: [{ ...delivery.continuation, status: "confirmed" }],
					});
					await progress("continuation_submit_confirmed", "none", "settled");
					return;
				}
				// 原生迟到补证只更新新尝试，不把它伪装成原投递接受。
				const metadata = await stat(summary.agentNativeConversationSessionIdentity?.transcriptPath ?? "").catch(
					() => null,
				);
				const fingerprint = JSON.stringify([
					delivery.idempotencyKey,
					summary.runtimeSessionIncarnationId,
					summary.codexNativeSessionControlEndpoint,
					metadata ? [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs] : "missing",
				]);
				const previousBudget = delivery.continuation.observationBudget;
				const sameEvidence = previousBudget?.fingerprint === fingerprint;
				if (sameEvidence && (previousBudget.count >= 3 || previousBudget.nextAttemptAtMs > Date.now())) return;
				await save({
					promptDeliveryAttempts: [
						{
							...delivery.continuation,
							observationBudget: {
								fingerprint,
								count: sameEvidence ? previousBudget.count + 1 : 1,
								nextAttemptAtMs: Date.now() + 15_000,
							},
						},
					],
				});
				try {
					await verifyRvfCloseoutContinuationNativeAcceptance({
						record,
						attempt: delivery.continuation,
						summary,
						getMainSummary: deps.getMainSummary,
					});
					await save({
						status: "closeout_prompt_submitted",
						promptDeliveryAttempts: [{ ...delivery.continuation, status: "confirmed" }],
					});
					await progress("continuation_native_acceptance_verified", "none", "settled");
				} catch {
					await progress("continuation_acceptance_not_yet_proven", "await_changed_evidence");
				}
				return;
			}
			const acceptanceVerificationReasonCode =
				record.automaticRecoveryProgress?.nativePromptAcceptanceVerificationReasonCode ??
				record.automaticRecoveryProgress?.reasonCode;
			const resumeVerifiedAcceptedStages = Boolean(
				(injected?.terminal_delivery_status === "delivered_and_submit_confirmed" ||
					(record.lateNativePromptAcceptanceRecoveryReceipt &&
						acceptanceVerificationReasonCode === "native_prompt_acceptance_verified")) &&
					(record.automaticRecoveryProgress?.nativeSessionRestoreAttempted ||
						[record.landExecutionResult, record.baseBranchSyncExecutionResult].some(
							(result) => result?.blockedReasonKind === "machine_precondition",
						)),
			);
			const inspectUnclassifiedHistoricalBlock = hasUnclassifiedHistoricalStageBlock(record);
			if (
				!inspectUnclassifiedHistoricalBlock &&
				!resumeVerifiedAcceptedStages &&
				(!record.automaticRecoveryProgress ||
					record.automaticRecoveryProgress.verificationAttemptCount < 3 ||
					record.automaticRecoveryProgress.nextVerificationAtMs > Date.now())
			)
				return;
			if (
				!inspectUnclassifiedHistoricalBlock &&
				!resumeVerifiedAcceptedStages &&
				!["native_prompt_acceptance_not_proven", "native_control_unavailable"].includes(
					acceptanceVerificationReasonCode ?? "",
				)
			)
				return;
			const preparationFingerprint =
				resumeVerifiedAcceptedStages || inspectUnclassifiedHistoricalBlock
					? `verified-accepted:${await readContinuationEnqueueEvidenceFingerprint()}`
					: (record.automaticRecoveryProgress?.evidenceFingerprint ?? "");
			// 旧版仅有一次性指纹时折算为已尝试一次，不把它继续当成永久完成标记。
			const previousPreparationBudget =
				record.automaticRecoveryProgress?.continuationPreparationObservationBudget ??
				(record.automaticRecoveryProgress?.continuationPreparationEvidenceFingerprint
					? {
							fingerprint: record.automaticRecoveryProgress.continuationPreparationEvidenceFingerprint,
							count: 1,
							nextAttemptAtMs: 0,
						}
					: undefined);
			const samePreparationEvidence = previousPreparationBudget?.fingerprint === preparationFingerprint;
			if (samePreparationEvidence && previousPreparationBudget.count >= 3) {
				await progress("continuation_preparation_budget_exhausted", "await_changed_evidence");
				return;
			}
			if (samePreparationEvidence && previousPreparationBudget.nextAttemptAtMs > Date.now()) return;
			const preparationAttemptCount = samePreparationEvidence ? previousPreparationBudget.count + 1 : 1;
			await save({
				automaticRecoveryProgress: {
					evidenceFingerprint: "",
					verificationAttemptCount: 0,
					nextVerificationAtMs: 0,
					...record.automaticRecoveryProgress,
					kind: "machine_waiting",
					reasonCode: "continuation_preparation_native_history_query_pending",
					nativePromptAcceptanceVerificationReasonCode: acceptanceVerificationReasonCode,
					nextAutomaticAction: "enqueue_reconciliation_attempt",
					continuationPreparationEvidenceFingerprint: preparationFingerprint,
					continuationPreparationObservationBudget: {
						fingerprint: preparationFingerprint,
						count: preparationAttemptCount,
						nextAttemptAtMs: Date.now() + 15_000,
					},
				},
			});
			const turns = await withRunningCodexAppServerControlSocketConnection(
				(port) => readCodexConversationTurns(port, delivery.nativeSessionId ?? ""),
				{ socketPath: summary.codexNativeSessionControlEndpoint.socketPath },
			).catch(async () => {
				await progress(
					preparationAttemptCount >= 3
						? "continuation_preparation_budget_exhausted"
						: "native_control_unavailable",
					preparationAttemptCount >= 3 ? "await_changed_evidence" : "enqueue_reconciliation_attempt",
				);
				return null;
			});
			if (!turns) return;
			if (turns.some((turn) => !["completed", "interrupted", "failed"].includes(turn.status))) return;
			const originalMatches = turns.flatMap((turn) =>
				turn.items.filter(
					(item) =>
						item.type === "userMessage" &&
						computeRvfTextSha256(readCodexNativeCloseoutCandidateText(item.content ?? [])) ===
							injected?.prompt_sha256,
				),
			);
			if (originalMatches.length > 1 || (resumeVerifiedAcceptedStages && originalMatches.length !== 1)) {
				await progress("duplicate_original_native_message", "await_changed_evidence");
				return;
			}
			const unchanged =
				record.restoreWorkspaceStateSha256 !== null &&
				(await readRvfCloseoutWorkspaceStateDigest(record.receipt.worktree)) === record.restoreWorkspaceStateSha256;
			const purpose =
				unchanged && !inspectUnclassifiedHistoricalBlock
					? ("execute_remaining_stages" as const)
					: ("inspect_existing_state" as const);
			const deliveryAttemptId = randomUUID();
			const promptText = `这是同一 RVF run 的受控续验，来源为 Kanban 自动恢复，不是人类新授权。\nRVF_AUTOMATIC_CLOSEOUT_TOKEN=${record.receipt.decision_token}\n${record.handoffPath}\nrun_id=${record.runId}\nhandoff_sha256=${record.handoffSha256}\ndelivery_attempt_id=${deliveryAttemptId}\n先核验既有 Land 与 base 规范产物并报告真实结果，保留原投递与阶段历史，分别登记接受与完成事实。当前模式=${purpose}；待核验阶段=${remainingRvfCloseoutVerificationStages(record).join("、")}；允许申请执行的阶段=${remainingRvfCloseoutStages(record).join("、") || "无"}。旧未分类 blocked 只允许读取原报告、原生记录和当前用户限制，附明确来源报告分类；原因仍未知时保留待验与恢复条件，不能猜测为机器故障或用户禁止。不要重做已完成阶段，不开启新 RVF，不部署，不移动 Done。先读取当前用户限制；用户禁止的阶段须报告 blocked、blockedReasonKind=user_restriction。任何写入前调用 kanban task claim-rvf-automatic-closeout-execution-stage，绑定 task=${record.taskId}、token/run/handoff 和本 deliveryAttemptId；只有 claimed 才可使用相应 $rvf-land 或 $base-branch-sync，已有 completed 直接复用。inspect_existing_state 模式先只读补证，原收尾资格或规范结果足以恢复后才可认领；不能凭本消息扩大授权。按原阶段结果报告命令登记，并附 deliveryAttemptId 和 stageExecutionClaimId。`;
			const attempt: RvfCloseoutDeliveryAttempt = {
				deliveryAttemptId,
				idempotencyKey: `rvf-automatic-closeout-${record.receipt.decision_token}-continuation`,
				promptSha256: computeRvfTextSha256(promptText),
				promptText,
				purpose,
				sourcePromptDeliveryIdempotencyKey: record.promptDeliveryIdempotencyKey,
				nativeSessionId: delivery.nativeSessionId ?? "",
				conversationSessionId: delivery.conversationSessionId,
				createdAt: Date.now(),
				status: "prepared",
				observationBudget: {
					fingerprint: await readContinuationEnqueueEvidenceFingerprint(),
					count: 1,
					nextAttemptAtMs: Date.now() + 15_000,
				},
			};
			await save({ status: "submitting_closeout_prompt", promptDeliveryAttempts: [attempt] });
			await guard();
			await deps.enqueueContinuation(record, attempt, guard);
		},
	);
}
