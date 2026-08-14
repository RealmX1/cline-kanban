// 待答决策的答案回投：严格顺序（先作废计时再动进程）、幂等（绝不重复送）、
// 会话未就绪时的失败与重试、以及投递正文里带上原问题。
import { describe, expect, it, vi } from "vitest";
import { computeAgentSessionRuntimeReclamationEligibleAt } from "../../src/core/session-activity";
import { createAgentRaisedPendingUserDecisionAnswerDelivery } from "../../src/server/agent-raised-pending-user-decision-answer-delivery";
import {
	type RecordAgentRaisedPendingUserDecisionInput,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
} from "../../src/state/agent-raised-pending-user-decision-store";
import {
	findLiveAgentSessionReclamationDeadlineRecord,
	type RecordAgentSessionRetentionDeadlineInput,
	readAgentSessionReclamationDeadlineRecords,
	recordAgentSessionRetentionDeadline,
} from "../../src/state/agent-session-reclamation-deadline-store";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const ASKED_AT = 1_700_000_000_000;
const DECISION_ID = "task-a:toolu_abc";

function questionInput(workspaceId: string): RecordAgentRaisedPendingUserDecisionInput {
	return {
		decisionId: DECISION_ID,
		taskId: "task-a",
		workspaceId,
		agentId: "claude",
		sessionTransport: "pty_terminal",
		decisionKind: "ordinary_user_question",
		questionMarkdown: "数据访问层用哪种方案？",
		options: [
			{ optionId: "option-0", label: "自建 SQL" },
			{ optionId: "option-1", label: "用 ORM" },
		],
		allowsFreeformAnswer: true,
		askedAt: ASKED_AT,
		graceDeadlineAt: ASKED_AT + 60 * 60_000,
		originRuntimeSessionIncarnationId: "incarnation-1",
		originTurnSequence: 1,
		sourceHarnessSignal: "claude:AskUserQuestion",
	};
}

async function seedLiveDeadline(workspaceId: string): Promise<void> {
	await recordAgentSessionRetentionDeadline(workspaceId, {
		taskId: "task-a",
		agentId: "claude",
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 1,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: ASKED_AT,
		responseGenerationStopSignalConfidence: "harness_turn_complete",
		reclamationEligibleAt: computeAgentSessionRuntimeReclamationEligibleAt(ASKED_AT),
		recordedAt: ASKED_AT,
	} satisfies RecordAgentSessionRetentionDeadlineInput);
}

