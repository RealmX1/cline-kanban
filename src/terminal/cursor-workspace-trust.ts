import { normalizeTerminalText, stripAnsiAndControl } from "./terminal-output-normalization";

// cursor-agent 的 Workspace Trust 对话框（未信任的 cwd 上交互启动时弹出，prompt 要等用户应答后才提交）：
//
//   Workspace Trust Required
//   ...
//   Do you trust the contents of this directory?
//     /path/to/cwd
//   ▶ [a] Trust this workspace
//     [q] Quit
//
// Codex 的信任对话框问的是同一句 "Do you trust the contents of this directory?"，所以本 matcher 只对 Cursor 会话使用。
// 实录 fixture：test/runtime/terminal/fixtures/cursor-agent-2026.10.01-workspace-trust-dialog-raw-pty-output.txt。kanban 不替用户按「信任」——
// task worktree 已在启动时传 `--trust` 直接跳过；其余 cwd 只用这个识别结果把「卡在信任对话框」如实标出来。
export function hasCursorWorkspaceTrustPrompt(text: string): boolean {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	return (
		/workspace\s*trust\s*required/u.test(normalized) ||
		/do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory/u.test(normalized)
	);
}
