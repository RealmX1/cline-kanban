import { useCallback, useRef } from "react";

// 「固定展开 / 收起」开关在一行的三态里各是一个独立实例：精简行的 hover 动作组、完整卡体的 hover 动作组、
// 卡快照未到时的兜底。切换形态时旧实例随旧形态的 DOM 一起卸载，键盘焦点会落到 body。
const CROSS_PROJECT_TASK_SWITCHER_IN_LIST_EXPANSION_TOGGLE_BUTTON_SELECTOR =
	'[data-testid="cross-project-task-switcher-full-task-card-in-list-expansion-toggle-button"]';
// 行根节点（三态共用同一个，见 CrossProjectRecentlyActiveTaskSwitcherTaskRow）。同一任务在 Pinned 与下方区各有一行，
// 从卸载的元素往上找到的是触发的那一行。
const CROSS_PROJECT_TASK_SWITCHER_ROW_ROOT_ELEMENT_SELECTOR =
	"[data-cross-project-task-switcher-row-in-place-expansion-state]";

function handOffKeyboardFocusFromInListExpansionToggleInsideElementAboutToBeRemoved(
	elementAboutToBeRemoved: HTMLElement,
): void {
	const ownerDocument = elementAboutToBeRemoved.ownerDocument;
	const focusedElement = ownerDocument.activeElement;
	if (!(focusedElement instanceof HTMLElement) || !elementAboutToBeRemoved.contains(focusedElement)) {
		return;
	}
	// 只接力键盘焦点。鼠标点开关时 Chrome 也会把焦点给按钮（但不 :focus-visible）：那种焦点照旧随卸载丢掉，
	// 否则新形态 hover 动作组的 focus-within 会让它在指针离开后仍常显。
	if (
		!focusedElement.matches(CROSS_PROJECT_TASK_SWITCHER_IN_LIST_EXPANSION_TOGGLE_BUTTON_SELECTOR) ||
		!focusedElement.matches(":focus-visible")
	) {
		return;
	}
	const rowRootElement = elementAboutToBeRemoved.closest<HTMLElement>(
		CROSS_PROJECT_TASK_SWITCHER_ROW_ROOT_ELEMENT_SELECTOR,
	);
	if (!rowRootElement) {
		return;
	}
	// 此刻旧形态还在 DOM 里（React 先解绑 ref、再移除节点），新形态要等这次提交做完才挂上：提交后再找。
	queueMicrotask(() => {
		const activeElementAfterCommit = ownerDocument.activeElement;
		// 焦点已经有了别的去处（不是随卸载落到 body）就不抢。
		if (activeElementAfterCommit !== null && activeElementAfterCommit !== ownerDocument.body) {
			return;
		}
		if (!rowRootElement.isConnected) {
			return;
		}
		// 精简行 hover 意图期间完整卡片隐藏挂载（hidden），里面的开关不算。
		const inListExpansionToggleInNewRowState = [
			...rowRootElement.querySelectorAll<HTMLElement>(
				CROSS_PROJECT_TASK_SWITCHER_IN_LIST_EXPANSION_TOGGLE_BUTTON_SELECTOR,
			),
		].find((inListExpansionToggle) => inListExpansionToggle.closest("[hidden]") === null);
		inListExpansionToggleInNewRowState?.focus();
	});
}

/**
 * All projects 切换面板一行里「会随形态切换整块卸载」的元素（精简行、完整卡片外框、卡快照兜底）挂这个 callback ref：
 * 它卸载时若键盘焦点正在它里面的展开开关上，提交后把焦点交给同一行新形态下的开关（同一坐标），而不是落到 body。
 * 只在本面板的行里用，主看板与 This project 的卡不受影响。
 */
export function useCallbackRefHandingOffInListExpansionToggleKeyboardFocusWhenElementIsRemoved(): (
	element: HTMLElement | null,
) => void {
	const attachedElementRef = useRef<HTMLElement | null>(null);
	return useCallback((element: HTMLElement | null) => {
		if (element) {
			attachedElementRef.current = element;
			return;
		}
		const detachedElement = attachedElementRef.current;
		attachedElementRef.current = null;
		if (detachedElement) {
			handOffKeyboardFocusFromInListExpansionToggleInsideElementAboutToBeRemoved(detachedElement);
		}
	}, []);
}
