import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CrossProjectRecentlyActiveTaskSwitcherSectionsModel,
	useCrossProjectRecentlyActiveTaskSwitcherSections,
} from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import { useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry } from "@/hooks/use-task-worktree-git-metadata-for-cross-project-task-switcher-entry";
import type { RuntimeProjectSummary, RuntimeTaskWorkspaceMetadata } from "@/runtime/types";
import {
	applyCrossProjectTaskWorktreeGitMetadataPollResults,
	getCrossProjectTaskWorktreeGitMetadataPollObservation,
	markCrossProjectTaskWorktreeGitMetadataPollFailed,
	resetCrossProjectTaskWorktreeGitMetadataStore,
} from "@/stores/cross-project-task-worktree-git-metadata-store";
import { replaceWorkspaceMetadata, resetWorkspaceMetadataStore } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";
import {
	createRecentTaskSwitcherEntryTestFixture,
	createRecentTaskSwitcherProjectTestFixture,
	createRecentTaskWorktreeMetadataTestFixture,
	createRecentTaskWorktreeUnavailableGitProbeMetadataTestFixture,
} from "../../tests/recent-task-worktree-changes-filter-fixtures";

const failedProbeMetadataOverrides = createRecentTaskWorktreeUnavailableGitProbeMetadataTestFixture("task-a");
const unavailableBaseRelationship = failedProbeMetadataOverrides.workspaceGitStatus;

