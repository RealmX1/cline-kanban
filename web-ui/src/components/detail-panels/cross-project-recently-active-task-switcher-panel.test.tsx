import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	collectCrossProjectTaskSwitcherEntriesInProjects,
	collectUnreadHandoffEntryKeysFromNotificationLog,
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
	return scope?.querySelector<HTMLButtonElement>(IN_LIST_EXPANSION_TOGGLE_SELECTOR) ?? null;
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
		expect(claudeRow?.querySelector('[title^="Prompt cache expected to expire"]')).toBeNull();

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
			section("remaining")
				.querySelector<HTMLButtonElement>(
					'[data-cross-project-task-switcher-task-id="backlog-task"] button:not([aria-expanded])',
				)
				?.click(),
		);

		expect(host.onOpenBacklogTaskEditorInProject).toHaveBeenCalledWith("project-b", "backlog-task");
		expect(host.onOpenTaskInProject).not.toHaveBeenCalled();
	});

	it("其他项目的行 hover：意图期间就隐藏挂载完整卡片、预取服务端快照；停够后这一行在列表里原地换成同一个紧凑卡体（不是浮层），行级信息并进卡体；右上角开关固定展开 / 收起，动作走同一组 taskCardAction 命令（不带 overlay）", async () => {
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
		// 原地：完整卡片就在这一行里（推下方的行），不是 portal 出去的浮层；精简行的首行换掉了。
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		expect(expandedRow?.querySelector("[data-cross-project-task-switcher-row-title]")).toBeNull();
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

	it("交接：指针从展开的行挪到下一行时它不收起，下一行停够意图时长后两行在同一次提交里换过来；坐标没变的指针事件不发起意图；离开面板（延时）与 Esc 收起", async () => {
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
		// 离开展开的行不收起：否则它一收、整列上移，指针脚下换成更下面的行。
		expect(rowInPlaceExpansionState(queryRow("first"))).toBe("expanded_in_place_by_hover");
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

	it.each([
		{ panelScrollTopBeforeHandOffPx: 200, expectedScrollTopPx: 140, expectedTopSpacerPx: 0 },
		// 面板差不多在顶：scrollTop 只够补 30，余下 30 垫成顶部空白。
		{ panelScrollTopBeforeHandOffPx: 30, expectedScrollTopPx: 0, expectedTopSpacerPx: 30 },
	])(
		"交接时收起的行在新行上方：提交后先用 scrollTop、不够再用面板顶部空白补回新行被带着上移的距离，新展开的行停在指针下不动；指针离开面板收起时空白撤掉（scrollTop $panelScrollTopBeforeHandOffPx）",
		async ({ panelScrollTopBeforeHandOffPx, expectedScrollTopPx, expectedTopSpacerPx }) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
			const host = makeHost({
				projects: [
					makeProject("project-a", []),
					makeProject("project-b", [makeEntry("first"), makeEntry("second")]),
				],
			});
			act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
			const queryRow = (taskId: string) =>
				section("remaining").querySelector<HTMLElement>(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
			const panel = container.querySelector<HTMLElement>(
				'[data-testid="cross-project-recently-active-task-switcher-panel"]',
			);
			// 自带 scroll anchoring 关掉，补偿只由 hook 做一次。
			expect(panel?.className).toContain("[overflow-anchor:none]");
			let panelScrollTopPx = panelScrollTopBeforeHandOffPx;
			if (panel) {
				Object.defineProperty(panel, "scrollTop", {
					configurable: true,
					get: () => panelScrollTopPx,
					set: (nextScrollTopPx: number) => {
						panelScrollTopPx = Math.max(0, nextScrollTopPx);
					},
				});
			}
			await hoverRowUntilExpandedInPlace(queryRow("first"));
			const secondRow = queryRow("second");
			if (!secondRow) {
				throw new Error("second row not rendered");
			}
			// 交接前量到 300，上方的 first 收起后量到 240：被带着上移了 60px。
			secondRow.getBoundingClientRect = vi
				.fn<() => DOMRect>()
				.mockReturnValueOnce({ top: 300 } as DOMRect)
				.mockReturnValue({ top: 240 } as DOMRect);
			await movePointerFromRowToRow(queryRow("first"), secondRow);
			await act(async () => {
				vi.advanceTimersByTime(400);
			});
			expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");
			expect(panelScrollTopPx).toBe(expectedScrollTopPx);
			// jsdom 会把 calc 的两项重排，只认垫的那一项。
			if (expectedTopSpacerPx > 0) {
				expect(panel?.style.paddingTop).toContain(`${expectedTopSpacerPx}px`);
			} else {
				expect(panel?.style.paddingTop).toBe("");
			}

			await movePointerOutOfRow(queryRow("second"));
			await act(async () => {
				vi.advanceTimersByTime(400);
			});
			expect(rowInPlaceExpansionState(queryRow("second"))).toBe("compact_row");
			expect(panel?.style.paddingTop).toBe("");
		},
	);

	it.each([
		{
			panelTopSpacerClearingTrigger: "escape_key",
			dispatchPanelTopSpacerClearingTrigger: () =>
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
		},
		{
			panelTopSpacerClearingTrigger: "pointer_down_outside_panel",
			dispatchPanelTopSpacerClearingTrigger: () =>
				document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
		},
	])(
		"交接垫出顶部空白后把这一行固定展开再收起：指针仍在面板里时空白不撤（撤了指针下的行会移动），之后不靠指针离开面板也能撤掉（触屏 / 键盘）（$panelTopSpacerClearingTrigger）",
		async ({ dispatchPanelTopSpacerClearingTrigger }) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			readTaskCardWithBoardColumnInWorkspace.mockReturnValue(new Promise(() => {}));
			const host = makeHost({
				projects: [
					makeProject("project-a", []),
					makeProject("project-b", [makeEntry("first"), makeEntry("second")]),
				],
			});
			act(() => root.render(<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />));
			const queryRow = (taskId: string) =>
				section("remaining").querySelector<HTMLElement>(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
			const panel = container.querySelector<HTMLElement>(
				'[data-testid="cross-project-recently-active-task-switcher-panel"]',
			);
			// 面板差不多在顶：scrollTop 只够补 30，余下 30 垫成顶部空白。
			let panelScrollTopPx = 30;
			if (panel) {
				Object.defineProperty(panel, "scrollTop", {
					configurable: true,
					get: () => panelScrollTopPx,
					set: (nextScrollTopPx: number) => {
						panelScrollTopPx = Math.max(0, nextScrollTopPx);
					},
				});
			}
			await hoverRowUntilExpandedInPlace(queryRow("first"));
			const secondRow = queryRow("second");
			if (!secondRow) {
				throw new Error("second row not rendered");
			}
			secondRow.getBoundingClientRect = vi
				.fn<() => DOMRect>()
				.mockReturnValueOnce({ top: 300 } as DOMRect)
				.mockReturnValue({ top: 240 } as DOMRect);
			await movePointerFromRowToRow(queryRow("first"), secondRow);
			await act(async () => {
				vi.advanceTimersByTime(400);
			});
			expect(rowInPlaceExpansionState(queryRow("second"))).toBe("expanded_in_place_by_hover");
			expect(panel?.style.paddingTop).toContain("30px");

			// 固定展开：hover 记录清掉，空白留着；在面板里按下指针（触屏点开关）也不撤。
			await act(async () => queryInListExpansionToggle(queryRow("second"))?.click());
			expect(rowInPlaceExpansionState(queryRow("second"))).toBe("kept_expanded_in_list");
			expect(panel?.style.paddingTop).toContain("30px");
			await act(async () => {
				queryInListExpansionToggle(queryRow("second"))?.dispatchEvent(
					new MouseEvent("pointerdown", { bubbles: true }),
				);
			});
			expect(panel?.style.paddingTop).toContain("30px");
			await act(async () => queryInListExpansionToggle(queryRow("second"))?.click());
			expect(rowInPlaceExpansionState(queryRow("second"))).toBe("compact_row");
			expect(panel?.style.paddingTop).toContain("30px");

			await act(async () => dispatchPanelTopSpacerClearingTrigger());
			expect(panel?.style.paddingTop).toBe("");
		},
	);

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
		// 与完整卡片同一几何：叠在右上角的 hover 动作组里、是最右一格。
		expect(compactRowToggle?.parentElement?.className).toContain("absolute right-1 top-1");
		expect(compactRowToggle?.parentElement?.lastElementChild).toBe(compactRowToggle);
		expect(
			queryRecentRow()?.querySelector("[data-cross-project-task-switcher-row-leading-activity-indicator]"),
		).not.toBeNull();

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
		// 快照还在读：先画与精简行同一个首行（前导点 + 标题），提示放在下面，开关仍在。
		const unavailableFallback = keptExpandedRow?.querySelector(
			"[data-cross-project-task-switcher-full-task-card-unavailable-fallback]",
		);
		expect(unavailableFallback?.querySelector("[data-cross-project-task-switcher-row-title]")?.textContent).toBe(
			"Title recent",
		);
		expect(
			unavailableFallback
				?.querySelector("[data-cross-project-task-switcher-row-leading-activity-indicator]")
				?.getAttribute("data-cross-project-task-switcher-row-leading-activity-indicator"),
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
		// 首行前导位换成精简行同一个前导点：Pinned 行没有前导点，也不画 In progress 的 Spinner。
		expect(
			pinnedRunningRow?.querySelector("[data-cross-project-task-switcher-row-leading-activity-indicator]"),
		).toBeNull();
		expect(pinnedRunningRow?.querySelector(".animate-spin")).toBeNull();
		act(() => clickTaskCardBodyTitle(pinnedRunningRow));
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "running-pinned");
		expect(rowInPlaceExpansionState(queryRow("pinned", "running-pinned"))).toBe("expanded_in_place_by_hover");
		expect(section("running").querySelector('button[aria-expanded="true"]')).not.toBeNull();
		// Running 区那一行的完整卡有 Running 的脉动前导点，与精简行一致。
		await movePointerFromRowToRow(queryRow("pinned", "running-pinned"), queryRow("running", "running-pinned"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		expect(
			queryRow("running", "running-pinned")
				?.querySelector("[data-cross-project-task-switcher-row-leading-activity-indicator]")
				?.getAttribute("data-cross-project-task-switcher-row-leading-activity-indicator"),
		).toBe("running");

		// 置顶的 Done 卡：本体卡上不可点，这里与精简行一样能打开。
		await movePointerFromRowToRow(queryRow("running", "running-pinned"), queryRow("pinned", "done-pinned"));
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
		act(() => clickTaskCardBodyTitle(queryRow("pinned", "done-pinned")));
		expect(host.onOpenTaskInProject).toHaveBeenLastCalledWith("project-b", "done-pinned");

		// Backlog：原地打开编辑框（与点精简行同一条路径，不是卡体自己的编辑回调）。
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
