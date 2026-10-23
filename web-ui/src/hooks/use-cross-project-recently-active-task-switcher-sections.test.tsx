import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import type {
	RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse,
	RuntimeCrossProjectTaskSwitcherEntry,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	resetCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";

const fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/cross-project-recently-active-task-switcher-query", () => ({
	fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon,
}));

type SectionsInputs = Parameters<typeof useCrossProjectRecentlyActiveTaskSwitcherSections>[0];
type SectionsModel = ReturnType<typeof useCrossProjectRecentlyActiveTaskSwitcherSections>;
type ExtendedActivityHorizonSnapshot = RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse;

const INITIAL_NOW_MS = Date.UTC(2026, 9, 18, 12);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function makeExtendedActivityHorizonSnapshot(taskId: string): ExtendedActivityHorizonSnapshot {
	return {
		activityHorizonMs: 30 * DAY_MS,
		projects: [
			{
				workspaceId: "project-a",
				crossProjectTaskSwitcherEntries: [
					{
						...makeRecentlyRunningTaskEntry(),
						taskId,
						turnOwner: null,
						liveness: "none",
						lastOutputAt: null,
						taskDescriptionLastUpdatedAt: INITIAL_NOW_MS - 20 * DAY_MS,
					},
				],
			},
		],
	};
}

function makeRecentlyRunningTaskEntry(): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		taskId: "recently-running",
		title: "最近运行的任务",
		agentId: "codex",
		createdAt: INITIAL_NOW_MS - 60 * MINUTE_MS,
		columnId: "in_progress",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		lastOutputAt: INITIAL_NOW_MS - 4 * MINUTE_MS,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		taskDescriptionLastUpdatedAt: INITIAL_NOW_MS - MINUTE_MS,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
	};
}

function makeInputs(): SectionsInputs {
	return {
		isTaskSwitcherSectionModelActive: true,
		currentProjectId: "project-a",
		notificationLogByWorkspaceId: {},
		projects: [
			{
				id: "project-a",
				path: "/repos/project-a",
				name: "project-a",
				taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
				availability: { status: "available" },
				inProgressTaskDetails: [],
				crossProjectTaskSwitcherEntries: [makeRecentlyRunningTaskEntry()],
			},
		],
	};
}

