import { describe, expect, it } from "vitest";
import type {
	RuntimeProjectSummary,
	RuntimeStateStreamSnapshotMessage,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import {
	applyRuntimeStateEntityUpdate,
	buildRuntimeStateEntityUpdate,
} from "../../../src/core/runtime-state-stream-entity-synchronization";

function baseline(): RuntimeStateStreamSnapshotMessage {
	return {
		type: "snapshot",
		currentProjectId: "workspace",
		projects: [
			{
				id: "workspace",
				name: "项目",
				path: "/isolated",
				availability: { status: "available" },
				taskCounts: { backlog: 1, in_progress: 0, review: 0, validation: 0, trash: 0 },
				inProgressTaskDetails: [],
				crossProjectTaskSwitcherEntries: [],
			},
		],
		workspaceState: {
			repoPath: "/isolated",
			statePath: "/isolated/state",
			revision: 1,
			git: { defaultBranch: "main", branches: [], currentBranch: null },
			board: {
				columns: [
					{
						id: "backlog",
						title: "待办",
						cards: [
							{
								id: "task",
								title: "原始",
								prompt: "完整提示词".repeat(1000),
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{ id: "in_progress", title: "执行", cards: [] },
				],
			},
			sessions: {},
		} as RuntimeWorkspaceStateResponse,
		workspaceMetadata: { homeGitSummary: null, homeGitStateVersion: 1, taskWorkspaces: [] },
		notificationLog: [],
	};
}

describe("状态流实体增量", () => {
	it("只传变化实体，卡片移动、顺序及删除重建还原完整状态", () => {
		const previous = baseline();
		const next = structuredClone(previous.workspaceState!);
		next.revision++;
		const card = next.board.columns[0]!.cards.pop()!;
		next.board.columns[1]!.cards.push({ ...card, title: "新实例", createdAt: 2 });
		const update = buildRuntimeStateEntityUpdate(previous, {
			type: "workspace_state_updated",
			workspaceId: "workspace",
			workspaceState: next,
		});
		expect(update).not.toBeNull();
		const restored = applyRuntimeStateEntityUpdate(previous, update!);
		expect(restored.workspaceState).toEqual(next);
		const unchanged = buildRuntimeStateEntityUpdate(restored, {
			type: "workspace_state_updated",
			workspaceId: "workspace",
			workspaceState: next,
		});
		expect(unchanged).toBeNull();
	});
	it("项目基础信息变化不重发跨项目条目", () => {
		const previous = baseline();
		const project = { ...previous.projects[0]!, name: "更名" } as RuntimeProjectSummary;
		const update = buildRuntimeStateEntityUpdate(previous, {
			type: "projects_updated",
			currentProjectId: "workspace",
			projects: [project],
		});
		expect(JSON.stringify(update)).not.toContain("完整提示词");
		expect(applyRuntimeStateEntityUpdate(previous, update!).projects).toEqual([project]);
	});
	it("未知卡片引用与缺少工作区基线拒绝应用", () => {
		const previous = baseline();
		const next = structuredClone(previous.workspaceState!);
		next.revision++;
		const update = buildRuntimeStateEntityUpdate(previous, {
			type: "workspace_state_updated",
			workspaceId: "workspace",
			workspaceState: next,
		})!;
		expect(() => applyRuntimeStateEntityUpdate({ ...previous, workspaceState: null }, update)).toThrow();
	});
});
