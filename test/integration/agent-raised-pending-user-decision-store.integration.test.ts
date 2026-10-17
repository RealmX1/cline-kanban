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
	resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession,
	resolveAgentRaisedUserQuestionFromAgentTerminal,
	saveAgentRaisedPendingUserDecisionAnswerDraft,
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
	it("未提交草稿原样落盘并可重读，保存不记录答案也不改变待答状态", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("draft-project");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			const orderedQuestionAnswers = [
				{ decisionQuestionId: "question-0", selectedOptionIds: ["orm"], freeformText: "  Notes\n保留空白  " },
			];
			await saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, {
				taskId: "task-a",
				decisionId: "claude-tool-use-1",
				orderedQuestionAnswers,
			});
			const [restored] = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(restored?.pendingAnswerDraft?.orderedQuestionAnswers).toEqual(orderedQuestionAnswers);
			expect(restored?.status).toBe("pending");
			expect(restored?.answer).toBeNull();
			expect(restored?.answerDeliveryState).toBe("not_answered");
			await saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, {
				taskId: "task-a",
				decisionId: "claude-tool-use-1",
				orderedQuestionAnswers: [{ decisionQuestionId: "question-0", selectedOptionIds: [], freeformText: "" }],
			});
			expect(
				(await readAgentRaisedPendingUserDecisions(workspaceId))[0]?.pendingAnswerDraft?.orderedQuestionAnswers[0]
					?.freeformText,
			).toBe("");
		});
	});

	it("草稿编辑版本持久化，迟到旧请求与同版本重试不能回滚已确认内容", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("draft-edit-version-project");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			const latestDraftRequest = {
				taskId: "task-a",
				decisionId: "claude-tool-use-1",
				answerDraftEditVersion: 2,
				orderedQuestionAnswers: [
					{ decisionQuestionId: "question-0", selectedOptionIds: ["orm"], freeformText: "最新已确认草稿" },
				],
			};
			await saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, latestDraftRequest);
			for (const answerDraftEditVersion of [1, 2]) {
				const response = await saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, {
					...latestDraftRequest,
					answerDraftEditVersion,
					orderedQuestionAnswers: [
						{ decisionQuestionId: "question-0", selectedOptionIds: [], freeformText: "迟到的旧草稿" },
					],
				});
				expect(response?.pendingAnswerDraft?.answerDraftEditVersion).toBe(2);
				expect(response?.pendingAnswerDraft?.orderedQuestionAnswers).toEqual(
					latestDraftRequest.orderedQuestionAnswers,
				);
			}
			const [restored] = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(restored?.pendingAnswerDraft?.answerDraftEditVersion).toBe(2);
			expect(restored?.pendingAnswerDraft?.orderedQuestionAnswers).toEqual(
				latestDraftRequest.orderedQuestionAnswers,
			);
		});
	});

	it("草稿校验任务归属、问题、选项、单选数量及自由回答权限", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("draft-validation-project");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { allowsFreeformAnswer: false }),
			);
			for (const invalidAnswer of [
				{ decisionQuestionId: "missing", selectedOptionIds: [], freeformText: null },
				{ decisionQuestionId: "question-0", selectedOptionIds: ["missing"], freeformText: null },
				{ decisionQuestionId: "question-0", selectedOptionIds: ["orm", "raw-sql"], freeformText: null },
				{ decisionQuestionId: "question-0", selectedOptionIds: [], freeformText: "禁止的自由回答" },
			]) {
				await expect(
					saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, {
						taskId: "task-a",
						decisionId: "claude-tool-use-1",
						orderedQuestionAnswers: [invalidAnswer],
					}),
				).rejects.toThrow();
			}
			await expect(
				saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, {
					taskId: "other-task",
					decisionId: "claude-tool-use-1",
					orderedQuestionAnswers: [],
				}),
			).rejects.toThrow();
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0]?.pendingAnswerDraft ?? null).toBeNull();
		});
	});

	it("了结问题会清掉草稿，迟到的草稿保存不能复活它", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("draft-closed-project");
			for (const resolution of ["answer", "dismiss", "supersede", "terminal"] as const) {
				const decisionId = `task-a:${resolution}`;
				await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId, { decisionId }));
				const draftRequest = {
					taskId: "task-a",
					decisionId,
					orderedQuestionAnswers: [
						{ decisionQuestionId: "question-0", selectedOptionIds: ["orm"], freeformText: "草稿" },
					],
				};
				await saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, draftRequest);
				if (resolution === "answer") {
					await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, decisionId, {
						selectedOptionIds: ["orm"],
						freeformText: null,
						answeredAt: ASKED_AT + 1,
					});
				} else if (resolution === "dismiss") {
					await dismissAgentRaisedPendingUserDecision(workspaceId, decisionId, ASKED_AT + 1);
				} else if (resolution === "supersede") {
					await recordAgentRaisedPendingUserDecision(
						workspaceId,
						questionInput(workspaceId, { decisionId: `${decisionId}-new`, questionMarkdown: "新问题" }),
					);
				} else {
					await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
						taskId: "task-a",
						resolvedAt: ASKED_AT + 1,
						resolution: {
							decisionSourceId: resolution,
							resolutionKind: "answered_in_agent_terminal",
							answersForQuestions: [
								{ questionText: "数据访问层用哪种方案？", answerText: "用 ORM", notesText: null },
							],
						},
					});
				}
				expect(await saveAgentRaisedPendingUserDecisionAnswerDraft(workspaceId, draftRequest)).toBeNull();
				expect(
					(await readAgentRaisedPendingUserDecisions(workspaceId)).find(
						(record) => record.decisionId === decisionId,
					)?.pendingAnswerDraft,
				).toBeNull();
			}
		});
	});
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

	it("Codex 面板答案与显式取消的关闭事实不会被历史裁剪抹掉", async () => {
		await withIsolatedWorkspaceHome(async (register) => {
			const { workspaceId } = await register("codex-closed-facts");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { decisionId: "codex-panel", taskId: "answered-task", agentId: "codex" }),
			);
			await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, "codex-panel", {
				selectedOptionIds: ["raw-sql"],
				freeformText: null,
				answeredAt: ASKED_AT + 1,
				answerSource: "kanban_panel",
			});
			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "codex-panel", {
				answerDeliveryState: "delivery_in_progress",
				updatedAt: ASKED_AT + 2,
			});
			await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "codex-panel", {
				answerDeliveryState: "delivered",
				updatedAt: ASKED_AT + 3,
			});
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { decisionId: "codex-dismissed", taskId: "dismissed-task", agentId: "codex" }),
			);
			const dismissed = await dismissAgentRaisedPendingUserDecision(workspaceId, "codex-dismissed", ASKED_AT + 4);
			if (!dismissed) throw new Error("取消夹具无效");
			const closureRecords = await readAgentRaisedPendingUserDecisions(workspaceId);
			const ordinaryHistory = Array.from({ length: 205 }, (_, index) => ({
				...dismissed,
				decisionId: `ordinary-${index}`,
				taskId: `ordinary-task-${index}`,
				agentId: "claude",
				sourceHarnessSignal: "claude:AskUserQuestion",
			}));
			await writeFile(
				join(getWorkspaceDirectoryPath(workspaceId), "agent-raised-pending-user-decisions.json"),
				JSON.stringify([...closureRecords, ...ordinaryHistory]),
			);
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { decisionId: "newest", taskId: "newest-task" }),
			);
			const retained = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(retained.find((record) => record.decisionId === "codex-panel")?.answer?.selectedOptionIds).toEqual([
				"raw-sql",
			]);
			expect(retained.find((record) => record.decisionId === "codex-dismissed")?.status).toBe("dismissed");
			expect(retained.some((record) => record.decisionId === "ordinary-0")).toBe(false);
		});
	});

	it("裁剪已了结历史时保留旧待答问题；文件损坏 fail-open；逃逸 workspaces 根被拒", async () => {
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
				if (index > 0)
					await dismissAgentRaisedPendingUserDecision(workspaceId, `decision-${index}`, ASKED_AT + index);
			}
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records).toHaveLength(201);
			expect(records.some((record) => record.decisionId === "decision-0")).toBe(true);
			expect(records.some((record) => record.decisionId === "decision-1")).toBe(false);
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

	it("同一次提问从第二条路径以另一个 id 抵达（正文相同、旧的仍在等答）→ 不新增、不顶掉用户眼前那条", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			const secondObservation = await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					decisionId: "ask-user-question:数据访问层用哪种方案？",
					askedAt: ASKED_AT + 1_500,
				}),
			);
			expect(secondObservation.decisionId).toBe("claude-tool-use-1");
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records).toHaveLength(1);
			expect(records[0]?.status).toBe("pending");
		});
	});

	it("旧数据的一问两记：沿重复链走到仍在等答的那条；正文不同（agent 真问了新问题）则停在原处", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			// 先真实落一条被「不同正文的新问题」顶掉的记录；再把后继改成同正文，模拟新去重上线前
			// 旧版本写下的一问两记（新代码已不会再产生这种数据，只能从文件层构造）。
			await recordAgentRaisedPendingUserDecision(workspaceId, questionInput(workspaceId));
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					decisionId: "claude-tool-use-2",
					questionMarkdown: "另一个问题",
					askedAt: ASKED_AT + 1_000,
				}),
			);
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			// 正文不同：停在原处（superseded），不会被误当成同一次提问。
			expect(
				resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession(records, "claude-tool-use-1")?.decisionId,
			).toBe("claude-tool-use-1");
			const duplicateChainRecords = records.map((record) =>
				record.decisionId === "claude-tool-use-2"
					? { ...record, questionMarkdown: "数据访问层用哪种方案？" }
					: record,
			);
			expect(
				resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession(
					duplicateChainRecords,
					"claude-tool-use-1",
				)?.decisionId,
			).toBe("claude-tool-use-2");
		});
	});

	it("终端作答：按 tool_use_id 了结，标签映射为选项、对不上的记为自由回答，备注保留，视为已送达且不再 open", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					decisionId: "task-a:toolu_1",
					orderedQuestions: [
						{
							decisionQuestionId: "question-0",
							headerMarkdown: null,
							questionMarkdown: "数据访问层用哪种方案？",
							selectionMode: "multiple",
							options: [
								{ optionId: "question-0-option-0", label: "自建 SQL" },
								{ optionId: "question-0-option-1", label: "用 ORM" },
							],
							allowsFreeformAnswer: true,
						},
					],
				}),
			);
			const resolved = await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
				taskId: "task-a",
				resolution: {
					decisionSourceId: "toolu_1",
					resolutionKind: "answered_in_agent_terminal",
					answersForQuestions: [
						{
							questionText: "数据访问层用哪种方案？",
							answerText: "自建 SQL, 用 ORM, 两者混用",
							notesText: "先做读路径",
						},
					],
				},
				resolvedAt: ASKED_AT + 5_000,
			});
			expect(resolved?.status).toBe("answered");
			expect(resolved?.answerDeliveryState).toBe("delivered");
			expect(resolved?.answer?.answerSource).toBe("agent_terminal");
			expect(resolved?.answer?.orderedQuestionAnswers).toEqual([
				{
					decisionQuestionId: "question-0",
					selectedOptionIds: ["question-0-option-0", "question-0-option-1"],
					freeformText: "两者混用",
				},
			]);
			expect(resolved?.answer?.agentTerminalAnswersForQuestions?.[0]?.notesText).toBe("先做读路径");
			expect(isOpenAgentRaisedPendingUserDecision(resolved)).toBe(false);
		});
	});

	it("终端多选里有一个标签本身含「, 」：写入账本时整体识别为该选项，不拆碎成自由回答", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					decisionId: "task-a:toolu_comma",
					orderedQuestions: [
						{
							decisionQuestionId: "question-0",
							headerMarkdown: null,
							questionMarkdown: "数据访问层用哪种方案？",
							selectionMode: "multiple",
							options: [
								{ optionId: "question-0-option-0", label: "读写分离, 带缓存" },
								{ optionId: "question-0-option-1", label: "用 ORM" },
							],
							allowsFreeformAnswer: true,
						},
					],
				}),
			);
			const resolved = await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
				taskId: "task-a",
				resolution: {
					decisionSourceId: "toolu_comma",
					resolutionKind: "answered_in_agent_terminal",
					answersForQuestions: [
						{ questionText: "数据访问层用哪种方案？", answerText: "读写分离, 带缓存, 用 ORM", notesText: null },
					],
				},
				resolvedAt: ASKED_AT + 5_000,
			});
			expect(resolved?.answer?.orderedQuestionAnswers).toEqual([
				{
					decisionQuestionId: "question-0",
					selectedOptionIds: ["question-0-option-0", "question-0-option-1"],
					freeformText: null,
				},
			]);
		});
	});

	it("终端拒答 → dismissed（来源 agent_terminal）；已在面板作答的记录不被随后为投递发出的 Esc 拒答冲掉", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { decisionId: "task-a:toolu_1" }),
			);
			const declineResolution = {
				decisionSourceId: "toolu_1",
				resolutionKind: "declined_in_agent_terminal" as const,
				answersForQuestions: [{ questionText: "数据访问层用哪种方案？", answerText: null, notesText: null }],
			};
			await recordAgentRaisedPendingUserDecisionAnswer(workspaceId, "task-a:toolu_1", {
				selectedOptionIds: ["orm"],
				freeformText: null,
				answeredAt: ASKED_AT + 1_000,
				answerSource: "kanban_panel",
			});
			expect(
				await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
					taskId: "task-a",
					resolution: declineResolution,
					resolvedAt: ASKED_AT + 2_000,
				}),
			).toBeNull();
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0]?.status).toBe("answered");

			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, {
					decisionId: "task-a:toolu_2",
					questionMarkdown: "第二个问题",
					askedAt: ASKED_AT + 3_000,
				}),
			);
			const declined = await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
				taskId: "task-a",
				resolution: { ...declineResolution, decisionSourceId: "toolu_2" },
				resolvedAt: ASKED_AT + 4_000,
			});
			expect(declined?.status).toBe("dismissed");
			expect(declined?.dismissalSource).toBe("agent_terminal");
		});
	});

	it("结局没有 tool_use_id 时按逐问正文回落匹配；正文对不上则不动任何记录", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await recordAgentRaisedPendingUserDecision(
				workspaceId,
				questionInput(workspaceId, { decisionId: "task-a:toolu_1" }),
			);
			expect(
				await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
					taskId: "task-a",
					resolution: {
						decisionSourceId: null,
						resolutionKind: "answered_in_agent_terminal",
						answersForQuestions: [{ questionText: "别的问题", answerText: "用 ORM", notesText: null }],
					},
					resolvedAt: ASKED_AT + 1_000,
				}),
			).toBeNull();
			const resolved = await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
				taskId: "task-a",
				resolution: {
					decisionSourceId: null,
					resolutionKind: "answered_in_agent_terminal",
					answersForQuestions: [{ questionText: "数据访问层用哪种方案？", answerText: "用 ORM", notesText: null }],
				},
				resolvedAt: ASKED_AT + 2_000,
			});
			expect(resolved?.decisionId).toBe("task-a:toolu_1");
			expect(resolved?.answer?.selectedOptionIds).toEqual(["orm"]);
		});
	});
});
