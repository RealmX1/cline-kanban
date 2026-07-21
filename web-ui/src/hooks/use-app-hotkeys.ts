import { useHotkeys } from "react-hotkeys-hook";

import type { CardSelection } from "@/types";

function isEventInsideDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[role='dialog']") !== null;
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
}: UseAppHotkeysInput): void {
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
