import { describe, expect, it, vi } from "vitest";
import { collectAllProjectsTaskGroupQuerySnapshot } from "../../../src/server/all-projects-task-group-query-snapshot";

describe("全项目分组快照完整性", () => {
	it("逐项目保留读取失败，正常空项目不受影响，并向读取器传入相同时间窗", async () => {
		const loadEntries = vi.fn(async (workspaceId: string, _nowMs: number, _activityHorizonMs: number) => {
			if (workspaceId === "unreadable") throw new Error("看板无法读取");
			return [];
		});
		const result = await collectAllProjectsTaskGroupQuerySnapshot({
			recentDays: 30,
			nowMs: 123,
			projects: ["empty", "unreadable"].map((workspaceId) => ({ workspaceId, repoPath: `/${workspaceId}` })),
			loadEntries,
		});
		expect(result.projects.map((project) => project.taskEntriesReadStatus)).toEqual(["complete", "unavailable"]);
		expect(result.projects[1]).toMatchObject({
			unavailableReason: "看板无法读取",
			crossProjectTaskSwitcherEntries: [],
		});
		expect(loadEntries).toHaveBeenCalledWith("empty", 123, 30 * 24 * 60 * 60_000);
	});
});
