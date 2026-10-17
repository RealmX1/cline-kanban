import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard } from "@/components/board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetLastLoadedOtherProjectTaskCardSnapshotCache } from "@/hooks/use-task-card-snapshot-of-other-project-for-cross-project-task-switcher-row-expansion";
import type {
	RuntimeCrossProjectTaskSwitcherEntry,
	RuntimeInProgressTaskDetail,
	RuntimeProjectSummary,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { resetCrossProjectTaskSwitcherPanelViewContinuity } from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { resetCrossProjectTaskWorktreeGitMetadataStore } from "@/stores/cross-project-task-worktree-git-metadata-store";

// All projects 首页分区列看板（docs/context-cross-project-recently-active-task-switcher.md）的渲染契约：与 Focus View
// 左栏面板同一组分区横排成列且同序、Pinned 全量 / Running 常开、点行走宿主、移动端回落竖排面板、
// 列滚动位置跨重挂载保留。行本身与 hover 原地展开的行为由面板测试覆盖（同一个渲染 hook）。

const isMobileViewportForTest = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => isMobileViewportForTest.value }));
const readTaskCardWithBoardColumnInWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/task-card-action-query", () => ({
	setTaskPinboardPinStateOfTaskCardInWorkspace: vi.fn(),
	readTaskCardWithBoardColumnInWorkspace,
	moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace: vi.fn(),
}));
vi.mock("@/runtime/cross-project-recently-active-task-switcher-query", () => ({
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon: vi.fn(),
}));
const fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/cross-project-task-worktree-git-metadata-query", () => ({
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries,
}));

const NOW_MS = Date.now();

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

function makeLiveAgentInProgressTaskDetail(taskId: string): RuntimeInProgressTaskDetail {
	return {
		taskId,
		title: `Title ${taskId}`,
		agentId: "claude",
		createdAt: NOW_MS - 60 * 60_000,
		lastOutputAt: NOW_MS - 1_000,
		lastSubstantiveOutputAt: NOW_MS - 1_000,
		turnOwner: "agent",
		liveness: "live",
	};
}

function makeProject(
	id: string,
	entries: RuntimeCrossProjectTaskSwitcherEntry[],
	overrides: Partial<RuntimeProjectSummary> = {},
): RuntimeProjectSummary {
	return {
		id,
		path: `/repos/${id}`,
		name: id,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: entries,
		...overrides,
	};
}

