import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel as ProductionCrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { CrossProjectTaskSwitcherRowPromptCacheWarmthPill } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-prompt-cache-warmth-pill";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	collectCrossProjectTaskSwitcherEntriesInProjects,
	collectUnreadHandoffEntryKeysFromNotificationLog,
	useCrossProjectRecentlyActiveTaskSwitcherSections,
} from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import { resetLastLoadedOtherProjectTaskCardSnapshotCache } from "@/hooks/use-task-card-snapshot-of-other-project-for-cross-project-task-switcher-row-expansion";
import type {
	RuntimeCrossProjectTaskSwitcherEntry,
	RuntimeProjectSummary,
	RuntimeTaskWorkspaceMetadata,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { resetCrossProjectTaskSwitcherPanelViewContinuity } from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { resetCrossProjectTaskWorktreeGitMetadataStore } from "@/stores/cross-project-task-worktree-git-metadata-store";
import { clearAllTaskCardActionCommandsInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import { replaceWorkspaceMetadata, resetWorkspaceMetadataStore } from "@/stores/workspace-metadata-store";
import type { BoardColumnId } from "@/types";

function CrossProjectRecentlyActiveTaskSwitcherPanel(
	props: ComponentProps<typeof ProductionCrossProjectRecentlyActiveTaskSwitcherPanel>,
) {
	const sectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({
		projects: props.host.projects,
		notificationLogByWorkspaceId: props.host.notificationLogByWorkspaceId,
		currentProjectId: props.host.currentProjectId,
	});
	return (
		<ProductionCrossProjectRecentlyActiveTaskSwitcherPanel
			{...props}
			host={{ ...props.host, crossProjectTaskSwitcherSectionsModel: sectionsModel }}
		/>
	);
}

// 跨项目切换面板（docs/context-cross-project-recently-active-task-switcher.md）的渲染契约：四个区、Running 默认收起、
// Pinned 与下方区重复、点击走宿主的跨项目打开、对非当前项目的卡取消置顶走 runtime。

const setTaskPinboardPinStateOfTaskCardInWorkspace = vi.hoisted(() => vi.fn());
const readTaskCardWithBoardColumnInWorkspace = vi.hoisted(() => vi.fn());
const fetchTaskWorkspaceInfoForWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/workspace-state-query", () => ({ fetchTaskWorkspaceInfoForWorkspace }));
const moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/task-card-action-query", () => ({
	setTaskPinboardPinStateOfTaskCardInWorkspace,
	readTaskCardWithBoardColumnInWorkspace,
	moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace,
}));
const fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/cross-project-recently-active-task-switcher-query", () => ({
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon,
}));
const fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/cross-project-task-worktree-git-metadata-query", () => ({
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries,
}));

function makeTaskWorkspaceMetadata(
	taskId: string,
	counts: { ahead: number; behind: number; changedFiles: number; additions: number; deletions: number },
): RuntimeTaskWorkspaceMetadata {
	return {
		taskId,
		path: `/worktrees/${taskId}`,
		exists: true,
		baseRef: "main",
		baseCommit: null,
		commitsAheadOfBaseRef: counts.ahead,
		commitsBehindBaseRef: counts.behind,
		workspaceGitStatus: {
			baseRef: "main",
			commitsAheadOfBaseRef: counts.ahead,
			commitsBehindBaseRef: counts.behind,
			taskCommitsIntegratedIntoBaseRef: 0,
			taskCommitIntegrationTrackingStatus: "complete",
			observationSource: "live_worktree",
			observedAt: 1,
		},
		branch: null,
		isDetached: true,
		headCommit: "abc",
		changedFiles: counts.changedFiles,
		additions: counts.additions,
		deletions: counts.deletions,
		stateVersion: 1,
	};
}

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
	setTaskPinboardPinStateOfTaskCardInWorkspace.mockReset();
	setTaskPinboardPinStateOfTaskCardInWorkspace.mockResolvedValue({ boardWasSaved: true });
	readTaskCardWithBoardColumnInWorkspace.mockReset();
	fetchTaskWorkspaceInfoForWorkspace.mockReset();
	fetchTaskWorkspaceInfoForWorkspace.mockResolvedValue({ path: "/Users/test/.cline/worktrees/recent/project-b" });
	moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace.mockReset();
	clearAllTaskCardActionCommandsInFlight();
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockReset();
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue({
		activityHorizonMs: EXTENDED_ACTIVITY_HORIZON_MS,
		projects: [],
	});
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockReset();
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockResolvedValue({ tasks: [] });
	resetCrossProjectTaskWorktreeGitMetadataStore();
	resetWorkspaceMetadataStore();
	resetLastLoadedOtherProjectTaskCardSnapshotCache();
	container = document.createElement("div");
	document.body.appendChild(container);
	// 与真实应用一致：卡片复制按钮的 ID tooltip 在键盘聚焦时也必须可用。
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
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

function rowInPlaceExpansionState(row: HTMLElement | null | undefined): string | undefined {
	return row?.dataset.crossProjectTaskSwitcherRowInPlaceExpansionState;
}

// hook 只认坐标真的变了的 pointermove（同坐标 = 布局 / 滚动把别的行换到了静止的光标下）：每次真实移动换一个坐标。
let lastDispatchedPointerClientY = 100;
function dispatchPointerMoveAtFreshCoordinates(target: Element | null | undefined): void {
	lastDispatchedPointerClientY += 7;
	target?.dispatchEvent(
		new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: lastDispatchedPointerClientY }),
	);
}
function dispatchPointerMoveAtLastCoordinates(target: Element | null | undefined): void {
	target?.dispatchEvent(
		new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: lastDispatchedPointerClientY }),
	);
}

// 指针在一行上真实移动，再等过 hover 意图的延时。展开后的行没有精简行按钮，事件派发到卡片里的第一个按钮或行本身。
async function hoverRowUntilExpandedInPlace(row: HTMLElement | null | undefined): Promise<void> {
	await act(async () => dispatchPointerMoveAtFreshCoordinates(row?.querySelector("button") ?? row));
	await act(async () => {
		vi.advanceTimersByTime(400);
	});
}

// 指针从一行挪到另一行（不离开面板）：React 的 onPointerLeave / onPointerEnter 由 pointerout + relatedTarget 合成。
async function movePointerFromRowToRow(
	fromRow: HTMLElement | null | undefined,
	toRow: HTMLElement | null | undefined,
): Promise<void> {
	const toRowPointerTarget = toRow?.querySelector("button") ?? toRow;
	await act(async () => {
		(fromRow?.querySelector("button") ?? fromRow)?.dispatchEvent(
			new MouseEvent("pointerout", { bubbles: true, relatedTarget: toRowPointerTarget ?? null }),
		);
		dispatchPointerMoveAtFreshCoordinates(toRowPointerTarget);
	});
}

const IN_LIST_EXPANSION_TOGGLE_SELECTOR =
	'[data-testid="cross-project-task-switcher-full-task-card-in-list-expansion-toggle-button"]';

function queryInListExpansionToggle(scope: ParentNode | null | undefined): HTMLButtonElement | null {
	return (
		[...(scope?.querySelectorAll<HTMLButtonElement>(IN_LIST_EXPANSION_TOGGLE_SELECTOR) ?? [])].find(
			(toggle) => toggle.closest("[hidden], [inert]") === null,
		) ?? null
	);
}

// 指针移出一行、也移出面板（relatedTarget 是 body）。
async function movePointerOutOfRow(row: HTMLElement | null | undefined): Promise<void> {
	await act(async () => {
		(row?.querySelector("button") ?? row)?.dispatchEvent(
			new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
		);
	});
}

// 点卡体上非按钮的位置（标题）：走卡壳自己的 onClick。
function clickTaskCardBodyTitle(scope: ParentNode | null | undefined): void {
	const title = scope?.querySelector<HTMLElement>("[data-task-card-title]");
	if (!title) {
		throw new Error("task card body title not rendered");
	}
	title.click();
}

function makeOtherProjectTaskCardSnapshot(
	taskId: string,
	boardColumnIdContainingTaskCard: "backlog" | "in_progress" | "review" | "trash",
) {
	return {
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			taskCard: {
				id: taskId,
				title: `Card title ${taskId}`,
				prompt: `Prompt ${taskId}`,
				startInPlanMode: false,
				baseRef: "main",
				createdAt: NOW_MS - DAY_MS,
				updatedAt: NOW_MS - DAY_MS,
			},
			boardColumnIdContainingTaskCard,
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		},
	};
}

// jsdom 没有 PointerEvent：用同名 MouseEvent 补上 pointerType（React 的合成事件从原生事件上读它）。
function dispatchTouchPointerEvent(target: Element | null | undefined, type: "pointerdown" | "pointerup"): void {
	const touchPointerEvent = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
	Object.defineProperty(touchPointerEvent, "pointerType", { value: "touch" });
	target?.dispatchEvent(touchPointerEvent);
}

// 触屏没有 hover：手指按住精简行等过长按延时原地展开，再抬手（这里不派发 click，抬手后的 click 由用例自己决定）。
async function longPressRowByTouchUntilExpandedInPlace(rowMainButton: HTMLElement | null | undefined): Promise<void> {
	await act(async () => {
		dispatchTouchPointerEvent(rowMainButton, "pointerdown");
	});
	await act(async () => {
		vi.advanceTimersByTime(600);
	});
	await act(async () => {
		dispatchTouchPointerEvent(rowMainButton, "pointerup");
	});
}

function rowTaskIds(sectionElement: HTMLElement): string[] {
	return [...sectionElement.querySelectorAll<HTMLElement>("[data-cross-project-task-switcher-task-id]")].map(
		(row) => row.dataset.crossProjectTaskSwitcherTaskId ?? "",
	);
}