describe("Recent 工作树改动筛选的共享分区模型", () => {
	let root: Root;
	let model: CrossProjectRecentlyActiveTaskSwitcherSectionsModel;
	let projects: RuntimeProjectSummary[];
	let currentProjectId: string;
	let rowSnapshotByWorkspaceId: Record<string, ReviewTaskWorkspaceSnapshot | null>;
	function Harness() {
		model = useCrossProjectRecentlyActiveTaskSwitcherSections({
			projects,
			currentProjectId,
			notificationLogByWorkspaceId: {},
		});
		rowSnapshotByWorkspaceId = {
			"project-a": useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry(
				"project-a",
				"task-a",
				currentProjectId,
			),
			"project-b": useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry(
				"project-b",
				"task-a",
				currentProjectId,
			),
		};
		return null;
	}
	function render() {
		act(() => root.render(<Harness />));
	}
	function observe(taskId: string, overrides: Partial<RuntimeTaskWorkspaceMetadata> = {}, workspaceId = "project-a") {
		act(() =>
			applyCrossProjectTaskWorktreeGitMetadataPollResults([
				{
					workspaceId,
					taskId,
					availability: "available",
					taskWorkspaceMetadata: createRecentTaskWorktreeMetadataTestFixture(taskId, overrides),
				},
			]),
		);
	}
	function recentTaskIds() {
		return model.sections.remainingSection.entries.map(({ workspaceId, entry }) => `${workspaceId}:${entry.taskId}`);
	}
	function pushCurrentProjectMetadata(overrides: Partial<RuntimeTaskWorkspaceMetadata>) {
		act(() =>
			replaceWorkspaceMetadata({
				homeGitSummary: null,
				homeGitStateVersion: 0,
				taskWorkspaces: [createRecentTaskWorktreeMetadataTestFixture("task-a", overrides)],
			}),
		);
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		window.localStorage.clear();
		resetWorkspaceMetadataStore();
		resetCrossProjectTaskWorktreeGitMetadataStore();
		currentProjectId = "project-a";
		projects = [
			createRecentTaskSwitcherProjectTestFixture("project-a", [createRecentTaskSwitcherEntryTestFixture("task-a")]),
		];
		root = createRoot(document.createElement("div"));
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.unstubAllGlobals();
	});

	it("默认关闭，跨视图及项目切换保留，重新挂载模型恢复关闭", () => {
		render();
		expect(model.showsOnlyRecentTasksWithWorktreeChanges).toBe(false);
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		currentProjectId = "project-b";
		render();
		expect(model.showsOnlyRecentTasksWithWorktreeChanges).toBe(true);
		act(() => root.unmount());
		root = createRoot(document.createElement("div"));
		render();
		expect(model.showsOnlyRecentTasksWithWorktreeChanges).toBe(false);
	});

	it.each([
		["仅未提交改动", { changedFiles: 1 }, true, 0],
		["仅独有提交", { commitsAheadOfBaseRef: 2 }, true, 0],
		["两者都有", { changedFiles: 1, commitsAheadOfBaseRef: 2 }, true, 0],
		["只有 behind", { commitsBehindBaseRef: 3 }, false, 0],
		["已知无改动", {}, false, 0],
		["dirty 且 ahead 未知", { changedFiles: 1, commitsAheadOfBaseRef: null }, true, 0],
		["ahead 且 dirty 未知", { changedFiles: null, commitsAheadOfBaseRef: 1 }, true, 0],
		["没有正向证据且 dirty 未知", { changedFiles: null }, false, 1],
		["没有正向证据且 ahead 未知", { commitsAheadOfBaseRef: null }, false, 1],
		["工作树已删除但保留历史 ahead", { exists: false, commitsAheadOfBaseRef: 5 }, false, 0],
	] as const)("%s", (_, overrides, matches, unavailableCount) => {
		observe("task-a", overrides);
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual(matches ? ["project-a:task-a"] : []);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(unavailableCount);
	});

	it("隐藏任务的后续改动、提交及合入实时改变列表，筛选前候选始终保留供轮询", () => {
		observe("task-a");
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual([]);
		expect(model.sectionsBeforeRecentWorktreeChangesFilter.remainingSection.entries).toHaveLength(1);
		observe("task-a", { changedFiles: 1 });
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		observe("task-a", { changedFiles: 0, commitsAheadOfBaseRef: 1 });
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		observe("task-a");
		expect(recentTaskIds()).toEqual([]);
	});

	it("未知、失败和恢复可观察，网络失败保留上次已知命中", () => {
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(model.recentTaskWorktreeChangesFilterPendingCount).toBe(1);
		act(() => markCrossProjectTaskWorktreeGitMetadataPollFailed([{ workspaceId: "project-a", taskId: "task-a" }]));
		expect(model.recentTaskWorktreeChangesFilterPendingCount).toBe(0);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(1);
		observe("task-a", { changedFiles: 1 });
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(0);
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		act(() =>
			applyCrossProjectTaskWorktreeGitMetadataPollResults([
				{
					workspaceId: "project-a",
					taskId: "task-a",
					availability: "unavailable",
					unavailableReason: "git_metadata_probe_failed",
				},
			]),
		);
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(1);
		act(() => markCrossProjectTaskWorktreeGitMetadataPollFailed([{ workspaceId: "project-a", taskId: "task-a" }]));
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(1);
		observe("task-a");
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(0);
		expect(recentTaskIds()).toEqual([]);
	});

	it.each([{ changedFiles: 1 }, { commitsAheadOfBaseRef: 2 }])(
		"外层 available 的全未知探针失败保留可信快照并提示不可用：%j",
		(previousPositiveCounts) => {
			observe("task-a", previousPositiveCounts);
			render();
			act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
			const previousSnapshot = getCrossProjectTaskWorktreeGitMetadataPollObservation(
				"project-a",
				"task-a",
			)?.snapshot;
			observe("task-a", failedProbeMetadataOverrides);
			expect(recentTaskIds()).toEqual(["project-a:task-a"]);
			expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(1);
			expect(getCrossProjectTaskWorktreeGitMetadataPollObservation("project-a", "task-a")).toMatchObject({
				pollStatus: "unavailable",
				worktreeExists: true,
			});
			expect(rowSnapshotByWorkspaceId["project-a"]).toBe(previousSnapshot);
			observe("task-a");
			expect(recentTaskIds()).toEqual([]);
			expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(0);
		},
	);

	it("没有可信旧快照时，全未知探针失败保持未知并提示不可用", () => {
		observe("task-a", failedProbeMetadataOverrides);
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual([]);
		expect(model.recentTaskWorktreeChangesFilterPendingCount).toBe(0);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(1);
		expect(rowSnapshotByWorkspaceId["project-a"]).toBeNull();
	});

	it.each([{ changedFiles: 1 }, { commitsAheadOfBaseRef: 2 }])(
		"当前项目全未知推流不压过有效轮询，行与筛选来源一致且跨项目同号隔离：%j",
		(polledPositiveCounts) => {
			projects.push(
				createRecentTaskSwitcherProjectTestFixture("project-b", [
					createRecentTaskSwitcherEntryTestFixture("task-a"),
				]),
			);
			observe("task-a", polledPositiveCounts);
			observe("task-a", {}, "project-b");
			pushCurrentProjectMetadata(failedProbeMetadataOverrides);
			render();
			act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
			expect(recentTaskIds()).toEqual(["project-a:task-a"]);
			expect(rowSnapshotByWorkspaceId["project-a"]).toMatchObject(polledPositiveCounts);
			expect(rowSnapshotByWorkspaceId["project-b"]).toMatchObject({ changedFiles: 0, commitsAheadOfBaseRef: 0 });
			pushCurrentProjectMetadata({});
			expect(recentTaskIds()).toEqual([]);
			expect(rowSnapshotByWorkspaceId["project-a"]).toMatchObject({ changedFiles: 0, commitsAheadOfBaseRef: 0 });
		},
	);

	it.each(["推流", "轮询"])("base 关系未知时仍接受独立的 dirty 正向证据：%s", (source) => {
		const dirtyWithUnknownBaseRelationship = {
			changedFiles: 1,
			commitsAheadOfBaseRef: null,
			commitsBehindBaseRef: null,
			workspaceGitStatus: unavailableBaseRelationship,
		};
		if (source === "推流") pushCurrentProjectMetadata(dirtyWithUnknownBaseRelationship);
		else observe("task-a", dirtyWithUnknownBaseRelationship);
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(0);
		expect(rowSnapshotByWorkspaceId["project-a"]).toMatchObject({ changedFiles: 1, commitsAheadOfBaseRef: null });
	});

	it.each(["推流", "轮询"])("历史快照不会作为实时命中：%s", (source) => {
		const historicalSnapshot = createRecentTaskWorktreeMetadataTestFixture("task-a", { commitsAheadOfBaseRef: 5 });
		historicalSnapshot.workspaceGitStatus.observationSource = "persisted_final_snapshot";
		observe("task-a", { changedFiles: 1 });
		if (source === "推流") pushCurrentProjectMetadata(historicalSnapshot);
		else observe("task-a", historicalSnapshot);
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual([]);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(0);
	});

	it("当前项目明确报告工作树已删除时，不回落到旧轮询命中", () => {
		observe("task-a", { changedFiles: 1 });
		pushCurrentProjectMetadata({ exists: false, changedFiles: null, commitsAheadOfBaseRef: null });
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual([]);
		expect(model.recentTaskWorktreeChangesFilterUnavailableCount).toBe(0);
	});

	it("当前项目优先推流、其他项目使用复合键轮询，切项目不混用同号任务", () => {
		projects.push(
			createRecentTaskSwitcherProjectTestFixture("project-b", [createRecentTaskSwitcherEntryTestFixture("task-a")]),
		);
		observe("task-a");
		observe("task-a", {}, "project-b");
		act(() =>
			replaceWorkspaceMetadata({
				homeGitSummary: null,
				homeGitStateVersion: 0,
				taskWorkspaces: [createRecentTaskWorktreeMetadataTestFixture("task-a", { changedFiles: 1 })],
			}),
		);
		render();
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		act(() => resetWorkspaceMetadataStore());
		currentProjectId = "project-b";
		render();
		expect(recentTaskIds()).toEqual([]);
		observe("task-a", { commitsAheadOfBaseRef: 1 }, "project-b");
		expect(recentTaskIds()).toEqual(["project-b:task-a"]);
	});

	it("与项目、阶段、时间窗取交集，Pinned、Running、Cache warm 不受影响", () => {
		const entry = createRecentTaskSwitcherEntryTestFixture;
		projects = [
			createRecentTaskSwitcherProjectTestFixture("project-a", [
				entry("pinned", { pinnedToTaskPinboardAt: 1 }),
				entry("running", { turnOwner: "agent", liveness: "live" }),
				entry("warm", {
					agentId: "claude",
					lastAgentConversationPromptCacheReferenceObservation: {
						observedAtMs: Date.now(),
						evidenceKind: "post_tool_use_hook_event",
					},
				}),
				entry("backlog", { columnId: "backlog" }),
			]),
			createRecentTaskSwitcherProjectTestFixture("project-b", [
				entry("review"),
				entry("validation", { columnId: "validation" }),
				entry("done", { columnId: "trash" }),
				entry("old", {
					taskDescriptionLastUpdatedAt: Date.now() - 40 * 86_400_000,
					createdAt: Date.now() - 40 * 86_400_000,
				}),
			]),
		];
		for (const taskId of ["review", "validation", "done", "old"]) observe(taskId, { changedFiles: 1 }, "project-b");
		render();
		act(() => {
			model.setShowsOnlyRecentTasksWithWorktreeChanges(true);
			model.setSelectedRecentProjectWorkspaceIds(["project-b"]);
			model.setSelectedRecentTaskStageFilters(["validation", "done"]);
		});
		expect(new Set(recentTaskIds())).toEqual(new Set(["project-b:validation", "project-b:done"]));
		expect(model.sections.pinnedEntries.map(({ entry }) => entry.taskId)).toEqual(["pinned"]);
		expect(model.sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["running"]);
		expect(model.sections.promptCacheWarmAwaitingUserEntries.map(({ entry }) => entry.taskId)).toEqual(["warm"]);
		act(() => {
			model.setSelectedRecentProjectWorkspaceIds([]);
			model.setSelectedRecentTaskStageFilters([]);
		});
		expect(recentTaskIds()).not.toContain("project-a:backlog");
		expect(recentTaskIds()).not.toContain("project-b:old");
	});

	it("切换开关解除 Recent 导航顺序锁，开关关闭恢复全部候选", () => {
		projects[0]!.crossProjectTaskSwitcherEntries.push(
			createRecentTaskSwitcherEntryTestFixture("task-b", { lastOpenedByUserAt: Date.now() }),
		);
		observe("task-a", { changedFiles: 1 });
		observe("task-b", { changedFiles: 1 });
		render();
		act(() => model.beginRecentSectionKeyboardNavigationOrderLock());
		projects = projects.map((project) => ({
			...project,
			crossProjectTaskSwitcherEntries: project.crossProjectTaskSwitcherEntries.map((entry) => ({
				...entry,
				lastOpenedByUserAt: entry.taskId === "task-a" ? Date.now() + 1_000 : entry.lastOpenedByUserAt,
			})),
		}));
		render();
		expect(recentTaskIds()).toEqual(["project-a:task-b", "project-a:task-a"]);
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(true));
		expect(recentTaskIds()).toEqual(["project-a:task-a", "project-a:task-b"]);
		observe("task-b");
		expect(recentTaskIds()).toEqual(["project-a:task-a"]);
		act(() => model.setShowsOnlyRecentTasksWithWorktreeChanges(false));
		expect(recentTaskIds()).toEqual(["project-a:task-a", "project-a:task-b"]);
	});
});
