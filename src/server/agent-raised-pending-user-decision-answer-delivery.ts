// 把用户对「agent 发起的待答决策」给出的答案，幂等地送回（可能已被回收、需要重新起来的）会话。
//
// 严格顺序（计划 §7.4，顺序本身是正确性的一部分）：
//   ① 原子写 answer + answerDeliveryState="answer_recorded"，并作废该 task 的回收期限
//      —— **先作废计时，再动进程**，否则「刚恢复起来就被上一轮的陈旧期限杀掉」；
//   ② 恢复 / 新建 agent 会话；
//   ③ 用稳定幂等键投递「原问题 + 用户答案」；
//   ④ 成功 → delivered；失败 → delivery_failed + 退避重试。
//
// 幂等由 store 的投递状态机守门：`delivered` 是终态，任何再投递都会被存储层拒绝，
// 所以「重试」永远不会变成「重复送两次」。
import type { RuntimeAgentSessionTransport } from "../core/api-contract";
import {
	logAgentSessionRetentionInfo,
	logAgentSessionRetentionWarning,
} from "../diagnostics/agent-session-retention-logger";
import {
	type AgentRaisedPendingUserDecisionAnswer,
	type PersistedAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecisionAnswer,
	updateAgentRaisedPendingUserDecisionAnswerDeliveryState,
} from "../state/agent-raised-pending-user-decision-store";
import { supersedeAgentSessionRetentionDeadlinesForTask } from "../state/agent-session-reclamation-deadline-store";

// 投递给 agent 的正文。刻意把**原问题**也带上：会话可能已经被回收重启，新活体并不知道
// 「你刚才问了什么」，只发一句「我选 B」它无从对应。
export function buildAgentRaisedPendingUserDecisionAnswerMessage(
	decision: PersistedAgentRaisedPendingUserDecision,
	answer: AgentRaisedPendingUserDecisionAnswer,
): string {
	const selectedLabels = answer.selectedOptionIds
		.map((optionId) => decision.options.find((option) => option.optionId === optionId)?.label ?? optionId)
		.filter((label) => label.length > 0);
	const lines = [
		"你此前向我提出了一个需要我拍板的问题，当时的会话已经结束。这是我的答复：",
		"",
		"原问题：",
		decision.questionMarkdown,
		"",
	];
	if (selectedLabels.length > 0) {
		lines.push(`我的选择：${selectedLabels.join("、")}`);
	}
	const freeformText = answer.freeformText?.trim();
	if (freeformText) {
		lines.push(selectedLabels.length > 0 ? `补充说明：${freeformText}` : `我的答复：${freeformText}`);
	}
	if (selectedLabels.length === 0 && !freeformText) {
		lines.push("我没有选择任何选项，请按你认为最合理的方式继续。");
	}
	lines.push("", "请据此继续。");
	return lines.join("\n");
}

export interface AgentRaisedPendingUserDecisionAnswerDeliveryDependencies {
	// 确保该任务的会话处于可投递状态（必要时先恢复 / 新建），返回是否就绪。
	// 三种 transport 各自的恢复手法不同，故由调用方注入。
	// 语义要求（这一步是整条闭环的承重点）：会话被回收后账本里的 summary 仍在，**光看 summary
	// 存不存在不算就绪判据**——必须真的把运行时（PTY / ACP 连接 / Cline SDK 会话）拉回来，
	// 否则随后的 deliverTaskSessionInput 必然落空、答案永远送不到 agent 手里。
	// 返回 false = 这次恢复不了（答案已 durable 落库，不会丢），交由退避重试。
	ensureTaskSessionReadyForDelivery: (input: {
		workspaceId: string;
		taskId: string;
		sessionTransport: RuntimeAgentSessionTransport;
	}) => Promise<boolean>;
	// 真正把文本送进会话。返回 false = 会话还没准备好（不是错误，稍后重试）。
	deliverTaskSessionInput: (input: {
		workspaceId: string;
		taskId: string;
		sessionTransport: RuntimeAgentSessionTransport;
		text: string;
		idempotencyKey: string;
	}) => Promise<boolean>;
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

