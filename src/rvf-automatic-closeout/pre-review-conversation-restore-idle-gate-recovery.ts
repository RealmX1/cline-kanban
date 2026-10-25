import { stat } from "node:fs/promises";
import { z } from "zod";
import { readCodexNativeAgentTurnExecution } from "../agent-session-history/codex-native-agent-turn-execution-reader";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	buildCodexNativeAgentTurnExecutionSemanticGuard,
	type CodexNativeAgentTurnExecutionObservation,
} from "../core/codex-native-agent-turn-execution-observation";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type {
	RvfPreReviewConversationRestoreIdleGateBlocker,
	RvfPreReviewConversationRestoreIdleGateRecovery,
} from "../core/rvf-pre-review-conversation-restore-idle-gate-recovery-contract";
import { resolveSessionFacets } from "../core/session-activity";
import type { TaskMessageInjectionRecord } from "../core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import {
	assertCodexNativeConversationLoadedByCurrentHost,
	readCodexConversationTurnHistoryPage,
	readCodexConversationTurns,
} from "./codex-native-conversation-prefix";
import { readPreReviewRestoreNativeMessageOwnership } from "./read-pre-review-restore-native-message-ownership";
import { RvfAutomaticCloseoutPauseError, RvfAutomaticCloseoutWaitError } from "./rvf-automatic-closeout-coordinator";

export function collectPreReviewConversationRestoreIdleGateBlockers(input: {
	summary: RuntimeTaskSessionSummary;
	backgroundWorkParked: boolean;
	programmaticDeliveryInFlight: boolean;
}): RvfPreReviewConversationRestoreIdleGateBlocker[] {
	const facets = resolveSessionFacets(input.summary);
	const submission = input.summary.agentConversationPromptSubmissionAcceptance;
	const blockers: RvfPreReviewConversationRestoreIdleGateBlocker[] = [];
	if (!["live", "exited"].includes(facets.liveness)) blockers.push("process_liveness_not_ready");
	if (facets.turnOwner !== "user") blockers.push("turn_owner_not_user");
	if (facets.userTurnKind !== "review") blockers.push("user_turn_kind_not_review");
	if (
		facets.liveness === "live" &&
		submission != null &&
		submission.runtimeSessionIncarnationId === input.summary.runtimeSessionIncarnationId &&
		submission.status !== "accepted"
	)
		blockers.push("current_process_prompt_acceptance_unconfirmed");
	if (input.backgroundWorkParked) blockers.push("background_work_parked");
	if (input.programmaticDeliveryInFlight) blockers.push("programmatic_delivery_in_flight");
	return blockers;
}

function nativeHealthFingerprint(observation: CodexNativeAgentTurnExecutionObservation | null) {
	return JSON.stringify(
		observation && [
			observation.nativeTurnId,
			observation.nativeTurnStatus,
			observation.threadStatus,
			observation.activeFlags,
			observation.canAcceptDirectInput,
		],
	);
}
function isStrictlyCompletedNativeTurn(observation: CodexNativeAgentTurnExecutionObservation | null) {
	return (
		observation?.threadStatus === "idle" &&
		observation.nativeTurnStatus === "completed" &&
		Boolean(observation.nativeTurnId) &&
		observation.activeFlags.length === 0 &&
		observation.canAcceptDirectInput === true
	);
}

