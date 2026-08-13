import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RuntimeNotificationFeedEntry, RuntimeTaskSessionUserTurnKind } from "@/runtime/types";

// 一个通知「组」= 同一 (workspaceId, taskId) 下的全部通知条目。标记最新 = 标记整组（后端置整组已读）。
export interface NotificationGroup {
	key: string;
	workspaceId: string;
	taskId: string;
	repoName: string;
	taskTitle: string;
	latestUserTurnKind: RuntimeTaskSessionUserTurnKind;
	// 组内条目按 triggeredAt 降序（最新在前）。
	entries: RuntimeNotificationFeedEntry[];
	latestTriggeredAt: number;
	hasUnvisited: boolean;
	isDone: boolean;
}

export interface UseNotificationCenterInput {
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
	// 当前选中的 task（跨 repo taskId 全局唯一），用于「打开即自动已读」。
	selectedTaskId: string | null;
	onMarkTaskVisited: (workspaceId: string, taskId: string) => void;
	onClearWorkspace: (workspaceId: string) => void;
}

export interface UseNotificationCenterResult {
	// 铃铛面板：排除 done 的组，按最新触发时间降序。
	panelGroups: NotificationGroup[];
	// 历史弹窗的「按 task 分组」排列：全部组（含 done），按各组最新触发时间降序。
	allGroups: NotificationGroup[];
	// 历史弹窗的「时间流」排列：跨全部 workspace 展平的一维条目，按 triggeredAt 降序（含已读、含 done）。
	allEntriesSortedByTriggeredAtDescending: RuntimeNotificationFeedEntry[];
	// 铃铛徽标：面板中仍有未读的组数（跨 repo，非 done）。
	unreadCount: number;
	markGroupVisited: (workspaceId: string, taskId: string) => void;
	// 铃铛面板的「全部已读」：范围 = panelGroups（非 done），与徽标 unreadCount 同口径。
	markAllPanelGroupsVisited: () => void;
	// 历史弹窗的「全部已读」：范围 = allGroups（含 done），与历史视图里看得见的未读同口径。
	markAllHistoryGroupsVisited: () => void;
	clearAll: () => void;
}

export function buildNotificationGroups(
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>,
): NotificationGroup[] {
	const groupsByKey = new Map<string, RuntimeNotificationFeedEntry[]>();
	for (const entries of Object.values(notificationLogByWorkspaceId)) {
		for (const entry of entries) {
			const key = `${entry.workspaceId}:${entry.taskId}`;
			const bucket = groupsByKey.get(key) ?? [];
			bucket.push(entry);
			groupsByKey.set(key, bucket);
		}
	}
	const groups: NotificationGroup[] = [];
	for (const [key, bucket] of groupsByKey) {
		const sorted = [...bucket].sort((left, right) => right.triggeredAt - left.triggeredAt);
		const latest = sorted[0];
		if (!latest) {
			continue;
		}
		groups.push({
			key,
			workspaceId: latest.workspaceId,
			taskId: latest.taskId,
			repoName: latest.repoName,
			taskTitle: latest.taskTitle,
			latestUserTurnKind: latest.userTurnKind,
			entries: sorted,
			latestTriggeredAt: latest.triggeredAt,
			hasUnvisited: sorted.some((entry) => entry.visitedAt === null),
			// 同一 workspace 的桶每次整体重建，故组内 isDone 一致；取最新条目即可。
			isDone: latest.isDone,
		});
	}
	return groups.sort((left, right) => right.latestTriggeredAt - left.latestTriggeredAt);
}

// 历史弹窗「时间流」排列的数据源：跨全部 workspace 展平成一维，按 triggeredAt 降序。
// 刻意不做任何过滤——已读条目与 done 组的条目一律保留，历史视图的职责就是「全部看得见」。
export function buildNotificationEntriesSortedByTriggeredAtDescending(
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>,
): RuntimeNotificationFeedEntry[] {
	const entries: RuntimeNotificationFeedEntry[] = [];
	for (const workspaceEntries of Object.values(notificationLogByWorkspaceId)) {
		entries.push(...workspaceEntries);
	}
	return entries.sort((left, right) => {
		if (right.triggeredAt !== left.triggeredAt) {
			return right.triggeredAt - left.triggeredAt;
		}
		// 同毫秒（不同 task 在同一毫秒触发）用 id 兜底，保证跨渲染顺序稳定、不随快照重建抖动。
		return left.id.localeCompare(right.id);
	});
}

