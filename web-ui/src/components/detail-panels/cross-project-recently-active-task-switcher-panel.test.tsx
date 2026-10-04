import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import {
	collectCrossProjectTaskSwitcherEntriesInProjects,
	collectUnreadHandoffEntryKeysFromNotificationLog,
} from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { resetCrossProjectTaskSwitcherPanelViewContinuity } from "@/stores/cross-project-task-switcher-panel-view-continuity-store";

// 跨项目切换面板（docs/context-cross-project-recently-active-task-switcher.md）的渲染契约：四个区、Running 默认收起、
// Pinned 与下方区重复、点击走宿主的跨项目打开、对非当前项目的卡取消置顶走 runtime。

const setTaskPinboardPinStateOfTaskCardInProject = vi.hoisted(() => vi.fn());
const fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/cross-project-recently-active-task-switcher-query", () => ({
	setTaskPinboardPinStateOfTaskCardInProject,
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon,
}));

const NOW_MS = Date.now();
const DAY_MS = 24 * 60 * 60_000;
const EXTENDED_ACTIVITY_HORIZON_MS = 30 * DAY_MS;

function makeEntry(
	taskId: string,
	overrides: Partial<RuntimeCrossProjectTaskSwitcherEntry> = {},
): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		taskId,
		title: `Title ${taskId}`,
		agentId: "claude",
		createdAt: NOW_MS - 60 * 60_000,
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		turnOwner: null,
		liveness: "none",
		columnId: "review",
		userTurnKind: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		taskDescriptionLastUpdatedAt: NOW_MS - 60_000,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		...overrides,
	};
}

function makeProject(id: string, entries: RuntimeCrossProjectTaskSwitcherEntry[]): RuntimeProjectSummary {
	return {
		id,
		path: `/repos/${id}`,
		name: id,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: entries,
	};
}

