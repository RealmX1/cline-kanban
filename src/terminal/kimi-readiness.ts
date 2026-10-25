// Kimi Code CLI 启动 / 提示符 readiness 检测。
//
// 与 codex-readiness 的 `hasCodexInteractivePrompt` / `hasCodexStartupPromptReady`
// 对称：用于在 deferredStartupPromptText 注入前判断 TUI 是否已渲染并可接收 bracketed-paste
// prompt，同时供 output-reactions 框架在连接中断后判断 agent 是否已回到空闲输入提示符。

import { stripAnsi } from "./output-utils";

// Kimi 的输入提示符是圆角框内一行 `│ > `：box 左边框（U+2502）后跟 `>` 字形。
// 匹配「边框 + `>` + 其后空白」以避开正文里裸露的 `>`（diff / 引用等）。
export function hasKimiInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /│\s*>\s/u.test(stripped);
}

// 窄终端会把原生横幅裁成 `Welcome to Kim…` 等带省略号的前缀；信任门禁与首发必须识别同一事件。
function findLastKimiStartupBannerIndex(normalizedText: string): number {
	const startupBannerText = "welcome to kimi code";
	let lastStartupBannerIndex = normalizedText.lastIndexOf(startupBannerText);
	for (const match of normalizedText.matchAll(/welcome to [a-z ]+…/gu)) {
		if (startupBannerText.startsWith(match[0].slice(0, -1))) {
			lastStartupBannerIndex = Math.max(lastStartupBannerIndex, match.index);
		}
	}
	return lastStartupBannerIndex;
}

export function hasKimiStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return findLastKimiStartupBannerIndex(stripped) >= 0;
}

// 原生信任模态可能同时渲染底下的 composer。只有后来的启动横幅才能证明该模态已经关闭；
// 使用累积输出处理分块与短屏幕，当前屏幕另作独立核验。
export function hasKimiWorkspaceTrustAwaitingConfirmation(startupOutputText: string): boolean {
	const normalized = stripAnsi(startupOutputText).replace(/\s+/gu, " ").toLowerCase();
	const trustPromptIndex = normalized.lastIndexOf("trust this folder?");
	return trustPromptIndex >= 0 && trustPromptIndex > findLastKimiStartupBannerIndex(normalized);
}

export function hasKimiStartupPromptReady(screenText: string, startupOutputText: string): boolean {
	return (
		hasKimiInteractivePrompt(screenText) &&
		hasKimiStartupUiRendered(startupOutputText) &&
		!hasKimiWorkspaceTrustAwaitingConfirmation(startupOutputText) &&
		!hasKimiWorkspaceTrustAwaitingConfirmation(screenText)
	);
}

// 只保留原生信任对话框支持的方向键和确认键；普通文本或 Esc 仍让出自动首发控制权。
export function isKimiWorkspaceTrustNavigationOrConfirmationInput(inputText: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 原生终端方向键和回车的协议字节。
	return /^(?:\u001b(?:\[|O)[ABCD]|\r|\n)+$/u.test(inputText);
}