// 所有入口都留在原 coordinator/备用路线互斥内；这里只补读证据，不变更 summary 或发送消息。
export async function requirePreReviewConversationRestoreIdleGate(input: {
	record: RvfAutomaticCloseoutRecord;
	summary: RuntimeTaskSessionSummary;
	blockingConditions: RvfPreReviewConversationRestoreIdleGateBlocker[];
	readLedger: () => Promise<TaskMessageInjectionRecord[]>;
	assertCurrentGuards: () => Promise<RuntimeTaskSessionSummary>;
	save: (patch: Partial<RvfAutomaticCloseoutRecord>) => Promise<void>;
}) {
	const { record, blockingConditions } = input;
	const summary = structuredClone(input.summary);
	const previous = record.preReviewConversationRestoreIdleGateRecovery;
	// 旧进程已经退出时没有可重验的活体端点；保留历史资格，复用已持久化 fork，外层仍核对 Stop 与终态。
	if (!blockingConditions.length && (!previous?.qualification || resolveSessionFacets(summary).liveness === "exited"))
		return;
	const wait = () => {
		throw new RvfAutomaticCloseoutWaitError(
			"agent_turn_not_ready_for_closeout",
			"等待 Agent 空闲及本轮原生消息归属补证。",
		);
	};
	const identity = {
		workspaceId: record.workspaceId,
		conversationSessionId: summary.taskId,
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
		nativeSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
		controlSocketPath: summary.codexNativeSessionControlEndpoint?.socketPath ?? null,
	};
	const semanticGuard = buildCodexNativeAgentTurnExecutionSemanticGuard(summary);
	const facets = resolveSessionFacets(summary);
	// forceStop 的非零退出会投影为 error；只复用本次身份切换前已确认的资格及 fork，不重新签发资格。
	if (
		facets.turnOwner === "user" &&
		facets.liveness === "exited" &&
		facets.userTurnKind === "error" &&
		summary.reviewReason === "error" &&
		summary.pid === null &&
		record.status === "restoring_pre_review_conversation" &&
		record.nativeIdentitySwitchStartedAt !== null &&
		record.nativeForkAttemptStartedAt !== null &&
		record.restoredNativeSessionId &&
		record.restoredTranscriptPath &&
		previous?.status === "qualified" &&
		previous.qualification &&
		previous.qualification.observedAtMs <= record.nativeIdentitySwitchStartedAt &&
		JSON.stringify(previous.identity) === JSON.stringify(identity) &&
		identity.nativeSessionId === record.receipt.session_id &&
		summary.agentNativeConversationSessionIdentity?.transcriptPath === record.receipt.transcript_path &&
		blockingConditions.every((condition) => condition === "user_turn_kind_not_review")
	) {
		const latest = await input.assertCurrentGuards();
		if (buildCodexNativeAgentTurnExecutionSemanticGuard(latest) !== semanticGuard) return wait();
		return;
	}
	const transcriptStat = await stat(record.receipt.transcript_path).catch(() => null);
	let ledger: TaskMessageInjectionRecord[] = [];
	let ledgerReadable = true;
	try {
		ledger = await input.readLedger();
	} catch {
		ledgerReadable = false;
	}
	const evidenceFingerprint = computeRvfTextSha256(
		JSON.stringify([
			semanticGuard,
			record.receipt.decision_token,
			record.runId,
			record.handoffSha256,
			blockingConditions,
			transcriptStat && [transcriptStat.size, transcriptStat.mtimeMs, transcriptStat.ctimeMs],
			ledgerReadable,
			ledger.filter((entry) => entry.task_id === record.taskId || entry.task_id === record.conversationSessionId),
		]),
	);
	const sameEvidence = previous?.evidenceFingerprint === evidenceFingerprint;
	let recovery: RvfPreReviewConversationRestoreIdleGateRecovery = sameEvidence
		? { ...previous }
		: {
				status: "waiting_for_runtime_conditions",
				blockingConditions,
				evidenceFingerprint,
				identity,
				evidenceSources: ["runtime_summary"],
				attemptCount: 0,
				lastAttemptAtMs: null,
				nextProbeAtMs: null,
				lastNativeHealthFingerprint: null,
				lastFailureCode: null,
				failedNativeConversationTurnHistoryPageRead: null,
				resumeCondition: "runtime_guards_clear",
				qualification: null,
			};
	const save = async (patch: Partial<RvfPreReviewConversationRestoreIdleGateRecovery>) => {
		recovery = { ...recovery, ...patch };
		if (JSON.stringify(record.preReviewConversationRestoreIdleGateRecovery) === JSON.stringify(recovery)) return;
		await input.save({ preReviewConversationRestoreIdleGateRecovery: recovery });
		record.preReviewConversationRestoreIdleGateRecovery = recovery;
	};
	const hardBlocker =
		blockingConditions.some(
			(condition) =>
				![
					"turn_owner_not_user",
					"user_turn_kind_not_review",
					"current_process_prompt_acceptance_unconfirmed",
				].includes(condition),
		) ||
		(resolveSessionFacets(summary).turnOwner === "user" && resolveSessionFacets(summary).userTurnKind !== "review") ||
		resolveSessionFacets(summary).liveness !== "live";
	if (hardBlocker) {
		await save({
			status: "waiting_for_runtime_conditions",
			qualification: null,
			nextProbeAtMs: null,
			resumeCondition: "runtime_guards_clear",
		});
		return wait();
	}
	let nativeEvidenceAttemptCountBeforeCurrentQuery = recovery.attemptCount;
	const assertCurrentRuntimeGuards = async () => {
		try {
			return await input.assertCurrentGuards();
		} catch (error) {
			if (error instanceof RvfAutomaticCloseoutWaitError)
				await save({
					status: "waiting_for_runtime_conditions",
					qualification: null,
					attemptCount: nativeEvidenceAttemptCountBeforeCurrentQuery,
					nextProbeAtMs: null,
					resumeCondition: "runtime_guards_clear",
				});
			throw error;
		}
	};
	// 草稿等动态条件先于原生补证；条件解除是独立重验边沿，不依赖端点或转录变化。
	await assertCurrentRuntimeGuards();
	if (recovery.status === "waiting_for_runtime_conditions" && recovery.attemptCount >= 3)
		await save({ attemptCount: 0, lastNativeHealthFingerprint: null });
	if (!recovery.qualification && recovery.nextProbeAtMs !== null && Date.now() < recovery.nextProbeAtMs) return wait();
	const readExecution = () =>
		readCodexNativeAgentTurnExecution({ workspaceId: record.workspaceId, summary, observedAtMs: Date.now() });
	const assertUnchanged = async () => {
		const latest = await assertCurrentRuntimeGuards();
		if (buildCodexNativeAgentTurnExecutionSemanticGuard(latest) !== semanticGuard)
			throw new Error("runtime_identity_or_submission_changed");
		const latestStat = await stat(record.receipt.transcript_path).catch(() => null);
		if (
			JSON.stringify(latestStat && [latestStat.size, latestStat.mtimeMs, latestStat.ctimeMs]) !==
				JSON.stringify(transcriptStat && [transcriptStat.size, transcriptStat.mtimeMs, transcriptStat.ctimeMs]) ||
			JSON.stringify(await input.readLedger()) !== JSON.stringify(ledger)
		)
			throw new Error("native_transcript_or_delivery_changed");
	};
	let health: CodexNativeAgentTurnExecutionObservation | null = null;
	const buildNativeReadCapabilityFingerprint = (capability: string) =>
		JSON.stringify([
			nativeHealthFingerprint(health),
			capability,
			...(recovery.failedNativeConversationTurnHistoryPageRead
				? [["failed_history_page", recovery.failedNativeConversationTurnHistoryPageRead.cursor]]
				: []),
		]);
	try {
		// 三次完整补证耗尽后仅探测轻量健康；能力或原生回合变化才重新开放完整查询预算。
		if (!recovery.qualification && recovery.attemptCount >= 3) {
			health = await readExecution();
			let fullMessageReadCapability = "unavailable";
			const failedHistoryPageRead = recovery.failedNativeConversationTurnHistoryPageRead;
			if (isStrictlyCompletedNativeTurn(health) && summary.codexNativeSessionControlEndpoint) {
				try {
					await withRunningCodexAppServerControlSocketConnection(
						async (port) => {
							if (failedHistoryPageRead) {
								await readCodexConversationTurnHistoryPage(
									port,
									record.receipt.session_id,
									failedHistoryPageRead.cursor,
								);
								return;
							}
							z.object({
								data: z.array(z.object({ id: z.string(), items: z.array(z.unknown()) })).min(1),
							}).parse(
								await port.request("thread/turns/list", {
									threadId: record.receipt.session_id,
									cursor: null,
									limit: 1,
									sortDirection: "desc",
									itemsView: "full",
								}),
							);
						},
						{ socketPath: summary.codexNativeSessionControlEndpoint.socketPath, requestTimeoutMs: 2_000 },
					);
					fullMessageReadCapability = "ready";
				} catch {
					/* 仅记录能力不可用，继续保留机器等待。 */
				}
			}
			if (failedHistoryPageRead)
				await save({
					failedNativeConversationTurnHistoryPageRead: {
						...failedHistoryPageRead,
						lastCapabilityProbeAtMs: Date.now(),
						lastCapabilityProbeStatus: fullMessageReadCapability === "ready" ? "ready" : "unavailable",
					},
				});
			await assertUnchanged();
			const fingerprint = buildNativeReadCapabilityFingerprint(fullMessageReadCapability);
			if (
				fingerprint === recovery.lastNativeHealthFingerprint ||
				!isStrictlyCompletedNativeTurn(health) ||
				fullMessageReadCapability !== "ready"
			) {
				await save({
					status: "waiting_for_evidence_change",
					nextProbeAtMs: Date.now() + 60_000,
					lastNativeHealthFingerprint: fingerprint,
					resumeCondition: "identity_submission_transcript_or_endpoint_changes",
				});
				return wait();
			}
			await save({ attemptCount: 0, lastNativeHealthFingerprint: fingerprint });
		}
		if (!recovery.qualification) {
			nativeEvidenceAttemptCountBeforeCurrentQuery = recovery.attemptCount;
			await save({
				status: "querying_native_evidence",
				attemptCount: recovery.attemptCount + 1,
				lastAttemptAtMs: Date.now(),
				nextProbeAtMs: Date.now() + 15_000,
			});
		}
		health ??= await readExecution();
		if (!isStrictlyCompletedNativeTurn(health)) throw new Error("native_completed_idle_input_ready_not_proven");
		if (!recovery.qualification) {
			if (!ledgerReadable) throw new Error("delivery_ledger_unavailable");
			const endpoint = summary.codexNativeSessionControlEndpoint;
			if (
				!endpoint ||
				summary.agentNativeConversationSessionIdentity?.transcriptPath !== record.receipt.transcript_path
			)
				throw new Error("native_control_identity_unproven");
			const ownership = await withRunningCodexAppServerControlSocketConnection(
				async (port) => {
					await assertCodexNativeConversationLoadedByCurrentHost(port, record.receipt.session_id);
					const turns = await readCodexConversationTurns(port, record.receipt.session_id, {
						onNativeTurnHistoryPageReadFailure: (cursor) =>
							save({
								failedNativeConversationTurnHistoryPageRead: {
									cursor,
									failedAtMs: Date.now(),
									lastCapabilityProbeAtMs: null,
									lastCapabilityProbeStatus: null,
								},
							}),
					});
					if (recovery.failedNativeConversationTurnHistoryPageRead)
						await save({ failedNativeConversationTurnHistoryPageRead: null });
					if (
						turns.at(-1)?.id !== health?.nativeTurnId ||
						turns.at(-1)?.status !== "completed" ||
						turns.some((turn) => turn.status === "inProgress")
					)
						throw new Error("native_active_turn_changed");
					return readPreReviewRestoreNativeMessageOwnership({ record, summary, turns, ledger });
				},
				{ socketPath: endpoint.socketPath, requestTimeoutMs: 2_000, signal: AbortSignal.timeout(10_000) },
			);
			await assertUnchanged();
			const finalHealth = await readExecution();
			if (
				!isStrictlyCompletedNativeTurn(finalHealth) ||
				nativeHealthFingerprint(finalHealth) !== nativeHealthFingerprint(health)
			)
				throw new Error("native_active_turn_changed");
			await assertUnchanged();
			await save({
				status: "qualified",
				qualification: {
					observedAtMs: Date.now(),
					nativeCompletedTurnId: health?.nativeTurnId ?? "",
					acceptedNativeUserMessageId: ownership.nativeUserMessageId,
					acceptedNativeTurnId: ownership.nativeTurnId,
					acceptedPromptSha256: ownership.promptSha256,
					acceptedMessageRecordedAtMs: ownership.recordedAtMs,
					transcriptSha256: ownership.transcriptSha256,
				},
				evidenceSources: ["runtime_summary", "native_control_host", "native_transcript", "delivery_ledger"],
				nextProbeAtMs: null,
				lastFailureCode: null,
			});
		} else {
			if (health?.nativeTurnId !== recovery.qualification.nativeCompletedTurnId)
				throw new Error("native_active_turn_changed");
			await assertUnchanged();
		}
	} catch (error) {
		if (error instanceof RvfAutomaticCloseoutPauseError || error instanceof RvfAutomaticCloseoutWaitError)
			throw error;
		// 不公开原生错误正文（可能包含 prompt），也不把机器查询失败升级为永久暂停。
		const knownCode =
			error instanceof Error && /^[a-z_]+$/u.test(error.message)
				? error.message
				: "native_evidence_query_unavailable";
		await save({
			status: recovery.attemptCount >= 3 ? "waiting_for_evidence_change" : "waiting_for_retry",
			qualification: null,
			lastFailureCode: knownCode,
			lastNativeHealthFingerprint: buildNativeReadCapabilityFingerprint(
				health === null ||
					recovery.failedNativeConversationTurnHistoryPageRead ||
					knownCode === "native_evidence_query_unavailable"
					? "unavailable"
					: "ready",
			),
			nextProbeAtMs: Date.now() + (recovery.attemptCount >= 3 ? 60_000 : 15_000),
			resumeCondition:
				recovery.attemptCount >= 3 ? "identity_submission_transcript_or_endpoint_changes" : "retry_deadline",
		});
		return wait();
	}
}
