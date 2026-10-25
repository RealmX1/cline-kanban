import type { RuntimeAllProjectsTaskGroupQuerySnapshot, RuntimeBoardColumnId } from "./api-contract";
import {
	assignCrossProjectTaskSwitcherSections,
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
} from "./cross-project-recently-active-task-switcher-section-assignment";

export const ALL_PROJECTS_TASK_QUERY_GROUPS = ["pinned", "running", "cache_warm_awaiting_user", "recent"] as const;
export type AllProjectsTaskQueryGroup = (typeof ALL_PROJECTS_TASK_QUERY_GROUPS)[number];

export interface AllProjectsTaskGroupQueryFilters {
	group?: AllProjectsTaskQueryGroup;
	query?: string;
	column?: RuntimeBoardColumnId;
}

export function buildAllProjectsTaskGroupQueryResult(
	snapshot: RuntimeAllProjectsTaskGroupQuerySnapshot,
	filters: AllProjectsTaskGroupQueryFilters,
) {
	const projectPathsByWorkspaceId = new Map(
		snapshot.projects.map((project) => [project.workspaceId, project.projectPath]),
	);
	const sections = assignCrossProjectTaskSwitcherSections({
		entriesInProjects: snapshot.projects.flatMap((project) =>
			project.crossProjectTaskSwitcherEntries.map((entry) => ({
				workspaceId: project.workspaceId,
				projectName: project.projectName,
				entry,
			})),
		),
		nowMs: snapshot.observedAtMs,
		remainingSectionActivityHorizonMs: snapshot.recentDays * 24 * 60 * 60_000,
		remainingSectionOrderingMode: "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
	});
	const entriesByGroup: Record<AllProjectsTaskQueryGroup, readonly CrossProjectTaskSwitcherEntryInProject[]> = {
		pinned: sections.pinnedEntries,
		running: sections.runningEntries,
		cache_warm_awaiting_user: sections.promptCacheWarmAwaitingUserEntries,
		recent: sections.remainingSection.entries,
	};
	const normalizedQuery = filters.query?.trim().toLowerCase() ?? "";
	const matchingTaskKeys = new Set<string>();
	const groups = ALL_PROJECTS_TASK_QUERY_GROUPS.filter((group) => !filters.group || filters.group === group).map(
		(group) => ({
			group,
			tasks: entriesByGroup[group]
				.filter(
					({ entry }) =>
						(!filters.column || entry.columnId === filters.column) &&
						(!normalizedQuery ||
							entry.taskId.toLowerCase().includes(normalizedQuery) ||
							entry.title.toLowerCase().includes(normalizedQuery)),
				)
				.map(({ workspaceId, projectName, entry }) => {
					matchingTaskKeys.add(buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId));
					return { workspaceId, projectName, projectPath: projectPathsByWorkspaceId.get(workspaceId), ...entry };
				}),
		}),
	);
	const complete = snapshot.projects.every((project) => project.taskEntriesReadStatus === "complete");
	return {
		ok: complete,
		scope: "all_projects" as const,
		observedAtMs: snapshot.observedAtMs,
		recentDays: snapshot.recentDays,
		filters: { group: filters.group ?? null, query: filters.query?.trim() ?? null, column: filters.column ?? null },
		coverage: {
			status: complete ? ("complete" as const) : ("incomplete" as const),
			projects: snapshot.projects.map(({ crossProjectTaskSwitcherEntries: _entries, ...coverage }) => coverage),
		},
		groups,
		count: matchingTaskKeys.size,
	};
}

export type AllProjectsTaskGroupQueryResult = ReturnType<typeof buildAllProjectsTaskGroupQueryResult>;