	// 已经记下答案、但尚未确认送达的记录：把它推进到 delivered / delivery_failed。
	// 幂等：状态机拒绝任何从 delivered 出发的迁移，故重复调用不会重复送。
	const attemptDelivery = async (
		workspaceId: string,
		decision: PersistedAgentRaisedPendingUserDecision,
	): Promise<boolean> => {
		const answer = decision.answer;
		if (!answer || decision.answerDeliveryState === "delivered") {
			return decision.answerDeliveryState === "delivered";
		}
		const inProgress = await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(
			workspaceId,
			decision.decisionId,
			{
				answerDeliveryState: "delivery_in_progress",
				updatedAt: now(),
			},
		);
		if (!inProgress) {
			// 非法迁移（多半是并发的另一次投递已经在跑）——交给那一次，绝不重复送。
			return false;
		}
		const markFailed = async (reason: string): Promise<boolean> => {
			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, decision.decisionId, {
				answerDeliveryState: "delivery_failed",
				updatedAt: now(),
				lastAnswerDeliveryFailureReason: reason,
			});
			logAgentSessionRetentionWarning(
				`pending-user-decision-delivery-failed workspaceId=${workspaceId} taskId=${decision.taskId} decisionKind=${decision.decisionKind} reason=${reason}`,
			);
			return false;
		};
		try {
			const ready = await dependencies.ensureTaskSessionReadyForDelivery({
				workspaceId,
				taskId: decision.taskId,
				sessionTransport: decision.sessionTransport,
			});
			if (!ready) {
				return await markFailed("无法恢复该任务的 agent 会话运行时");
			}
			const delivered = await dependencies.deliverTaskSessionInput({
				workspaceId,
				taskId: decision.taskId,
				sessionTransport: decision.sessionTransport,
				text: buildAgentRaisedPendingUserDecisionAnswerMessage(decision, answer),
				idempotencyKey: decision.answerDeliveryIdempotencyKey,
			});
			if (!delivered) {
				return await markFailed("投递未被会话接受");
			}
		} catch (error) {
			return await markFailed(error instanceof Error ? error.message : String(error));
		}
		await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, decision.decisionId, {
			answerDeliveryState: "delivered",
			updatedAt: now(),
			lastAnswerDeliveryFailureReason: null,
		});
		logAgentSessionRetentionInfo(
			`pending-user-decision-delivered workspaceId=${workspaceId} taskId=${decision.taskId} decisionKind=${decision.decisionKind}`,
		);
		return true;
	};

	return {
		async answerPendingUserDecision(input: {
			workspaceId: string;
			decisionId: string;
			selectedOptionIds: string[];
			freeformText: string | null;
		}): Promise<DeliverAgentRaisedPendingUserDecisionAnswerResult> {
			const { workspaceId, decisionId } = input;
			const existing = (await readAgentRaisedPendingUserDecisions(workspaceId)).find(
				(decision) => decision.decisionId === decisionId,
			);
			if (!existing) {
				return { ok: false, delivered: false, error: `Pending decision "${decisionId}" not found` };
			}
			if (existing.status === "answered") {
				// 已答过：不覆盖答案，但把「记下了却没送达」的推进一次（幂等重试入口）。
				const delivered = await attemptDelivery(workspaceId, existing);
				return { ok: true, delivered };
			}
			if (existing.status !== "pending") {
				return { ok: false, delivered: false, error: `Pending decision "${decisionId}" is ${existing.status}` };
			}

			const answeredAt = now();
			const answered = await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, decisionId, {
				selectedOptionIds: input.selectedOptionIds,
				freeformText: input.freeformText,
				answeredAt,
			});
			if (!answered) {
				return { ok: false, delivered: false, error: `Pending decision "${decisionId}" could not be answered` };
			}
			// **先作废计时，再动进程**：否则刚恢复起来的新会话可能被上一轮的陈旧期限直接杀掉。
			await supersedeAgentSessionRetentionDeadlinesForTask(workspaceId, answered.taskId, answeredAt);

			const delivered = await attemptDelivery(workspaceId, answered);
			return { ok: true, delivered };
		},

		// 重试入口：把该 workspace 里所有「已记下答案但未送达」的决策再推一次。
		async retryUndeliveredAnswers(workspaceId: string): Promise<number> {
			const decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			let deliveredCount = 0;
			for (const decision of decisions) {
				if (decision.status !== "answered") {
					continue;
				}
				if (
					decision.answerDeliveryState !== "answer_recorded" &&
					decision.answerDeliveryState !== "delivery_failed"
				) {
					continue;
				}
				if (await attemptDelivery(workspaceId, decision)) {
					deliveredCount += 1;
				}
			}
			return deliveredCount;
		},
	};
}
