import { useHotkeys } from "react-hotkeys-hook";

import { BOARD_OR_FOCUSED_TASK_PROJECT_SCOPE_TOGGLE_HOTKEY_BINDING } from "@/components/top-bar-project-switcher/board-or-focused-task-project-scope-toggle-hotkey-descriptor";
import type { CardSelection } from "@/types";

function isEventInsideDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[role='dialog']") !== null;
}

function isEventInsideTaskSpotlightSearchDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[data-task-spotlight-search-dialog]") !== null;
}

// react-hotkeys-hook 在调用回调之前就按 preventDefault 处理事件，回调里早退撤不回来；
// 所以「对话框内不切范围」要在这里同样判一次，否则对话框里的输入框按 ⌘E 会被空操作吞掉浏览器默认行为。
// 放在模块顶层保持引用稳定：库按引用比较 options 里的函数，内联箭头函数会让每次渲染都重挂监听。
function shouldPreventBrowserDefaultForBoardOrFocusedTaskProjectScopeToggleHotkey(event: KeyboardEvent): boolean {
	return !isEventInsideDialog(event.target);
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
	handleToggleBetweenBoardScopeAndFocusedTaskProjectScope,
}: UseAppHotkeysInput): void {
	useHotkeys(
		BOARD_OR_FOCUSED_TASK_PROJECT_SCOPE_TOGGLE_HOTKEY_BINDING,
		(event) => {
			// 对话框（建卡 / 编辑 / 设置等）开着时不在它背后切范围。
			// 与下方 enabled / preventDefault 的判定重复，留作双保险。
			if (isEventInsideDialog(event.target) || !handleToggleBetweenBoardScopeAndFocusedTaskProjectScope) {
				return;
			}
			handleToggleBetweenBoardScopeAndFocusedTaskProjectScope();
		},
		{
			// 没有可切的范围时整体不注册，⌘E 原样交还浏览器。必须是布尔值：
			// enabled 传函数且返回 false 时，库会对事件 preventDefault + stopPropagation，照样吞键。
			enabled: handleToggleBetweenBoardScopeAndFocusedTaskProjectScope !== null,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: shouldPreventBrowserDefaultForBoardOrFocusedTaskProjectScopeToggleHotkey,
		},
		[handleToggleBetweenBoardScopeAndFocusedTaskProjectScope],
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
		"mod+b",
		onRequestStartAllReadyBacklogTasks,
		{
			enableOnContentEditable: false,
			enableOnFormTags: false,
			preventDefault: true,
		},
		[onRequestStartAllReadyBacklogTasks],
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
