import { realpath } from "node:fs/promises";
import type { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type RvfAutomaticCloseoutRecord,
	type RvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCode,
	type RvfLateNativeCloseoutPromptAcceptanceRecoveryReceipt,
	type RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse,
	rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema,
	rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema,
	rvfLateNativeCloseoutRecoverableDeliveryFailureReasonSchema,
	rvfLateNativeCloseoutSubmissionIdentitySchema,
} from "../core/rvf-automatic-closeout-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	type TaskMessageInjectionRecord,
} from "../core/task-message-injection-ledger";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import {
	parseCodexNativeCloseoutUserMessageContent,
	readCodexNativeCloseoutCandidateText,
} from "./codex-native-closeout-user-message-content";
import {
	assertCodexNativeConversationLoadedByCurrentHost,
	readCodexConversationTurns,
} from "./codex-native-conversation-prefix";
import { readNormalRvfCloseoutSuppression } from "./independent-backup-route-ownership";
import { inspectRvfCompletionEvidence } from "./inspect-rvf-completion-evidence";
import { readCodexNativeCloseoutPromptAcceptanceEvidence } from "./read-codex-native-closeout-prompt-acceptance-evidence";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";
import {
	appendRvfCloseoutSkillEvidence,
	captureRvfCloseoutAcceptedSkillSnapshot,
	readRvfCloseoutSkillSnapshots,
} from "./rvf-closeout-skill-attachment-snapshot-store";
import { isRvfCloseoutEligibleForLateNativeAcceptanceVerification } from "./rvf-late-native-closeout-acceptance-recovery-eligibility";
import { verifyCodexNativeCloseoutSkillAttachmentEvidence } from "./verify-codex-native-closeout-skill-attachment-evidence";

class LateNativePromptAcceptanceRecoveryError extends Error {
	constructor(
		public readonly status: "unknown" | "blocked",
		public readonly reasonCode: RvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCode,
		message: string,
		public readonly failedNativeTurnHistoryPageReadCursor?: string | null,
	) {
		super(message);
	}
}
interface NativePromptAcceptanceVerificationDependencies {
	persistSkillEvidenceDiagnostics?: boolean;
	workspaceId: string;
	rvfHome: string;
	getMainSummary: () => Promise<RuntimeTaskSessionSummary>;
	isExplicitlyStopped: (conversationSessionId: string) => boolean;
}
function assertNotExplicitlyStopped(
	deps: NativePromptAcceptanceVerificationDependencies,
	record: RvfAutomaticCloseoutRecord,
) {
	if (record.explicitStopRequestedAt !== undefined || deps.isExplicitlyStopped(record.conversationSessionId))
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"explicit_stop",
			"用户明确停止过本轮收尾，不能补证恢复。",
		);
}
function summaryIdentitySnapshot(summary: RuntimeTaskSessionSummary) {
	return JSON.stringify([
		summary.taskId,
		summary.startedAt,
		summary.workspacePath,
		summary.runtimeSessionIncarnationId,
		summary.agentNativeConversationSessionIdentity?.nativeSessionId,
		summary.agentNativeConversationSessionIdentity?.transcriptPath,
		summary.codexNativeSessionControlEndpoint,
		resolveSessionFacets(summary).liveness,
	]);
}

