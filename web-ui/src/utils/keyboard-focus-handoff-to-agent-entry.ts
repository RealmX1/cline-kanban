// 「现在该不该把键盘焦点抢给 agent entry（agent 输入入口）」这一判断的单一真源。
//
// 详情视图切换 focus task card 后，键盘焦点要自动落到该卡的 agent 输入入口上，
// 否则裸方向键会落回 document 级热键、把详情视图变成翻卡器。但抢焦点是有代价的：
// `element.focus()` 会 collapse 文档选区，用户正在卡片上拖选的文字会瞬间消失。
//
// 于是三条抢焦点路径（conversation composer 的 taskId 变更、composer 的显式聚焦请求、
// PTY 终端的 mount autoFocus 与显式聚焦请求）共用这一个守卫，而不是各写各的条件。

import { matchesMobileViewportNow } from "@/utils/mobile-viewport-breakpoint";

function isEditableElement(element: Element | null): boolean {
	if (!(element instanceof HTMLElement)) {
		return false;
	}
	return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}

function hasLiveUserTextSelection(): boolean {
	if (typeof window === "undefined" || typeof window.getSelection !== "function") {
		return false;
	}
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed) {
		return false;
	}
	return selection.toString().trim().length > 0;
}

/**
 * 以下任一情形成立即返回 `false`（此刻不要抢焦点）：
 *
 * - 移动端视口——聚焦会拉起软键盘并触发 iOS Safari 的 viewport shift。
 * - 用户当前有非空的文本选区——抢焦点会清掉它，卡片上的文字就选不成了。
 * - 焦点已在某个可编辑元素里——别打断用户正在敲的 diff 评论或卡片标题内联编辑。
 * - 焦点落在对话框（`[role='dialog']`）内——对话框自己管焦点。
 */
export function shouldHandOffKeyboardFocusToAgentEntryNow(): boolean {
	if (matchesMobileViewportNow()) {
		return false;
	}
	if (hasLiveUserTextSelection()) {
		return false;
	}
	if (typeof document === "undefined") {
		return true;
	}
	const activeElement = document.activeElement;
	if (isEditableElement(activeElement)) {
		return false;
	}
	if (activeElement instanceof Element && activeElement.closest("[role='dialog']") !== null) {
		return false;
	}
	return true;
}
