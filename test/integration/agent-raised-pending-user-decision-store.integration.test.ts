// agent 发起的待答用户决策账本：提问即落库、decisionId 幂等、同 task 新决策 supersede 旧的、
// 回收标记、答案原子记录 + 不可覆盖、投递状态机合法迁移（重复投递被存储层拒绝）、
// plan_review 在类型与运行时双重不可构造、上限裁剪、损坏容错、路径遍历拒绝、跨 workspace 聚合。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	agentRaisedPendingUserDecisionKindSchema,
	buildAgentRaisedPendingUserDecisionAnswerDeliveryIdempotencyKey,
	clearAgentRaisedPendingUserDecisions,
	dismissAgentRaisedPendingUserDecision,
	isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition,
	isOpenAgentRaisedPendingUserDecision,
	markAgentRaisedPendingUserDecisionsReclaimed,
	type RecordAgentRaisedPendingUserDecisionInput,
	readAgentRaisedPendingUserDecisions,
	readAllAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	recordAgentRaisedPendingUserDecisionAnswer,
	updateAgentRaisedPendingUserDecisionAnswerDeliveryState,
} from "../../src/state/agent-raised-pending-user-decision-store";
import { getWorkspaceDirectoryPath } from "../../src/state/workspace-state";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const ASKED_AT = 1_700_000_000_000;

function questionInput(
	workspaceId: string,
	overrides: Partial<RecordAgentRaisedPendingUserDecisionInput> = {},
): RecordAgentRaisedPendingUserDecisionInput {
	return {
		decisionId: "claude-tool-use-1",
		taskId: "task-a",
		workspaceId,
		agentId: "claude",
		sessionTransport: "pty_terminal",
		decisionKind: "ordinary_user_question",
		questionMarkdown: "数据访问层用哪种方案？",
		options: [
			{ optionId: "raw-sql", label: "自建 SQL", description: "手写 SQL 与迁移脚本" },
			{ optionId: "orm", label: "用 ORM" },
		],
		allowsFreeformAnswer: true,
		askedAt: ASKED_AT,
		graceDeadlineAt: ASKED_AT + 60 * 60_000,
		originRuntimeSessionIncarnationId: "incarnation-1",
		originTurnSequence: 2,
		sourceHarnessSignal: "claude:AskUserQuestion",
		...overrides,
	};
}