describe.sequential("agent-raised-pending-user-decision answer delivery", () => {
	it("回答 → 先作废回收期限、再恢复会话、再投递；正文带上原问题与所选项", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			await seedLiveDeadline(workspaceId);

			const callOrder: string[] = [];
			let deliveredText = "";
			const ensureReady = vi.fn(async () => {
				callOrder.push("ensure-ready");
				// 恢复会话这一刻，期限必须已经被作废——否则刚起来的新会话可能被陈旧期限杀掉。
				const records = await readAgentSessionReclamationDeadlineRecords(workspaceId);
				callOrder.push(
					findLiveAgentSessionReclamationDeadlineRecord(records, "task-a") === null
						? "deadline-already-superseded"
						: "deadline-still-live",
				);
				return true;
			});

			const result = await createAgentRaisedPendingUserDecisionAnswerDelivery({
				now: () => ASKED_AT + 1_000,
				ensureTaskSessionReadyForDelivery: ensureReady,
				deliverTaskSessionInput: async ({ text }) => {
					callOrder.push("deliver");
					deliveredText = text;
					return true;
				},
			}).answerPendingUserDecision({
				workspaceId,
				decisionId: DECISION_ID,
				selectedOptionIds: ["option-1"],
				freeformText: "顺带把迁移也走 ORM",
			});

			expect(result).toEqual({ ok: true, delivered: true });
			expect(callOrder).toEqual(["ensure-ready", "deadline-already-superseded", "deliver"]);
			expect(deliveredText).toContain("数据访问层用哪种方案？");
			expect(deliveredText).toContain("自建 SQL");
			expect(deliveredText).toContain("用 ORM");
			expect(deliveredText).toContain("顺带把迁移也走 ORM");

			const decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.status).toBe("answered");
			expect(decisions[0]?.answerDeliveryState).toBe("delivered");
		});
	});

	it("兼容仅带顶层 selectedOptionIds 的旧答案，仍按首问选项映射成人类可读标签", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, {
				...questionInput(workspaceId),
				orderedQuestions: [
					{
						decisionQuestionId: "question-0",
						headerMarkdown: "数据访问",
						questionMarkdown: "数据访问层用哪种方案？",
						selectionMode: "single",
						options: [
							{ optionId: "question-0-option-0", label: "自建 SQL" },
							{ optionId: "question-0-option-1", label: "用 ORM" },
						],
						allowsFreeformAnswer: true,
					},
				],
			});

			let deliveredText = "";
			await createAgentRaisedPendingUserDecisionAnswerDelivery({
				now: () => ASKED_AT + 1_000,
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async ({ text }) => {
					deliveredText = text;
					return true;
				},
			}).answerPendingUserDecision({
				workspaceId,
				decisionId: DECISION_ID,
				selectedOptionIds: ["option-1"],
				freeformText: null,
			});

			expect(deliveredText).toContain("用户选择：用 ORM");
			expect(deliveredText).not.toContain("用户选择：option-1");
		});
	});

	it("重复回答不重复投递（幂等键 + 状态机双重守门）", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			const deliver = vi.fn(async () => true);
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				now: () => ASKED_AT + 1_000,
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: deliver,
			});
			const answer = { workspaceId, decisionId: DECISION_ID, selectedOptionIds: ["option-0"], freeformText: null };

			expect(await delivery.answerPendingUserDecision(answer)).toEqual({ ok: true, delivered: true });
			// 第二次回答：答案不被覆盖，也绝不再送一次。
			expect(await delivery.answerPendingUserDecision({ ...answer, selectedOptionIds: ["option-1"] })).toEqual({
				ok: true,
				delivered: true,
			});
			expect(deliver).toHaveBeenCalledTimes(1);
			const decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.answer?.selectedOptionIds).toEqual(["option-0"]);
		});
	});

	it("会话未就绪 → 答案已 durable 记下、标 delivery_failed，稍后重试送达且只送一次", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));

			let sessionReady = false;
			const deliver = vi.fn(async () => true);
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				now: () => ASKED_AT + 1_000,
				ensureTaskSessionReadyForDelivery: async () => sessionReady,
				deliverTaskSessionInput: deliver,
			});

			const first = await delivery.answerPendingUserDecision({
				workspaceId,
				decisionId: DECISION_ID,
				selectedOptionIds: ["option-0"],
				freeformText: null,
			});
			expect(first).toEqual({ ok: true, delivered: false });
			let decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.status).toBe("answered");
			expect(decisions[0]?.answerDeliveryState).toBe("delivery_failed");
			expect(decisions[0]?.lastAnswerDeliveryFailureReason).toBe("无法恢复该任务的 agent 会话运行时");
			expect(deliver).not.toHaveBeenCalled();

			sessionReady = true;
			expect(await delivery.retryUndeliveredAnswers(workspaceId)).toBe(1);
			decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.answerDeliveryState).toBe("delivered");
			expect(deliver).toHaveBeenCalledTimes(1);

			// 已送达之后再重试是彻底的 no-op。
			expect(await delivery.retryUndeliveredAnswers(workspaceId)).toBe(0);
			expect(deliver).toHaveBeenCalledTimes(1);
		});
	});

	it("实际写入完成前不标 delivered；排队取消后标失败并可由既有入口重试", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));

			let announceFirstPtyWriteAttemptStarted: () => void = () => undefined;
			const firstPtyWriteAttemptStarted = new Promise<void>((resolve) => {
				announceFirstPtyWriteAttemptStarted = resolve;
			});
			let settleFirstPtyWriteAttempt: (writtenToPty: boolean) => void = () => undefined;
			const firstPtyWriteCompletion = new Promise<boolean>((resolve) => {
				settleFirstPtyWriteAttempt = resolve;
			});
			let deliveryAttemptCount = 0;
			const deliver = vi.fn(async () => {
				deliveryAttemptCount += 1;
				if (deliveryAttemptCount === 1) {
					announceFirstPtyWriteAttemptStarted();
					return await firstPtyWriteCompletion;
				}
				return true;
			});
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				now: () => ASKED_AT + 1_000,
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: deliver,
			});

			const pendingAnswer = delivery.answerPendingUserDecision({
				workspaceId,
				decisionId: DECISION_ID,
				selectedOptionIds: ["option-0"],
				freeformText: null,
			});
			await firstPtyWriteAttemptStarted;

			let decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.answerDeliveryState).toBe("delivery_in_progress");

			// 模拟 session-manager 在真实 PTY write 之前因会话退出/投递被取代而把 completion 结算为 false。
			settleFirstPtyWriteAttempt(false);
			expect(await pendingAnswer).toEqual({ ok: true, delivered: false });
			decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.answerDeliveryState).toBe("delivery_failed");

			expect(await delivery.retryUndeliveredAnswers(workspaceId)).toBe(1);
			decisions = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(decisions[0]?.answerDeliveryState).toBe("delivered");
			expect(deliver).toHaveBeenCalledTimes(2);
		});
	});

	it("未选任何选项且无自由文本 → 正文如实说明，不构造假答案", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			let deliveredText = "";
			await createAgentRaisedPendingUserDecisionAnswerDelivery({
				now: () => ASKED_AT + 1_000,
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async ({ text }) => {
					deliveredText = text;
					return true;
				},
			}).answerPendingUserDecision({
				workspaceId,
				decisionId: DECISION_ID,
				selectedOptionIds: [],
				freeformText: null,
			});
			expect(deliveredText).toContain("我没有选择任何选项");
		});
	});

	it("未知 decisionId → 明确报错，不静默成功", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			const result = await createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async () => true,
			}).answerPendingUserDecision({
				workspaceId,
				decisionId: "no-such-decision",
				selectedOptionIds: [],
				freeformText: null,
			});
			expect(result.ok).toBe(false);
			expect(result.delivered).toBe(false);
			expect(result.error).toContain("not found");
		});
	});
});
