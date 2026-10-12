export type TerminalClipboardKeyboardShortcutAction =
	| {
			kind: "copy-terminal-selection-to-system-clipboard";
			// Windows 终端惯例：用 Ctrl+C 复制后清掉选区，下一次 Ctrl+C 就回到发 `^C` 的语义。
			clearSelectionAfterCopy: boolean;
	  }
	// 让浏览器执行原生粘贴：xterm 的 paste 监听读出当前设备剪贴板里的文本并发给 agent。
	| { kind: "release-to-browser-native-paste-of-this-device-clipboard" }
	| { kind: "not-a-clipboard-shortcut" };

export interface TerminalClipboardKeyboardShortcutEnvironment {
	isMacPlatform: boolean;
	isWindowsPlatform: boolean;
	terminalHasSelection: boolean;
	// 浏览器与 agent 不在同一台机器时，Ctrl+V 发 `^V` 只会让 agent 去读 runtime 主机的剪贴板，
	// 用户这台设备上的剪贴板内容永远进不去。
	browserIsOnDifferentMachineThanAgentRuntimeHost: boolean;
}

type TerminalClipboardKeyboardShortcutKeyEvent = Pick<
	KeyboardEvent,
	"type" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>;

const NOT_A_CLIPBOARD_SHORTCUT: TerminalClipboardKeyboardShortcutAction = { kind: "not-a-clipboard-shortcut" };

/**
 * 终端里哪些按键是剪贴板操作。
 *
 * - 复制只在**有选区**时接管；没有选区时 Ctrl+C 必须照常作为 `^C` 发给 agent（中断）。
 *   - macOS：Cmd+C。
 *   - Windows / Linux：Ctrl+Shift+C。
 *   - Windows 额外认 Ctrl+C（与 Windows Terminal、VS Code 终端一致）。Linux 终端没有这个惯例，不加。
 * - 粘贴（只有非 macOS 需要处理；macOS 的 Cmd+V xterm 本来就不接，浏览器自己会粘贴）：
 *   - Ctrl+Shift+V：Windows / Linux 终端的标准粘贴键，一律交给浏览器。
 *   - Ctrl+V：浏览器与 agent 不在同一台机器时交给浏览器；在同一台机器时保留 `^V`，让 Claude Code 之类的
 *     agent 能读本机剪贴板里的图片。
 */
export function resolveTerminalClipboardKeyboardShortcutAction(
	event: TerminalClipboardKeyboardShortcutKeyEvent,
	environment: TerminalClipboardKeyboardShortcutEnvironment,
): TerminalClipboardKeyboardShortcutAction {
	if (event.type !== "keydown" || event.altKey) {
		return NOT_A_CLIPBOARD_SHORTCUT;
	}
	const key = event.key.toLowerCase();
	if (key === "c") {
		if (!environment.terminalHasSelection) {
			return NOT_A_CLIPBOARD_SHORTCUT;
		}
		if (environment.isMacPlatform) {
			return event.metaKey && !event.ctrlKey && !event.shiftKey
				? { kind: "copy-terminal-selection-to-system-clipboard", clearSelectionAfterCopy: false }
				: NOT_A_CLIPBOARD_SHORTCUT;
		}
		if (!event.ctrlKey || event.metaKey) {
			return NOT_A_CLIPBOARD_SHORTCUT;
		}
		if (event.shiftKey) {
			return { kind: "copy-terminal-selection-to-system-clipboard", clearSelectionAfterCopy: false };
		}
		return environment.isWindowsPlatform
			? { kind: "copy-terminal-selection-to-system-clipboard", clearSelectionAfterCopy: true }
			: NOT_A_CLIPBOARD_SHORTCUT;
	}
	if (key === "v" && !environment.isMacPlatform && event.ctrlKey && !event.metaKey) {
		if (event.shiftKey || environment.browserIsOnDifferentMachineThanAgentRuntimeHost) {
			return { kind: "release-to-browser-native-paste-of-this-device-clipboard" };
		}
	}
	return NOT_A_CLIPBOARD_SHORTCUT;
}
