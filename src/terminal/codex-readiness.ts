// Codex CLI 启动 / 提示符 readiness 检测。
//
// 与 Claude 的 `hasClaudeInteractivePrompt` / `hasClaudeStartupUiRendered`
// 对称：用于在 deferredStartupPromptText 注入前判断 TUI 是否已渲染并可接收
// bracketed-paste prompt，同时供 output-reactions 框架在连接中断后判断
// agent 是否已回到空闲输入提示符（可以安全注入续跑指令）。

import { stripAnsi } from "./output-utils";

// Codex 输入提示符是独立一行上的 `›` 字符。
export function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

// 必须传当前视口：loading 横幅与目录信任菜单也带 ›，不能用历史输出判启动就绪。
export function hasCodexStartupPromptReady(text: string): boolean {
	const stripped = stripAnsi(text);
	return (
		hasCodexInteractivePrompt(stripped) &&
		!/model:\s+loading\b/iu.test(stripped) &&
		!/(?:esc to interrupt|tab to queue message|Do you trust the contents)/iu.test(stripped)
	);
}

// 只看最后一个 composer 提示符，避免把已提交到历史中的同文消息当成残留。
// Codex 的背景粒子会持续重绘；它们既不是正文，也不是提交成功的证据。
export function hasCodexUnsubmittedProgrammaticPrompt(viewportText: string, promptText: string): boolean {
	const composerLines = [...stripAnsi(viewportText).matchAll(/(?:^|[\n\r])\s*›([^\n\r]*)/gu)];
	const composerText = composerLines.at(-1)?.[1]?.replace(/[\s\u2800-\u28ff]/gu, "");
	if (!composerText) return false;
	const promptPrefix = promptText
		.trim()
		.split(/\r?\n/u)[0]
		?.replace(/[\s\u2800-\u28ff]/gu, "")
		.slice(0, 32);
	return Boolean(
		(promptPrefix && composerText.startsWith(promptPrefix)) ||
			(promptText.startsWith("/plan ") &&
				composerText.startsWith(`/plan[PastedContent${Array.from(promptText.slice(6)).length}chars]`)) ||
			composerText.startsWith(`[PastedContent${Array.from(promptText).length}chars]`),
	);
}