function deferredSnapshotRequest() {
	let resolve!: (snapshot: ExtendedActivityHorizonSnapshot) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<ExtendedActivityHorizonSnapshot>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("跨项目共享分区模型的活动生命周期", () => {
	let root: Root;
	let inputs: SectionsInputs;
	let model: SectionsModel;
	let renderCount: number;

	function SectionsModelHarness() {
		model = useCrossProjectRecentlyActiveTaskSwitcherSections(inputs);
		renderCount += 1;
		return null;
	}
	function render(changes: Partial<SectionsInputs> = {}) {
		inputs = { ...inputs, ...changes };
		act(() => root.render(<SectionsModelHarness />));
	}
	async function advanceTime(elapsedMs: number) {
		await act(async () => {
			vi.advanceTimersByTime(elapsedMs);
		});
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.useFakeTimers();
		vi.setSystemTime(INITIAL_NOW_MS);
		window.localStorage.clear();
		resetCrossProjectTaskSwitcherPanelViewContinuity();
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockReset();
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue({
			activityHorizonMs: 30 * DAY_MS,
			projects: [],
		});
		inputs = makeInputs();
		renderCount = 0;
		root = createRoot(document.createElement("div"));
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("首次停用挂载即暂停 tick 与记忆快照刷新，启用时立即按当前时间分组", async () => {
		writeCrossProjectTaskSwitcherPanelViewContinuity({
			entriesWithinExtendedActivityHorizon: makeExtendedActivityHorizonSnapshot("remembered-older"),
		});
		render({ isTaskSwitcherSectionModelActive: false });
		const inactiveRenderCount = renderCount;
		await advanceTime(10 * MINUTE_MS);
		expect(renderCount).toBe(inactiveRenderCount);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).not.toHaveBeenCalled();

		await act(async () => render({ isTaskSwitcherSectionModelActive: true }));
		expect(model.nowMs).toBe(INITIAL_NOW_MS + 10 * MINUTE_MS);
		expect(model.sections.runningEntries).toEqual([]);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledTimes(1);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledWith("project-a");
	});

	it("Recent 和 Cache warm 默认展开，阶段默认 In progress / Review；导航保留，刷新恢复默认", () => {
		render({ allProjectsTaskSwitcherView: "kanban_board" });
		expect(model.isRecentSectionExpanded).toBe(true);
		expect(model.isPromptCacheWarmSectionExpanded).toBe(true);
		expect(model.selectedRecentTaskStageFilters).toEqual(["in_progress_and_review"]);
		expect(model.selectedRecentProjectWorkspaceIds).toEqual([]);
		act(() => {
			model.setIsRecentSectionExpanded(false);
			model.setIsPromptCacheWarmSectionExpanded(false);
			model.setSelectedRecentTaskStageFilters(["backlog", "done"]);
			model.setSelectedRecentProjectWorkspaceIds(["project-a"]);
		});
		render({ allProjectsTaskSwitcherView: "task_focus", currentProjectId: "project-b" });
		expect(model.isRecentSectionExpanded).toBe(false);
		expect(model.isPromptCacheWarmSectionExpanded).toBe(false);
		expect(model.selectedRecentTaskStageFilters).toEqual(["backlog", "done"]);
		expect(model.selectedRecentProjectWorkspaceIds).toEqual(["project-a"]);
		act(() => root.unmount());
		root = createRoot(document.createElement("div"));
		render();
		expect(model.isRecentSectionExpanded).toBe(true);
		expect(model.isPromptCacheWarmSectionExpanded).toBe(true);
		expect(model.selectedRecentTaskStageFilters).toEqual(["in_progress_and_review"]);
		expect(model.selectedRecentProjectWorkspaceIds).toEqual([]);
	});

	it("旧 Unread + opened 排序偏好回落 Recently touched，现有 Conversation progress 偏好继续生效", () => {
		window.localStorage.setItem(
			LocalStorageKey.CrossProjectTaskSwitcherRemainingSectionOrderingMode,
			"unread_handoffs_then_recently_opened_by_user",
		);
		render();
		expect(model.remainingSectionOrderingMode).toBe(
			"most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
		);
		act(() => model.setRemainingSectionOrderingMode("most_recent_conversation_progress_only"));
		expect(window.localStorage.getItem(LocalStorageKey.CrossProjectTaskSwitcherRemainingSectionOrderingMode)).toBe(
			"most_recent_conversation_progress_only",
		);
	});

	it("扩展快照中的旧 Backlog 可进入 Recent，更新快照后删除的卡不复活", async () => {
		const snapshot = makeExtendedActivityHorizonSnapshot("old-backlog");
		const entry = snapshot.projects[0]?.crossProjectTaskSwitcherEntries[0];
		if (!entry) throw new Error("缺少旧快照测试条目");
		entry.columnId = "backlog";
		writeCrossProjectTaskSwitcherPanelViewContinuity({ entriesWithinExtendedActivityHorizon: snapshot });
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValue({
			activityHorizonMs: 30 * DAY_MS,
			projects: [],
		});
		render();
		act(() => model.setSelectedRecentTaskStageFilters([]));
		expect(model.sections.remainingSection.entries.map(({ entry }) => entry.taskId)).toEqual(["old-backlog"]);
		await advanceTime(30_000);
		expect(model.sections.remainingSection.entries).toEqual([]);
	});

	it("活动期间保留 30 秒 tick，停用后不重渲染，恢复时不等下一次 tick", async () => {
		render();
		expect(model.sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["recently-running"]);
		await advanceTime(30_000);
		expect(model.nowMs).toBe(INITIAL_NOW_MS + 30_000);
		render({ isTaskSwitcherSectionModelActive: false });
		const inactiveRenderCount = renderCount;
		await advanceTime(10 * MINUTE_MS);
		expect(renderCount).toBe(inactiveRenderCount);
		render({ isTaskSwitcherSectionModelActive: true });
		expect(model.nowMs).toBe(INITIAL_NOW_MS + 30_000 + 10 * MINUTE_MS);
		expect(model.sections.runningEntries).toEqual([]);
		await advanceTime(30_000);
		expect(model.nowMs).toBe(INITIAL_NOW_MS + MINUTE_MS + 10 * MINUTE_MS);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).not.toHaveBeenCalled();
	});

	it.each(["resolved", "rejected"] as const)("停用前首次加载的迟到结果不写入模型与记忆：%s", async (outcome) => {
		const pendingRequest = deferredSnapshotRequest();
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockReturnValueOnce(pendingRequest.promise);
		render();
		act(() => model.requestEntriesWithinExtendedActivityHorizon());
		expect(model.extendedActivityHorizonLoadState).toBe("loading");
		render({ isTaskSwitcherSectionModelActive: false });
		const inactiveRenderCount = renderCount;
		await act(async () => {
			if (outcome === "resolved") pendingRequest.resolve(makeExtendedActivityHorizonSnapshot("late-older"));
			else pendingRequest.reject(new Error("停用后才返回的失败"));
		});
		expect(renderCount).toBe(inactiveRenderCount);
		expect(readCrossProjectTaskSwitcherPanelViewContinuity().entriesWithinExtendedActivityHorizon).toBeNull();
		render({ isTaskSwitcherSectionModelActive: true });
		expect(model.extendedActivityHorizonLoadState).toBe("not_requested");
		const currentSnapshot = makeExtendedActivityHorizonSnapshot("current-older");
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValueOnce(currentSnapshot);
		await act(async () => model.requestEntriesWithinExtendedActivityHorizon());
		expect(model.extendedActivityHorizonLoadState).toBe("loaded");
		expect(readCrossProjectTaskSwitcherPanelViewContinuity().entriesWithinExtendedActivityHorizon).toBe(
			currentSnapshot,
		);
	});

	it("扩展期间停用即停止查询，恢复立即刷新，停用前的周期请求不能覆盖恢复后的快照", async () => {
		const initialSnapshot = makeExtendedActivityHorizonSnapshot("initial-older");
		writeCrossProjectTaskSwitcherPanelViewContinuity({ entriesWithinExtendedActivityHorizon: initialSnapshot });
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValueOnce(initialSnapshot);
		await act(async () => render());
		const pendingPeriodicRequest = deferredSnapshotRequest();
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockReturnValueOnce(
			pendingPeriodicRequest.promise,
		);
		await advanceTime(30_000);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledTimes(2);
		render({ isTaskSwitcherSectionModelActive: false });
		const inactiveRenderCount = renderCount;
		await advanceTime(10 * MINUTE_MS);
		expect(renderCount).toBe(inactiveRenderCount);
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledTimes(2);
		const resumedSnapshot = makeExtendedActivityHorizonSnapshot("resumed-older");
		fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.mockResolvedValueOnce(resumedSnapshot);
		await act(async () => render({ isTaskSwitcherSectionModelActive: true }));
		expect(fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon).toHaveBeenCalledTimes(3);
		await act(async () =>
			pendingPeriodicRequest.resolve(makeExtendedActivityHorizonSnapshot("stale-periodic-older")),
		);
		expect(readCrossProjectTaskSwitcherPanelViewContinuity().entriesWithinExtendedActivityHorizon).toBe(
			resumedSnapshot,
		);
	});
});