function makeHost(
	overrides: Partial<CrossProjectRecentlyActiveTaskSwitcherHostContextValue> = {},
): CrossProjectRecentlyActiveTaskSwitcherHostContextValue {
	return {
		projects: [
			makeProject(
				"project-a",
				[
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
				],
				{
					inProgressTaskDetails: [makeLiveAgentInProgressTaskDetail("running")],
					taskCounts: { backlog: 0, in_progress: 1, review: 2, validation: 0, trash: 0 },
				},
			),
			makeProject("project-b", [
				makeEntry("recent", { pinnedToTaskPinboardAt: 1, taskPinboardPinReason: "keep an eye" }),
				makeEntry("backlog-task", { columnId: "backlog" }),
			]),
		],
		notificationLogByWorkspaceId: {},
		currentProjectId: "project-a",
		isBoardScopeAllProjectsSelected: true,
		focusedTaskInProject: null,
		onOpenTaskInProject: vi.fn(),
		onOpenBacklogTaskEditorInProject: vi.fn(),
		onRequestCreateTaskInBoardScope: vi.fn(),
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
	isMobileViewportForTest.value = false;
	window.localStorage.clear();
	resetCrossProjectTaskSwitcherPanelViewContinuity();
	readTaskCardWithBoardColumnInWorkspace.mockReset();
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockReset();
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockResolvedValue({ tasks: [] });
	resetCrossProjectTaskWorktreeGitMetadataStore();
	resetLastLoadedOtherProjectTaskCardSnapshotCache();
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

function renderBoard(host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue): void {
	act(() =>
		root.render(
			<BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard
				host={host}
				currentProjectTaskCards={null}
				defaultAgentId={null}
			/>,
		),
	);
}

function sectionColumnTestIdSuffixesInOrder(): string[] {
	return [
		...container.querySelectorAll<HTMLElement>('section[data-testid^="cross-project-task-switcher-section-"]'),
	].map((sectionColumn) => sectionColumn.dataset.testid?.replace("cross-project-task-switcher-section-", "") ?? "");
}

function sectionColumnScrollContainer(testIdSuffix: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(
		`[data-testid="cross-project-task-switcher-section-column-scroll-container-${testIdSuffix}"]`,
	);
	if (!element) {
		throw new Error(`section column ${testIdSuffix} not rendered`);
	}
	return element;
}

function rowTaskIds(scope: ParentNode): string[] {
	return [...scope.querySelectorAll<HTMLElement>("[data-cross-project-task-switcher-task-id]")].map(
		(row) => row.dataset.crossProjectTaskSwitcherTaskId ?? "",
	);
}

describe("BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard", () => {
	it("同一组分区横排成列，与 Focus View 同序：Pinned | Running | Cache warm · your turn | Recent", () => {
		renderBoard(makeHost());

		expect(sectionColumnTestIdSuffixesInOrder()).toEqual(["pinned", "running", "prompt-cache-warm", "remaining"]);
		expect(rowTaskIds(sectionColumnScrollContainer("pinned"))).toEqual(["recent"]);
		expect(rowTaskIds(sectionColumnScrollContainer("prompt-cache-warm"))).toEqual(["warm"]);
		expect(rowTaskIds(sectionColumnScrollContainer("running"))).toEqual(["running"]);
		// 行是滚动容器（分区内容容器）的直接子节点：行根节点自带的 first:mt-4 才会作用在紧挨列 header 的首行上。
		const firstRunningRow = sectionColumnScrollContainer("running").querySelector<HTMLElement>(
			"[data-cross-project-task-switcher-task-id]",
		);
		expect(firstRunningRow?.parentElement).toBe(sectionColumnScrollContainer("running"));
		expect(firstRunningRow?.className).toContain("first:mt-4");
	});

	it("没有置顶时 Pinned 列不渲染", () => {
		renderBoard(
			makeHost({
				projects: [makeProject("project-a", [makeEntry("recent")])],
			}),
		);

		expect(sectionColumnTestIdSuffixesInOrder()).toEqual(["running", "prompt-cache-warm", "remaining"]);
	});

	it("Pinned 列全量显示、不折叠；Running 列不读左栏的收起偏好，始终列出行", () => {
		window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded, "false");
		window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed, "true");
		const pinnedTaskIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
		renderBoard(
			makeHost({
				projects: [
					makeProject("project-a", [
						makeEntry("running", { turnOwner: "agent", liveness: "live", lastOutputAt: NOW_MS - 1_000 }),
						...pinnedTaskIds.map((taskId, index) => makeEntry(taskId, { pinnedToTaskPinboardAt: index + 1 })),
					]),
				],
			}),
		);

		expect(rowTaskIds(sectionColumnScrollContainer("pinned"))).toHaveLength(pinnedTaskIds.length);
		expect(sectionColumnScrollContainer("pinned").textContent).not.toContain("more");
		expect(
			container.querySelector('[data-testid="cross-project-task-switcher-section-pinned"] button[aria-expanded]'),
		).toBeNull();
		expect(rowTaskIds(sectionColumnScrollContainer("running"))).toEqual(["running"]);
		expect(
			container.querySelector('[data-testid="cross-project-task-switcher-section-running"] button[aria-expanded]'),
		).toBeNull();
	});

	it("点行走宿主的跨项目打开；backlog 行原地打开编辑对话框", () => {
		const host = makeHost();
		renderBoard(host);

		act(() =>
			sectionColumnScrollContainer("remaining")
				.querySelector<HTMLButtonElement>(
					'[data-cross-project-task-switcher-task-id="recent"] button:not([aria-expanded])',
				)
				?.click(),
		);
		expect(host.onOpenTaskInProject).toHaveBeenCalledWith("project-b", "recent");

		act(() =>
			sectionColumnScrollContainer("remaining")
				.querySelector<HTMLButtonElement>(
					'[data-cross-project-task-switcher-task-id="backlog-task"] button:not([aria-expanded])',
				)
				?.click(),
		);
		expect(host.onOpenBacklogTaskEditorInProject).toHaveBeenCalledWith("project-b", "backlog-task");
		expect(host.onOpenTaskInProject).toHaveBeenCalledTimes(1);
	});

	it("页头：All projects、项目数 · live · 等你处理，Create task 走 Board Scope 建卡", () => {
		const host = makeHost();
		renderBoard(host);

		expect(container.querySelector("h1")?.textContent).toBe("All projects");
		expect(container.querySelector('[data-testid="board-scope-all-projects-home-page-summary"]')?.textContent).toBe(
			"2 projects · 1 live · 2 awaiting you",
		);
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Create task"]')?.click());
		expect(host.onRequestCreateTaskInBoardScope).toHaveBeenCalledTimes(1);
	});

	it("移动端放不下多列：回落竖排的切换面板，页头不重复 Create task", () => {
		isMobileViewportForTest.value = true;
		renderBoard(makeHost());

		expect(sectionColumnTestIdSuffixesInOrder()).toEqual(["pinned", "running", "prompt-cache-warm", "remaining"]);
		expect(
			container.querySelector('[data-testid="cross-project-recently-active-task-switcher-panel"]'),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[data-testid="board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board"]',
			),
		).toBeNull();
		expect(container.querySelectorAll('button[aria-label="Create task"]')).toHaveLength(1);
	});

	it("各列滚动位置互不影响，卸载（进 Focus View）再挂载（Back）后还原", () => {
		renderBoard(makeHost());
		const recentColumnScrollContainer = sectionColumnScrollContainer("remaining");
		recentColumnScrollContainer.scrollTop = 140;
		act(() => recentColumnScrollContainer.dispatchEvent(new Event("scroll")));
		const runningColumnScrollContainer = sectionColumnScrollContainer("running");
		runningColumnScrollContainer.scrollTop = 30;
		act(() => runningColumnScrollContainer.dispatchEvent(new Event("scroll")));

		act(() => root.render(<div />));
		renderBoard(makeHost());

		expect(sectionColumnScrollContainer("remaining").scrollTop).toBe(140);
		expect(sectionColumnScrollContainer("running").scrollTop).toBe(30);
		expect(sectionColumnScrollContainer("prompt-cache-warm").scrollTop).toBe(0);
	});

	it("置顶清空（Pinned 列消失）再出现置顶时，Pinned 列还原记住的滚动位置", () => {
		const makeHostWithPinnedEntryPresence = (hasPinnedEntry: boolean) =>
			makeHost({
				projects: [
					makeProject("project-b", [
						makeEntry("recent", hasPinnedEntry ? { pinnedToTaskPinboardAt: 1 } : {}),
						makeEntry("backlog-task", { columnId: "backlog" }),
					]),
				],
			});
		renderBoard(makeHostWithPinnedEntryPresence(true));
		const pinnedColumnScrollContainer = sectionColumnScrollContainer("pinned");
		pinnedColumnScrollContainer.scrollTop = 90;
		act(() => pinnedColumnScrollContainer.dispatchEvent(new Event("scroll")));

		renderBoard(makeHostWithPinnedEntryPresence(false));
		expect(sectionColumnTestIdSuffixesInOrder()).not.toContain("pinned");

		renderBoard(makeHostWithPinnedEntryPresence(true));
		expect(sectionColumnScrollContainer("pinned").scrollTop).toBe(90);
	});

	it("列里 hover 展开卡上弹出的原始 prompt 弹窗（portal 挂在 body 下、不在列 DOM 里）：在弹窗里按下不收起这一行；真正在列外按下照旧收起", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			act(() =>
				root.render(
					<BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard
						host={makeHost()}
						currentProjectTaskCards={{
							currentProjectDisplayedBoard: {
								columns: [
									{
										id: "review",
										title: "Review",
										cards: [
											{
												id: "warm",
												title: "Warm task from the in-browser board",
												prompt: "Original prompt of the warm task",
												startInPlanMode: false,
												baseRef: "main",
												createdAt: NOW_MS - 60 * 60_000,
												updatedAt: NOW_MS - 60 * 60_000,
											},
										],
									},
								],
							},
							currentProjectTaskSessions: {},
							currentProjectTaskCardActionHandlers: {},
							currentProjectWorkspacePath: "/repos/project-a",
						}}
						defaultAgentId={null}
					/>,
				),
			);
			const queryWarmRow = () =>
				sectionColumnScrollContainer("prompt-cache-warm").querySelector<HTMLElement>(
					'[data-cross-project-task-switcher-task-id="warm"]',
				);
			const warmRowInPlaceExpansionState = () =>
				queryWarmRow()?.dataset.crossProjectTaskSwitcherRowInPlaceExpansionState;
			// hook 只认坐标真的变了的 pointermove；再等过 hover 意图的延时。
			await act(async () =>
				(queryWarmRow()?.querySelector("button") ?? queryWarmRow())?.dispatchEvent(
					new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 137 }),
				),
			);
			await act(async () => {
				vi.advanceTimersByTime(400);
			});
			expect(warmRowInPlaceExpansionState()).toBe("expanded_in_place_by_hover");

			await act(async () =>
				queryWarmRow()?.querySelector<HTMLButtonElement>('[aria-label="View original prompt"]')?.click(),
			);
			const originalPromptDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
			expect(originalPromptDialog?.textContent).toContain("Original prompt of the warm task");
			expect(container.contains(originalPromptDialog)).toBe(false);

			const copyButton = [...(originalPromptDialog?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent?.trim() === "Copy prompt",
			);
			await act(async () => {
				copyButton?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
			});
			expect(warmRowInPlaceExpansionState()).toBe("expanded_in_place_by_hover");
			expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

			await act(async () => {
				document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
			});
			expect(warmRowInPlaceExpansionState()).toBe("compact_row");
		} finally {
			vi.useRealTimers();
		}
	});
});
