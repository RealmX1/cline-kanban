import { describe, expect, it } from "vitest";
import { createDefaultAcpSummary } from "../../../src/acp-client-session/acp-session-state";
import {
	advanceAgentWorkProgress,
	preservePersistedAgentWorkProgressEntriesAgainstStaleSnapshot,
	projectLegacyWorkPhaseGoalIntoExistingProgress,
	resolveAgentWorkProgressEntriesForDisplay,
} from "../../../src/core/agent-work-progress";
import {
	runtimeRecordCurrentTaskProgressRequestSchema,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";

describe("会话进展增量记录", () => {
	it("过期快照不能删除轨迹或撤销已确认结果，同一会话新输入后仍可完成上一条", () => {
		const summary = createDefaultAcpSummary("task-1", "omp");
		const first = advanceAgentWorkProgress(summary, { progressEntryId: "first", progressText: "实现" }, "first", 100);
		const next = advanceAgentWorkProgress(
			{ ...summary, agentWorkProgressEntries: first, agentCurrentWorkPhaseGoalInvalidatedAt: 200 },
			{
				progressEntryId: "next",
				progressText: "验证",
				previousProgressEntryId: "first",
				previousProgressEntryOutcome: "completed",
			},
			"next",
			300,
		);
		expect(next.map((entry) => entry.outcome)).toEqual(["completed", "in_progress"]);
		expect(preservePersistedAgentWorkProgressEntriesAgainstStaleSnapshot(next, first)).toEqual(next);
		expect(preservePersistedAgentWorkProgressEntriesAgainstStaleSnapshot(next, undefined)).toEqual(next);
	});
	it("终态条目无需再制造下一项，旧目标命令进入轨迹但不推断前项成功", () => {
		const summary = createDefaultAcpSummary("task-1", "omp");
		const entries = advanceAgentWorkProgress(
			summary,
			{
				progressEntryId: "finished",
				progressText: "阶段验证完成",
				progressEntryOutcome: "completed",
				outcomeExplanation: "相关回归已通过",
			},
			"finished",
			100,
		);
		expect(entries[0].outcome).toBe("completed");
		expect(entries[0].outcomeExplanation).toBe("相关回归已通过");
		const active = advanceAgentWorkProgress(
			{ ...summary, agentWorkProgressEntries: entries },
			{ progressEntryId: "next", progressText: "下一阶段" },
			"next",
			200,
		);
		const projected = projectLegacyWorkPhaseGoalIntoExistingProgress(
			{ ...summary, agentWorkProgressEntries: active },
			{
				goalText: "兼容入口更新进展",
				source: "agent_explicit_declaration",
				updatedAt: 300,
				owningKanbanTaskConversationSessionId: "task-1",
				owningNativeConversationSessionId: null,
				owningRuntimeSessionIncarnationId: null,
			},
			300,
		);
		expect(projected?.map((entry) => entry.outcome)).toEqual(["completed", "outcome_unknown", "in_progress"]);
	});
	it("完成或放弃上一条，追加新进展，原始条目保留且幂等重试不重复", () => {
		const summary = createDefaultAcpSummary("task-1", "omp");
		const first = { progressEntryId: "phase-1", progressText: "定位输入超限" };
		const entries = advanceAgentWorkProgress(summary, first, "first", 100);
		const next = {
			progressEntryId: "phase-2",
			progressText: "实现分级读取",
			previousProgressEntryId: "phase-1",
			previousProgressEntryOutcome: "completed" as const,
		};
		const updated = advanceAgentWorkProgress({ ...summary, agentWorkProgressEntries: entries }, next, "second", 200);
		expect(entries[0].outcome).toBe("in_progress");
		expect(updated.map((entry) => entry.outcome)).toEqual(["completed", "in_progress"]);
		expect(advanceAgentWorkProgress({ ...summary, agentWorkProgressEntries: updated }, next, "second", 300)).toBe(
			updated,
		);
		expect(() =>
			advanceAgentWorkProgress({ ...summary, agentWorkProgressEntries: updated }, next, "different", 300),
		).toThrow("不同内容");
		const abandoned = advanceAgentWorkProgress(
			{ ...summary, agentWorkProgressEntries: updated },
			{
				progressEntryId: "phase-3",
				progressText: "使用新的方案",
				previousProgressEntryId: "phase-2",
				previousProgressEntryOutcome: "abandoned",
				outcomeExplanation: "原路径不适用",
			},
			"third",
			300,
		);
		expect(abandoned[1]).toMatchObject({ outcome: "abandoned", outcomeExplanation: "原路径不适用" });
		expect(
			runtimeTaskSessionSummarySchema.parse(
				JSON.parse(JSON.stringify({ ...summary, agentWorkProgressEntries: abandoned })),
			).agentWorkProgressEntries,
		).toEqual(abandoned);
	});
	it("新输入或原生身份变化只把旧活动视为历史，不伪造完成，也不修改旁支记录", () => {
		const summary = createDefaultAcpSummary("task-1", "omp");
		const entries = advanceAgentWorkProgress(
			summary,
			{ progressEntryId: "one", progressText: "等待验证" },
			"one",
			100,
		);
		const invalidated = {
			...summary,
			agentWorkProgressEntries: entries,
			agentCurrentWorkPhaseGoalInvalidatedAt: 200,
		};
		expect(resolveAgentWorkProgressEntriesForDisplay(invalidated)[0].isHistorical).toBe(true);
		expect(resolveAgentWorkProgressEntriesForDisplay({ ...invalidated, taskId: "side-session" })).toEqual([]);
		expect(() =>
			advanceAgentWorkProgress(
				{ ...summary, agentWorkProgressEntries: entries },
				{ progressEntryId: "two", progressText: "另一条进展" },
				"two",
				200,
			),
		).toThrow("已变化");
	});
	it("旧阶段目标仅作为结果未记录的历史导入，实施开始要求名称与独立简介", () => {
		const summary = {
			...createDefaultAcpSummary("task-1", "omp"),
			agentCurrentWorkPhaseGoal: {
				goalText: "旧阶段",
				source: "agent_explicit_declaration" as const,
				updatedAt: 10,
				owningKanbanTaskConversationSessionId: "task-1",
				owningNativeConversationSessionId: null,
				owningRuntimeSessionIncarnationId: null,
			},
		};
		expect(
			advanceAgentWorkProgress(summary, { progressEntryId: "new", progressText: "新的进展" }, "new", 100)[0].outcome,
		).toBe("outcome_unknown");
		expect(
			runtimeRecordCurrentTaskProgressRequestSchema.safeParse({
				progressEntryId: "new",
				progressText: "开始实现",
				implementationStarted: true,
			}).success,
		).toBe(false);
		expect(
			runtimeRecordCurrentTaskProgressRequestSchema.safeParse({
				progressEntryId: "new",
				progressText: "开始实现",
				implementationStarted: true,
				taskTitle: "压缩查卡输入",
				taskDescription: "按范围分批召回，再核对候选原文",
				expectedTaskCardUpdatedAt: 1,
			}).success,
		).toBe(true);
	});
});