async function verifyOriginalNativeSubmissionIdentity(
	record: RvfAutomaticCloseoutRecord,
	delivery: TaskMessageInjectionRecord,
	evidence: Awaited<ReturnType<typeof readCodexNativeCloseoutPromptAcceptanceEvidence>>,
) {
	if (delivery.terminal_delivery_failure_reason !== "codex_native_prompt_delivery_unconfirmed") return;
	const operation = delivery.codex_native_prompt_delivery_operation;
	const confirmation = delivery.nativeCompactionAwareConfirmation;
	const conflict = () => {
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"native_submission_binding_mismatch",
			"原发送的 client ID、会话、正文或提交响应回合与接受事件不符。",
		);
	};
	let identity: z.infer<typeof rvfLateNativeCloseoutSubmissionIdentitySchema>;
	if (operation) {
		if (
			operation.workspaceId !== record.workspaceId ||
			operation.conversationSessionId !== record.conversationSessionId ||
			operation.nativeSessionId !== record.restoredNativeSessionId ||
			operation.promptSha256 !== delivery.prompt_sha256 ||
			(await realpath(operation.workingDirectoryPath)) !== (await realpath(record.receipt.worktree)) ||
			operation.actualSendAttemptCount < 1 ||
			!["request_intent_persisted", "request_invoked", "native_accepted"].includes(operation.sendPhase)
		)
			conflict();
		const cached = operation.historicalAcceptanceEvidence;
		if (
			cached &&
			(cached.clientUserMessageId !== operation.clientUserMessageId ||
				cached.nativeSessionId !== record.restoredNativeSessionId ||
				cached.nativeTurnId !== evidence.nativeTurnId ||
				cached.nativeUserMessageId !== evidence.nativeUserMessageId)
		)
			conflict();
		identity = rvfLateNativeCloseoutSubmissionIdentitySchema.parse({
			source: "native_delivery_operation",
			clientUserMessageId: operation.clientUserMessageId,
			returnedNativeTurnId: operation.returnedTurnId,
			previousNativeTurnId: operation.previousTurnId,
		});
	} else if (confirmation) {
		const binding = confirmation.binding;
		if (
			confirmation.submissionTransport !== "codex_native_request" ||
			binding.workspaceId !== record.workspaceId ||
			binding.taskId !== record.taskId ||
			binding.conversationSessionId !== record.conversationSessionId ||
			binding.decisionToken !== record.receipt.decision_token ||
			binding.runId !== record.runId ||
			binding.handoffSha256 !== record.handoffSha256 ||
			binding.idempotencyKey !== delivery.idempotency_key ||
			binding.promptSha256 !== delivery.prompt_sha256 ||
			binding.nativeSessionId !== record.restoredNativeSessionId ||
			confirmation.firstSubmissionAtEpochMs < Date.parse(delivery.created_at) ||
			confirmation.firstSubmissionAtEpochMs > Date.parse(evidence.nativeUserMessageRecordedAt)
		)
			conflict();
		if (!confirmation.clientUserMessageId)
			throw new LateNativePromptAcceptanceRecoveryError(
				"unknown",
				"native_submission_identity_not_proven",
				"同次确认快照缺少 client ID，等待原发送证据恢复。",
			);
		identity = rvfLateNativeCloseoutSubmissionIdentitySchema.parse({
			source: "compaction_confirmation_snapshot",
			clientUserMessageId: confirmation.clientUserMessageId,
			returnedNativeTurnId: confirmation.nativeTurnIdReturnedBySubmissionRequest ?? null,
			previousNativeTurnId: confirmation.predecessorNativeTurnId,
		});
	} else {
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"native_submission_identity_not_proven",
			"缺少原生发送操作与绑定同次提交的确认快照，等待发送身份补证。",
		);
	}
	if (
		operation &&
		confirmation &&
		(confirmation.clientUserMessageId !== operation.clientUserMessageId ||
			confirmation.binding.workspaceId !== operation.workspaceId ||
			confirmation.binding.conversationSessionId !== operation.conversationSessionId ||
			confirmation.binding.nativeSessionId !== operation.nativeSessionId ||
			confirmation.binding.promptSha256 !== operation.promptSha256 ||
			(confirmation.nativeTurnIdReturnedBySubmissionRequest !== undefined &&
				confirmation.nativeTurnIdReturnedBySubmissionRequest !== operation.returnedTurnId))
	)
		conflict();
	if (
		identity.previousNativeTurnId === evidence.nativeTurnId ||
		(identity.returnedNativeTurnId !== null && identity.returnedNativeTurnId !== evidence.nativeTurnId)
	)
		conflict();
	// 原生服务端可能分配新的 item ID；此时只接受同次提交响应给出的非前驱回合。
	if (
		identity.clientUserMessageId !== evidence.nativeUserMessageId &&
		identity.returnedNativeTurnId !== evidence.nativeTurnId
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"native_submission_identity_not_proven",
			"精确正文尚不能关联原发送 client ID 或提交响应回合。",
		);
	return identity;
}

