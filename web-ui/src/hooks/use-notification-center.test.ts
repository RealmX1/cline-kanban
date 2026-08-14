import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildNotificationEntriesSortedByTriggeredAtDescending,
	buildNotificationGroups,
	type UseNotificationCenterResult,
	useNotificationCenter,
} from "@/hooks/use-notification-center";
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

describe("buildNotificationEntriesSortedByTriggeredAtDescending", () => {
	it("跨 workspace 展平成一条时间流，严格按 triggeredAt 降序", () => {
		const entries = buildNotificationEntriesSortedByTriggeredAtDescending({
			"ws-a": [entry({ taskId: "t1", triggeredAt: 1 }), entry({ taskId: "t1", triggeredAt: 5 })],
			"ws-b": [
				entry({ taskId: "t2", triggeredAt: 3, workspaceId: "ws-b", repoName: "repo-b" }),
				entry({ taskId: "t2", triggeredAt: 9, workspaceId: "ws-b", repoName: "repo-b" }),
			],
		});
		expect(entries.map((e) => e.triggeredAt)).toEqual([9, 5, 3, 1]);
		expect(entries.map((e) => e.repoName)).toEqual(["repo-b", "repo-a", "repo-b", "repo-a"]);
	});

	it("已读条目与 done 组条目一律保留——历史视图要「全部看得见」", () => {
		const entries = buildNotificationEntriesSortedByTriggeredAtDescending({
			"ws-a": [
				entry({ taskId: "t1", triggeredAt: 1, visitedAt: 100 }),
				entry({ taskId: "t2", triggeredAt: 2, isDone: true }),
				entry({ taskId: "t3", triggeredAt: 3, visitedAt: 200, isDone: true }),
			],
		});
		expect(entries.map((e) => e.taskId)).toEqual(["t3", "t2", "t1"]);
	});

	it("同毫秒触发按 id 稳定排序，不随 workspace 遍历顺序抖动", () => {
		const sortedFirstOrder = buildNotificationEntriesSortedByTriggeredAtDescending({
			"ws-a": [entry({ taskId: "t-a", triggeredAt: 7 })],
			"ws-b": [entry({ taskId: "t-b", triggeredAt: 7, workspaceId: "ws-b" })],
		});
		const sortedReversedOrder = buildNotificationEntriesSortedByTriggeredAtDescending({
			"ws-b": [entry({ taskId: "t-b", triggeredAt: 7, workspaceId: "ws-b" })],
			"ws-a": [entry({ taskId: "t-a", triggeredAt: 7 })],
		});
		expect(sortedFirstOrder.map((e) => e.id)).toEqual(["t-a:7", "t-b:7"]);
		expect(sortedReversedOrder.map((e) => e.id)).toEqual(["t-a:7", "t-b:7"]);
	});
});

describe("useNotificationCenter", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let latestResult: UseNotificationCenterResult | null = null;

	type ActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

	function NotificationCenterHookHarness({
		notificationLogByWorkspaceId,
		selectedTaskId,
		onMarkTaskVisited,
	}: {
		notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
		selectedTaskId: string | null;
		onMarkTaskVisited: (workspaceId: string, taskId: string) => void;
	}): null {
		latestResult = useNotificationCenter({
			notificationLogByWorkspaceId,
			selectedTaskId,
			onMarkTaskVisited,
			onClearWorkspace: () => {},
		});
		return null;
	}

	function renderHarness(props: {
		notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
		selectedTaskId: string | null;
		onMarkTaskVisited: (workspaceId: string, taskId: string) => void;
	}): void {
		act(() => {
			root.render(createElement(NotificationCenterHookHarness, props));
		});
	}

	function requireLatestResult(): UseNotificationCenterResult {
		if (!latestResult) {
			throw new Error("Expected useNotificationCenter result.");
		}
		return latestResult;
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestResult = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		}
	});

	it("打开有未读的 task 即自动整组已读，同一选择不重复标记，该 task 来新通知后可再次标记", () => {
		const onMarkTaskVisited = vi.fn();
		renderHarness({
			notificationLogByWorkspaceId: { "ws-a": [entry({ taskId: "t1", triggeredAt: 1 })] },
			selectedTaskId: "t1",
			onMarkTaskVisited,
		});
		expect(onMarkTaskVisited.mock.calls).toEqual([["ws-a", "t1"]]);

		// 同一选择重渲染（快照重建导致的新对象标识）不得再次标记。
		renderHarness({
			notificationLogByWorkspaceId: { "ws-a": [entry({ taskId: "t1", triggeredAt: 1 })] },
			selectedTaskId: "t1",
			onMarkTaskVisited,
		});
		expect(onMarkTaskVisited).toHaveBeenCalledTimes(1);

		// 同一 task 又来新通知（latestTriggeredAt 变化）→ 允许再次自动标记。
		renderHarness({
			notificationLogByWorkspaceId: {
				"ws-a": [entry({ taskId: "t1", triggeredAt: 1 }), entry({ taskId: "t1", triggeredAt: 2 })],
			},
			selectedTaskId: "t1",
			onMarkTaskVisited,
		});
		expect(onMarkTaskVisited.mock.calls).toEqual([
			["ws-a", "t1"],
			["ws-a", "t1"],
		]);
	});

	it("未选中 task 时不自动标记；全部已读的组也不标记", () => {
		const onMarkTaskVisited = vi.fn();
		renderHarness({
			notificationLogByWorkspaceId: {
				"ws-a": [entry({ taskId: "t1", triggeredAt: 1 }), entry({ taskId: "t2", triggeredAt: 2, visitedAt: 50 })],
			},
			selectedTaskId: null,
			onMarkTaskVisited,
		});
		expect(onMarkTaskVisited).not.toHaveBeenCalled();

		renderHarness({
			notificationLogByWorkspaceId: {
				"ws-a": [entry({ taskId: "t1", triggeredAt: 1 }), entry({ taskId: "t2", triggeredAt: 2, visitedAt: 50 })],
			},
			selectedTaskId: "t2",
			onMarkTaskVisited,
		});
		expect(onMarkTaskVisited).not.toHaveBeenCalled();
	});

	it("两个「全部已读」各自与可见范围对齐：面板跳过 done 组，历史含 done 组", () => {
		const onMarkTaskVisited = vi.fn();
		renderHarness({
			notificationLogByWorkspaceId: {
				"ws-a": [
					entry({ taskId: "t-active", triggeredAt: 1 }),
					entry({ taskId: "t-done", triggeredAt: 2, isDone: true }),
				],
			},
			selectedTaskId: null,
			onMarkTaskVisited,
		});

		act(() => {
			requireLatestResult().markAllPanelGroupsVisited();
		});
		expect(onMarkTaskVisited.mock.calls).toEqual([["ws-a", "t-active"]]);
		expect(requireLatestResult().unreadCount).toBe(1);

		onMarkTaskVisited.mockClear();
		act(() => {
			requireLatestResult().markAllHistoryGroupsVisited();
		});
		expect(onMarkTaskVisited.mock.calls).toEqual([
			["ws-a", "t-done"],
			["ws-a", "t-active"],
		]);
	});
});
