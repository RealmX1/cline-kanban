import { isMacPlatform } from "@/utils/platform";

/**
 * 范围切换热键：Board Scope（All projects）⇄ 焦点任务所属的项目（无焦点任务时是当前项目）。
 *
 * macOS 用 ⌘⇧E，其它平台用 Ctrl+Shift+E。精确匹配平台修饰键，避免 mod 同时接受 Ctrl 与 Meta，
 * 将 Ctrl+E 留给输入框与终端的原生行尾移动。
 */
export function isBoardOrFocusedTaskProjectScopeToggleKeyboardEvent(event: KeyboardEvent): boolean {
	return (
		event.code === "KeyE" &&
		event.shiftKey &&
		!event.altKey &&
		(isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
	);
}

export function formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel(): string {
	return isMacPlatform ? "⌘⇧E" : "Ctrl+Shift+E";
}
