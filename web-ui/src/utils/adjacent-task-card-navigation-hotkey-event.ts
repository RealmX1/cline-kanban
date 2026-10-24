/** 精确修饰键匹配由 react-hotkeys-hook 负责，弹窗和已消费事件继续交给原处理者。 */
export function shouldIgnoreAdjacentTaskCardNavigationHotkey(event: KeyboardEvent): boolean {
	return (
		event.defaultPrevented ||
		event.ctrlKey ||
		event.metaKey ||
		(event.target instanceof Element && event.target.closest("[role='dialog']") !== null)
	);
}
