import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherSections,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type RefObject, useLayoutEffect } from "react";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { useSelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import { findCardSelection } from "@/state/board-state";
import { findCrossProjectTaskSwitcherFocusedTaskSourceSection } from "@/state/cross-project-task-switcher-focus-view-visible-task-rows";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";

/** 焦点卡的数据、唯一定位源、导航连续性与 Sticky 共用同一份 workspace/task 身份。 */
export function useCrossProjectTaskSwitcherFocusedTaskVisibility({
	host,
	currentProjectTaskCards,
	sections,
	scrollRootRef,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	sections: CrossProjectTaskSwitcherSections;
	scrollRootRef: RefObject<HTMLDivElement | null>;
}) {
	const focusedTaskInProject = host.isBoardScopeAllProjectsSelected ? host.focusedTaskInProject : null;
	const focusedTaskEntryKey = focusedTaskInProject
		? buildCrossProjectTaskSwitcherEntryKey(focusedTaskInProject.workspaceId, focusedTaskInProject.taskId)
		: null;
	// 过渡壳没有完整 board；即便 taskId 相同，也不能拿旧项目的数据填入新项目的卡。
	const focusedTaskSelection =
		focusedTaskInProject?.workspaceId === host.currentProjectId && currentProjectTaskCards
			? findCardSelection(currentProjectTaskCards.currentProjectDisplayedBoard, focusedTaskInProject.taskId)
			: null;
	const focusedTaskSourceSection = findCrossProjectTaskSwitcherFocusedTaskSourceSection(sections, focusedTaskEntryKey);
	const focusedTaskScrollAnchorSelector = `[data-cross-project-focused-task-scroll-anchor="${escapeCssAttributeSelectorValue(focusedTaskEntryKey ?? "")}"]`;
	const focusedTaskPinState = useSelectedCardPinState({
		selectedTaskId: focusedTaskInProject?.taskId ?? "",
		selectedCardElementSelector: focusedTaskScrollAnchorSelector,
		scrollRootRef,
		enabled: focusedTaskSelection !== null,
	});

	useLayoutEffect(() => {
		const scrollRoot = scrollRootRef.current;
		if (scrollRoot) scrollRoot.scrollTop = readCrossProjectTaskSwitcherPanelViewContinuity().panelScrollTopPx;
	}, [scrollRootRef]);

	useLayoutEffect(() => {
		if (!focusedTaskSelection || !focusedTaskEntryKey) return;
		const continuity = readCrossProjectTaskSwitcherPanelViewContinuity();
		if (continuity.focusedTaskEntryKeyLastRevealedInPanel === focusedTaskEntryKey) return;
		const anchor = scrollRootRef.current?.querySelector<HTMLElement>(focusedTaskScrollAnchorSelector);
		if (!anchor) return;
		anchor.scrollIntoView?.({ block: "center", inline: "nearest" });
		writeCrossProjectTaskSwitcherPanelViewContinuity({ focusedTaskEntryKeyLastRevealedInPanel: focusedTaskEntryKey });
	}, [focusedTaskEntryKey, focusedTaskSelection, focusedTaskScrollAnchorSelector, scrollRootRef]);

	const revealFocusedTaskScrollAnchor = () => {
		scrollRootRef.current
			?.querySelector<HTMLElement>(focusedTaskScrollAnchorSelector)
			?.scrollIntoView?.({ block: "center", inline: "nearest" });
	};
	return {
		focusedTaskInProject,
		focusedTaskEntryKey,
		focusedTaskSelection,
		focusedTaskSourceSection,
		focusedTaskPinState,
		revealFocusedTaskScrollAnchor,
	};
}
