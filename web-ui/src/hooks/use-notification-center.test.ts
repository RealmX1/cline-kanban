import { describe, expect, it } from "vitest";
import { buildNotificationGroups } from "@/hooks/use-notification-center";
import type { RuntimeNotificationFeedEntry } from "@/runtime/types";

function entry(
	overrides: Partial<RuntimeNotificationFeedEntry> & { taskId: string; triggeredAt: number },
): RuntimeNotificationFeedEntry {
	return {
		id: `${overrides.taskId}:${overrides.triggeredAt}`,
		workspaceId: "ws-a",
		repoName: "repo-a",
		taskTitle: "Task A",
		userTurnKind: "review",
		visitedAt: null,
		isDone: false,
		...overrides,
	};
}

describe("buildNotificationGroups", () => {
	it("按 workspaceId:taskId 分组，组内按 triggeredAt 降序、取最新元数据", () => {
		const groups = buildNotificationGroups({
			"ws-a": [
				entry({ taskId: "t1", triggeredAt: 1, userTurnKind: "review" }),
				entry({ taskId: "t1", triggeredAt: 3, userTurnKind: "question", taskTitle: "Newer title" }),
				entry({ taskId: "t1", triggeredAt: 2 }),
			],
		});
		expect(groups).toHaveLength(1);
		const group = groups[0];
		expect(group?.key).toBe("ws-a:t1");
		expect(group?.entries.map((e) => e.triggeredAt)).toEqual([3, 2, 1]);
		expect(group?.latestTriggeredAt).toBe(3);
		// 元数据取最新条目。
		expect(group?.latestUserTurnKind).toBe("question");
		expect(group?.taskTitle).toBe("Newer title");
	});

	it("hasUnvisited = 组内任一条未读；全部已读则 false", () => {
		const [partiallyRead] = buildNotificationGroups({
			"ws-a": [
				entry({ taskId: "t1", triggeredAt: 1, visitedAt: 100 }),
				entry({ taskId: "t1", triggeredAt: 2, visitedAt: null }),
			],
		});
		expect(partiallyRead?.hasUnvisited).toBe(true);

		const [allRead] = buildNotificationGroups({
			"ws-a": [
				entry({ taskId: "t2", triggeredAt: 1, visitedAt: 100 }),
				entry({ taskId: "t2", triggeredAt: 2, visitedAt: 200 }),
			],
		});
		expect(allRead?.hasUnvisited).toBe(false);
	});

	it("跨 workspace 聚合并按 latestTriggeredAt 降序", () => {
		const groups = buildNotificationGroups({
			"ws-a": [entry({ taskId: "t1", triggeredAt: 5 })],
			"ws-b": [entry({ taskId: "t2", triggeredAt: 10, workspaceId: "ws-b", repoName: "repo-b" })],
		});
		expect(groups.map((g) => g.key)).toEqual(["ws-b:t2", "ws-a:t1"]);
		expect(groups[0]?.repoName).toBe("repo-b");
	});

	it("isDone 取最新条目——供面板过滤 done", () => {
		const [group] = buildNotificationGroups({
			"ws-a": [
				entry({ taskId: "t1", triggeredAt: 1, isDone: false }),
				entry({ taskId: "t1", triggeredAt: 2, isDone: true }),
			],
		});
		expect(group?.isDone).toBe(true);
	});
});