function markGroupsWithUnvisitedEntries(
	groups: NotificationGroup[],
	onMarkTaskVisited: (workspaceId: string, taskId: string) => void,
): void {
	for (const group of groups) {
		if (group.hasUnvisited) {
			onMarkTaskVisited(group.workspaceId, group.taskId);
		}
	}
}

export function useNotificationCenter(input: UseNotificationCenterInput): UseNotificationCenterResult {
	const { notificationLogByWorkspaceId, selectedTaskId, onMarkTaskVisited, onClearWorkspace } = input;

	const allGroups = useMemo(
		() => buildNotificationGroups(notificationLogByWorkspaceId),
		[notificationLogByWorkspaceId],
	);
	const allEntriesSortedByTriggeredAtDescending = useMemo(
		() => buildNotificationEntriesSortedByTriggeredAtDescending(notificationLogByWorkspaceId),
		[notificationLogByWorkspaceId],
	);
	const panelGroups = useMemo(() => allGroups.filter((group) => !group.isDone), [allGroups]);
	const unreadCount = useMemo(() => panelGroups.filter((group) => group.hasUnvisited).length, [panelGroups]);
	const groupByTaskId = useMemo(() => {
		const map = new Map<string, NotificationGroup>();
		for (const group of allGroups) {
			map.set(group.taskId, group);
		}
		return map;
	}, [allGroups]);

	const markGroupVisited = useCallback(
		(workspaceId: string, taskId: string) => {
			onMarkTaskVisited(workspaceId, taskId);
		},
		[onMarkTaskVisited],
	);

	// 两个「全部已读」各自与自己的可见范围对齐，杜绝「看得到却清不掉的未读」：
	// 铃铛面板只看得见非 done 组，故它的 action 也只覆盖 panelGroups（与徽标 unreadCount 同口径）；
	// 历史弹窗看得见含 done 的全部组，故它的 action 覆盖 allGroups。
	const markAllPanelGroupsVisited = useCallback(() => {
		markGroupsWithUnvisitedEntries(panelGroups, onMarkTaskVisited);
	}, [panelGroups, onMarkTaskVisited]);

	const markAllHistoryGroupsVisited = useCallback(() => {
		markGroupsWithUnvisitedEntries(allGroups, onMarkTaskVisited);
	}, [allGroups, onMarkTaskVisited]);

	const clearAll = useCallback(() => {
		for (const workspaceId of Object.keys(notificationLogByWorkspaceId)) {
			onClearWorkspace(workspaceId);
		}
	}, [notificationLogByWorkspaceId, onClearWorkspace]);

	// 打开 task 即自动已读：选中的 task 若有未读则标记整组。用 ref 去重（同一选择只标一次），
	// 但当该 task 又来新通知（latestTriggeredAt 变化）时允许再次自动标记。
	const lastAutoMarkedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!selectedTaskId) {
			return;
		}
		const group = groupByTaskId.get(selectedTaskId);
		if (!group || !group.hasUnvisited) {
			return;
		}
		const marker = `${group.workspaceId}:${group.taskId}:${group.latestTriggeredAt}`;
		if (lastAutoMarkedRef.current === marker) {
			return;
		}
		lastAutoMarkedRef.current = marker;
		onMarkTaskVisited(group.workspaceId, group.taskId);
	}, [selectedTaskId, groupByTaskId, onMarkTaskVisited]);

	return {
		panelGroups,
		allGroups,
		allEntriesSortedByTriggeredAtDescending,
		unreadCount,
		markGroupVisited,
		markAllPanelGroupsVisited,
		markAllHistoryGroupsVisited,
		clearAll,
	};
}
