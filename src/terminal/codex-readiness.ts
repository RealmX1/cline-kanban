// Codex CLI 启动 / 提示符 readiness 检测。
//
// 与 Claude 的 `hasClaudeInteractivePrompt` / `hasClaudeStartupUiRendered`
// 对称：用于在 deferredStartupInput 注入前判断 TUI 是否已渲染并可接收
// bracketed-paste prompt，同时供 output-reactions 框架在连接中断后判断
// agent 是否已回到空闲输入提示符（可以安全注入续跑指令）。

import { stripAnsi } from "./output-utils";

// Codex 输入提示符是独立一行上的 `›` 字符。
export function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

// Codex 启动横幅："OpenAI Codex (v..."。
export function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}
