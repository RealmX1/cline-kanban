import { z } from "zod";

export const VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY = "kanban:visited-task-navigation-history:v1";
const VISITED_TASK_NAVIGATION_HISTORY_LIMIT = 200;

const visitedTaskHistoryEntrySchema = z.object({
	workspaceId: z.string().min(1),
	taskId: z.string().min(1),
	taskIncarnationCreatedAtEpochMs: z.number().finite().nonnegative(),
	workspaceIdsUsedByTaskIncarnation: z.array(z.string().min(1)).max(200).optional(),
	titleSnapshot: z.string(),
	projectNameSnapshot: z.string(),
	lastVisitedAtEpochMs: z.number().finite().nonnegative(),
	unavailable: z.boolean(),
});
export type VisitedTaskHistoryEntry = z.infer<typeof visitedTaskHistoryEntrySchema>;
export type VisitedTaskIdentity = Pick<
	VisitedTaskHistoryEntry,
	"workspaceId" | "taskId" | "taskIncarnationCreatedAtEpochMs" | "workspaceIdsUsedByTaskIncarnation"
>;

const visitedTaskNavigationHistorySchema = z
	.object({
		schemaVersion: z.literal(1),
		recentTasks: z.array(visitedTaskHistoryEntrySchema).max(VISITED_TASK_NAVIGATION_HISTORY_LIMIT),
		navigationPath: z.array(visitedTaskHistoryEntrySchema).max(VISITED_TASK_NAVIGATION_HISTORY_LIMIT),
		cursor: z.number().int().min(-1),
	})
	.refine((history) =>
		history.navigationPath.length === 0
			? history.cursor === -1
			: history.cursor >= 0 && history.cursor < history.navigationPath.length,
	);
export type VisitedTaskNavigationHistory = z.infer<typeof visitedTaskNavigationHistorySchema>;

export function createEmptyVisitedTaskNavigationHistory(): VisitedTaskNavigationHistory {
	return { schemaVersion: 1, recentTasks: [], navigationPath: [], cursor: -1 };
}

export function isSameVisitedTaskIdentity(left: VisitedTaskIdentity, right: VisitedTaskIdentity): boolean {
	return (
		left.taskId === right.taskId &&
		left.taskIncarnationCreatedAtEpochMs === right.taskIncarnationCreatedAtEpochMs &&
		(left.workspaceId === right.workspaceId ||
			left.workspaceIdsUsedByTaskIncarnation?.includes(right.workspaceId) === true ||
			right.workspaceIdsUsedByTaskIncarnation?.includes(left.workspaceId) === true)
	);
}

export function parseVisitedTaskNavigationHistory(raw: string | null): VisitedTaskNavigationHistory {
	try {
		const parsed = visitedTaskNavigationHistorySchema.safeParse(JSON.parse(raw ?? "null"));
		return parsed.success ? parsed.data : createEmptyVisitedTaskNavigationHistory();
	} catch {
		return createEmptyVisitedTaskNavigationHistory();
	}
}

function updateRecentlyVisitedTasks(history: VisitedTaskNavigationHistory, entry: VisitedTaskHistoryEntry) {
	return [entry, ...history.recentTasks.filter((task) => !isSameVisitedTaskIdentity(task, entry))].slice(
		0,
		VISITED_TASK_NAVIGATION_HISTORY_LIMIT,
	);
}

export function recordVisitedTask(
	history: VisitedTaskNavigationHistory,
	entry: VisitedTaskHistoryEntry,
): VisitedTaskNavigationHistory {
	const current = history.navigationPath[history.cursor];
	const navigationPath =
		current && isSameVisitedTaskIdentity(current, entry)
			? history.navigationPath.map((task, index) => (index === history.cursor ? entry : task))
			: [...history.navigationPath.slice(0, history.cursor + 1), entry].slice(
					-VISITED_TASK_NAVIGATION_HISTORY_LIMIT,
				);
	return {
		...history,
		recentTasks: updateRecentlyVisitedTasks(history, entry),
		navigationPath,
		cursor: current && isSameVisitedTaskIdentity(current, entry) ? history.cursor : navigationPath.length - 1,
	};
}

