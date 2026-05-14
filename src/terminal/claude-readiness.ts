// Claude Code 启动 readiness 检测。
//
// 与 Codex 的 `hasCodexInteractivePrompt` / `hasCodexStartupUiRendered`
// 对称：用于在 deferredStartupInput 注入前判断 TUI 是否已经渲染并可接收
// bracketed-paste prompt。
//
// 设计上做"宽松启发式 + fallback 超时"组合：
//   - predicate 命中即放行（命中越早，prompt 注入越准）
//   - predicate 没命中也会被 session-manager 的 deadline 兜底，
//     避免回归到 prompt 永远注不进去的失败模式。
// 因此 predicate 端可以激进地只匹配高置信度信号，把模糊场景交给 deadline。

import { stripAnsi } from "./output-utils";

// Claude TUI 启动时间窗：在这段时间内，session-manager 只在 readiness predicate
// 命中后才注入 deferred startup input；超时后回退到"任意 output 即触发"，
// 与未引入 readiness 之前的行为对齐，确保不回归。
export const CLAUDE_STARTUP_READINESS_TIMEOUT_MS = 5_000;

function normalize(text: string): string {
	return stripAnsi(text).toLowerCase();
}

// 检测 Claude Code 启动横幅 / 引导文案是否已经渲染。
//   "Claude Code" 是每个 Claude 会话都会出现的品牌字样；
//   配合常见的启动引导文案，提高对早期启动帧的命中率。
export function hasClaudeStartupUiRendered(text: string): boolean {
	const normalized = normalize(text);
	if (normalized.includes("claude code")) {
		return true;
	}
	if (normalized.includes("how can i help")) {
		return true;
	}
	if (normalized.includes("tips for getting started")) {
		return true;
	}
	return false;
}

// 检测 Claude TUI 输入框是否已就绪：
//   - 框线字符（box drawing `╭` / `╰` 加横线）作为强信号
//   - 或独立一行的 `>` 输入提示符
const CLAUDE_PROMPT_BOX_TOP_REGEX = /╭[─━]+/u;
const CLAUDE_PROMPT_BOX_BOTTOM_REGEX = /╰[─━]+/u;
const CLAUDE_PROMPT_MARKER_REGEX = /(?:^|\n)\s*>\s/u;

export function hasClaudeInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	if (CLAUDE_PROMPT_BOX_TOP_REGEX.test(stripped) || CLAUDE_PROMPT_BOX_BOTTOM_REGEX.test(stripped)) {
		return true;
	}
	if (CLAUDE_PROMPT_MARKER_REGEX.test(stripped)) {
		return true;
	}
	return false;
}
