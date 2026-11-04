import { useCallback } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { isBoardOrFocusedTaskProjectScopeToggleKeyboardEvent } from "@/components/top-bar-project-switcher/board-or-focused-task-project-scope-toggle-hotkey-descriptor";
import type { CardSelection } from "@/types";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { isMacPlatform } from "@/utils/platform";
import { useDocumentEvent } from "@/utils/react-use";

function isEventInsideDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[role='dialog'], [role='alertdialog'], dialog") !== null;
}

function isEventInsideTaskSpotlightSearchDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[data-task-spotlight-search-dialog]") !== null;
}

interface UseAppHotkeysInput {
	selectedCard: CardSelection | null;
	isDetailTerminalOpen: boolean;
	isHomeTerminalOpen: boolean;
	isHomeGitHistoryOpen: boolean;
	canUseCreateTaskShortcut: boolean;
	canUseTaskSpotlightSearch: boolean;
	handleToggleDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleToggleExpandDetailTerminal: () => void;
	handleToggleExpandHomeTerminal: () => void;
	handleOpenCreateTask: () => void;
	handleToggleTaskSpotlightSearch: () => void;
	handleOpenSettings: () => void;
	handleToggleGitHistory: () => void;
	handleCloseGitHistory: () => void;
	onRequestStartAllReadyBacklogTasks: () => void;
	handleToggleCurrentPageLeftSidebar?: (() => void) | null;
	handleToggleFocusViewWorkbenchSidebar?: (() => void) | null;
	// null = 当前没有可切的范围（没有项目、或项目不可用）。
	handleToggleBetweenBoardScopeAndFocusedTaskProjectScope: (() => void) | null;
}

export function useAppHotkeys({
	selectedCard,
	isDetailTerminalOpen,
	isHomeTerminalOpen,
	isHomeGitHistoryOpen,
	canUseCreateTaskShortcut,
	canUseTaskSpotlightSearch,
	handleToggleDetailTerminal,
	handleToggleHomeTerminal,
	handleToggleExpandDetailTerminal,
	handleToggleExpandHomeTerminal,
	handleOpenCreateTask,
	handleToggleTaskSpotlightSearch,
	handleOpenSettings,
	handleToggleGitHistory,
	handleCloseGitHistory,
	onRequestStartAllReadyBacklogTasks,
	handleToggleCurrentPageLeftSidebar,
	handleToggleFocusViewWorkbenchSidebar,
	handleToggleBetweenBoardScopeAndFocusedTaskProjectScope,
}: UseAppHotkeysInput): void {
	const handleSidebarOrStartAllTasksKeydown = useCallback(
		(event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				isEventInsideDialog(event.target) ||
				isKeyboardEventEmittedDuringImeComposition(event) ||
				event.code !== "KeyB" ||
				!(isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
				(event.shiftKey && event.altKey)
			)
				return;
			const action = event.shiftKey
				? onRequestStartAllReadyBacklogTasks
				: event.altKey
					? handleToggleFocusViewWorkbenchSidebar
					: handleToggleCurrentPageLeftSidebar;
			if (!action) return;
			// 捕获阶段先于终端处理；长按继续拦截，但只触发一次。
			event.preventDefault();
			event.stopPropagation();
			if (!event.repeat) action();
		},
		[handleToggleCurrentPageLeftSidebar, handleToggleFocusViewWorkbenchSidebar, onRequestStartAllReadyBacklogTasks],
	);
	useDocumentEvent("keydown", handleSidebarOrStartAllTasksKeydown, true);
	const handleBoardOrFocusedTaskProjectScopeToggleKeydown = useCallback(
		(event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				isEventInsideDialog(event.target) ||
				isKeyboardEventEmittedDuringImeComposition(event) ||
				!isBoardOrFocusedTaskProjectScopeToggleKeyboardEvent(event)
			) {
				return;
			}
			// 在捕获阶段接管，不让新组合先经过终端的按键处理或发给 agent。
			// 长按仍拦截重复事件，但只在第一次按下时切换一次。
			event.preventDefault();
			event.stopPropagation();
			if (!event.repeat) {
				handleToggleBetweenBoardScopeAndFocusedTaskProjectScope?.();
			}
		},
		[handleToggleBetweenBoardScopeAndFocusedTaskProjectScope],
	);
	useDocumentEvent(
		"keydown",
		handleToggleBetweenBoardScopeAndFocusedTaskProjectScope === null
			? null
			: handleBoardOrFocusedTaskProjectScopeToggleKeydown,
		true,
	);

	useHotkeys(
		"mod+j",
		() => {
			if (selectedCard) {
				handleToggleDetailTerminal();
				return;
			}
			handleToggleHomeTerminal();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleDetailTerminal, handleToggleHomeTerminal, selectedCard],
	);

	useHotkeys(
		"mod+m",
		() => {
			if (selectedCard) {
				if (isDetailTerminalOpen) {
					handleToggleExpandDetailTerminal();
				}
				return;
			}
			if (isHomeTerminalOpen) {
				handleToggleExpandHomeTerminal();
			}
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[
			handleToggleExpandDetailTerminal,
			handleToggleExpandHomeTerminal,
			isDetailTerminalOpen,
			isHomeTerminalOpen,
			selectedCard,
		],
	);

	useHotkeys(
		"c",
		() => {
			if (!canUseCreateTaskShortcut) {
				return;
			}
			handleOpenCreateTask();
		},
		{ preventDefault: true },
		[canUseCreateTaskShortcut, handleOpenCreateTask],
	);

	useHotkeys(
		"mod+k",
		(event) => {
			// 事件落在其它 dialog（非 Spotlight）内时放行给该 dialog，不劫持 mod+k。
			if (isEventInsideDialog(event.target) && !isEventInsideTaskSpotlightSearchDialog(event.target)) {
				return;
			}
			if (!canUseTaskSpotlightSearch) {
				return;
			}
			// 弹层内再按 mod+k = toggle 关闭；其它位置 = 打开。
			handleToggleTaskSpotlightSearch();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[canUseTaskSpotlightSearch, handleToggleTaskSpotlightSearch],
	);

	useHotkeys(
		"mod+g",
		() => {
			handleToggleGitHistory();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleGitHistory],
	);

	useHotkeys(
		"mod+shift+s",
		() => {
			handleOpenSettings();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleOpenSettings],
	);

	useHotkeys(
		"escape",
		(event) => {
			if (selectedCard || !isHomeGitHistoryOpen || isEventInsideDialog(event.target)) {
				return;
			}
			event.preventDefault();
			handleCloseGitHistory();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleCloseGitHistory, isHomeGitHistoryOpen, selectedCard],
	);
}
