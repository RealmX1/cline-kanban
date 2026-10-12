import { useEffect, useRef } from "react";
import { recordTaskOpenedByUserOnRuntime } from "@/runtime/cross-project-recently-active-task-switcher-query";

/**
 * 跨项目切换面板的「我最后打开」：在任一浏览器 origin 里选中任务都记到 runtime（127.0.0.1 / localhost /
 * Tailscale 是不同 origin，localStorage 不共享）。与通知中心「打开即已读」同一时机。
 *
 * 只在 board 已是当前项目的完整快照时记——切项目途中 selectedTaskId 还是上一个项目的，taskId 跨项目会撞号，
 * 记错项目就成了「我打开过」的假事实。同一 (workspaceId, taskId) 连续选中只记一次。
 */
export function useRecordTaskOpenedByUserOnRuntime({
	workspaceId,
	openedTaskId,
	isCurrentProjectBoardSettled,
}: {
	workspaceId: string | null;
	openedTaskId: string | null;
	isCurrentProjectBoardSettled: boolean;
}): void {
	const lastRecordedTaskOpenedByUserKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspaceId || !openedTaskId || !isCurrentProjectBoardSettled) {
			return;
		}
		const taskOpenedByUserKey = `${workspaceId}:${openedTaskId}`;
		if (lastRecordedTaskOpenedByUserKeyRef.current === taskOpenedByUserKey) {
			return;
		}
		lastRecordedTaskOpenedByUserKeyRef.current = taskOpenedByUserKey;
		void recordTaskOpenedByUserOnRuntime(workspaceId, openedTaskId).catch(() => {
			// 只损失一个排序信号；下次打开再记。
		});
	}, [isCurrentProjectBoardSettled, openedTaskId, workspaceId]);
}