export async function readRvfAutomaticCloseoutHistoricalNativePromptAcceptance(
	deps: NativePromptAcceptanceVerificationDependencies,
	record: RvfAutomaticCloseoutRecord,
) {
	assertNotExplicitlyStopped(deps, record);
	if (record.workspaceId !== deps.workspaceId || !record.restoredNativeSessionId || !record.restoredTranscriptPath)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"binding_mismatch",
			"历史接受缺少绑定的工作区或恢复原生身份。",
		);
	let completion: Awaited<ReturnType<typeof inspectRvfCompletionEvidence>>;
	try {
		completion = await inspectRvfCompletionEvidence(record, deps.rvfHome);
	} catch (error) {
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"completion_evidence_unavailable",
			`绑定的 RVF 完成证据不能确认：${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!completion ||
		completion.runId !== record.runId ||
		completion.runDirectory !== record.runDirectory ||
		completion.handoffPath !== record.handoffPath ||
		completion.handoffSha256 !== record.handoffSha256
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"binding_mismatch",
			"RVF 完成证据与本轮绑定不一致。",
		);
	const delivery = findTaskMessageInjectionRecord(
		await readTaskMessageInjectionLedger(
			getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(deps.workspaceId)),
		),
		record.conversationSessionId,
		record.promptDeliveryIdempotencyKey,
	);
	if (
		!delivery ||
		delivery.source !== "rvf_automatic_closeout" ||
		delivery.terminal_delivery_status !== "delivery_failed" ||
		!rvfLateNativeCloseoutRecoverableDeliveryFailureReasonSchema.safeParse(delivery.terminal_delivery_failure_reason)
			.success ||
		(delivery.attempt_id !== undefined && delivery.attempt_id !== record.conversationSessionId) ||
		!delivery.agent_idle_gate_passed_at ||
		!Number.isFinite(Date.parse(delivery.agent_idle_gate_passed_at)) ||
		!Number.isFinite(Date.parse(delivery.created_at)) ||
		!Number.isFinite(Date.parse(delivery.terminal_delivery_status_updated_at))
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"delivery_failure_not_eligible",
			"缺少本轮可恢复失败且已经通过空闲门的原始投递账本。",
		);
	const originalDeliveryFailure = {
		taskId: delivery.task_id,
		...(delivery.attempt_id !== undefined ? { attemptId: delivery.attempt_id } : {}),
		source: "rvf_automatic_closeout" as const,
		idempotencyKey: delivery.idempotency_key,
		promptSha256: delivery.prompt_sha256,
		messageId: delivery.message_id,
		status: "delivery_failed" as const,
		failureReason: rvfLateNativeCloseoutRecoverableDeliveryFailureReasonSchema.parse(
			delivery.terminal_delivery_failure_reason,
		),
		createdAt: delivery.created_at,
		statusUpdatedAt: delivery.terminal_delivery_status_updated_at,
	};
	const expectedPauseReason =
		record.lateNativePromptAcceptanceRecoveryReceipt?.previousPauseReason ?? record.pauseReason;
	if (expectedPauseReason !== `收尾投递失败：${originalDeliveryFailure.failureReason}`)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"delivery_failure_not_eligible",
			"原失败码与本轮暂停快照不一致。",
		);
	const prior = record.lateNativePromptAcceptanceRecoveryReceipt;
	if (
		prior &&
		(prior.workspaceId !== deps.workspaceId ||
			prior.taskId !== record.taskId ||
			prior.conversationSessionId !== record.conversationSessionId ||
			prior.decisionToken !== record.receipt.decision_token ||
			prior.runId !== record.runId ||
			prior.handoffSha256 !== record.handoffSha256 ||
			prior.promptDeliveryIdempotencyKey !== record.promptDeliveryIdempotencyKey ||
			JSON.stringify(prior.originalDeliveryFailure) !== JSON.stringify(originalDeliveryFailure))
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"binding_mismatch",
			"已保存补证凭据与当前绑定或原始失败账本不符。",
		);
	let evidence: Awaited<ReturnType<typeof readCodexNativeCloseoutPromptAcceptanceEvidence>>;
	try {
		evidence = await readCodexNativeCloseoutPromptAcceptanceEvidence({
			transcriptPath: record.restoredTranscriptPath,
			nativeSessionId: record.restoredNativeSessionId,
			worktree: record.receipt.worktree,
			promptSha256: delivery.prompt_sha256,
			deliveryCreatedAt: delivery.created_at,
			decisionToken: record.receipt.decision_token,
			runId: completion.runId,
			handoffSha256: completion.handoffSha256,
			handoffPath: completion.handoffPath,
			previousTranscriptSnapshot: prior,
		});
	} catch (error) {
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"native_prompt_acceptance_not_proven",
			`不能确认精确原生接受事实：${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		prior &&
		(prior.nativeSessionId !== record.restoredNativeSessionId ||
			prior.promptSha256 !== delivery.prompt_sha256 ||
			prior.nativeTurnId !== evidence.nativeTurnId ||
			prior.nativeUserMessageId !== evidence.nativeUserMessageId ||
			prior.nativeTurnStartedAt !== evidence.nativeTurnStartedAt ||
			prior.nativeUserMessageRecordedAt !== evidence.nativeUserMessageRecordedAt ||
			prior.transcriptPath !== evidence.transcriptPath)
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"binding_mismatch",
			"原生接受事件与首次补证不一致。",
		);
	const observedSubmissionIdentity = await verifyOriginalNativeSubmissionIdentity(record, delivery, evidence);
	if (
		prior?.nativeSubmissionIdentity &&
		JSON.stringify([
			prior.nativeSubmissionIdentity.clientUserMessageId,
			prior.nativeSubmissionIdentity.returnedNativeTurnId,
			prior.nativeSubmissionIdentity.previousNativeTurnId,
		]) !==
			JSON.stringify([
				observedSubmissionIdentity?.clientUserMessageId,
				observedSubmissionIdentity?.returnedNativeTurnId,
				observedSubmissionIdentity?.previousNativeTurnId,
			])
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"native_submission_binding_mismatch",
			"原发送身份与首次补证不一致。",
		);
	// 同次 operation 后来恢复不撤销已由确认快照证明的历史来源。
	const nativeSubmissionIdentity = prior?.nativeSubmissionIdentity ?? observedSubmissionIdentity;
	return { completion, delivery, originalDeliveryFailure, evidence, nativeSubmissionIdentity };
}