describe.sequential("agent-raised-pending-user-decision-store integration", () => {
	it("提问即落库：正文、结构化选项、来源信号、幂等键", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));

			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records).toHaveLength(1);
			expect(records[0]?.questionMarkdown).toBe("数据访问层用哪种方案？");
			expect(records[0]?.options.map((option) => option.optionId)).toEqual(["raw-sql", "orm"]);
			expect(records[0]?.status).toBe("pending");
			expect(records[0]?.answerDeliveryState).toBe("not_answered");
			expect(records[0]?.reclaimedAt).toBeNull();
			expect(records[0]?.sourceHarnessSignal).toBe("claude:AskUserQuestion");
			expect(records[0]?.answerDeliveryIdempotencyKey).toBe(
				buildAgentRaisedPendingUserDecisionAnswerDeliveryIdempotencyKey("claude-tool-use-1"),
			);
			expect(isOpenAgentRaisedPendingUserDecision(records[0])).toBe(true);
		});
	});

	it("同 decisionId 重复落库幂等（harness 重发同一 hook 不产生第二条）", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { questionMarkdown: "被忽略的改写" }),
			);
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records).toHaveLength(1);
			expect(records[0]?.questionMarkdown).toBe("数据访问层用哪种方案？");
		});
	});

	it("同 task 出现新决策 → 旧 pending 置 superseded 并互链，UI 只呈现最新那条", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					decisionId: "claude-tool-use-2",
					decisionKind: "tool_permission_request",
					questionMarkdown: "agent 请求运行 `rm -rf build/`",
					options: [
						{ optionId: "allow", label: "允许" },
						{ optionId: "deny", label: "拒绝" },
					],
					allowsFreeformAnswer: false,
					sourceHarnessSignal: "claude:PermissionRequest",
					askedAt: ASKED_AT + 1_000,
				}),
			);

			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records).toHaveLength(2);
			const first = records.find((record) => record.decisionId === "claude-tool-use-1");
			const second = records.find((record) => record.decisionId === "claude-tool-use-2");
			expect(first?.status).toBe("superseded");
			expect(first?.supersededByDecisionId).toBe("claude-tool-use-2");
			expect(second?.status).toBe("pending");
			expect(second?.decisionKind).toBe("tool_permission_request");
			// 工具授权是独立种类，不与普通提问混型。
			expect(second?.decisionKind).not.toBe(first?.decisionKind);
		});
	});

	it("plan_review 在运行时与类型上都不可构造（计划审批不做 carry-forward）", async () => {
		expect(agentRaisedPendingUserDecisionKindSchema.safeParse("plan_review").success).toBe(false);
		expect(agentRaisedPendingUserDecisionKindSchema.safeParse("ordinary_user_question").success).toBe(true);
		expect(agentRaisedPendingUserDecisionKindSchema.safeParse("tool_permission_request").success).toBe(true);
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					// @ts-expect-error plan_review 刻意不在 decisionKind 枚举里——类型层面杜绝计划审批冒充普通提问。
					decisionKind: "plan_review",
				}),
			);
			// 写进去的坏值在读侧被 schema 拒绝（fail-open 成空），故绝不会被 UI 当成待答问题重现。
			expect(await readAgentRaisedPendingUserDecisions(workspaceId)).toEqual([]);
		});
	});

	it("会话被回收 → 标 reclaimedAt，但状态仍是 pending（问题还等着人答）", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { decisionId: "other-task", taskId: "task-b" }),
			);

			expect(await markAgentRaisedPendingUserDecisionsReclaimed(workspaceId, "task-a", ASKED_AT + 60 * 60_000)).toBe(
				1,
			);
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			const reclaimed = records.find((record) => record.decisionId === "claude-tool-use-1");
			expect(reclaimed?.reclaimedAt).toBe(ASKED_AT + 60 * 60_000);
			expect(reclaimed?.status).toBe("pending");
			expect(records.find((record) => record.decisionId === "other-task")?.reclaimedAt).toBeNull();

			// 幂等：已标记过的不重复计数。
			expect(await markAgentRaisedPendingUserDecisionsReclaimed(workspaceId, "task-a", ASKED_AT + 99)).toBe(0);
		});
	});

	it("答案原子记录且不可覆盖；已答记录仍算 open 直到确认送达", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));

			const answered = await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, "claude-tool-use-1", {
				selectedOptionIds: ["orm"],
				freeformText: "顺带把迁移也走 ORM",
				answeredAt: ASKED_AT + 500,
			});
			expect(answered?.status).toBe("answered");
			expect(answered?.answerDeliveryState).toBe("answer_recorded");
			expect(answered?.answer?.selectedOptionIds).toEqual(["orm"]);
			expect(isOpenAgentRaisedPendingUserDecision(answered)).toBe(true);

			// 第二次回答被拒（幂等守门第一道），既有答案不被覆盖。
			expect(
				await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, "claude-tool-use-1", {
					selectedOptionIds: ["raw-sql"],
					freeformText: null,
					answeredAt: ASKED_AT + 900,
				}),
			).toBeNull();
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records[0]?.answer?.selectedOptionIds).toEqual(["orm"]);
		});
	});

	it("投递状态机只允许合法迁移；delivered 之后不可再投递（绝不重复送进 agent）", async () => {
		expect(
			isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition("answer_recorded", "delivery_in_progress"),
		).toBe(true);
		expect(
			isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition("delivery_failed", "delivery_in_progress"),
		).toBe(true);
		expect(isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition("delivered", "delivery_in_progress")).toBe(
			false,
		);
		expect(isLegalAgentRaisedPendingUserDecisionAnswerDeliveryTransition("answer_recorded", "delivered")).toBe(false);

		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, "claude-tool-use-1", {
				selectedOptionIds: ["orm"],
				freeformText: null,
				answeredAt: ASKED_AT + 500,
			});

			// answer_recorded → delivered 是非法跳跃，被存储层拒绝。
			expect(
				await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "claude-tool-use-1", {
					answerDeliveryState: "delivered",
					updatedAt: ASKED_AT + 600,
				}),
			).toBeNull();

			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "claude-tool-use-1", {
				answerDeliveryState: "delivery_in_progress",
				updatedAt: ASKED_AT + 700,
			});
			const failed = await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(
				workspaceId,
				"claude-tool-use-1",
				{
					answerDeliveryState: "delivery_failed",
					updatedAt: ASKED_AT + 800,
					lastAnswerDeliveryFailureReason: "会话尚未就绪",
				},
			);
			expect(failed?.lastAnswerDeliveryFailureReason).toBe("会话尚未就绪");

			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "claude-tool-use-1", {
				answerDeliveryState: "delivery_in_progress",
				updatedAt: ASKED_AT + 900,
			});
			const delivered = await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(
				workspaceId,
				"claude-tool-use-1",
				{ answerDeliveryState: "delivered", updatedAt: ASKED_AT + 1_000 },
			);
			expect(delivered?.answerDeliveryState).toBe("delivered");
			expect(isOpenAgentRaisedPendingUserDecision(delivered)).toBe(false);

			// 已送达后任何再投递尝试都被拒绝。
			expect(
				await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "claude-tool-use-1", {
					answerDeliveryState: "delivery_in_progress",
					updatedAt: ASKED_AT + 1_100,
				}),
			).toBeNull();
		});
	});

	it("用户放弃回答 → dismissed 终态，不再重现", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			const dismissed = await dismissAgentRaisedPendingUserDecision(workspaceId, "claude-tool-use-1", ASKED_AT + 10);
			expect(dismissed?.status).toBe("dismissed");
			expect(isOpenAgentRaisedPendingUserDecision(dismissed)).toBe(false);
			expect(
				await dismissAgentRaisedPendingUserDecision(workspaceId, "claude-tool-use-1", ASKED_AT + 20),
			).toBeNull();
		});
	});

	it("上限 200 丢最旧；文件损坏 fail-open；逃逸 workspaces 根被拒", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			for (let index = 0; index < 205; index += 1) {
				await recordAgentRaisedPendingUserDecision(
					workspaceId,
					questionInput(workspaceId, {
						decisionId: `decision-${index}`,
						taskId: `task-${index}`,
						askedAt: ASKED_AT + index,
					}),
				);
			}
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records).toHaveLength(200);
			expect(records.some((record) => record.decisionId === "decision-0")).toBe(false);
			expect(records.some((record) => record.decisionId === "decision-204")).toBe(true);

			await writeFile(
				join(getWorkspaceDirectoryPath(workspaceId), "agent-raised-pending-user-decisions.json"),
				"{ 这不是合法 JSON",
				"utf8",
			);
			await expect(readAgentRaisedPendingUserDecisions(workspaceId)).resolves.toEqual([]);

			await expect(readAgentRaisedPendingUserDecisions("../escaped")).rejects.toThrow(/outside workspaces root/);
		});
	});

	it("readAll 聚合多 workspace，空 workspace 不出现；clear 清空", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const first = await registerIsolatedWorkspace("project-a");
			const second = await registerIsolatedWorkspace("project-b");
			const empty = await registerIsolatedWorkspace("project-c");
			await recordAgentRaisedPendingUserDecision(first.workspaceId, questionInput(first.workspaceId));
			await recordAgentRaisedPendingUserDecision(
				second.workspaceId,
				questionInput(second.workspaceId, { decisionId: "other", taskId: "task-z" }),
			);

			const all = await readAllAgentRaisedPendingUserDecisions();
			expect(all[first.workspaceId]).toHaveLength(1);
			expect(all[second.workspaceId]).toHaveLength(1);
			expect(all[empty.workspaceId]).toBeUndefined();

			await clearAgentRaisedPendingUserDecisions(first.workspaceId);
			expect(await readAgentRaisedPendingUserDecisions(first.workspaceId)).toEqual([]);
		});
	});
});
