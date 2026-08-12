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

// 检测 Claude TUI 输入框是否已就绪。
//
// ⚠️ 这是**逐版本漂移的外部契约**，历史上已经栽过一次：下面前三条正则匹配的是旧版画法
// （`╭`/`╰` 框线 + 半角 `>` 提示符），而 v2.1.226+ 改成了「整行 U+2500 横线 + `❯`(U+276F)」，
// 于是本函数对当前 Claude **恒返回 false**。它与另外两个缺陷叠加，造成 2026-08-08 那次
// 「程序化投递在输入框里躺了 49 分钟」的事故。
//
// 因此：**程序化投递的就绪判定不再依赖本函数**，改走 terminal-input-box-reader 的结构判定
// （读终端镜像 buffer，判「存在一个被两条边界线夹住、且首行以提示符开头的区域」，不赌具体画法）。
// 本函数只保留给拿不到镜像、只有原始输出字符串的调用点（adapter 的启动横幅识别等），
// 并保持「新旧画法都认」——旧版渲染仍可能出现在历史 scrollback 与旧版 CLI 上。
const CLAUDE_PROMPT_BOX_TOP_REGEX = /╭[─━]+/u;
const CLAUDE_PROMPT_BOX_BOTTOM_REGEX = /╰[─━]+/u;
const CLAUDE_PROMPT_MARKER_REGEX = /(?:^|\n)\s*>\s/u;
// v2.1.226+ 的提示符：行首的 `❯`(U+276F)。与 Codex 的 `›` 谓词同形。
// 刻意**不**把「整行长横线」也当信号：那与 agent 输出里的分隔线不可区分，会造成过早注入。
const CLAUDE_PROMPT_CHEVRON_MARKER_REGEX = /(?:^|[\n\r])\s*❯/u;

export function hasClaudeInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	if (CLAUDE_PROMPT_BOX_TOP_REGEX.test(stripped) || CLAUDE_PROMPT_BOX_BOTTOM_REGEX.test(stripped)) {
		return true;
	}
	if (CLAUDE_PROMPT_MARKER_REGEX.test(stripped)) {
		return true;
	}
	if (CLAUDE_PROMPT_CHEVRON_MARKER_REGEX.test(stripped)) {
		return true;
	}
	return false;
}
