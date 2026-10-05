import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import {
	collectCrossProjectTaskSwitcherEntriesInProjects,
	collectUnreadHandoffEntryKeysFromNotificationLog,
} from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
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
	it("行上显示 ahead/behind 与未提交改动：其他项目读轮询结果，当前项目读推流 store；Backlog 与无改动不显示", async () => {
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

		// 只请求其他项目、非 Backlog 的条目。
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).toHaveBeenCalledWith("project-a", {
			tasks: [{ workspaceId: "project-b", taskId: "recent" }],
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

	it("其他项目的行展开：按需读服务端快照，渲染同一个紧凑卡体；动作走同一组 taskCardAction 命令（不带 overlay）", async () => {
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
		const recentRow = section("remaining").querySelector<HTMLElement>(
			'[data-cross-project-task-switcher-task-id="recent"]',
		);
		await act(async () => recentRow?.querySelector<HTMLButtonElement>('[aria-label="Expand task card"]')?.click());

		expect(readTaskCardWithBoardColumnInWorkspace).toHaveBeenCalledWith("project-b", "recent");
		expect(recentRow?.getAttribute("data-cross-project-task-switcher-row-expanded")).toBe("true");
		const expandedTaskCard = recentRow?.querySelector(
			'[data-task-card-render-role="expanded_card_copy_in_cross_project_task_switcher_row"]',
		);
		expect(expandedTaskCard?.textContent).toContain("Recent task in project B");
		// 展开副本不持有 DOM 身份（data-task-id 全局唯一属于本体卡）。
		expect(expandedTaskCard?.hasAttribute("data-task-id")).toBe(false);

		await act(async () =>
			expandedTaskCard?.querySelector<HTMLButtonElement>('[aria-label="Move task to validation"]')?.click(),
		);
		expect(moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace).toHaveBeenCalledWith("project-b", {
			taskId: "recent",
			targetBoardColumnId: "validation",
			boardMutationInitiator: "web_ui_user_gesture",
		});
		expect(host.onOpenTaskInProject).not.toHaveBeenCalled();
	});

	it("当前项目的行展开：直接用宿主给的本页 board 与动作，不读服务端", async () => {
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
		const warmRow = section("prompt-cache-warm").querySelector<HTMLElement>(
			'[data-cross-project-task-switcher-task-id="warm"]',
		);
		await act(async () => warmRow?.querySelector<HTMLButtonElement>('[aria-label="Expand task card"]')?.click());

		expect(readTaskCardWithBoardColumnInWorkspace).not.toHaveBeenCalled();
		expect(warmRow?.textContent).toContain("Warm task from the in-browser board");
		await act(async () =>
			warmRow?.querySelector<HTMLButtonElement>('[aria-label="Move task to validation"]')?.click(),
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
