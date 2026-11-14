import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherSections,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type RefObject, useLayoutEffect, useRef } from "react";
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
	pinnedScrollRootRef,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	sections: CrossProjectTaskSwitcherSections;
	scrollRootRef: RefObject<HTMLDivElement | null>;
	pinnedScrollRootRef?: RefObject<HTMLDivElement | null>;
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
	const focusedTaskSourceScrollRootRef =
		focusedTaskSourceSection === "pinned" && pinnedScrollRootRef ? pinnedScrollRootRef : scrollRootRef;
	const focusedTaskPinState = useSelectedCardPinState({
		selectedTaskId: focusedTaskInProject?.taskId ?? "",
		selectedCardElementSelector: focusedTaskScrollAnchorSelector,
		scrollRootRef,
		enabled:
			focusedTaskSelection !== null && focusedTaskSourceSection !== null && focusedTaskSourceSection !== "pinned",
	});

	useLayoutEffect(() => {
		const scrollRoot = scrollRootRef.current;
		if (scrollRoot) scrollRoot.scrollTop = readCrossProjectTaskSwitcherPanelViewContinuity().panelScrollTopPx;
	}, [scrollRootRef]);

	useLayoutEffect(() => {
		if (!focusedTaskSelection || !focusedTaskEntryKey) return;
		const continuity = readCrossProjectTaskSwitcherPanelViewContinuity();
		if (continuity.focusedTaskEntryKeyLastRevealedInPanel === focusedTaskEntryKey) return;
		const anchor = focusedTaskSourceScrollRootRef.current?.querySelector<HTMLElement>(
			focusedTaskScrollAnchorSelector,
		);
		if (!anchor) return;
		anchor.scrollIntoView?.({ block: "center", inline: "nearest" });
		writeCrossProjectTaskSwitcherPanelViewContinuity({ focusedTaskEntryKeyLastRevealedInPanel: focusedTaskEntryKey });
	}, [
		focusedTaskEntryKey,
		focusedTaskSelection,
		focusedTaskSourceSection,
		focusedTaskScrollAnchorSelector,
		focusedTaskSourceScrollRootRef,
	]);
	const pendingSourceRowKeyboardFocusHandoffRef = useRef<{
		sourceRowAnchorElement: HTMLElement;
		originatingKeyboardEntryElement: Element;
	} | null>(null);
	useLayoutEffect(() => {
		const pendingSourceRowKeyboardFocusHandoff = pendingSourceRowKeyboardFocusHandoffRef.current;
		if (!pendingSourceRowKeyboardFocusHandoff) return;
		const { sourceRowAnchorElement, originatingKeyboardEntryElement } = pendingSourceRowKeyboardFocusHandoff;
		if (
			!sourceRowAnchorElement.isConnected ||
			!sourceRowAnchorElement.matches(focusedTaskScrollAnchorSelector) ||
			(document.activeElement !== originatingKeyboardEntryElement && document.activeElement !== document.body)
		) {
			pendingSourceRowKeyboardFocusHandoffRef.current = null;
			return;
		}
		// Sticky 存在时 CSS 隐藏源行；等移除副本的提交让源行恢复可见后再接力焦点。
		if (getComputedStyle(sourceRowAnchorElement).visibility === "hidden") return;
		pendingSourceRowKeyboardFocusHandoffRef.current = null;
		sourceRowAnchorElement
			.querySelector<HTMLElement>(
				":is([data-cross-project-task-switcher-compact-row-open-task], [data-task-card-title][role='button']):not([inert] *):not([hidden] *)",
			)
			?.focus({ preventScroll: true });
	});

	const revealFocusedTaskScrollAnchor = () => {
		const anchor = focusedTaskSourceScrollRootRef.current?.querySelector<HTMLElement>(
			focusedTaskScrollAnchorSelector,
		);
		if (!anchor) return;
		const originatingKeyboardEntryElement = document.activeElement;
		pendingSourceRowKeyboardFocusHandoffRef.current = originatingKeyboardEntryElement?.matches(":focus-visible")
			? { sourceRowAnchorElement: anchor, originatingKeyboardEntryElement }
			: null;
		anchor.scrollIntoView?.({ block: "center", inline: "nearest" });
	};
	return {
		focusedTaskInProject,
		focusedTaskEntryKey,
		focusedTaskSelection,
		focusedTaskSourceSection,
		focusedTaskPinState,
		focusedTaskScrollAnchorSelector,
		revealFocusedTaskScrollAnchor,
	};
}
