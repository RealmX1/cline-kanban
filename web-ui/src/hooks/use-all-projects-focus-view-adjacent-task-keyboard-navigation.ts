import { useEffect, useLayoutEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { collectAllProjectsFocusViewAdjacentTaskNavigationCandidates } from "@/state/cross-project-task-switcher-focus-view-visible-task-rows";
import { shouldIgnoreAdjacentTaskCardNavigationHotkey } from "@/utils/adjacent-task-card-navigation-hotkey-event";

/** 常驻组合根，跨项目「旧详情 → 过渡壳 → 新详情」期间仍只有一个热键所有者。 */
export function useAllProjectsFocusViewAdjacentTaskKeyboardNavigation({
	host,
	isFocusViewActive,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	isFocusViewActive: boolean;
}): void {
	const sectionsModel = host.crossProjectTaskSwitcherSectionsModel;
	const enabled =
		isFocusViewActive &&
		host.isBoardScopeAllProjectsSelected &&
		sectionsModel !== undefined &&
		host.focusedTaskInProject !== null;
	const latestHostRef = useRef(host);
	latestHostRef.current = host;
	const navigationCursorRef = useRef(host.focusedTaskInProject);
	useLayoutEffect(() => {
		navigationCursorRef.current = host.focusedTaskInProject;
	});

	useHotkeys(
		["alt+up", "alt+down"],
		(event) => {
			const latestHost = latestHostRef.current;
			const model = latestHost.crossProjectTaskSwitcherSectionsModel;
			const currentTask = navigationCursorRef.current ?? latestHost.focusedTaskInProject;
			if (!model || !currentTask) return;
			const candidates = collectAllProjectsFocusViewAdjacentTaskNavigationCandidates({
				sections: model.sections,
				visibility: model,
				focusedTaskInProject: currentTask,
			});
			if (candidates.length === 0) return;
			const currentIndex = candidates.findIndex(
				({ workspaceId, entry }) => workspaceId === currentTask.workspaceId && entry.taskId === currentTask.taskId,
			);
			const step = event.key === "ArrowUp" ? -1 : 1;
			const nextIndex =
				currentIndex === -1
					? step === 1
						? 0
						: candidates.length - 1
					: (currentIndex + step + candidates.length) % candidates.length;
			const next = candidates[nextIndex];
			if (!next || (next.workspaceId === currentTask.workspaceId && next.entry.taskId === currentTask.taskId))
				return;
			model.beginRecentSectionKeyboardNavigationOrderLock();
			// 同一帧连发的按键先推进游标，不等待项目握手或 React 提交。
			navigationCursorRef.current = { workspaceId: next.workspaceId, taskId: next.entry.taskId };
			latestHost.onOpenTaskInProject(next.workspaceId, next.entry.taskId);
		},
		{
			enabled,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: shouldIgnoreAdjacentTaskCardNavigationHotkey,
			preventDefault: true,
		},
		[],
	);

	const endOrderLock = sectionsModel?.endRecentSectionKeyboardNavigationOrderLock;
	useEffect(() => {
		if (!enabled || !endOrderLock) {
			endOrderLock?.();
			return;
		}
		const releaseWhenOptionIsNotHeld = (event: KeyboardEvent) => {
			if (!event.altKey) endOrderLock();
		};
		const releaseWhenPageIsHidden = () => {
			if (document.hidden) endOrderLock();
		};
		window.addEventListener("keyup", releaseWhenOptionIsNotHeld, true);
		window.addEventListener("keydown", releaseWhenOptionIsNotHeld, true);
		window.addEventListener("blur", endOrderLock);
		document.addEventListener("visibilitychange", releaseWhenPageIsHidden);
		return () => {
			window.removeEventListener("keyup", releaseWhenOptionIsNotHeld, true);
			window.removeEventListener("keydown", releaseWhenOptionIsNotHeld, true);
			window.removeEventListener("blur", endOrderLock);
			document.removeEventListener("visibilitychange", releaseWhenPageIsHidden);
			endOrderLock();
		};
	}, [enabled, endOrderLock]);
}
