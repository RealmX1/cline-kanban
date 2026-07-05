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
	// 完整日志：全部组（含 done），按最新触发时间降序。
	allGroups: NotificationGroup[];
	// 铃铛徽标：面板中仍有未读的组数（跨 repo，非 done）。
	unreadCount: number;
	markGroupVisited: (workspaceId: string, taskId: string) => void;
	markAllVisited: () => void;
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

export function useNotificationCenter(input: UseNotificationCenterInput): UseNotificationCenterResult {
	const { notificationLogByWorkspaceId, selectedTaskId, onMarkTaskVisited, onClearWorkspace } = input;

	const allGroups = useMemo(
		() => buildNotificationGroups(notificationLogByWorkspaceId),
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

	// 「全部已读」仅覆盖 panel（非 done）组，与铃铛徽标/gate 的 unreadCount 同范围；
	// done 组的未读继续由「打开 task 自动已读」处理，避免 gate（panel）与 action（all）范围不一致。
	const markAllVisited = useCallback(() => {
		for (const group of panelGroups) {
			if (group.hasUnvisited) {
				onMarkTaskVisited(group.workspaceId, group.taskId);
			}
		}
	}, [panelGroups, onMarkTaskVisited]);

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
		unreadCount,
		markGroupVisited,
		markAllVisited,
		clearAll,
	};
}