function makeHost(
	overrides: Partial<CrossProjectRecentlyActiveTaskSwitcherHostContextValue> = {},
): CrossProjectRecentlyActiveTaskSwitcherHostContextValue {
	return {
		projects: [
			makeProject("project-a", [
				makeEntry("running", { turnOwner: "agent", liveness: "live", lastOutputAt: NOW_MS - 1_000 }),
				makeEntry("warm", {
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					lastMainAgentConversationModelRequestDispatchObservation: {
						observedAtMs: NOW_MS - 5 * 60_000,
						evidenceKind: "post_tool_use_hook_event",
					},
				}),
			]),
			makeProject("project-b", [
				makeEntry("recent", { pinnedToTaskPinboardAt: 1, taskPinboardPinReason: "keep an eye" }),
			]),
		],
		notificationLogByWorkspaceId: {},
		currentProjectId: "project-a",
		isBoardScopeAllProjectsSelected: true,
		focusedTaskInProject: { workspaceId: "project-a", taskId: "warm" },
		onOpenTaskInProject: vi.fn(),
		onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
		onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
		onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.localStorage.clear();
	resetCrossProjectTaskSwitcherPanelViewContinuity();
	setTaskPinboardPinStateOfTaskCardInProject.mockReset();
	setTaskPinboardPinStateOfTaskCardInProject.mockResolvedValue({ taskCardFound: true, boardWasSaved: true });
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockReset();
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue({
		activityHorizonMs: EXTENDED_ACTIVITY_HORIZON_MS,
		projects: [],
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	vi.useRealTimers();
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

function section(name: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(`[data-testid="cross-project-task-switcher-section-${name}"]`);
	if (!element) {
		throw new Error(`section ${name} not rendered`);
	}
	return element;
}

function rowTaskIds(sectionElement: HTMLElement): string[] {
	return [...sectionElement.querySelectorAll<HTMLElement>("[data-cross-project-task-switcher-task-id]")].map(
		(row) => row.dataset.crossProjectTaskSwitcherTaskId ?? "",
	);
}

describe("CrossProjectRecentlyActiveTaskSwitcherPanel", () => {
	it("四个区按归属渲染：Running 默认收起只显示计数，Pinned 与剩余区重复同一任务", () => {
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));

		expect(section("running").textContent).toContain("Running1");
		expect(rowTaskIds(section("running"))).toEqual([]);
		expect(rowTaskIds(section("prompt-cache-warm"))).toEqual(["warm"]);
		expect(section("prompt-cache-warm").textContent).toMatch(/4\dm|5\dm/);
		expect(rowTaskIds(section("pinned"))).toEqual(["recent"]);
		expect(rowTaskIds(section("remaining"))).toEqual(["recent"]);
		// 焦点任务高亮。
		expect(section("prompt-cache-warm").querySelector('[aria-current="true"]')).not.toBeNull();
	});

	it("重挂载（Focus View 左栏 ↔ 跨项目打开的过渡外壳）后保留「显示更早」与滚动位置", async () => {
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue({
			activityHorizonMs: EXTENDED_ACTIVITY_HORIZON_MS,
			projects: [
				{
					workspaceId: "project-b",
					crossProjectTaskSwitcherEntries: [
						makeEntry("older", { taskDescriptionLastUpdatedAt: NOW_MS - 20 * DAY_MS }),
					],
				},
			],
		});
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const showOlderButton = [...section("remaining").querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Show older"),
		);
		await act(async () => {
			showOlderButton?.click();
		});
		expect(rowTaskIds(section("remaining"))).toContain("older");
		const panel = container.querySelector<HTMLElement>(
			'[data-testid="cross-project-recently-active-task-switcher-panel"]',
		);
		if (panel) {
			panel.scrollTop = 120;
			act(() => panel.dispatchEvent(new Event("scroll")));
		}

		act(() => root.render(<div />));
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		expect(rowTaskIds(section("remaining"))).toContain("older");
		expect(
			container.querySelector<HTMLElement>('[data-testid="cross-project-recently-active-task-switcher-panel"]')
				?.scrollTop,
		).toBe(120);
	});

	it("Pinned 区可折叠（默认展开），折叠态落 localStorage", () => {
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const toggle = section("pinned").querySelector<HTMLButtonElement>("button[aria-expanded]");
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		act(() => toggle?.click());

		expect(rowTaskIds(section("pinned"))).toEqual([]);
		expect(section("pinned").textContent).toContain("Pinned1");
		expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed)).toBe("true");
	});

	it("行内三颗时长药丸全部显示（含创建时长），倒计时 tooltip 写明起点与来源", () => {
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const warmRow = section("prompt-cache-warm").querySelector<HTMLElement>(
			'[data-cross-project-task-switcher-task-id="warm"]',
		);
		expect(warmRow?.querySelector('[title^="Created ·"]')).not.toBeNull();
		const countdownTitle = warmRow
			?.querySelector('[title^="Prompt cache expected to expire"]')
			?.getAttribute("title");
		expect(countdownTitle).toContain("Countdown started");
		expect(countdownTitle).toContain("last main-conversation model request");
	});

	it("展开 Running 后列出在跑的任务，展开态落 localStorage", () => {
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const toggle = section("running").querySelector<HTMLButtonElement>("button[aria-expanded]");
		act(() => toggle?.click());

		expect(rowTaskIds(section("running"))).toEqual(["running"]);
		expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded)).toBe("true");
	});

	it("点击行走宿主的跨项目打开，键是 (workspaceId, taskId)", () => {
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const recentRowButton = section("remaining").querySelector<HTMLButtonElement>(
			'[data-cross-project-task-switcher-task-id="recent"] button',
		);
		act(() => recentRowButton?.click());

		expect(host.onOpenTaskInProject).toHaveBeenCalledWith("project-b", "recent");
	});

	it("对非当前项目的卡取消置顶走 runtime；当前项目的卡走浏览器既有链路", async () => {
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const unpinOtherProject = section("pinned").querySelector<HTMLButtonElement>(
			'[aria-label="Unpin from Pinboard"]',
		);
		await act(async () => unpinOtherProject?.click());
		expect(setTaskPinboardPinStateOfTaskCardInProject).toHaveBeenCalledWith("project-b", {
			taskPinboardPinAction: "unpin_task_card",
			taskId: "recent",
		});

		const pinCurrentProject = section("prompt-cache-warm").querySelector<HTMLButtonElement>(
			'[aria-label="Pin to Pinboard"]',
		);
		act(() => pinCurrentProject?.click());
		expect(host.onRequestPinCurrentProjectTaskToTaskPinboard).toHaveBeenCalledWith("warm");
	});

	it("「显示更早」后取消置顶的旧任务不再按快照留在 Pinned；扩展期间随 30 秒 tick 刷新快照，收敛到新状态", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const olderThanBroadcastActivityHorizon = { taskDescriptionLastUpdatedAt: NOW_MS - 20 * DAY_MS };
		const oldPinnedEntry = makeEntry("old-pinned", {
			...olderThanBroadcastActivityHorizon,
			pinnedToTaskPinboardAt: 1,
		});
		const snapshotContaining = (entry: RuntimeCrossProjectTaskSwitcherEntry) => ({
			activityHorizonMs: EXTENDED_ACTIVITY_HORIZON_MS,
			projects: [{ workspaceId: "project-b", crossProjectTaskSwitcherEntries: [entry] }],
		});
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue(
			snapshotContaining(oldPinnedEntry),
		);
		const hostWithBroadcastEntries = (entries: RuntimeCrossProjectTaskSwitcherEntry[]) =>
			makeHost({ projects: [makeProject("project-a", []), makeProject("project-b", entries)] });

		act(() =>
			root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={hostWithBroadcastEntries([oldPinnedEntry])} />),
		);
		const showOlderButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Show older"),
		);
		await act(async () => showOlderButton?.click());
		expect(rowTaskIds(section("pinned"))).toEqual(["old-pinned"]);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledTimes(1);

		// 取消置顶：旧卡滑出广播取景范围，广播里不再有它；快照里它仍是置顶态，不得补回。
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={hostWithBroadcastEntries([])} />));
		expect(container.querySelector('[data-testid="cross-project-task-switcher-section-pinned"]')).toBeNull();
		expect(rowTaskIds(section("remaining"))).toEqual([]);

		// 下一个 tick 重新拉快照：它以未置顶的旧任务身份由快照补回剩余区。
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue(
			snapshotContaining({ ...oldPinnedEntry, pinnedToTaskPinboardAt: null }),
		);
		await act(async () => {
			vi.advanceTimersByTime(30_000);
		});
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[data-testid="cross-project-task-switcher-section-pinned"]')).toBeNull();
		expect(rowTaskIds(section("remaining"))).toEqual(["old-pinned"]);
	});
});

