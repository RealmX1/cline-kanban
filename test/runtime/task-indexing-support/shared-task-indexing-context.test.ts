import { describe, expect, it } from "vitest";
import type { TaskIndexingMaterial } from "../../../src/core/task-indexing-support-contract";
import { advanceSharedTaskIndexingSnapshot } from "../../../src/task-indexing-support/shared-task-indexing-context";

function material(taskId: string, columnId = "backlog"): TaskIndexingMaterial {
	return {
		taskReference: {
			workUnitType: "kanban_board_card",
			workspaceId: "project",
			taskId,
			taskIncarnationCreatedAtEpochMs: 123,
		},
		projectName: "项目",
		title: `任务 ${taskId}`,
		prompt: "第一段需求。\n\n完整要求。".repeat(100),
		columnId,
		latestNotificationSummaryText: "通知摘要".repeat(100),
		latestHookFinalMessage: null,
		claudeAwaySummary: null,
		missingContextParts: ["claude_away_summary"],
	};
}
function requireTaskMaterialAtIndex(materials: TaskIndexingMaterial[], index: number): TaskIndexingMaterial {
	const material = materials[index];
	if (!material) throw new Error("测试材料缺失");
	return material;
}
const settings = { agentId: "claude" as const, modelId: "model" };
const input = (materials = [material("a"), material("b"), material("c"), material("d")]) => ({
	workspaceId: "project",
	settings,
	instructionVersion: "triage-v1",
	materials,
	now: 1000,
});

describe("共享任务 Context 的快照与追加变化", () => {
	it("排序、查询时间与运行身份不改变 L1–L2 的真实字节", () => {
		const one = advanceSharedTaskIndexingSnapshot(null, input());
		const two = advanceSharedTaskIndexingSnapshot(one.snapshot, {
			...input(),
			materials: input().materials.reverse(),
			now: 2000,
		});
		expect(two.context.levelOneBoardTaskIndexText).toBe(one.context.levelOneBoardTaskIndexText);
		expect(two.context.levelTwoProjectTaskRecapsText).toBe(one.context.levelTwoProjectTaskRecapsText);
		expect(two.context.snapshotFingerprint).toBe(one.context.snapshotFingerprint);
		expect(two.context.rebuildReason).toBeNull();
	});
	it("热缓存时变化追加到 L3，重启载入后不重复追加", () => {
		const one = advanceSharedTaskIndexingSnapshot(null, input());
		const materials = input().materials;
		requireTaskMaterialAtIndex(materials, 0).title = "新标题";
		const two = advanceSharedTaskIndexingSnapshot(one.snapshot, { ...input(materials), now: 2000 });
		expect(two.context.levelOneBoardTaskIndexText).toBe(one.context.levelOneBoardTaskIndexText);
		expect(two.context.levelThreeAppendedChangesText).toContain("新标题");
		const restored = JSON.parse(JSON.stringify(two.snapshot));
		expect(
			advanceSharedTaskIndexingSnapshot(restored, { ...input(materials), now: 3000 }).context
				.levelThreeAppendedChangesText,
		).toBe(two.context.levelThreeAppendedChangesText);
	});
	it("实测缓存下限、指令版本、L3 字节比例分别触发重建", () => {
		const one = advanceSharedTaskIndexingSnapshot(null, input());
		one.snapshot.lastModelRequestAt = 1000;
		expect(
			advanceSharedTaskIndexingSnapshot(one.snapshot, { ...input(), now: 1000 + 55 * 60000 + 1 }).context
				.rebuildReason,
		).toBe("cache_retention_lower_bound_exceeded");
		expect(
			advanceSharedTaskIndexingSnapshot(one.snapshot, { ...input(), instructionVersion: "v2" }).context
				.rebuildReason,
		).toBe("instruction_version_changed");
		const materials = input().materials;
		requireTaskMaterialAtIndex(materials, 0).latestHookFinalMessage = "新增材料".repeat(3000);
		expect(advanceSharedTaskIndexingSnapshot(one.snapshot, input(materials)).context.rebuildReason).toBe(
			"appended_changes_exceed_snapshot_fraction",
		);
	});
	it("仅统计快照后退休的条目，历史 Done 不导致每次重建", () => {
		const materials = input().materials;
		requireTaskMaterialAtIndex(materials, 0).columnId = "trash";
		const one = advanceSharedTaskIndexingSnapshot(null, input(materials));
		expect(advanceSharedTaskIndexingSnapshot(one.snapshot, input(materials)).context.rebuildReason).toBeNull();
		requireTaskMaterialAtIndex(materials, 1).columnId = "trash";
		requireTaskMaterialAtIndex(materials, 2).columnId = "trash";
		expect(advanceSharedTaskIndexingSnapshot(one.snapshot, input(materials)).context.rebuildReason).toBe(
			"retired_entries_exceed_snapshot_fraction",
		);
	});
	it("Codex 不把主会话的同进程 TTL 冒充成无状态调用缓存保证", () => {
		const args = { ...input(), settings: { agentId: "codex" as const, modelId: null } };
		const one = advanceSharedTaskIndexingSnapshot(null, args);
		one.snapshot.lastModelRequestAt = 1000;
		expect(
			advanceSharedTaskIndexingSnapshot(one.snapshot, { ...args, forModelRequest: true }).context.rebuildReason,
		).toBe("new_process_cache_reuse_unproven");
		expect(advanceSharedTaskIndexingSnapshot(one.snapshot, args).context.rebuildReason).toBeNull();
	});
	it("稳定前缀清除材料中的时间、session id 和绝对工作树路径并标记转换", () => {
		const materials = input().materials;
		requireTaskMaterialAtIndex(materials, 0).prompt =
			"位置 /Users/person/.cline/worktrees/abcd1/repo/src/file.ts\nsession_id=5fc9c0e0-9f90-4d45-8e60-df63681047da\n2026-10-20T12:30:40.123Z";
		const { context } = advanceSharedTaskIndexingSnapshot(null, input(materials));
		const prefix = context.levelOneBoardTaskIndexText + context.levelTwoProjectTaskRecapsText;
		expect(prefix).not.toContain("/Users/");
		expect(prefix).not.toContain("5fc9c0e0");
		expect(prefix).not.toContain("2026-10-20");
		expect(context.contextCompleteness.join(" ")).toContain("stable_reference_normalization");
	});
});
