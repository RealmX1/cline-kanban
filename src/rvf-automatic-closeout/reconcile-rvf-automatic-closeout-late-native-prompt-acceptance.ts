import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type RvfAutomaticCloseoutRecord,
	type RvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCode,
	type RvfLateNativeCloseoutPromptAcceptanceRecoveryReceipt,
	type RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse,
	rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema,
	rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema,
} from "../core/rvf-automatic-closeout-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import { readCodexConversationTurns } from "./codex-native-conversation-prefix";
import { inspectRvfCompletionEvidence } from "./inspect-rvf-completion-evidence";
import { readCodexNativeCloseoutPromptAcceptanceEvidence } from "./read-codex-native-closeout-prompt-acceptance-evidence";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";

const eligiblePauseReason = "收尾投递失败：submit_confirmation_budget_exhausted";
class LateNativePromptAcceptanceRecoveryError extends Error {
	constructor(
		public readonly status: "unknown" | "blocked",
		public readonly reasonCode: RvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCode,
		message: string,
	) {
		super(message);
	}
}
interface NativePromptAcceptanceVerificationDependencies {
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
	]);
}

export async function verifyRvfAutomaticCloseoutLateNativePromptAcceptance(
	deps: NativePromptAcceptanceVerificationDependencies,
	record: RvfAutomaticCloseoutRecord,
): Promise<RvfLateNativeCloseoutPromptAcceptanceRecoveryReceipt> {
	assertNotExplicitlyStopped(deps, record);
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
		delivery.terminal_delivery_failure_reason !== "submit_confirmation_budget_exhausted" ||
		(delivery.attempt_id !== undefined && delivery.attempt_id !== record.conversationSessionId) ||
		!delivery.agent_idle_gate_passed_at ||
		!Number.isFinite(Date.parse(delivery.agent_idle_gate_passed_at)) ||
		!Number.isFinite(Date.parse(delivery.created_at)) ||
		!Number.isFinite(Date.parse(delivery.terminal_delivery_status_updated_at))
	)
		throw new LateNativePromptAcceptanceRecoveryError(
			"blocked",
			"delivery_failure_not_eligible",
			"缺少本轮确认预算耗尽且已经通过空闲门的原始投递账本。",
		);
	const originalDeliveryFailure = {
		taskId: delivery.task_id,
		...(delivery.attempt_id !== undefined ? { attemptId: delivery.attempt_id } : {}),
		source: "rvf_automatic_closeout" as const,
		idempotencyKey: delivery.idempotency_key,
		promptSha256: delivery.prompt_sha256,
		messageId: delivery.message_id,
		status: "delivery_failed" as const,
		failureReason: "submit_confirmation_budget_exhausted" as const,
		createdAt: delivery.created_at,
		statusUpdatedAt: delivery.terminal_delivery_status_updated_at,
	};
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
	const summary = await deps.getMainSummary();
	const summaryIdentityBeforeObservation = summaryIdentitySnapshot(summary);
	if (
		summary.taskId !== record.conversationSessionId ||
		!record.restoredNativeSessionId ||
		!record.restoredTranscriptPath ||
		summary.agentId !== "codex" ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.restoredNativeSessionId ||
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
	try {
		await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				let cursor: string | null = null;
				const seenCursors = new Set<string>();
				let loaded = false;
				do {
					const page = z
						.object({ data: z.array(z.string()), nextCursor: z.string().nullable() })
						.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
					loaded ||= page.data.includes(record.restoredNativeSessionId ?? "");
					cursor = page.nextCursor ?? null;
					if (cursor && seenCursors.has(cursor)) throw new Error("原生已加载会话分页循环。");
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				if (!loaded) throw new Error("恢复会话并未由当前 TUI 宿主持有。");
				const turns = await readCodexConversationTurns(port, record.restoredNativeSessionId ?? "");
				const matches = turns.flatMap((turn) =>
					turn.items
						.filter((item) => item.type === "userMessage")
						.filter(
							(item) =>
								item.content?.length &&
								item.content.every(
									(part) => ["text", "input_text"].includes(part.type) && typeof part.text === "string",
								) &&
								computeRvfTextSha256(item.content.map((part) => part.text).join("")) === delivery.prompt_sha256,
						)
						.map((item) => ({ turnId: turn.id, messageId: item.id })),
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
			},
			{ socketPath: endpoint.socketPath },
		);
	} catch (error) {
		if (error instanceof LateNativePromptAcceptanceRecoveryError) throw error;
		throw new LateNativePromptAcceptanceRecoveryError(
			"unknown",
			"native_control_unavailable",
			`当前原生活动分支不能完整核验：${error instanceof Error ? error.message : String(error)}`,
		);
	}
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
			if (
				record.lateNativePromptAcceptanceRecoveryReceipt
					? !["closeout_prompt_submitted", "completed"].includes(record.status)
					: record.status !== "paused" || record.pauseReason !== eligiblePauseReason
			)
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"pause_reason_not_eligible",
					"本轮并非确认预算耗尽暂停，不能通过此入口恢复。",
				);
			const receipt = await verifyRvfAutomaticCloseoutLateNativePromptAcceptance(deps, record);
			assertOwned();
			const current = (await readRvfAutomaticCloseoutRecords(storePath)).find(
				(entry) => entry.taskId === request.taskId && entry.receipt.decision_token === request.decisionToken,
			);
			if (JSON.stringify(current) !== JSON.stringify(record))
				throw new LateNativePromptAcceptanceRecoveryError(
					"blocked",
					"record_changed",
					"核验期间自动收尾记录已改变，请重新核对。",
				);
			if (record.lateNativePromptAcceptanceRecoveryReceipt || request.dryRun) {
				response = {
					status: record.lateNativePromptAcceptanceRecoveryReceipt ? "already_recovered" : "eligible",
					reasonCode: "native_prompt_acceptance_verified",
					record,
					receipt,
				};
				return;
			}
			const saved = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
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
					updatedAt: Date.now(),
				};
				return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
			});
			response = { status: "recovered", reasonCode: "native_prompt_acceptance_verified", record: saved, receipt };
		});
	} catch (error) {
		if (error instanceof LateNativePromptAcceptanceRecoveryError)
			return { status: error.status, reasonCode: error.reasonCode, reason: error.message };
		return {
			status: "unknown",
			reasonCode: "native_prompt_acceptance_not_proven",
			reason: `补证未完成，保持原记录：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return response;
}
