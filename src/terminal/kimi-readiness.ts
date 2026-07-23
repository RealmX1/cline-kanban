// Kimi Code CLI 启动 / 提示符 readiness 检测。
//
// 与 codex-readiness 的 `hasCodexInteractivePrompt` / `hasCodexStartupUiRendered`
// 对称：用于在 deferredStartupInput 注入前判断 TUI 是否已渲染并可接收 bracketed-paste
// prompt，同时供 output-reactions 框架在连接中断后判断 agent 是否已回到空闲输入提示符。

import { stripAnsi } from "./output-utils";

// Kimi 的输入提示符是圆角框内一行 `│ > `：box 左边框（U+2502）后跟 `>` 字形。
// 匹配「边框 + `>` + 其后空白」以避开正文里裸露的 `>`（diff / 引用等）。
export function hasKimiInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /│\s*>\s/u.test(stripped);
}

// Kimi 启动横幅："Welcome to Kimi Code!"。
export function hasKimiStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("welcome to kimi code");
}
