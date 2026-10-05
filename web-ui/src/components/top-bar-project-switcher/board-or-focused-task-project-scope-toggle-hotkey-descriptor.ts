import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";

/**
 * 范围切换热键：Board Scope（All projects）⇄ 焦点任务所属的项目（无焦点任务时是当前项目）。
 *
 * 选 ⌘E 的理由：左手单手可按（拇指 ⌘ + 中指 E），不与本应用已有热键、Chrome / macOS 的保留键重合；
 * ⌘E 在 Chrome / macOS 上只是「用所选内容查找」，页面可以接管。mac 上终端不吃 ⌘ 组合，终端有焦点时也能用。
 * 非 mac 上是 Ctrl+E，会盖掉终端 readline 的「行尾」——与 mod+j / mod+k / mod+g 同样处理。
 */
// EXPERIMENT_NODE: 范围切换热键用 mod+e 还是冲突更少、多按一键的 mod+shift+e
export const BOARD_OR_FOCUSED_TASK_PROJECT_SCOPE_TOGGLE_HOTKEY_BINDING = "mod+e";

export function formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel(): string {
	return isMacPlatform ? "⌘E" : `${modifierKeyLabel}+E`;
}