export async function verifyRvfAutomaticCloseoutLateNativePromptAcceptance(
	deps: NativePromptAcceptanceVerificationDependencies,
	record: RvfAutomaticCloseoutRecord,
): Promise<RvfLateNativeCloseoutPromptAcceptanceRecoveryReceipt> {
	const { completion, delivery, originalDeliveryFailure, evidence, nativeSubmissionIdentity } =
		await readRvfAutomaticCloseoutHistoricalNativePromptAcceptance(deps, record);
	const prior = record.lateNativePromptAcceptanceRecoveryReceipt;
	const summary = await deps.getMainSummary();
	const summaryIdentityBeforeObservation = summaryIdentitySnapshot(summary);
	if (
		summary.taskId !== record.conversationSessionId ||
		!record.restoredNativeSessionId ||
		!record.restoredTranscriptPath ||
		summary.agentId !== "codex" ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.restoredNativeSessionId ||
		(await realpath(summary.agentNativeConversationSessionIdentity?.transcriptPath ?? "")) !==
			(await realpath(record.restoredTranscriptPath ?? "")) ||
		(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"session_binding_changed",
			"当前主会话、恢复身份或工作区已经改变。",
		);
	const endpoint = summary.codexNativeSessionControlEndpoint ? { ...summary.codexNativeSessionControlEndpoint } : null;
	if (
		resolveSessionFacets(summary).liveness !== "live" ||
		!summary.runtimeSessionIncarnationId ||
		!endpoint ||
		endpoint.workspaceId !== deps.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"native_control_unavailable",
			"当前恢复会话没有有效的本代原生控制面；须先恢复同一原生会话再核验。",
		);
	let failedNativeTurnHistoryPageReadCursor: string | null | undefined;
	try {
		await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				await assertCodexNativeConversationLoadedByCurrentHost(port, record.restoredNativeSessionId ?? "");
				let revalidateSkillInstallation: (() => Promise<void>) | undefined;
				if (evidence.skillReferences.length) {
					try {
						revalidateSkillInstallation = await verifyCodexNativeCloseoutSkillAttachmentEvidence({
							port,
							worktree: record.receipt.worktree,
							text: evidence.text,
							historicalSnapshots: (
								await readRvfCloseoutSkillSnapshots(record, evidence.nativeSkillExpansionTexts, {
									persistDiagnostics: deps.persistSkillEvidenceDiagnostics !== false,
								})
							).filter(
								(snapshot) =>
									snapshot.promptDeliveryIdempotencyKey === delivery.idempotency_key &&
									snapshot.promptSha256 === delivery.prompt_sha256,
							),
							nativeUserMessageId: evidence.nativeUserMessageId,
							nativeTurnId: evidence.nativeTurnId,
							skillReferences: evidence.skillReferences,
							nativeSkillExpansionTexts: evidence.nativeSkillExpansionTexts,
						});
					} catch {
						throw new LateNativePromptAcceptanceRecoveryError(
							"unknown",
							"native_prompt_acceptance_not_proven",
							"不能唯一核对 Skill 附件的事件时路径、显式引用与原生展开正文。",
						);
					}
				}
				const turns = await readCodexConversationTurns(port, record.restoredNativeSessionId ?? "", {
					onNativeTurnHistoryPageReadFailure: async (cursor) => {
						failedNativeTurnHistoryPageReadCursor = cursor;
					},
				});
				const matches = turns.flatMap((turn) =>
					turn.items
						.filter((item) => item.type === "userMessage")
						.filter(
							(item) =>
								computeRvfTextSha256(readCodexNativeCloseoutCandidateText(item.content ?? [])) ===
								delivery.prompt_sha256,
						)
						.map((item) => ({ turnId: turn.id, messageId: item.id, content: item.content ?? [] })),
				);
				if (
					matches.length !== 1 ||
					matches[0]?.turnId !== evidence.nativeTurnId ||
					matches[0]?.messageId !== evidence.nativeUserMessageId
				)
					throw new LateNativePromptAcceptanceRecoveryError(
						"blocked",
						"native_message_not_on_active_branch",
						"精确原生正文不在当前活动分支，或存在重复正文，不能恢复。",
					);
				try {
					const content = parseCodexNativeCloseoutUserMessageContent(matches[0]?.content ?? []);
					if (JSON.stringify(content.skillReferences) !== JSON.stringify(evidence.skillReferences))
						throw new Error("原生附件已改变。");
				} catch {
					throw new LateNativePromptAcceptanceRecoveryError(
						"blocked",
						"native_message_not_on_active_branch",
						"当前活动分支的精确消息附件与原生转录不符或不受支持。",
					);
				}
				try {
					await revalidateSkillInstallation?.();
					await readCodexNativeCloseoutPromptAcceptanceEvidence({
						transcriptPath: record.restoredTranscriptPath ?? "",
						nativeSessionId: record.restoredNativeSessionId ?? "",
						worktree: record.receipt.worktree,
						promptSha256: delivery.prompt_sha256,
						deliveryCreatedAt: delivery.created_at,
						decisionToken: record.receipt.decision_token,
						runId: completion.runId,
						handoffSha256: completion.handoffSha256,
						handoffPath: completion.handoffPath,
						previousTranscriptSnapshot: evidence,
					});
				} catch {
					throw new LateNativePromptAcceptanceRecoveryError(
						"unknown",
						"native_prompt_acceptance_not_proven",
						"核验期间历史转录或 Skill 接受证据改变。",
					);
				}
			},
			{ socketPath: endpoint.socketPath },
		);
	} catch (error) {
		if (error instanceof LateNativePromptAcceptanceRecoveryError) throw error;
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"native_control_unavailable",
			`当前原生活动分支不能完整核验：${error instanceof Error ? error.message : String(error)}`,
			failedNativeTurnHistoryPageReadCursor,
		);
	}
	const refreshed = await readRvfAutomaticCloseoutHistoricalNativePromptAcceptance(deps, record);
	if (
		JSON.stringify(refreshed.originalDeliveryFailure) !== JSON.stringify(originalDeliveryFailure) ||
		JSON.stringify(refreshed.nativeSubmissionIdentity) !== JSON.stringify(nativeSubmissionIdentity)
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"record_changed",
			"核验期间原投递失败快照或发送身份改变。",
		);
	const latest = await deps.getMainSummary();
	assertNotExplicitlyStopped(deps, record);
	if (summaryIdentitySnapshot(latest) !== summaryIdentityBeforeObservation)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"session_binding_changed",
			"核验期间主会话或原生控制端点改变。",
		);
	if (prior) return prior;
	return rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema.parse({
		schema: "rvf-late-native-closeout-prompt-acceptance-recovery/v1",
		workspaceId: deps.workspaceId,
		taskId: record.taskId,
		conversationSessionId: record.conversationSessionId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId,
		handoffSha256: record.handoffSha256,
		promptDeliveryIdempotencyKey: record.promptDeliveryIdempotencyKey,
		nativeSessionId: record.restoredNativeSessionId,
		nativeTurnId: evidence.nativeTurnId,
		nativeUserMessageId: evidence.nativeUserMessageId,
		nativeTurnStartedAt: evidence.nativeTurnStartedAt,
		nativeUserMessageRecordedAt: evidence.nativeUserMessageRecordedAt,
		transcriptPath: evidence.transcriptPath,
		transcriptSha256: evidence.transcriptSha256,
		transcriptByteLength: evidence.transcriptByteLength,
		promptSha256: delivery.prompt_sha256,
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		observedAt: Date.now(),
		previousPauseReason: record.pauseReason,
		previousPauseUpdatedAt: record.updatedAt,
		originalDeliveryFailure,
		...(nativeSubmissionIdentity ? { nativeSubmissionIdentity } : {}),
	});
}