export function visitTaskAtHistoryPathIndex(
	history: VisitedTaskNavigationHistory,
	index: number,
	entry: VisitedTaskHistoryEntry,
): VisitedTaskNavigationHistory {
	if (!history.navigationPath[index]) return history;
	return {
		...history,
		cursor: index,
		recentTasks: updateRecentlyVisitedTasks(history, entry),
		navigationPath: history.navigationPath.map((task, position) => (position === index ? entry : task)),
	};
}

/** 身份刷新后，旧下标落到合并相邻同任务之后的新下标。 */
export function refreshedVisitedTaskPathIndex(
	history: VisitedTaskNavigationHistory,
	previous: VisitedTaskIdentity,
	replacement: VisitedTaskHistoryEntry,
	index: number,
): number {
	return rewriteVisitedTaskHistoryForIdentityRefresh(history, previous, replacement).pathIndexMap[index] ?? index;
}

function rewriteVisitedTaskHistoryForIdentityRefresh(
	history: VisitedTaskNavigationHistory,
	previous: VisitedTaskIdentity,
	replacement: VisitedTaskHistoryEntry,
) {
	const recentTasks = history.recentTasks.map((task) =>
		isSameVisitedTaskIdentity(task, previous) ? replacement : task,
	);
	const rewrittenPath = history.navigationPath.map((task) =>
		isSameVisitedTaskIdentity(task, previous) ? replacement : task,
	);
	const navigationPath: VisitedTaskHistoryEntry[] = [];
	const pathIndexMap: number[] = [];
	for (const task of rewrittenPath) {
		const adjacent = navigationPath.at(-1);
		if (adjacent && isSameVisitedTaskIdentity(adjacent, task)) {
			navigationPath[navigationPath.length - 1] = task;
			pathIndexMap.push(navigationPath.length - 1);
			continue;
		}
		navigationPath.push(task);
		pathIndexMap.push(navigationPath.length - 1);
	}
	return {
		recentTasks: recentTasks.filter(
			(task, index) => recentTasks.findIndex((other) => isSameVisitedTaskIdentity(task, other)) === index,
		),
		navigationPath,
		pathIndexMap,
		cursor: navigationPath.length === 0 ? -1 : (pathIndexMap[history.cursor] ?? navigationPath.length - 1),
	};
}

export function refreshVisitedTaskHistoryEntry(
	history: VisitedTaskNavigationHistory,
	previous: VisitedTaskIdentity,
	replacement: VisitedTaskHistoryEntry,
): VisitedTaskNavigationHistory {
	const rewritten = rewriteVisitedTaskHistoryForIdentityRefresh(history, previous, replacement);
	return {
		...history,
		recentTasks: rewritten.recentTasks,
		navigationPath: rewritten.navigationPath,
		cursor: rewritten.cursor,
	};
}

export function setVisitedTaskUnavailable(history: VisitedTaskNavigationHistory, identity: VisitedTaskIdentity) {
	const markUnavailable = (task: VisitedTaskHistoryEntry) =>
		isSameVisitedTaskIdentity(task, identity) ? { ...task, unavailable: true } : task;
	return {
		...history,
		recentTasks: history.recentTasks.map(markUnavailable),
		navigationPath: history.navigationPath.map(markUnavailable),
	};
}

export function findAdjacentAvailableVisitedTaskPathIndex(
	history: VisitedTaskNavigationHistory,
	direction: -1 | 1,
	fromIndex = history.cursor,
): number | null {
	for (let index = fromIndex + direction; index >= 0 && index < history.navigationPath.length; index += direction) {
		if (!history.navigationPath[index]?.unavailable) return index;
	}
	return null;
}
