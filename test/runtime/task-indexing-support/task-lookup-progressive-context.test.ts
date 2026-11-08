import { describe, expect, it } from "vitest";
import type { TaskIndexingMaterial } from "../../../src/core/task-indexing-support-contract";
import {
	buildTaskLookupScopedOverview,
	partitionTaskLookupItemsWithinByteBudget,
	splitTaskLookupTextWithinByteBudget,
} from "../../../src/task-indexing-support/task-lookup-progressive-context";

function material(taskId: string, workspaceId = "project-a"): TaskIndexingMaterial {
	return {
		taskReference: { workUnitType: "kanban_board_card", workspaceId, taskId, taskIncarnationCreatedAtEpochMs: 1 },
		projectName: workspaceId,
		title: `任务 ${taskId}`,
		prompt: "## TLDR\n\n原始需求首段\n\n原始完整要求不应进入轻索引",
		columnId: "backlog",
		latestNotificationSummaryText: "很长的汇报".repeat(1000),
		latestHookFinalMessage: "完整回合输出".repeat(1000),
		claudeAwaySummary: null,
		missingContextParts: [],
	};
}

describe("查卡范围轻索引与预算分批", () => {
	it("先过滤范围，完整身份仅留在服务端映射，旧卡不回退读取 Initial Prompt", () => {
		const scoped = buildTaskLookupScopedOverview([material("abc12"), material("def34", "project-b")], {
			projectIds: ["project-a"],
			columnIds: ["backlog"],
		});
		expect(scoped.rows).toHaveLength(1);
		expect(scoped.rows[0]).toMatchObject({
			taskId: "abc12",
			taskName: "任务 abc12",
			taskDescriptionSummaryText: "",
			descriptionSource: "task_description_unavailable",
		});
		expect(scoped.materialsByReferenceKey.get(scoped.rows[0].taskReferenceKey)?.taskReference.taskId).toBe("abc12");
		const text = JSON.stringify(scoped.rows);
		expect(text).not.toContain("taskIncarnationCreatedAtEpochMs");
		expect(text).not.toContain("完整回合输出");
		expect(text).not.toContain("原始完整要求");
		expect(text).not.toContain("def34");
	});

	it("任务编号不在概况正文时仍可按编号召回，完整一世身份不进入索引", () => {
		const target = { ...material("abc12"), title: "同名任务", taskDescription: "公共简介" };
		const scoped = buildTaskLookupScopedOverview([target], { projectIds: [], columnIds: [] });
		expect(scoped.rows[0]).toMatchObject({ taskId: "abc12", taskName: "同名任务" });
		expect(JSON.stringify(scoped.rows)).not.toContain("taskIncarnationCreatedAtEpochMs");
	});

	it("中文材料按 UTF-8 字节分批，覆盖每一项且不产生空批次", () => {
		const items = Array.from({ length: 30 }, (_, index) => ({ title: `任务 ${index} ${"说明".repeat(20)}` }));
		const batches = partitionTaskLookupItemsWithinByteBudget(items, 600, JSON.stringify);
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(items);
		for (const batch of batches) {
			expect(batch.length).toBeGreaterThan(0);
			expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(600);
		}
	});

	it("超大单段按 Unicode 字符边界分片，原文可完整还原", () => {
		const original = "中文🙂原文\n".repeat(1000);
		const segments = splitTaskLookupTextWithinByteBudget(original, 512);
		expect(segments.join("")).toBe(original);
		for (const segment of segments) expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(512);
	});
});