export async function reconcileRvfAutomaticCloseoutLateNativePromptAcceptance(
	deps: NativePromptAcceptanceVerificationDependencies,
	input: z.infer<typeof rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema>,
): Promise<RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse> {
	const request = rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema.parse(input);
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	let response: RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse = {
		status: "unknown",
		reasonCode: "record_operation_busy",
		reason: "本轮收尾操作正在被另一执行者持有，请稍后重试同一补证请求。",
	};
	try {
		await withRvfAutomaticCloseoutRecordOperationLock(storePath, request.decisionToken, async (assertOwned) => {
			const record = (await readRvfAutomaticCloseoutRecords(storePath)).find(
				(entry) => entry.taskId === request.taskId && entry.receipt.decision_token === request.decisionToken,
			);
			if (
				!record ||
				record.workspaceId !== deps.workspaceId ||
				record.runId !== request.runId ||
				record.handoffSha256 !== request.handoffSha256
			)
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"binding_mismatch",
					"补证请求与已登记的 task/token/run/handoff 绑定不一致。",
				);
			assertNotExplicitlyStopped(deps, record);
			if (!isRvfCloseoutEligibleForLateNativeAcceptanceVerification(record))
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"pause_reason_not_eligible",
					"本轮并非可恢复的原生收尾确认失败，不能通过此入口恢复。",
				);
			const suppressionBefore = await readNormalRvfCloseoutSuppression(record.receipt.worktree, record.runDirectory);
			const summaryBeforeVerification = summaryIdentitySnapshot(await deps.getMainSummary());
			const receipt = await verifyRvfAutomaticCloseoutLateNativePromptAcceptance(
				request.dryRun ? { ...deps, persistSkillEvidenceDiagnostics: false } : deps,
				record,
			);
			let skillEvidenceReference: Awaited<ReturnType<typeof captureRvfCloseoutAcceptedSkillSnapshot>> | null = null;
			if (
				!request.dryRun &&
				!record.skillAttachmentEvidenceHistory?.some(
					(entry) =>
						entry.phase === "accepted_native_expansion" &&
						entry.promptDeliveryIdempotencyKey === record.promptDeliveryIdempotencyKey,
				)
			) {
				try {
					skillEvidenceReference = await captureRvfCloseoutAcceptedSkillSnapshot(record, {
						idempotencyKey: record.promptDeliveryIdempotencyKey,
						promptSha256: receipt.promptSha256,
						createdAt: receipt.originalDeliveryFailure.createdAt,
						nativeMessageId: receipt.nativeUserMessageId,
					});
				} catch {
					appendDiagnosticEventToRotatingJsonlJournal(
						"rvf-late-native-closeout-prompt-acceptance-automatic-recovery",
						{
							outcome: "accepted_skill_snapshot_capture_unavailable",
							workspaceId: record.workspaceId,
							taskId: record.taskId,
						},
					);
				}
			}
			const latestSummary = await deps.getMainSummary();
			assertNotExplicitlyStopped(deps, record);
			if (
				summaryIdentitySnapshot(latestSummary) !== summaryBeforeVerification ||
				latestSummary.taskId !== record.conversationSessionId ||
				latestSummary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.restoredNativeSessionId ||
				resolveSessionFacets(latestSummary).liveness !== "live"
			)
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"session_binding_changed",
					"补证保存前本代会话身份改变。",
				);
			const refreshedEvidence = await readRvfAutomaticCloseoutHistoricalNativePromptAcceptance(deps, record);
			if (
				JSON.stringify(refreshedEvidence.originalDeliveryFailure) !==
					JSON.stringify(receipt.originalDeliveryFailure) ||
				JSON.stringify(refreshedEvidence.nativeSubmissionIdentity) !==
					JSON.stringify(receipt.nativeSubmissionIdentity) ||
				JSON.stringify(await readNormalRvfCloseoutSuppression(record.receipt.worktree, record.runDirectory)) !==
					JSON.stringify(suppressionBefore)
			)
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"record_changed",
					"补证保存前原投递或接管状态改变。",
				);
			const assertCurrentSessionAndOperation = async () => {
				const currentSummary = await deps.getMainSummary();
				assertNotExplicitlyStopped(deps, record);
				assertOwned();
				if (summaryIdentitySnapshot(currentSummary) !== summaryBeforeVerification)
					throw new LateNativePromptAcceptanceRecoveryError(
						"blocked",
						"session_binding_changed",
						"补证最终写入前会话身份改变。",
					);
			};
			await assertCurrentSessionAndOperation();
			const current = (await readRvfAutomaticCloseoutRecords(storePath)).find(
				(entry) => entry.taskId === request.taskId && entry.receipt.decision_token === request.decisionToken,
			);
			if (JSON.stringify(current) !== JSON.stringify(record))
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"record_changed",
					"核验期间自动收尾记录已改变，请重新核对。",
				);
			assertNotExplicitlyStopped(deps, record);
			assertOwned();
			if (record.lateNativePromptAcceptanceRecoveryReceipt || request.dryRun) {
				const savedRecord = skillEvidenceReference
					? await updateRvfAutomaticCloseoutRecords(storePath, async (records) => {
							await assertCurrentSessionAndOperation();
							assertOwned();
							const latest = records.find(
								(entry) =>
									entry.taskId === record.taskId && entry.receipt.decision_token === request.decisionToken,
							);
							if (JSON.stringify(latest) !== JSON.stringify(record)) throw new Error("补证追加期间记录改变。");
							assertNotExplicitlyStopped(deps, record);
							const updated = {
								...record,
								skillAttachmentEvidenceHistory: appendRvfCloseoutSkillEvidence(record, skillEvidenceReference),
							};
							return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
						})
					: record;
				response = {
					status: record.lateNativePromptAcceptanceRecoveryReceipt ? "already_recovered" : "eligible",
					reasonCode: "native_prompt_acceptance_verified",
					record: savedRecord,
					receipt,
				};
				return;
			}
			const saved = await updateRvfAutomaticCloseoutRecords(storePath, async (records) => {
				await assertCurrentSessionAndOperation();
				assertOwned();
				const latest = records.find(
					(entry) => entry.taskId === request.taskId && entry.receipt.decision_token === request.decisionToken,
				);
				if (JSON.stringify(latest) !== JSON.stringify(record))
					throw new LateNativePromptAcceptanceRecoveryError(
						"blocked",
						"record_changed",
						"补证写入前自动收尾记录已改变。",
					);
				assertNotExplicitlyStopped(deps, record);
				const updated: RvfAutomaticCloseoutRecord = {
					...record,
					status: "closeout_prompt_submitted",
					pauseReason: null,
					waitingReasonCode: null,
					waitingReason: null,
					waitingSince: null,
					waitingNotificationSentAt: null,
					lateNativePromptAcceptanceRecoveryReceipt: receipt,
					...(skillEvidenceReference
						? { skillAttachmentEvidenceHistory: appendRvfCloseoutSkillEvidence(record, skillEvidenceReference) }
						: {}),
					updatedAt: Date.now(),
				};
				return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
			});
			response = { status: "recovered", reasonCode: "native_prompt_acceptance_verified", record: saved, receipt };
		});
	} catch (error) {
		if (error instanceof LateNativePromptAcceptanceRecoveryError)
			return {
				status: error.status,
				reasonCode: error.reasonCode,
				reason: error.message,
				...(error.failedNativeTurnHistoryPageReadCursor !== undefined
					? { failedNativeTurnHistoryPageReadCursor: error.failedNativeTurnHistoryPageReadCursor }
					: {}),
			};
		return {
			status: "unknown",
			reasonCode: "native_prompt_acceptance_not_proven",
			reason: `补证未完成，保持原记录：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return response;
}