describe("CrossProjectRecentlyActiveTaskSwitcherPanel", () => {
	it("重连任务保留 Running 并显示重连说明，恢复后位置保持不变", () => {
		window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded, "true");
		const renderEntries = (liveness: "retrying" | "live") =>
			act(() =>
				root.render(
					<CrossProjectRecentlyActiveTaskSwitcherPanel
						host={makeHost({
							projects: [
								makeProject("project-a", [
									makeEntry("retrying", {
										turnOwner: "agent",
										liveness,
										agentResponseGenerationTurnStarted: { startedAt: NOW_MS - 2000, turnSequence: 1 },
									}),
									makeEntry("other", {
										turnOwner: "agent",
										liveness: "live",
										agentResponseGenerationTurnStarted: { startedAt: NOW_MS - 1000, turnSequence: 1 },
									}),
								]),
							],
						})}
					/>,
				),
			);
		renderEntries("retrying");
		expect(rowTaskIds(section("running"))).toEqual(["retrying", "other"]);
		expect(section("running").textContent).toContain("重连中");
		expect(rowTaskIds(section("remaining"))).not.toContain("retrying");
		renderEntries("live");
		expect(rowTaskIds(section("running"))).toEqual(["retrying", "other"]);
		expect(section("running").textContent).not.toContain("重连中");
	});

	it("主 Agent 真实处理推导的缓存参考在药丸提示中保留明确的请求时间估计来源", () => {
		act(() =>
			root.render(
				<CrossProjectTaskSwitcherRowPromptCacheWarmthPill
					nowMs={NOW_MS}
					promptCacheWarmthEstimate={{
						promptCacheWarmthAnchorAt: NOW_MS - 100,
						promptCacheExpectedExpiryAt: NOW_MS + 54 * 60_000,
						promptCacheWarmthAnchorSource: "main_agent_conversation_request_processing_cache_reference_estimate",
					}}
				/>,
			),
		);
		expect(container.querySelector("span[title]")?.getAttribute("title")).toContain(
			"主 Agent 真实处理或响应推导的请求时间估计",
		);
	});

	it("统一 Recent 收录近期 Backlog / Validation / Done，并支持阶段并集和 All 重置", () => {
		const host = makeHost({
			projects: [
				makeProject("project-a", [
					makeEntry("pinned-backlog", { columnId: "backlog", pinnedToTaskPinboardAt: 1 }),
					makeEntry("validation", { columnId: "validation" }),
					makeEntry("done", { columnId: "trash" }),
					makeEntry("review", { columnId: "review" }),
					makeEntry("in-progress", { columnId: "in_progress" }),
					makeEntry("old-backlog", { columnId: "backlog", taskDescriptionLastUpdatedAt: NOW_MS - 60 * DAY_MS }),
				]),
			],
		});
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		expect(container.querySelector('[data-testid="cross-project-task-switcher-section-backlog"]')).toBeNull();
		const filters = section("remaining").querySelector('[aria-label="Filter recent tasks by stage"]');
		const filterButton = (label: string) =>
			[...(filters?.querySelectorAll("button") ?? [])].find((button) => button.textContent === label);
		expect(filterButton("In progress / Review")?.getAttribute("aria-pressed")).toBe("true");
		expect(filterButton("All")?.getAttribute("aria-pressed")).toBe("false");
		expect(rowTaskIds(section("remaining"))).toEqual(["in-progress", "review"]);
		act(() => filterButton("All")?.click());
		expect(rowTaskIds(section("remaining"))).toEqual([
			"done",
			"in-progress",
			"pinned-backlog",
			"review",
			"validation",
		]);
		act(() => filterButton("Backlog")?.click());
		expect(rowTaskIds(section("remaining"))).toEqual(["pinned-backlog"]);
		act(() => filterButton("Done")?.click());
		expect(rowTaskIds(section("remaining"))).toEqual(["done", "pinned-backlog"]);
		expect(filterButton("Backlog")?.getAttribute("aria-pressed")).toBe("true");
		expect(filterButton("All")?.getAttribute("aria-pressed")).toBe("false");
		act(() => filterButton("Backlog")?.click());
		expect(rowTaskIds(section("remaining"))).toEqual(["done"]);
		act(() => filterButton("Done")?.click());
		expect(filterButton("All")?.getAttribute("aria-pressed")).toBe("true");
		act(() => filterButton("In progress / Review")?.click());
		expect(rowTaskIds(section("remaining"))).toEqual(["in-progress", "review"]);
		act(() => filterButton("Validation")?.click());
		expect(rowTaskIds(section("remaining"))).toEqual(["in-progress", "review", "validation"]);
		act(() => filterButton("All")?.click());
		expect(rowTaskIds(section("remaining"))).toHaveLength(5);
		expect(rowTaskIds(section("pinned"))).toEqual(["pinned-backlog"]);
	});

	it.each([
		["remaining", "Recent"],
		["prompt-cache-warm", "Cache warm · your turn"],
	])("%s 可独立收起与展开", (sectionName, title) => {
		act(() =>
			root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost({ focusedTaskInProject: null })} />),
		);
		const toggle = section(sectionName).querySelector<HTMLButtonElement>(`button[aria-label="Collapse ${title}"]`);
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		act(() => toggle?.click());
		expect(rowTaskIds(section(sectionName))).toEqual([]);
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		act(() => toggle?.click());
		expect(rowTaskIds(section(sectionName)).length).toBeGreaterThan(0);
	});
	function renderFocusedTask(
		taskId: string,
		columnId: BoardColumnId,
		host = makeHost(),
		fullCardTitle = `完整焦点卡 ${taskId}`,
	) {
		const currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion = {
			currentProjectDisplayedBoard: {
				columns: [
					{
						id: columnId,
						title: columnId,
						cards: [
							{
								id: taskId,
								title: fullCardTitle,
								prompt: "搜索命中的完整任务需求",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: NOW_MS - 60 * DAY_MS,
								updatedAt: NOW_MS - 60 * DAY_MS,
							},
						],
					},
				],
			},
			currentProjectTaskSessions: {},
			currentProjectTaskCardActionHandlers: { onRestoreFromTrashTask: vi.fn() },
			currentProjectWorkspacePath: "/repos/project-a",
		};
		act(() =>
			root.render(
				<CrossProjectRecentlyActiveTaskSwitcherPanel
					host={host}
					currentProjectTaskCards={currentProjectTaskCards}
				/>,
			),
		);
		return currentProjectTaskCards;
	}

	it("Recent 收起时保留 Backlog 焦点任务的唯一定位行，不另造组外副本", () => {
		const host = makeHost({
			projects: [
				makeProject("project-a", [
					makeEntry("focused-backlog", { columnId: "backlog", pinnedToTaskPinboardAt: 1 }),
				]),
			],
			focusedTaskInProject: { workspaceId: "project-a", taskId: "focused-backlog" },
		});
		renderFocusedTask("focused-backlog", "backlog", host);
		act(() =>
			[
				...section("remaining").querySelectorAll<HTMLButtonElement>(
					'[aria-label="Filter recent tasks by stage"] button',
				),
			]
				.find((button) => button.textContent === "All")
				?.click(),
		);
		act(() => section("remaining").querySelector<HTMLButtonElement>('button[aria-label="Collapse Recent"]')?.click());
		expect(section("remaining").querySelector('button[aria-expanded="false"]')).not.toBeNull();
		expect(rowTaskIds(section("remaining"))).toEqual(["focused-backlog"]);
		expect(
			container.querySelectorAll('[data-cross-project-focused-task-scroll-anchor="project-a:focused-backlog"]'),
		).toHaveLength(1);
		expect(section("pinned").querySelector("[data-cross-project-focused-task-scroll-anchor]")).toBeNull();
		expect(container.querySelector("[data-cross-project-focused-task-outside-sections]")).toBeNull();
	});

	it("搜索命中的未置顶 Done 即使完全不在广播里，也从完整 board 展示焦点卡，且不伪造分组成员", () => {
		const host = makeHost({ focusedTaskInProject: { workspaceId: "project-a", taskId: "outside" } });
		const taskCards = renderFocusedTask("outside", "trash", host);
		const fallback = container.querySelector("[data-cross-project-focused-task-outside-sections]");
		expect(fallback?.textContent).toContain("完整焦点卡 outside");
		expect(fallback?.textContent).toContain("Done");
		expect(fallback?.querySelector("[data-task-id]")).toBeNull();
		expect(
			container.querySelectorAll('[data-cross-project-focused-task-scroll-anchor="project-a:outside"]'),
		).toHaveLength(1);
		expect(rowTaskIds(section("remaining"))).not.toContain("outside");
		const restore = fallback?.querySelector<HTMLButtonElement>('button[aria-label="Restore task from done"]');
		act(() => restore?.click());
		expect(taskCards.currentProjectTaskCardActionHandlers.onRestoreFromTrashTask).toHaveBeenCalledWith("outside");
	});

	it.each([
		"most_recent_conversation_progress_only",
		"most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
	])("Recent 模式 %s 排除当前任务时显示独立焦点区，任务正常归组后移除独立区并重绑唯一定位行", (mode) => {
		window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherRemainingSectionOrderingMode, mode);
		const host = makeHost({
			projects: [
				makeProject("project-a", [makeEntry("outside", { taskDescriptionLastUpdatedAt: NOW_MS - 60 * DAY_MS })]),
			],
			focusedTaskInProject: { workspaceId: "project-a", taskId: "outside" },
		});
		renderFocusedTask("outside", "review", host);
		expect(container.querySelector("[data-cross-project-focused-task-outside-sections]")).not.toBeNull();
		renderFocusedTask("outside", "review", {
			...host,
			projects: [
				makeProject("project-a", [
					makeEntry("outside", {
						lastConversationProgressObservation: {
							observedAtMs: NOW_MS,
							evidenceKind: "persisted_agent_transcript",
						},
						lastOpenedByUserAt: NOW_MS,
					}),
				]),
			],
		});
		expect(container.querySelector("[data-cross-project-focused-task-outside-sections]")).toBeNull();
		expect(
			container.querySelectorAll('[data-cross-project-focused-task-scroll-anchor="project-a:outside"]'),
		).toHaveLength(1);
	});

	it("Running 收起时保留当前任务行，不修改收起偏好，优先于重复的 Pinned 行作为定位源", () => {
		const host = makeHost({
			projects: [
				makeProject("project-a", [
					makeEntry("running", {
						turnOwner: "agent",
						liveness: "live",
						lastOutputAt: NOW_MS,
						pinnedToTaskPinboardAt: 1,
					}),
				]),
			],
			focusedTaskInProject: { workspaceId: "project-a", taskId: "running" },
		});
		renderFocusedTask("running", "in_progress", host);
		expect(rowTaskIds(section("running"))).toEqual(["running"]);
		expect(section("running").querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
		expect(section("running").querySelector("[data-cross-project-focused-task-scroll-anchor]")).not.toBeNull();
		expect(section("pinned").querySelector("[data-cross-project-focused-task-scroll-anchor]")).toBeNull();
		expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded)).not.toBe(
			"true",
		);
	});

	it("仅在 Pinned 的焦点卡超出前五条仍保留，收起 Pinned 后只留它且偏好仍为收起", () => {
		const entries = Array.from({ length: 8 }, (_, index) =>
			makeEntry(`pinned-${index}`, {
				columnId: "trash",
				taskDescriptionLastUpdatedAt: NOW_MS - 60 * DAY_MS,
				pinnedToTaskPinboardAt: index + 1,
			}),
		);
		const host = makeHost({
			projects: [makeProject("project-a", entries)],
			focusedTaskInProject: { workspaceId: "project-a", taskId: "pinned-0" },
		});
		renderFocusedTask("pinned-0", "trash", host);
		expect(rowTaskIds(section("pinned"))).toContain("pinned-0");
		expect(rowTaskIds(section("pinned"))).toHaveLength(6);
		act(() => section("pinned").querySelector<HTMLButtonElement>("button[aria-expanded]")?.click());
		expect(rowTaskIds(section("pinned"))).toEqual(["pinned-0"]);
		expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed)).toBe("true");
	});

	it("跨项目在途同号任务绝不拿旧项目 board 充当目标卡，显示目标占位且不创建 Sticky 副本", () => {
		const host = makeHost({
			projects: [makeProject("project-a", []), makeProject("project-b", [])],
			focusedTaskInProject: { workspaceId: "project-b", taskId: "outside" },
		});
		renderFocusedTask("outside", "review", host);
		const fallback = container.querySelector("[data-cross-project-focused-task-outside-sections]");
		expect(fallback).not.toBeNull();
		expect(fallback?.textContent).not.toContain("完整焦点卡 outside");
		expect(fallback?.textContent).toContain("加载");
		expect(container.querySelector("[data-cross-project-focused-task-sticky-edge]")).toBeNull();
	});

	it.each(["running_collapsed", "pinned_collapsed", "pinned_truncated"] as const)(
		"跨项目未水合的 %s 按复合身份保留定位行，水合后升级目标卡且不改折叠偏好",
		async (scenario) => {
			vi.useFakeTimers();
			const targetTaskId = "same-id";
			const targetSection = scenario === "running_collapsed" ? "running" : "pinned";
			const targetColumnId = scenario === "running_collapsed" ? "in_progress" : "trash";
			if (scenario === "pinned_collapsed") {
				window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed, "true");
			}
			const targetEntry = makeEntry(targetTaskId, {
				title: "目标项目的定位任务",
				taskDescriptionLastUpdatedAt: NOW_MS - 60 * DAY_MS,
				columnId: targetColumnId,
				pinnedToTaskPinboardAt: 1,
				...(scenario === "running_collapsed"
					? { turnOwner: "agent" as const, liveness: "live" as const, lastOutputAt: NOW_MS }
					: {}),
			});
			const targetEntries = [
				targetEntry,
				...Array.from({ length: 7 }, (_, index) =>
					makeEntry(`other-pinned-${index}`, { columnId: "trash", pinnedToTaskPinboardAt: index + 2 }),
				),
			];
			const host = makeHost({
				projects: [
					makeProject("project-a", [makeEntry(targetTaskId, { title: "旧项目同号任务" })]),
					makeProject("project-b", targetEntries),
				],
				currentProjectId: "project-a",
				focusedTaskInProject: { workspaceId: "project-b", taskId: targetTaskId },
			});
			const queryTargetAnchor = () =>
				section(targetSection).querySelector<HTMLElement>(
					'[data-cross-project-focused-task-scroll-anchor="project-b:same-id"]',
				);
			const assertCollapsedPreferencesAndUniqueTarget = () => {
				expect(
					container.querySelectorAll('[data-cross-project-focused-task-scroll-anchor="project-b:same-id"]'),
				).toHaveLength(1);
				expect(queryTargetAnchor()?.textContent).toContain("目标项目的定位任务");
				expect(queryTargetAnchor()?.dataset.crossProjectTaskSwitcherWorkspaceId).toBe("project-b");
				expect(container.querySelector("[data-cross-project-focused-task-outside-sections]")).toBeNull();
				if (scenario === "running_collapsed") {
					expect(rowTaskIds(section("running"))).toEqual([targetTaskId]);
					expect(section("running").querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
						"false",
					);
					expect(
						window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded),
					).not.toBe("true");
				} else if (scenario === "pinned_collapsed") {
					expect(rowTaskIds(section("pinned"))).toEqual([targetTaskId]);
					expect(section("pinned").querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
						"false",
					);
					expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed)).toBe(
						"true",
					);
				} else {
					expect(rowTaskIds(section("pinned"))).toHaveLength(6);
					expect(rowTaskIds(section("pinned"))).toContain(targetTaskId);
				}
			};
			act(() =>
				root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} currentProjectTaskCards={null} />),
			);
			assertCollapsedPreferencesAndUniqueTarget();
			expect(
				container.querySelector(
					'[data-task-card-render-role="focused_task_card_copy_in_cross_project_task_switcher"]',
				),
			).toBeNull();

			// 旧项目的同号完整 board 仍在时，不能把它当成目标项目的卡片。
			renderFocusedTask(targetTaskId, "review", host, "旧项目同号完整卡");
			assertCollapsedPreferencesAndUniqueTarget();
			expect(queryTargetAnchor()?.textContent).not.toContain("旧项目同号完整卡");
			expect(
				container.querySelector(
					'[data-task-card-render-role="focused_task_card_copy_in_cross_project_task_switcher"]',
				),
			).toBeNull();

			const hydratedTaskCards = renderFocusedTask(
				targetTaskId,
				targetColumnId,
				{ ...host, currentProjectId: "project-b" },
				"水合后的目标项目完整卡",
			);
			assertCollapsedPreferencesAndUniqueTarget();
			await hoverRowUntilExpandedInPlace(queryTargetAnchor());
			expect(queryTargetAnchor()?.textContent).toContain("水合后的目标项目完整卡");
			expect(queryTargetAnchor()?.textContent).not.toContain("旧项目同号任务");
			if (scenario !== "running_collapsed") {
				act(() =>
					queryTargetAnchor()
						?.querySelector<HTMLButtonElement>('button[aria-label="Restore task from done"]')
						?.click(),
				);
				expect(hydratedTaskCards.currentProjectTaskCardActionHandlers.onRestoreFromTrashTask).toHaveBeenCalledWith(
					targetTaskId,
				);
			}
		},
	);

	it("各区按归属渲染：Running 默认收起只显示计数，Pinned 与剩余区重复同一任务", () => {
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

	it("行内只显示会话时间，创建时间留详情；缓存 tooltip 写明估计起点与来源", () => {
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const warmRow = section("prompt-cache-warm").querySelector<HTMLElement>(
			'[data-cross-project-task-switcher-task-id="warm"]',
		);
		expect(warmRow?.querySelector('[title^="Created ·"]')).toBeNull();
		expect(warmRow?.querySelector("[data-task-conversation-session-activity-details]")).not.toBeNull();
		const countdownTitle = warmRow?.querySelector('[title^="缓存预计过期"]')?.getAttribute("title");
		expect(countdownTitle).toContain("估计起点");
		expect(countdownTitle).toContain("最后一次主对话请求的代理观测（估计）");
	});

	// 用户拍板 B′（2026-10-05）：手动 /compact 后留在 Cache warm，但不显示倒计时，改显示「已压缩」。
	it("手动压缩后的行留在 Cache warm，显示 Compacted 而不是倒计时；harness 报了大小就带 ~N k", () => {
		function compactedEntry(taskId: string, contextTokenCount?: number) {
			return makeEntry(taskId, {
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "review",
				lastMainAgentConversationModelRequestDispatchObservation: {
					observedAtMs: NOW_MS - 60_000,
					evidenceKind:
						"manual_compact_command_completed_main_conversation_prompt_cache_replaced_without_follow_up_request",
					...(contextTokenCount !== undefined
						? { mainAgentConversationContextTokenCountAfterCompactionReportedByHarness: contextTokenCount }
						: {}),
				},
			});
		}
		act(() =>
			root.render(
				<CrossProjectRecentlyActiveTaskSwitcherPanel
					host={makeHost({
						projects: [
							makeProject("project-a", [
								compactedEntry("claude-compacted"),
								{
									...compactedEntry("kimi-compacted", 41_600),
									agentId: "kimi",
									agentProcessStartedAt: NOW_MS - 3_600_000,
								},
							]),
						],
					})}
				/>,
			),
		);
		const claudeRow = section("prompt-cache-warm").querySelector<HTMLElement>(
			'[data-cross-project-task-switcher-task-id="claude-compacted"]',
		);
		const compactedPill = claudeRow?.querySelector('[title^="Compacted ·"]');
		expect(compactedPill?.textContent).toBe("Compacted");
		expect(compactedPill?.getAttribute("title")).toContain("rewrites the compacted context");
		expect(claudeRow?.querySelector('[title^="缓存预计过期"]')).toBeNull();

		const kimiRow = section("prompt-cache-warm").querySelector<HTMLElement>(
			'[data-cross-project-task-switcher-task-id="kimi-compacted"]',
		);
		expect(kimiRow?.querySelector('[title^="Compacted ·"]')?.textContent).toBe("Compacted · ~42k");
	});

	// 2026-10-05 用户反馈：This project 卡片上「相对 base 的提交关系」与「未提交改动」也要出现在 All projects 的默认行上。
	it("行上显示 ahead/behind 与未提交改动：其他项目读轮询结果，当前项目优先读推流 store；Backlog 与无改动不显示", async () => {
		fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockResolvedValue({
			tasks: [
				{
					workspaceId: "project-b",
					taskId: "recent",
					availability: "available",
					taskWorkspaceMetadata: makeTaskWorkspaceMetadata("recent", {
						ahead: 2,
						behind: 1,
						changedFiles: 3,
						additions: 5,
						deletions: 2,
					}),
				},
			],
		});
		replaceWorkspaceMetadata({
			homeGitSummary: null,
			homeGitStateVersion: 0,
			taskWorkspaces: [
				makeTaskWorkspaceMetadata("warm", { ahead: 4, behind: 0, changedFiles: 0, additions: 0, deletions: 0 }),
			],
		});
		const host = makeHost({
			projects: [
				makeProject("project-a", [
					makeEntry("warm", {
						turnOwner: "user",
						liveness: "exited",
						userTurnKind: "review",
						lastMainAgentConversationModelRequestDispatchObservation: {
							observedAtMs: NOW_MS - 5 * 60_000,
							evidenceKind: "post_tool_use_hook_event",
						},
					}),
					makeEntry("backlog-task", { columnId: "backlog" }),
				]),
				makeProject("project-b", [makeEntry("recent", { baseRef: "develop" })]),
			],
		});
		await act(async () => {
			root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />);
		});

		// 请求全部非 Backlog 条目，含当前项目：All projects 下状态流只探焦点任务，当前项目其余行也靠轮询。
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).toHaveBeenCalledWith("project-a", {
			tasks: [
				{ workspaceId: "project-a", taskId: "warm" },
				{ workspaceId: "project-b", taskId: "recent" },
			],
		});
		const gitMetadataOf = (taskId: string) =>
			container.querySelector<HTMLElement>(
				`[data-cross-project-task-switcher-section="remaining"][data-cross-project-task-switcher-task-id="${taskId}"] [data-cross-project-task-switcher-row-worktree-git-metadata]`,
			) ??
			container.querySelector<HTMLElement>(
				`[data-cross-project-task-switcher-section="prompt_cache_warm"][data-cross-project-task-switcher-task-id="${taskId}"] [data-cross-project-task-switcher-row-worktree-git-metadata]`,
			);
		const otherProjectGitMetadata = gitMetadataOf("recent");
		expect(otherProjectGitMetadata?.textContent).toContain("(3 files +5 -2)");
		expect(otherProjectGitMetadata?.getAttribute("title")).toContain("2 commits ahead of develop");
		const currentProjectGitMetadata = gitMetadataOf("warm");
		expect(currentProjectGitMetadata?.getAttribute("title")).toContain("4 commits ahead of base branch");
		expect(currentProjectGitMetadata?.textContent).not.toContain("files");
		expect(gitMetadataOf("backlog-task")).toBeNull();
	});

	it("当前项目的行在推流里没有数据（All projects 下不在探测范围）时回落到轮询结果", async () => {
		fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockResolvedValue({
			tasks: [
				{
					workspaceId: "project-a",
					taskId: "warm",
					availability: "available",
					taskWorkspaceMetadata: makeTaskWorkspaceMetadata("warm", {
						ahead: 7,
						behind: 0,
						changedFiles: 0,
						additions: 0,
						deletions: 0,
					}),
				},
			],
		});
		await act(async () => {
			root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />);
		});
		expect(
			container
				.querySelector<HTMLElement>(
					'[data-cross-project-task-switcher-section="prompt_cache_warm"][data-cross-project-task-switcher-task-id="warm"] [data-cross-project-task-switcher-row-worktree-git-metadata]',
				)
				?.getAttribute("title"),
		).toContain("7 commits ahead of");
	});

	it("展开 Running 后列出在跑的任务，展开态落 localStorage", () => {
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const toggle = section("running").querySelector<HTMLButtonElement>("button[aria-expanded]");
		act(() => toggle?.click());

		expect(rowTaskIds(section("running"))).toEqual(["running"]);
		expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded)).toBe("true");
	});

	// hover 动作组伸出行顶边 12px（-top-3），最右一格展开开关的命中区伪元素再向上扩 4px（after:-top-1）。分区第一行上方是
	// 分区 header（Pinned / Running 的折叠按钮、Recent 的排序下拉框）：首行若贴着 header，动作组与开关命中区会盖住它们的
	// 右下沿、截走点击。jsdom 不排版，这里断言的几何约定是「紧挨 header 的首行 = 分区内容容器的第一个子节点，行根节点带
	// first:mt-4（16px = 伸出量 12px + 命中区向上扩展 4px）」，开关命中区顶边因此落在 header 底边上；首行前是小标题时它不是
	// 第一个子节点，上外边距不生效、不多出空白。真实像素与命中区由集成测试阶段 6 用 elementFromPoint 量。
	it("分区第一行留出 hover 动作组伸出量 + 展开开关命中区向上扩展量的上外边距：动作组不压分区 header 的折叠按钮 / 排序下拉框", () => {
		window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded, "true");
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		for (const sectionName of ["pinned", "running", "prompt-cache-warm", "remaining"]) {
			const firstRow = section(sectionName).querySelector<HTMLElement>("[data-cross-project-task-switcher-task-id]");
			expect(firstRow?.matches(":first-child"), `${sectionName} 首行紧挨 header`).toBe(true);
			expect(firstRow?.classList.contains("first:mt-4"), `${sectionName} 首行上外边距`).toBe(true);
			expect(queryInListExpansionToggle(firstRow)?.parentElement?.classList.contains("-top-3")).toBe(true);
		}
	});

	// 2026-10-04 用户反馈：Running 区随 agent 动作不断重排闪烁。agent 输出（spinner 重绘）只推进 lastOutputAt，
	// 不该改变顺序；新进入 agent 回合的任务追加在末尾。
	it("Running 区顺序不随 agent 输出变化，新进入的任务追加在末尾", () => {
		window.localStorage.setItem(LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded, "true");
		function runningEntry(taskId: string, turnStartedAgoMs: number, lastOutputAgoMs: number) {
			return makeEntry(taskId, {
				turnOwner: "agent",
				liveness: "live",
				lastOutputAt: NOW_MS - lastOutputAgoMs,
				agentResponseGenerationTurnStarted: { startedAt: NOW_MS - turnStartedAgoMs, turnSequence: 1 },
			});
		}
		function renderWithRunningEntries(entries: RuntimeCrossProjectTaskSwitcherEntry[]) {
			act(() =>
				root.render(
					<CrossProjectRecentlyActiveTaskSwitcherPanel
						host={makeHost({ projects: [makeProject("project-a", entries)] })}
					/>,
				),
			);
		}

		renderWithRunningEntries([runningEntry("b", 60_000, 3_000), runningEntry("a", 120_000, 1_000)]);
		expect(rowTaskIds(section("running"))).toEqual(["a", "b"]);
		renderWithRunningEntries([runningEntry("b", 60_000, 500), runningEntry("a", 120_000, 2_500)]);
		expect(rowTaskIds(section("running"))).toEqual(["a", "b"]);
		renderWithRunningEntries([
			runningEntry("c", 1_000, 100),
			runningEntry("b", 60_000, 4_000),
			runningEntry("a", 120_000, 200),
		]);
		expect(rowTaskIds(section("running"))).toEqual(["a", "b", "c"]);
	});

	it("点击行走宿主的跨项目打开，键是 (workspaceId, taskId)", () => {
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const recentRowButton = section("remaining").querySelector<HTMLButtonElement>(
			'[data-cross-project-task-switcher-task-id="recent"] button:not([aria-expanded])',
		);
		act(() => recentRowButton?.click());

		expect(host.onOpenTaskInProject).toHaveBeenCalledWith("project-b", "recent");
	});

	it("点 backlog 行原地打开编辑对话框（不切项目、不打开任务）", () => {
		const host = makeHost({
			projects: [
				makeProject("project-a", []),
				makeProject("project-b", [makeEntry("backlog-task", { columnId: "backlog" })]),
			],
			onOpenBacklogTaskEditorInProject: vi.fn(),
		});
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		act(() =>
			[
				...section("remaining").querySelectorAll<HTMLButtonElement>(
					'[aria-label="Filter recent tasks by stage"] button',
				),
			]
				.find((button) => button.textContent === "All")
				?.click(),
		);
		act(() =>
			section("remaining")
				.querySelector<HTMLButtonElement>(
					'[data-cross-project-task-switcher-task-id="backlog-task"] button:not([aria-expanded])',
				)
				?.click(),
		);

		expect(host.onOpenBacklogTaskEditorInProject).toHaveBeenCalledWith("project-b", "backlog-task");
		expect(host.onOpenTaskInProject).not.toHaveBeenCalled();
	});

	it("其他项目的行 hover：复用预取卡体作为悬浮层，精简行隐藏且不可交互但保留占位；固定展开与卡片动作沿用原链路", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockResolvedValue({
			taskCardLookupOutcome: "task_card_found_on_workspace_board",
			taskCardSnapshot: {
				taskCard: {
					id: "recent",
					title: "Recent task in project B",
					prompt: "Do the recent thing",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: NOW_MS - DAY_MS,
					updatedAt: NOW_MS - DAY_MS,
				},
				boardColumnIdContainingTaskCard: "review",
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		});
		moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace.mockResolvedValue({
			taskCardSnapshotAfterAction: {
				taskCard: { id: "recent" },
				boardColumnIdContainingTaskCard: "validation",
			},
		});
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const queryRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		// 行上不再有常驻占位的展开 chevron。
		expect(queryRecentRow()?.querySelector('[aria-label="Expand task card"]')).toBeNull();
		await act(async () => dispatchPointerMoveAtFreshCoordinates(queryRecentRow()?.querySelector("button")));
		// 还没到 hover 意图的延时：完整卡片已隐藏挂载在这一行里（预取），行仍是精简行。
		expect(readTaskCardWithBoardColumnInWorkspace).toHaveBeenCalledWith("project-b", "recent");
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		expect(
			queryRecentRow()
				?.querySelector('[data-testid="cross-project-task-switcher-full-task-card"]')
				?.closest("[hidden]"),
		).not.toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		const expandedRow = queryRecentRow();
		expect(rowInPlaceExpansionState(expandedRow)).toBe("expanded_in_place_by_hover");
		// 精简行保留自然高度，但不再展示、命中或参与键盘导航。
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		const placeholder = expandedRow?.querySelector("[data-cross-project-task-switcher-compact-row-placeholder]");
		expect(placeholder?.hasAttribute("inert")).toBe(true);
		expect(placeholder?.classList.contains("invisible")).toBe(true);
		expect(placeholder?.querySelector("[data-cross-project-task-switcher-row-title]")).not.toBeNull();
		expect(
			expandedRow
				?.querySelector("[data-cross-project-task-switcher-hover-floating-card]")
				?.classList.contains("absolute"),
		).toBe(true);
		expect(
			expandedRow?.querySelector('[data-testid="cross-project-task-switcher-full-task-card"]')?.closest("[hidden]"),
		).toBeNull();
		// 展开用的就是预取时挂载的那个实例：没有再读一次。
		expect(readTaskCardWithBoardColumnInWorkspace).toHaveBeenCalledTimes(1);
		const expandedTaskCard = expandedRow?.querySelector(
			'[data-task-card-render-role="expanded_card_copy_in_cross_project_task_switcher_row"]',
		);
		expect(expandedTaskCard?.textContent).toContain("Recent task in project B");
		// 卡片副本不持有 DOM 身份（data-task-id 全局唯一属于本体卡）。
		expect(expandedTaskCard?.hasAttribute("data-task-id")).toBe(false);
		// 项目名并进卡体元信息行最左（对应精简行第 2 行最左）。
		expect(
			expandedTaskCard?.querySelector("[data-task-card-compact-metadata-row]")?.firstElementChild?.textContent,
		).toBe("project-b");
		// 展开开关在卡体 hover 动作组的最右一格；展开发生在静止的光标下，动作组第一帧就可见，精简行上的开关不会闪没。
		const hoverExpandedToggle = queryInListExpansionToggle(expandedRow);
		expect(hoverExpandedToggle?.parentElement?.lastElementChild).toBe(hoverExpandedToggle);
		expect(hoverExpandedToggle?.parentElement?.classList.contains("opacity-100")).toBe(true);
		// 卡体动作组（铅笔、置顶、原始 prompt、移列、删除……）与精简行同一坐标：叠在首行上方，不压首行的字。
		// 一般紧凑密度（Focus View 左栏列表）的 top-1 压在首行右端，这里不能用。
		expect(hoverExpandedToggle?.parentElement?.classList.contains("-top-3")).toBe(true);
		expect(hoverExpandedToggle?.parentElement?.classList.contains("top-1")).toBe(false);
		expect(hoverExpandedToggle?.dataset.crossProjectTaskSwitcherFullTaskCardInListExpansionState).toBe(
			"collapsed_to_compact_row",
		);
		expect(hoverExpandedToggle?.getAttribute("aria-label")).toBe("Keep expanded in list");

		await act(async () => hoverExpandedToggle?.click());
		const keptExpandedRow = queryRecentRow();
		expect(rowInPlaceExpansionState(keptExpandedRow)).toBe("kept_expanded_in_list");
		// 原地替换，不是「精简行 + 下方完整卡」：标题只出现一次。
		expect(keptExpandedRow?.textContent?.split("Recent task in project B")).toHaveLength(2);
		const keptExpandedToggle = queryInListExpansionToggle(keptExpandedRow);
		expect(keptExpandedToggle?.dataset.crossProjectTaskSwitcherFullTaskCardInListExpansionState).toBe(
			"kept_expanded_in_list",
		);
		expect(keptExpandedToggle?.getAttribute("aria-label")).toBe("Collapse to compact row");
		// 固定展开的卡在列表里常驻：动作组照常只在 hover / 聚焦时显形。
		expect(keptExpandedToggle?.parentElement?.classList.contains("opacity-0")).toBe(true);

		// 复制使用卡片所属项目的只读查询，不能借当前项目 project-a 的路径。
		await act(async () =>
			keptExpandedRow?.querySelector<HTMLButtonElement>('[aria-label="Copy directory path"]')?.click(),
		);
		expect(fetchTaskWorkspaceInfoForWorkspace).toHaveBeenCalledWith("project-b", {
			taskId: "recent",
			baseRef: "main",
			worktreeMode: undefined,
		});

		await act(async () =>
			keptExpandedRow?.querySelector<HTMLButtonElement>('[aria-label="Move task to validation"]')?.click(),
		);
		expect(moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace).toHaveBeenCalledWith("project-b", {
			taskId: "recent",
			targetBoardColumnId: "validation",
			boardMutationInitiator: "web_ui_user_gesture",
			expectedTaskIncarnationCreatedAtEpochMs: NOW_MS - DAY_MS,
		});
		expect(host.onOpenTaskInProject).not.toHaveBeenCalled();

		await act(async () => queryInListExpansionToggle(queryRecentRow())?.click());
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		// 刚收起、指针还在这一行上：不能一动又原地展开。
		await hoverRowUntilExpandedInPlace(queryRecentRow());
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		// 指针离开这一行再回来：照常展开。
		await movePointerOutOfRow(queryRecentRow());
		await hoverRowUntilExpandedInPlace(queryRecentRow());
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("expanded_in_place_by_hover");
	});

	it("离开浮层 300ms 后收起，下一行停够 350ms 再展开；同坐标事件不发起意图，返回与 Esc 沿用现有语义", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		const host = makeHost({
			projects: [makeProject("project-a", []), makeProject("project-b", [makeEntry("first"), makeEntry("second")])],
		});
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const queryRow = (taskId: string) =>
			section("remaining").querySelector<HTMLElement>(`[data-cross-project-task-switcher-task-id="${taskId}"]`);

		await hoverRowUntilExpandedInPlace(queryRow("first"));
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("expanded_in_place_by_hover");

		await movePointerFromRowToRow(queryRow("first"), queryRow("second"));
		await act(async () => {
			vi.advanceTimersByTime(300);
		});
		// 离开卡片后 300ms 收起；下一行的 350ms 意图仍在计时。
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("compact_row");
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("compact_row");
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("compact_row");
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");

		// 布局 / 滚动把别的行换到静止的光标下时浏览器补发的同坐标事件：不算移动，不发起意图、不连锁展开。
		await act(async () => dispatchPointerMoveAtLastCoordinates(queryRow("first")?.querySelector("button")));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("compact_row");

		// 指针离开整个面板：延时后收起；延时内回来就不收。
		await movePointerOutOfRow(queryRow("second"));
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");
		await act(async () => dispatchPointerMoveAtFreshCoordinates(queryRow("second")?.querySelector("button")));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");
		await movePointerOutOfRow(queryRow("second"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("compact_row");

		await hoverRowUntilExpandedInPlace(queryRow("first"));
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("expanded_in_place_by_hover");
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("compact_row");
	});

	it("悬浮卡片交接与收起不写宿主 scrollTop，不垫顶部空白", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		act(() =>
			root.render(
				<CrossProjectRecentlyActiveTaskSwitcherPanel
					host={makeHost({
						projects: [
							makeProject("project-a", []),
							makeProject("project-b", [makeEntry("first"), makeEntry("second")]),
						],
					})}
				/>,
			),
		);
		const queryRow = (taskId: string) =>
			section("remaining").querySelector<HTMLElement>(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
		const panel = container.querySelector<HTMLElement>(
			'[data-testid="cross-project-recently-active-task-switcher-panel"]',
		)!;
		const setScrollTop = vi.fn();
		Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => 200, set: setScrollTop });
		await hoverRowUntilExpandedInPlace(queryRow("first"));
		await movePointerFromRowToRow(queryRow("first"), queryRow("second"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("compact_row");
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");
		await movePointerOutOfRow(queryRow("second"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(rowInPlaceExpansionState(queryRow("second"))).toBe("compact_row");
		expect(setScrollTop).not.toHaveBeenCalled();
		expect(panel.style.paddingTop).toBe("");
	});

	it("精简行右上角的展开开关常驻 DOM（键盘 Tab 得到），点它不等 hover 意图直接原地固定展开；卡快照未到时完整卡先画同一个首行", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		const host = makeHost({
			notificationLogByWorkspaceId: {
				"project-b": [{ id: "n1", workspaceId: "project-b", taskId: "recent", visitedAt: null } as never],
			},
		});
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const queryRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		const compactRowToggle = queryInListExpansionToggle(queryRecentRow());
		expect(compactRowToggle).not.toBeNull();
		expect(compactRowToggle?.disabled).toBe(false);
		expect(compactRowToggle?.dataset.crossProjectTaskSwitcherFullTaskCardInListExpansionState).toBe(
			"collapsed_to_compact_row",
		);
		// 与完整卡片同一几何：hover 动作组叠在首行上方（不压首行的字）、开关是最右一格。
		expect(compactRowToggle?.parentElement?.classList.contains("absolute")).toBe(true);
		expect(compactRowToggle?.parentElement?.classList.contains("right-1")).toBe(true);
		expect(compactRowToggle?.parentElement?.classList.contains("-top-3")).toBe(true);
		expect(compactRowToggle?.parentElement?.lastElementChild).toBe(compactRowToggle);
		expect(queryRecentRow()?.querySelector("[data-task-card-corner-status-indicator]")).not.toBeNull();

		// 指针移进行（hover 意图开始）后按下开关：意图作废，直接固定展开。
		await act(async () => dispatchPointerMoveAtFreshCoordinates(queryRecentRow()?.querySelector("button")));
		await act(async () => {
			compactRowToggle?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			compactRowToggle?.click();
		});
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		const keptExpandedRow = queryRecentRow();
		expect(rowInPlaceExpansionState(keptExpandedRow)).toBe("kept_expanded_in_list");
		// 快照还在读：先画同一个首行，角标仍挂在行外框，提示放在下面，开关仍在。
		const unavailableFallback = keptExpandedRow?.querySelector(
			"[data-cross-project-task-switcher-full-task-card-unavailable-fallback]",
		);
		expect(unavailableFallback?.querySelector("[data-cross-project-task-switcher-row-title]")?.textContent).toBe(
			"Title recent",
		);
		expect(
			keptExpandedRow
				?.querySelector("[data-task-card-corner-status-indicator]")
				?.getAttribute("data-task-card-corner-status-indicator"),
		).toBe("unread_handoff");
		expect(unavailableFallback?.textContent).toContain("Loading task…");
		expect(
			queryInListExpansionToggle(unavailableFallback)?.dataset
				.crossProjectTaskSwitcherFullTaskCardInListExpansionState,
		).toBe("kept_expanded_in_list");
		// 兜底态点它也等于点精简行。
		act(() =>
			unavailableFallback?.querySelector<HTMLElement>("[data-cross-project-task-switcher-row-title]")?.click(),
		);
		expect(host.onOpenTaskInProject).toHaveBeenCalledWith("project-b", "recent");
	});

	it.each(["键盘焦点", "用户已移走焦点", "非 focus-visible 焦点"])(
		"慢速快照升级卡体时保留打开任务入口：%s",
		async (focusCase) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let resolveSnapshot: (snapshot: unknown) => void = () => {};
			readTaskCardWithBoardColumnInWorkspace.mockReturnValue(
				new Promise((resolve) => {
					resolveSnapshot = resolve;
				}),
			);
			const host = makeHost();
			act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
			const row = section("remaining").querySelector<HTMLElement>(
				'[data-cross-project-task-switcher-task-id="recent"]',
			);
			const compactEntry = row?.querySelector<HTMLButtonElement>('button[aria-label="打开任务：Title recent"]');
			act(() => compactEntry?.focus());
			await hoverRowUntilExpandedInPlace(row);
			const fallbackEntry = row?.querySelector<HTMLElement>(
				"[data-cross-project-task-switcher-full-task-card-unavailable-fallback-open-task-keyboard-entry]",
			);
			expect(document.activeElement).toBe(fallbackEntry);
			const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
			const externalButton = document.createElement("button");
			document.body.appendChild(externalButton);
			let matchesSpy: ReturnType<typeof vi.spyOn> | undefined;
			if (focusCase === "用户已移走焦点") externalButton.focus();
			if (focusCase === "非 focus-visible 焦点" && fallbackEntry) {
				const originalMatches = fallbackEntry.matches.bind(fallbackEntry);
				matchesSpy = vi
					.spyOn(fallbackEntry, "matches")
					.mockImplementation((selector) => (selector === ":focus-visible" ? false : originalMatches(selector)));
			}
			focusSpy.mockClear();
			await act(async () => {
				resolveSnapshot(makeOtherProjectTaskCardSnapshot("recent", "review"));
			});
			await act(async () => {
				await Promise.resolve();
			});
			const title = row?.querySelector<HTMLElement>("[data-task-card-title]");
			expect(title).not.toBeNull();
			if (focusCase === "键盘焦点") {
				expect(document.activeElement).toBe(title);
				expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
				for (const key of ["Enter", " "]) {
					act(() => title?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
				}
				expect(host.onOpenTaskInProject).toHaveBeenCalledTimes(2);
				expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "recent");
			} else {
				expect(document.activeElement).toBe(focusCase === "用户已移走焦点" ? externalButton : document.body);
				expect(focusSpy).not.toHaveBeenCalled();
			}
			matchesSpy?.mockRestore();
			focusSpy.mockRestore();
			externalButton.remove();
		},
	);

	it("键盘按展开开关切换形态后焦点交给触发那一行新形态下的开关（含卡快照到达后兜底换成卡体），不落到 body；展开态的首行 / 卡体标题是可聚焦、Enter / Space 打开任务的键盘入口", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let resolveOtherProjectTaskCardSnapshot: (snapshot: unknown) => void = () => {};
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(
			new Promise((resolve) => {
				resolveOtherProjectTaskCardSnapshot = resolve;
			}),
		);
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		// 置顶的任务在 Pinned 与下方区各有一行，固定展开按任务记、两行一起展开：焦点只回到触发的下方区那一行。
		const queryRemainingRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		const queryPinnedRecentRow = () =>
			section("pinned").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		// 浏览器里键盘 Enter / Space 按在按钮上 = 先有焦点、再派发 click。
		const pressInListExpansionToggleByKeyboard = async (toggle: HTMLButtonElement | null) => {
			await act(async () => {
				toggle?.focus();
				toggle?.click();
			});
			// 焦点接力排在这次提交之后的微任务里。
			await act(async () => {
				await Promise.resolve();
			});
		};
		const flushMicrotasksAfterCommit = async () => {
			await act(async () => {
				await Promise.resolve();
			});
		};

		// 精简行 → 固定展开：卡快照还在读，焦点落在兜底上的开关（同一坐标），不是 body。
		await pressInListExpansionToggleByKeyboard(queryInListExpansionToggle(queryRemainingRecentRow()));
		expect(rowInPlaceExpansionState(queryRemainingRecentRow())).toBe("kept_expanded_in_list");
		expect(rowInPlaceExpansionState(queryPinnedRecentRow())).toBe("kept_expanded_in_list");
		const unavailableFallback = queryRemainingRecentRow()?.querySelector<HTMLElement>(
			"[data-cross-project-task-switcher-full-task-card-unavailable-fallback]",
		);
		const fallbackToggle = queryInListExpansionToggle(unavailableFallback);
		expect(fallbackToggle?.dataset.crossProjectTaskSwitcherFullTaskCardInListExpansionState).toBe(
			"kept_expanded_in_list",
		);
		expect(document.activeElement).toBe(fallbackToggle);

		// 兜底的首行是打开任务的键盘入口：可聚焦、Enter 打开，与点首行同一结果。
		const fallbackOpenTaskKeyboardEntry = unavailableFallback?.querySelector<HTMLElement>(
			"[data-cross-project-task-switcher-full-task-card-unavailable-fallback-open-task-keyboard-entry]",
		);
		expect(fallbackOpenTaskKeyboardEntry?.getAttribute("role")).toBe("button");
		expect(fallbackOpenTaskKeyboardEntry?.tabIndex).toBe(0);
		expect(fallbackOpenTaskKeyboardEntry?.querySelector("button")).toBeNull();
		act(() => {
			fallbackOpenTaskKeyboardEntry?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(host.onOpenTaskInProject).toHaveBeenCalledTimes(1);
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "recent");

		// 快照到了，兜底换成卡体：焦点跟到卡体上的开关。
		await act(async () => {
			fallbackToggle?.focus();
		});
		await act(async () => {
			resolveOtherProjectTaskCardSnapshot(makeOtherProjectTaskCardSnapshot("recent", "review"));
		});
		await flushMicrotasksAfterCommit();
		const keptExpandedRemainingRow = queryRemainingRecentRow();
		expect(
			keptExpandedRemainingRow?.querySelector(
				"[data-cross-project-task-switcher-full-task-card-unavailable-fallback]",
			),
		).toBeNull();
		const taskCardBodyToggle = queryInListExpansionToggle(
			keptExpandedRemainingRow?.querySelector(
				'[data-task-card-render-role="expanded_card_copy_in_cross_project_task_switcher_row"]',
			),
		);
		expect(taskCardBodyToggle).not.toBeNull();
		expect(document.activeElement).toBe(taskCardBodyToggle);

		// 卡体标题是打开任务的键盘入口：可聚焦、Enter / Space 打开；标题里没有嵌套的按钮。
		const taskCardBodyTitle = keptExpandedRemainingRow?.querySelector<HTMLElement>("[data-task-card-title]");
		expect(taskCardBodyTitle?.getAttribute("role")).toBe("button");
		expect(taskCardBodyTitle?.tabIndex).toBe(0);
		expect(taskCardBodyTitle?.querySelector("button")).toBeNull();
		act(() => {
			taskCardBodyTitle?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(host.onOpenTaskInProject).toHaveBeenCalledTimes(2);
		act(() => {
			taskCardBodyTitle?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
		});
		expect(host.onOpenTaskInProject).toHaveBeenCalledTimes(3);
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "recent");

		// 固定展开 → 精简行：焦点回到这一行精简行上的开关。
		await pressInListExpansionToggleByKeyboard(taskCardBodyToggle);
		expect(rowInPlaceExpansionState(queryRemainingRecentRow())).toBe("compact_row");
		const compactRowToggle = queryInListExpansionToggle(queryRemainingRecentRow());
		expect(compactRowToggle?.dataset.crossProjectTaskSwitcherFullTaskCardInListExpansionState).toBe(
			"collapsed_to_compact_row",
		);
		expect(document.activeElement).toBe(compactRowToggle);

		// 焦点不在开关上（鼠标点、Safari 不给按钮焦点）时不接力：照旧不抢焦点。
		await act(async () => {
			compactRowToggle?.blur();
			queryInListExpansionToggle(queryRemainingRecentRow())?.click();
		});
		await flushMicrotasksAfterCommit();
		expect(rowInPlaceExpansionState(queryRemainingRecentRow())).toBe("kept_expanded_in_list");
		expect(document.activeElement).toBe(document.body);
	});

	it("展开开关三态：命中区用伪元素向上、向右扩到 24×24（不向左盖住相邻动作按钮，按钮盒子不动）；读屏用 aria-pressed 表达「保持展开」开关、不用 aria-expanded——hover 原地展开时内容已可见展开但开关未按下", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockResolvedValue(makeOtherProjectTaskCardSnapshot("recent", "review"));
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const queryRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		const expectToggleHitAreaExtendedUpAndRightOnlyWithButtonBoxUnchanged = (toggle: HTMLButtonElement | null) => {
			expect(toggle).not.toBeNull();
			for (const hitAreaExtensionClassName of [
				"relative",
				"after:absolute",
				"after:-top-1",
				"after:-right-1",
				"after:bottom-0",
				"after:left-0",
			]) {
				expect(toggle?.classList.contains(hitAreaExtensionClassName), hitAreaExtensionClassName).toBe(true);
			}
			// 按钮盒子本身仍是 xs icon-only（20×20）：三态同一坐标不受影响。
			expect(toggle?.classList.contains("h-5")).toBe(true);
			expect(toggle?.classList.contains("aspect-square")).toBe(true);
		};

		const compactRowToggle = queryInListExpansionToggle(queryRecentRow());
		expectToggleHitAreaExtendedUpAndRightOnlyWithButtonBoxUnchanged(compactRowToggle);
		expect(compactRowToggle?.hasAttribute("aria-expanded")).toBe(false);
		expect(compactRowToggle?.getAttribute("aria-pressed")).toBe("false");

		await hoverRowUntilExpandedInPlace(queryRecentRow());
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("expanded_in_place_by_hover");
		const hoverExpandedToggle = queryInListExpansionToggle(queryRecentRow());
		expect(hoverExpandedToggle?.dataset.crossProjectTaskSwitcherFullTaskCardInListExpansionState).toBe(
			"collapsed_to_compact_row",
		);
		expectToggleHitAreaExtendedUpAndRightOnlyWithButtonBoxUnchanged(hoverExpandedToggle);
		// 内容已可见展开，但「保持展开」没按下：不宣布 collapsed，也不宣布 pressed。
		expect(hoverExpandedToggle?.hasAttribute("aria-expanded")).toBe(false);
		expect(hoverExpandedToggle?.getAttribute("aria-pressed")).toBe("false");

		await act(async () => hoverExpandedToggle?.click());
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("kept_expanded_in_list");
		const keptExpandedToggle = queryInListExpansionToggle(queryRecentRow());
		expectToggleHitAreaExtendedUpAndRightOnlyWithButtonBoxUnchanged(keptExpandedToggle);
		expect(keptExpandedToggle?.hasAttribute("aria-expanded")).toBe(false);
		expect(keptExpandedToggle?.getAttribute("aria-pressed")).toBe("true");
		// label 文案照旧随状态切换。
		expect(keptExpandedToggle?.getAttribute("aria-label")).toBe("Collapse to compact row");

		await act(async () => keptExpandedToggle?.click());
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		expect(queryInListExpansionToggle(queryRecentRow())?.getAttribute("aria-pressed")).toBe("false");
	});

	it("点完整卡片（hover 展开 / 固定展开）的卡体 = 点精简行：立即打开不延迟、不接双击改标题；Pinned 行照样跳到下方区那一行；置顶的 Done 卡也能点开；Backlog 原地打开编辑框；点完不收起（收起会让列表在指针下移动）", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockImplementation((_workspaceId: string, taskId: string) =>
			Promise.resolve(
				makeOtherProjectTaskCardSnapshot(
					taskId,
					taskId === "done-pinned" ? "trash" : taskId === "backlog-task" ? "backlog" : "in_progress",
				),
			),
		);
		const host = makeHost({
			projects: [
				makeProject("project-a", []),
				makeProject("project-b", [
					makeEntry("running-pinned", {
						columnId: "in_progress",
						turnOwner: "agent",
						liveness: "live",
						lastOutputAt: NOW_MS - 1_000,
						pinnedToTaskPinboardAt: 2,
					}),
					makeEntry("done-pinned", { columnId: "trash", pinnedToTaskPinboardAt: 1 }),
					makeEntry("backlog-task", { columnId: "backlog" }),
				]),
			],
			onOpenBacklogTaskEditorInProject: vi.fn(),
		});
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const queryRow = (sectionName: string, taskId: string) =>
			section(sectionName).querySelector<HTMLElement>(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
		expect(section("running").querySelector('button[aria-expanded="true"]')).toBeNull();

		// Pinned 区的 In progress 行：卡体单击立即打开（不等 220ms 双击窗口），并像精简行一样展开 Running、跳过去。
		await hoverRowUntilExpandedInPlace(queryRow("pinned", "running-pinned"));
		const pinnedRunningRow = queryRow("pinned", "running-pinned");
		expect(rowInPlaceExpansionState(pinnedRunningRow)).toBe("expanded_in_place_by_hover");
		expect(pinnedRunningRow?.textContent).toContain("Card title running-pinned");
		// Pinned 副本也按任务实际状态显示运行角标，标题内不再画 In progress 标记。
		expect(pinnedRunningRow?.querySelector('[data-task-card-corner-status-indicator="running"]')).not.toBeNull();
		expect(pinnedRunningRow?.querySelector("[data-task-card-in-progress-column-status-marker]")).toBeNull();
		expect(pinnedRunningRow?.querySelector(".animate-spin")).toBeNull();
		act(() => clickTaskCardBodyTitle(pinnedRunningRow));
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "running-pinned");
		expect(rowInPlaceExpansionState(queryRow("pinned", "running-pinned"))).toBe("expanded_in_place_by_hover");
		expect(section("running").querySelector('button[aria-expanded="true"]')).not.toBeNull();
		// Running 区与 Pinned 副本显示同一个运行角标。
		await movePointerFromRowToRow(queryRow("pinned", "running-pinned"), queryRow("running", "running-pinned"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(
			queryRow("running", "running-pinned")
				?.querySelector("[data-task-card-corner-status-indicator]")
				?.getAttribute("data-task-card-corner-status-indicator"),
		).toBe("running");

		// 置顶的 Done 卡：本体卡上不可点，这里与精简行一样能打开。
		await movePointerFromRowToRow(queryRow("running", "running-pinned"), queryRow("pinned", "done-pinned"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		act(() => clickTaskCardBodyTitle(queryRow("pinned", "done-pinned")));
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "done-pinned");

		// Backlog：原地打开编辑框（与点精简行同一条路径，不是卡体自己的编辑回调）。
		act(() =>
			[
				...section("remaining").querySelectorAll<HTMLButtonElement>(
					'[aria-label="Filter recent tasks by stage"] button',
				),
			]
				.find((button) => button.textContent === "All")
				?.click(),
		);
		await movePointerFromRowToRow(queryRow("pinned", "done-pinned"), queryRow("remaining", "backlog-task"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		act(() => clickTaskCardBodyTitle(queryRow("remaining", "backlog-task")));
		expect(host.onOpenBacklogTaskEditorInProject).toHaveBeenCalledWith("project-b", "backlog-task");
		expect(host.onOpenTaskInProject).not.toHaveBeenCalledWith("project-b", "backlog-task");

		// 固定展开的卡同样：单击立即打开；双击不进改标题（改标题走铅笔）。
		await act(async () => queryInListExpansionToggle(queryRow("pinned", "running-pinned"))?.click());
		const keptExpandedRunningRow = queryRow("running", "running-pinned");
		expect(rowInPlaceExpansionState(keptExpandedRunningRow)).toBe("kept_expanded_in_list");
		const openCallCountBeforeKeptCardClick = vi.mocked(host.onOpenTaskInProject).mock.calls.length;
		act(() => clickTaskCardBodyTitle(keptExpandedRunningRow));
		expect(vi.mocked(host.onOpenTaskInProject).mock.calls.length).toBe(openCallCountBeforeKeptCardClick + 1);
		act(() => {
			keptExpandedRunningRow
				?.querySelector("[data-task-card-title]")
				?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
		});
		expect(keptExpandedRunningRow?.querySelector("textarea")).toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		// 没有被延迟的第二次打开。
		expect(vi.mocked(host.onOpenTaskInProject).mock.calls.length).toBe(openCallCountBeforeKeptCardClick + 1);
	});

	it("hover 意图期间在行上按下鼠标：不再在按下与抬起之间把这一行换成卡片，这次点击照常打开任务", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const queryRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		const rowMainButton = queryRecentRow()?.querySelector<HTMLButtonElement>("button");
		await act(async () => dispatchPointerMoveAtFreshCoordinates(rowMainButton));
		await act(async () => {
			vi.advanceTimersByTime(300);
			rowMainButton?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			vi.advanceTimersByTime(300);
		});
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		await act(async () => rowMainButton?.click());
		expect(host.onOpenTaskInProject).toHaveBeenCalledWith("project-b", "recent");
	});

	it("没等到意图就离开不展开", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
		const queryRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		await act(async () => dispatchPointerMoveAtFreshCoordinates(queryRecentRow()?.querySelector("button")));
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		await movePointerOutOfRow(queryRecentRow());
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		// 意图作废后预取用的隐藏卡片也撤掉。
		expect(queryRecentRow()?.querySelector('[data-testid="cross-project-task-switcher-full-task-card"]')).toBeNull();
	});

	it("触屏长按原地展开：紧随的那次行 click 被吞；长按后没有 click 落到行上时，「吞 click」标志不滞留到之后的点行", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const queryRecentRow = () =>
			section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
		const pressEscape = async () => {
			await act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			});
		};

		// 原意图：长按展开后抬手紧随的 click（手指下已经换成了卡片，这里快照未到、是兜底首行）不当成「打开任务」。
		await longPressRowByTouchUntilExpandedInPlace(queryRecentRow()?.querySelector("button"));
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("expanded_in_place_by_hover");
		act(() => queryRecentRow()?.querySelector<HTMLElement>("[data-cross-project-task-switcher-row-title]")?.click());
		expect(host.onOpenTaskInProject).not.toHaveBeenCalled();
		await pressEscape();
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");

		// 长按后浏览器没发 click → Esc 收起 → 再点行要照常打开任务。
		await longPressRowByTouchUntilExpandedInPlace(queryRecentRow()?.querySelector("button"));
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("expanded_in_place_by_hover");
		await pressEscape();
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		await act(async () => queryRecentRow()?.querySelector<HTMLButtonElement>("button")?.click());
		expect(host.onOpenTaskInProject).toHaveBeenCalledWith("project-b", "recent");

		// 长按后没发 click、这一行还展开着，直接轻点另一行（新手势）也要照常打开任务。
		await longPressRowByTouchUntilExpandedInPlace(queryRecentRow()?.querySelector("button"));
		expect(rowInPlaceExpansionState(queryRecentRow())).toBe("expanded_in_place_by_hover");
		const warmRowMainButton = section("prompt-cache-warm").querySelector<HTMLButtonElement>(
			'[data-cross-project-task-switcher-task-id="warm"] button',
		);
		await act(async () => {
			dispatchTouchPointerEvent(warmRowMainButton, "pointerdown");
			dispatchTouchPointerEvent(warmRowMainButton, "pointerup");
			warmRowMainButton?.click();
		});
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-a", "warm");
	});

	it("App 常驻的 Esc 热键早于行展开在 document 上注册、对每次 Esc 都 preventDefault：没有弹窗时 Esc 仍收起 hover 展开的行", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
		// 模拟 use-app-hotkeys 的 useHotkeys("escape", …, { preventDefault: true })：react-hotkeys-hook 在应用启动时就于
		// document 上以 bubble 阶段注册（早于行展开时才注册的收起监听，同节点同阶段按注册顺序先跑），且在回调之前无条件
		// preventDefault。
		const preventDefaultOfEveryEscapeKeydownLikeAppEscapeHotkey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", preventDefaultOfEveryEscapeKeydownLikeAppEscapeHotkey);
		try {
			act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={makeHost()} />));
			const queryRecentRow = () =>
				section("remaining").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="recent"]');
			await hoverRowUntilExpandedInPlace(queryRecentRow());
			expect(rowInPlaceExpansionState(queryRecentRow())).toBe("expanded_in_place_by_hover");

			const escapeKeydownWithoutAnyDialogOpen = new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			});
			await act(async () => {
				document.body.dispatchEvent(escapeKeydownWithoutAnyDialogOpen);
			});
			// 前提：这次 Esc 确实已被「App 热键」preventDefault。
			expect(escapeKeydownWithoutAnyDialogOpen.defaultPrevented).toBe(true);
			expect(rowInPlaceExpansionState(queryRecentRow())).toBe("compact_row");
		} finally {
			document.removeEventListener("keydown", preventDefaultOfEveryEscapeKeydownLikeAppEscapeHotkey);
		}
	});

	it("当前项目的行 hover：原地展开的卡直接用宿主给的本页 board 与动作，不读服务端", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const onMoveToValidationTask = vi.fn();
		const host = makeHost();
		act(() =>
			root.render(
				<CrossProjectRecentlyActiveTaskSwitcherPanel
					host={host}
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
											prompt: "warm",
											startInPlanMode: false,
											baseRef: "main",
											createdAt: NOW_MS - DAY_MS,
											updatedAt: NOW_MS - DAY_MS,
										},
									],
								},
							],
						},
						currentProjectTaskSessions: {},
						currentProjectTaskCardActionHandlers: { onMoveToValidationTask },
						currentProjectWorkspacePath: "/repos/project-a",
					}}
				/>,
			),
		);
		const queryWarmRow = () =>
			section("prompt-cache-warm").querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="warm"]');
		await hoverRowUntilExpandedInPlace(queryWarmRow());

		expect(readTaskCardWithBoardColumnInWorkspace).not.toHaveBeenCalled();
		expect(rowInPlaceExpansionState(queryWarmRow())).toBe("expanded_in_place_by_hover");
		expect(queryWarmRow()?.textContent).toContain("Warm task from the in-browser board");
		await act(async () =>
			queryWarmRow()?.querySelector<HTMLButtonElement>('[aria-label="Move task to validation"]')?.click(),
		);
		expect(onMoveToValidationTask).toHaveBeenCalledWith("warm");
	});

	it("hover 展开卡上弹出的原始 prompt 弹窗（portal 挂在 body 下、不在面板 DOM 里）：在弹窗里按下或按 Esc 不收起这一行，Copy 能复制；真正在面板外按下照旧收起", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const previousClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		try {
			const host = makeHost();
			act(() =>
				root.render(
					<CrossProjectRecentlyActiveTaskSwitcherPanel
						host={host}
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
												createdAt: NOW_MS - DAY_MS,
												updatedAt: NOW_MS - DAY_MS,
											},
										],
									},
								],
							},
							currentProjectTaskSessions: {},
							currentProjectTaskCardActionHandlers: {},
							currentProjectWorkspacePath: "/repos/project-a",
						}}
					/>,
				),
			);
			const queryWarmRow = () =>
				section("prompt-cache-warm").querySelector<HTMLElement>(
					'[data-cross-project-task-switcher-task-id="warm"]',
				);
			const queryOriginalPromptDialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
			await hoverRowUntilExpandedInPlace(queryWarmRow());
			expect(rowInPlaceExpansionState(queryWarmRow())).toBe("expanded_in_place_by_hover");

			await act(async () =>
				queryWarmRow()?.querySelector<HTMLButtonElement>('[aria-label="View original prompt"]')?.click(),
			);
			const originalPromptDialog = queryOriginalPromptDialog();
			expect(originalPromptDialog?.textContent).toContain("Original prompt of the warm task");
			expect(container.contains(originalPromptDialog)).toBe(false);

			// 先按下再 click，与真实浏览器同序：按下若把这一行收起，卡体连同弹窗卸载，click 就落空。
			const copyButton = [...(originalPromptDialog?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent?.trim() === "Copy prompt",
			);
			await act(async () => {
				copyButton?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
			});
			expect(rowInPlaceExpansionState(queryWarmRow())).toBe("expanded_in_place_by_hover");
			expect(queryOriginalPromptDialog()).not.toBeNull();
			await act(async () => copyButton?.click());
			expect(writeText).toHaveBeenCalledExactlyOnceWith("Original prompt of the warm task");

			// Esc 只关最上层的弹窗：弹窗关掉，hover 展开的这一行不跟着收起。与真实焦点一致，Esc 派发到弹窗内获得焦点的
			// 元素上（Radix 把焦点困在 role=dialog 的 Content 里）。
			const elementFocusedInsideOriginalPromptDialog = document.activeElement;
			expect(queryOriginalPromptDialog()?.contains(elementFocusedInsideOriginalPromptDialog)).toBe(true);
			await act(async () => {
				elementFocusedInsideOriginalPromptDialog?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
				);
			});
			expect(queryOriginalPromptDialog()).toBeNull();
			expect(rowInPlaceExpansionState(queryWarmRow())).toBe("expanded_in_place_by_hover");

			await act(async () => {
				document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
			});
			expect(rowInPlaceExpansionState(queryWarmRow())).toBe("compact_row");
		} finally {
			if (previousClipboardDescriptor) {
				Object.defineProperty(navigator, "clipboard", previousClipboardDescriptor);
			} else {
				Reflect.deleteProperty(navigator, "clipboard");
			}
		}
	});

	it("对非当前项目的卡取消置顶走 runtime；当前项目的卡走浏览器既有链路", async () => {
		const host = makeHost();
		act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
		const unpinOtherProject = section("pinned").querySelector<HTMLButtonElement>(
			'[aria-label="Unpin from Pinboard"]',
		);
		await act(async () => unpinOtherProject?.click());
		// 与当前项目同一个 taskCardAction 命令，只是不带 overlay。
		expect(setTaskPinboardPinStateOfTaskCardInWorkspace).toHaveBeenCalledWith("project-b", {
			taskPinboardPinAction: "unpin_task_card",
			taskId: "recent",
			boardMutationInitiator: "web_ui_user_gesture",
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
