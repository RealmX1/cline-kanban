import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { useCallback, useRef } from "react";

interface CacheWarmTaskFocusNavigationInputs {
	isBoardScopeAllProjectsSelected: boolean;
	currentProjectId: string | null;
	selectedTaskId: string | null;
	isCrossProjectTaskOpenPending: boolean;
	promptCacheWarmAwaitingUserEntries: readonly CrossProjectTaskSwitcherEntryInProject[];
	onOpenTaskInProject: (workspaceId: string, taskId: string) => void;
}

/** 操作前固定同组邻项，成功后才导航；null 表示该手势仍应使用普通 Review 列导航。 */
export function useCacheWarmTaskFocusNavigationAfterValidationMove(inputs: CacheWarmTaskFocusNavigationInputs) {
	const latestInputsRef = useRef(inputs);
	const focusNavigationRevisionRef = useRef(0);
	const previous = latestInputsRef.current;
	if (
		previous.currentProjectId !== inputs.currentProjectId ||
		previous.selectedTaskId !== inputs.selectedTaskId ||
		previous.isBoardScopeAllProjectsSelected !== inputs.isBoardScopeAllProjectsSelected ||
		previous.isCrossProjectTaskOpenPending !== inputs.isCrossProjectTaskOpenPending
	) {
		focusNavigationRevisionRef.current += 1;
	}
	latestInputsRef.current = inputs;

	return useCallback((movedTaskId: string): (() => void) | null => {
		const source = latestInputsRef.current;
		if (
			!source.isBoardScopeAllProjectsSelected ||
			source.isCrossProjectTaskOpenPending ||
			source.selectedTaskId !== movedTaskId ||
			!source.currentProjectId
		) {
			return null;
		}
		const entries = source.promptCacheWarmAwaitingUserEntries;
		const sourceIndex = entries.findIndex(
			({ workspaceId, entry }) => workspaceId === source.currentProjectId && entry.taskId === movedTaskId,
		);
		if (sourceIndex === -1) return null;
		const target = entries[sourceIndex + 1] ?? entries[sourceIndex - 1];
		const capturedFocusNavigationRevision = focusNavigationRevisionRef.current;
		return () => {
			// 返回空操作也表示已处理：同组只有这一项时，不能回退到 Review 列而跳入 Recent。
			if (!target || capturedFocusNavigationRevision !== focusNavigationRevisionRef.current) return;
			const latest = latestInputsRef.current;
			const targetStillInCacheWarmSection = latest.promptCacheWarmAwaitingUserEntries.some(
				({ workspaceId, entry }) => workspaceId === target.workspaceId && entry.taskId === target.entry.taskId,
			);
			if (!targetStillInCacheWarmSection) return;
			latest.onOpenTaskInProject(target.workspaceId, target.entry.taskId);
		};
	}, []);
}