describe("collectCrossProjectTaskSwitcherEntriesInProjects", () => {
	// 超出广播 7 天取景窗、但仍在 30 天扩展窗内的「最后被碰」时刻。
	const OLDER_THAN_BROADCAST_ACTIVITY_HORIZON = { taskDescriptionLastUpdatedAt: NOW_MS - 20 * DAY_MS };

	it("广播条目优先，「显示更早」只补广播取景范围外的旧任务；不可用项目整体剔除", () => {
		const unavailableProject: RuntimeProjectSummary = {
			...makeProject("project-gone", [makeEntry("x")]),
			availability: { status: "unavailable", reason: "project_path_missing" },
		};
		const entries = collectCrossProjectTaskSwitcherEntriesInProjects(
			[makeProject("project-a", [makeEntry("fresh", { title: "fresh title" })]), unavailableProject],
			{
				activityHorizonMs: EXTENDED_ACTIVITY_HORIZON_MS,
				projects: [
					{
						workspaceId: "project-a",
						crossProjectTaskSwitcherEntries: [
							makeEntry("fresh", { title: "stale title" }),
							makeEntry("older", OLDER_THAN_BROADCAST_ACTIVITY_HORIZON),
						],
					},
					{
						workspaceId: "project-gone",
						crossProjectTaskSwitcherEntries: [makeEntry("y", OLDER_THAN_BROADCAST_ACTIVITY_HORIZON)],
					},
				],
			},
			NOW_MS,
		);
		expect(entries.map(({ workspaceId, entry }) => [workspaceId, entry.taskId, entry.title])).toEqual([
			["project-a", "fresh", "fresh title"],
			["project-a", "older", "Title older"],
		]);
	});

	it("快照里落在广播取景范围内却不在广播里的条目已失效（取消置顶 / 移入 Done / 已删除），不按旧状态补回", () => {
		const entries = collectCrossProjectTaskSwitcherEntriesInProjects(
			// 广播里已经没有这些任务：旧置顶卡被取消置顶后滑出取景范围；最近碰过的卡被移入 Done 或删除。
			[makeProject("project-a", [])],
			{
				activityHorizonMs: EXTENDED_ACTIVITY_HORIZON_MS,
				projects: [
					{
						workspaceId: "project-a",
						crossProjectTaskSwitcherEntries: [
							// 快照时是置顶的旧卡（review 列）；此后被取消置顶，或取消置顶并移入 Done。
							makeEntry("unpinned-or-unpinned-and-moved-to-done-since-snapshot", {
								...OLDER_THAN_BROADCAST_ACTIVITY_HORIZON,
								pinnedToTaskPinboardAt: 1,
							}),
							makeEntry("moved-to-done-or-deleted-since-snapshot"),
							makeEntry("agent-holding-turn-at-snapshot-since-deleted", {
								...OLDER_THAN_BROADCAST_ACTIVITY_HORIZON,
								turnOwner: "agent",
								liveness: "live",
							}),
							makeEntry("older-outside-broadcast-activity-scope", OLDER_THAN_BROADCAST_ACTIVITY_HORIZON),
						],
					},
				],
			},
			NOW_MS,
		);
		expect(entries.map(({ entry }) => entry.taskId)).toEqual(["older-outside-broadcast-activity-scope"]);
	});
});

describe("collectUnreadHandoffEntryKeysFromNotificationLog", () => {
	it("只收 visitedAt 为空的条目，键带 workspaceId", () => {
		const keys = collectUnreadHandoffEntryKeysFromNotificationLog({
			"project-a": [
				{ id: "1", workspaceId: "project-a", taskId: "t1", visitedAt: null } as never,
				{ id: "2", workspaceId: "project-a", taskId: "t2", visitedAt: 5 } as never,
			],
		});
		expect([...keys]).toEqual(["project-a:t1"]);
	});
});
