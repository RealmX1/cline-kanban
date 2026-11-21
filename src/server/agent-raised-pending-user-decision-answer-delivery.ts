// 把用户对「agent 发起的待答决策」给出的答案，幂等地送回（可能已被回收、需要重新起来的）会话。
//
// 严格顺序（计划 §7.4，顺序本身是正确性的一部分）：
//   ① 原子写 answer + answerDeliveryState="answer_recorded"，并作废该 task 的回收期限
//      —— **先作废计时，再动进程**，否则「刚恢复起来就被上一轮的陈旧期限杀掉」；
//   ② 恢复 / 新建 agent 会话；
//   ③ 用稳定幂等键投递「原问题 + 用户答案」；
//   ④ 已接受 → delivered；明确未发送 → delivery_failed；其余 → delivery_unconfirmed，只补证。
//
// 幂等由 store 的投递状态机守门：`delivered` 是终态，任何再投递都会被存储层拒绝，
// 所以「重试」永远不会变成「重复送两次」。
import { createHash, randomUUID } from "node:crypto";
import type {
	InjectionLedgerTerminalDeliveryReceipt,
	RuntimeAgentSessionTransport,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import {
	logAgentSessionRetentionInfo,
	logAgentSessionRetentionWarning,
} from "../diagnostics/agent-session-retention-logger";
import {
	type AgentRaisedPendingUserDecisionAnswer,
	type AgentRaisedPendingUserDecisionAnswerDeliveryAttempt,
	confirmAgentRaisedPendingUserDecisionAnswerHandled,
	type PersistedAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecisionAnswer,
	resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession,
	updateAgentRaisedPendingUserDecisionAnswerDeliveryState,
} from "../state/agent-raised-pending-user-decision-store";
import { supersedeAgentSessionRetentionDeadlinesForTask } from "../state/agent-session-reclamation-deadline-store";
import { getThisRuntimeProcessInstanceId } from "../state/runtime-process-instance-heartbeat-registry";
import {
	activePendingUserDecisionAnswerDeliveryAttemptIds,
	isPendingUserDecisionAnswerDefinitelyNotSubmitted,
	type PendingUserDecisionAnswerDeliveryEvidence,
	reconcileAgentRaisedPendingUserDecisionAnswerDelivery,
} from "./agent-raised-pending-user-decision-answer-delivery-reconciliation";

import { buildAgentRaisedPendingUserDecisionAnswerMessage } from "./agent-raised-pending-user-decision-answer-message";

export { buildAgentRaisedPendingUserDecisionAnswerMessage } from "./agent-raised-pending-user-decision-answer-message";

export interface AgentRaisedPendingUserDecisionAnswerTransportReceipt extends InjectionLedgerTerminalDeliveryReceipt {
	failureExplanation?: string;
}

export interface AgentRaisedPendingUserDecisionAnswerDeliveryDependencies {
	ensureTaskSessionReadyForDelivery: (input: {
		workspaceId: string;
		taskId: string;
		sessionTransport: RuntimeAgentSessionTransport;
	}) => Promise<boolean>;
	deliverTaskSessionInput: (input: {
		workspaceId: string;
		taskId: string;
		sessionTransport: RuntimeAgentSessionTransport;
		text: string;
		idempotencyKey: string;
		decisionId: string;
		attemptId: string;
		dispatchIdempotencyKey: string;
		originRuntimeSessionIncarnationId: string | null;
		persistSubmissionContext: (
			context: Partial<AgentRaisedPendingUserDecisionAnswerDeliveryAttempt>,
		) => Promise<void>;
	}) => Promise<boolean | AgentRaisedPendingUserDecisionAnswerTransportReceipt>;
	reconcileDeliveryEvidence?: (
		decision: PersistedAgentRaisedPendingUserDecision,
	) => Promise<PendingUserDecisionAnswerDeliveryEvidence>;
	getSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	now?: () => number;
}

export interface DeliverAgentRaisedPendingUserDecisionAnswerResult {
	ok: boolean;
	delivered: boolean;
	error?: string;
}

export function createAgentRaisedPendingUserDecisionAnswerDelivery(
	dependencies: AgentRaisedPendingUserDecisionAnswerDeliveryDependencies,
) {
	const now = dependencies.now ?? (() => Date.now());
	const reconcile = (input: { workspaceId: string; decisionId: string }) =>
		reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
			...input,
			now: now(),
			readEvidence: dependencies.reconcileDeliveryEvidence,
			getSummary: dependencies.getSummary,
			force: true,
		});

	const attemptDelivery = async (
		workspaceId: string,
		suppliedDecision: PersistedAgentRaisedPendingUserDecision,
	): Promise<boolean> => {
		const decision = await reconcile({ workspaceId, decisionId: suppliedDecision.decisionId });
		if (!decision?.answer || decision.answerHandledConfirmation || decision.status !== "answered") return false;
		if (decision.answerDeliveryState === "delivered") return true;
		if (decision.answerDeliveryState !== "answer_recorded" && decision.answerDeliveryState !== "delivery_failed")
			return false;
		const attemptId = randomUUID();
		const messageIdentity = {
			dispatchIdempotencyKey: `${decision.answerDeliveryIdempotencyKey}:attempt:${attemptId}`,
			answerMessageFormatVersion: 2 as const,
		};
		const text = buildAgentRaisedPendingUserDecisionAnswerMessage(decision, decision.answer, messageIdentity);
		const attempt: AgentRaisedPendingUserDecisionAnswerDeliveryAttempt = {
			attemptId,
			...messageIdentity,
			ownerRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			startedAt: now(),
			submissionPhase: "preparing_session",
			state: "delivery_in_progress",
			promptSha256: createHash("sha256").update(text).digest("hex"),
		};
		activePendingUserDecisionAnswerDeliveryAttemptIds.add(attemptId);
		let submissionMayHaveStarted = false;
		try {
			const claimed = await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(
				workspaceId,
				decision.decisionId,
				{
					answerDeliveryState: "delivery_in_progress",
					updatedAt: now(),
					answerDeliveryAttempt: attempt,
				},
			);
			if (!claimed) return false;
			await supersedeAgentSessionRetentionDeadlinesForTask(workspaceId, decision.taskId, now());
			const persistSubmissionContext = async (
				context: Partial<AgentRaisedPendingUserDecisionAnswerDeliveryAttempt>,
			) => {
				const saved = await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(
					workspaceId,
					decision.decisionId,
					{
						answerDeliveryState: "delivery_in_progress",
						expectedAttemptId: attemptId,
						updatedAt: now(),
						answerDeliveryAttemptPatch: context,
					},
				);
				if (!saved) throw new Error("答案投递尝试已失效，未继续发送");
			};
			let result: boolean | AgentRaisedPendingUserDecisionAnswerTransportReceipt;
			if (
				!(await dependencies.ensureTaskSessionReadyForDelivery({
					workspaceId,
					taskId: decision.taskId,
					sessionTransport: decision.sessionTransport,
				}))
			) {
				result = {
					status: "delivery_failed",
					reason: "no_active_terminal_session",
					failureNote: "无法恢复该任务的 agent 会话运行时",
				};
			} else {
				await persistSubmissionContext({ submissionPhase: "submission_may_have_started" });
				submissionMayHaveStarted = true;
				result = await dependencies.deliverTaskSessionInput({
					workspaceId,
					taskId: decision.taskId,
					sessionTransport: decision.sessionTransport,
					text,
					idempotencyKey: decision.answerDeliveryIdempotencyKey,
					decisionId: decision.decisionId,
					attemptId,
					dispatchIdempotencyKey: attempt.dispatchIdempotencyKey,
					originRuntimeSessionIncarnationId: decision.originRuntimeSessionIncarnationId,
					persistSubmissionContext,
				});
			}
			const receipt: AgentRaisedPendingUserDecisionAnswerTransportReceipt =
				typeof result === "boolean"
					? result
						? { status: "delivered_and_submit_confirmed", reason: null }
						: {
								status: "delivery_failed",
								reason: "no_active_terminal_session",
								failureNote: "投递未完成实际会话写入",
							}
					: result;
			const delivered =
				receipt.status === "delivered_and_submit_confirmed" ||
				receipt.status === "delivered_queued_behind_active_agent_turn";
			const state = delivered
				? "delivered"
				: isPendingUserDecisionAnswerDefinitelyNotSubmitted(receipt)
					? "delivery_failed"
					: "delivery_unconfirmed";
			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, decision.decisionId, {
				answerDeliveryState: state,
				expectedAttemptId: attemptId,
				updatedAt: now(),
				lastAnswerDeliveryFailureReason: delivered
					? null
					: (receipt.failureExplanation ?? receipt.failureNote ?? receipt.reason),
				answerDeliveryAttemptPatch: {
					state,
					submissionPhase: "settled",
					originalReceipt: receipt,
					submissionMayHaveStarted: receipt.submissionMayHaveStarted,
					nextReconciliationAt: delivered ? null : now() + 15_000,
				},
			});
			if (delivered)
				logAgentSessionRetentionInfo(
					`pending-user-decision-delivered workspaceId=${workspaceId} taskId=${decision.taskId}`,
				);
			return delivered;
		} catch (error) {
			const state = submissionMayHaveStarted ? "delivery_unconfirmed" : "delivery_failed";
			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, decision.decisionId, {
				answerDeliveryState: state,
				expectedAttemptId: attemptId,
				updatedAt: now(),
				lastAnswerDeliveryFailureReason: error instanceof Error ? error.message : String(error),
				answerDeliveryAttemptPatch: { state, submissionPhase: "settled", nextReconciliationAt: now() + 15_000 },
			});
			logAgentSessionRetentionWarning(
				`pending-user-decision-delivery-unconfirmed workspaceId=${workspaceId} taskId=${decision.taskId}`,
			);
			return false;
		} finally {
			activePendingUserDecisionAnswerDeliveryAttemptIds.delete(attemptId);
		}
	};

	return {
		reconcileAgentRaisedPendingUserDecisionAnswerDelivery: reconcile,
		async confirmAgentRaisedPendingUserDecisionAnswerHandled(input: { workspaceId: string; decisionId: string }) {
			await reconcile(input);
			const confirmed = await confirmAgentRaisedPendingUserDecisionAnswerHandled(
				input.workspaceId,
				input.decisionId,
				now(),
			);
			return { ok: confirmed !== null, ...(confirmed ? {} : { error: "仍有发送操作未收敛，请等待后再确认处理。" }) };
		},
		async answerPendingUserDecision(input: {
			workspaceId: string;
			decisionId: string;
			selectedOptionIds: string[];
			freeformText: string | null;
			orderedQuestionAnswers?: AgentRaisedPendingUserDecisionAnswer["orderedQuestionAnswers"];
		}): Promise<DeliverAgentRaisedPendingUserDecisionAnswerResult> {
			const existing = resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession(
				await readAgentRaisedPendingUserDecisions(input.workspaceId),
				input.decisionId,
			);
			if (!existing)
				return { ok: false, delivered: false, error: `Pending decision "${input.decisionId}" not found` };
			if (existing.status === "answered")
				return { ok: true, delivered: await attemptDelivery(input.workspaceId, existing) };
			if (existing.status !== "pending")
				return {
					ok: false,
					delivered: false,
					error: `Pending decision "${input.decisionId}" is ${existing.status}`,
				};
			const answeredAt = now();
			const answered = await recordAgentRaisedPendingUserDecisionAnswer(input.workspaceId, existing.decisionId, {
				selectedOptionIds: input.selectedOptionIds,
				freeformText: input.freeformText,
				...(input.orderedQuestionAnswers ? { orderedQuestionAnswers: input.orderedQuestionAnswers } : {}),
				answeredAt,
				answerSource: "kanban_panel",
			});
			if (!answered) return { ok: true, delivered: false };
			await supersedeAgentSessionRetentionDeadlinesForTask(input.workspaceId, answered.taskId, answeredAt);
			return { ok: true, delivered: await attemptDelivery(input.workspaceId, answered) };
		},
		async retryUndeliveredAnswers(workspaceId: string): Promise<number> {
			let delivered = 0;
			for (const decision of await readAgentRaisedPendingUserDecisions(workspaceId)) {
				if (
					decision.status === "answered" &&
					!decision.answerHandledConfirmation &&
					decision.answerDeliveryState !== "delivered"
				)
					if (await attemptDelivery(workspaceId, decision)) delivered++;
			}
			return delivered;
		},
	};
}
