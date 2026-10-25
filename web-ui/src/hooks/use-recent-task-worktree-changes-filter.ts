import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { useMemo, useSyncExternalStore } from "react";
import { selectTaskWorktreeGitMetadataSnapshotForCrossProjectTaskSwitcherEntry } from "@/hooks/use-task-worktree-git-metadata-for-cross-project-task-switcher-entry";
import {
	getCrossProjectTaskWorktreeGitMetadataPollObservation,
	subscribeToCrossProjectTaskWorktreeGitMetadataEntry,
} from "@/stores/cross-project-task-worktree-git-metadata-store";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	subscribeToAnyTaskMetadata,
} from "@/stores/workspace-metadata-store";

interface RecentTaskWorktreeChangesFilterObservation {
	matchesWorktreeChangesFilter: boolean;
	metadataLoadState: "ready" | "pending" | "unavailable";
}

function readRecentTaskWorktreeChangesFilterObservation(
	{ workspaceId, entry }: CrossProjectTaskSwitcherEntryInProject,
	currentProjectId: string | null,
): RecentTaskWorktreeChangesFilterObservation {
	const doesNotMatch = { matchesWorktreeChangesFilter: false, metadataLoadState: "ready" } as const;
	if (entry.columnId === "backlog") return doesNotMatch;
	const polled = getCrossProjectTaskWorktreeGitMetadataPollObservation(workspaceId, entry.taskId);
	// 与行上的元数据取数口径一致；按 taskId 分键的推流只允许服务当前项目。
	const currentProjectSnapshot = workspaceId === currentProjectId ? getTaskWorkspaceSnapshot(entry.taskId) : null;
	const currentProjectWorktreeExists =
		workspaceId === currentProjectId ? (getTaskWorkspaceInfo(entry.taskId)?.exists ?? null) : null;
	const { snapshot, usesCurrentProjectStreamSnapshot } =
		selectTaskWorktreeGitMetadataSnapshotForCrossProjectTaskSwitcherEntry({
			currentProjectSnapshot,
			currentProjectWorktreeExists,
			polledSnapshot: polled?.snapshot ?? null,
		});
	const worktreeExists = usesCurrentProjectStreamSnapshot ? currentProjectWorktreeExists : polled?.worktreeExists;
	const metadataLoadState =
		!usesCurrentProjectStreamSnapshot && polled?.pollStatus === "unavailable"
			? "unavailable"
			: !snapshot && !currentProjectSnapshot && (!polled || polled.pollStatus === "loading")
				? "pending"
				: "ready";
	if (worktreeExists === false || snapshot?.workspaceGitStatusObservationSource === "persisted_final_snapshot") {
		return { ...doesNotMatch, metadataLoadState };
	}
	if (!snapshot) {
		return {
			matchesWorktreeChangesFilter: false,
			metadataLoadState: metadataLoadState === "pending" ? "pending" : "unavailable",
		};
	}
	const matchesWorktreeChangesFilter = (snapshot.changedFiles ?? 0) > 0 || (snapshot.commitsAheadOfBaseRef ?? 0) > 0;
	return {
		matchesWorktreeChangesFilter,
		metadataLoadState:
			!matchesWorktreeChangesFilter && (snapshot.changedFiles === null || snapshot.commitsAheadOfBaseRef === null)
				? "unavailable"
				: metadataLoadState,
	};
}

const EMPTY_FILTER_OBSERVATIONS: readonly RecentTaskWorktreeChangesFilterObservation[] = [];

// 订阅筛选前候选，包含当前被隐藏的任务；快照只随判定变化，逐行输出和轮询时间不会重绘整个列表。
export function useRecentTaskWorktreeChangesFilter({
	entries,
	currentProjectId,
	isEnabled,
}: {
	entries: readonly CrossProjectTaskSwitcherEntryInProject[];
	currentProjectId: string | null;
	isEnabled: boolean;
}) {
	const { subscribe, getSnapshot } = useMemo(() => {
		let cachedObservations = EMPTY_FILTER_OBSERVATIONS;
		return {
			subscribe: (listener: () => void) => {
				if (!isEnabled) return () => {};
				const currentProjectTaskIds = new Set(
					entries.filter(({ workspaceId }) => workspaceId === currentProjectId).map(({ entry }) => entry.taskId),
				);
				const unsubscribeCallbacks = entries.map(({ workspaceId, entry }) =>
					subscribeToCrossProjectTaskWorktreeGitMetadataEntry(
						buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId),
						listener,
					),
				);
				unsubscribeCallbacks.push(
					subscribeToAnyTaskMetadata((taskId) => {
						if (currentProjectTaskIds.has(taskId)) listener();
					}),
				);
				return () => {
					for (const unsubscribe of unsubscribeCallbacks) unsubscribe();
				};
			},
			getSnapshot: () => {
				if (!isEnabled) return EMPTY_FILTER_OBSERVATIONS;
				const observations = entries.map((entry) =>
					readRecentTaskWorktreeChangesFilterObservation(entry, currentProjectId),
				);
				if (
					observations.length !== cachedObservations.length ||
					observations.some(
						(observation, index) =>
							observation.matchesWorktreeChangesFilter !==
								cachedObservations[index]?.matchesWorktreeChangesFilter ||
							observation.metadataLoadState !== cachedObservations[index]?.metadataLoadState,
					)
				) {
					cachedObservations = observations;
				}
				return cachedObservations;
			},
		};
	}, [entries, currentProjectId, isEnabled]);
	const observations = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_FILTER_OBSERVATIONS);
	return useMemo(
		() => ({
			matchingEntryKeys: new Set(
				entries
					.filter((_, index) => observations[index]?.matchesWorktreeChangesFilter)
					.map(({ workspaceId, entry }) => buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId)),
			),
			pendingCount: observations.filter(({ metadataLoadState }) => metadataLoadState === "pending").length,
			unavailableCount: observations.filter(({ metadataLoadState }) => metadataLoadState === "unavailable").length,
		}),
		[entries, observations],
	);
}
