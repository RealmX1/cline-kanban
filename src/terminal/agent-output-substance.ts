// 终端 agent「实质输出」分类器（纯函数 + 每会话短记忆）。
//
// 背景：Claude / Codex 等 TUI agent 在「思考中」会每秒重绘状态行
// （`✻ Cogitating… (12s · esc to interrupt)`）、并周期性重绘输入框 / footer / 帮助提示。
// 这些都是装饰性重绘，不是新产出，但每来一段非空 PTY 字节都会刷新 `lastOutputAt`。
// 因此「距最近 PTY 输出 < 5s」无法区分「agent 真在产出正文」与「agent 只是在转 spinner」，
// 导致移入 Validation 的卡片被持续打回 In Progress（见 session-activity.ts
// isAgentActivelyProducingOutput 注释与本次修复计划）。
//
// 本模块回答「这段 decoded chunk 是否带来了新的实质内容」，供 session-manager 在 agent 回合
// 决定是否推进独立的 `lastSubstantiveOutputAt` 时间戳。设计取「行级 chrome 丢弃 + 内容行新鲜度」
// 双层，而非穷举 spinner 动词：
//   1) chrome 掩码专杀**每帧都在变**的 spinner 状态行（计时器递增 / 动词轮转，故新鲜度记忆对它无效，
//      必须靠 chrome 规则识别）。核心信号是 `esc to interrupt`、braille / sparkle spinner 字形、
//      计时器 / token / 费用 / auto-compact 计量、以及纯框线/输入框 chrome 行。
//   2) 新鲜度记忆专杀**内容不变、周期重绘**的静态 chrome（footer、`? for shortcuts`、整屏 re-render
//      同内容）——这类带词内容、chrome 规则可能漏掉，但「最近见过」即可判为非新鲜。
// 歧义一律判「非实质」（false）：过度掩码＝卡片留在 Validation（用户期望方向）；欠掩码＝复发 bug。
//
// 关键不变量：**绝不**把真实 assistant / 工具行误判为 chrome。Claude 用 `⏺` / `●` / `⎿` 前缀真实
// 正文与工具行，故这些字形不在 spinner 掩码内；spinner 用 sparkle 家族（✻ 等）+ `esc to interrupt`。

import { stripAnsiAndControl } from "./terminal-output-normalization";

// 每会话保留的「最近实质内容行签名」上限。spinner 每帧不同、永不入记忆；本上限只为
// 静态重绘 chrome（footer / 帮助提示）兜底，64 足够覆盖一屏内容行且常数级开销。
const MAX_RECENT_CONTENT_SIGNATURES = 64;

// 行内含 braille 字形（仅出现在进度 spinner，正文绝不出现）→ 整行判 chrome。
const BRAILLE_SPINNER_REGEX = /[⠀-⣿]/u;
// 行首为 Claude/Codex 思考 spinner 的 sparkle 家族字形 → 整行判 chrome。
// 有意排除 `*`（markdown 列表 / 加粗）、`·`/`●`/`⏺`/`⎿`（真实正文 / 工具行前缀），避免误杀正文。
const SPINNER_LEADING_GLYPH_REGEX = /^[✶✻✽✳✢✺✷∗❋]/u;
// 「esc to interrupt」是 spinner 状态行每帧恒在的强信号（容忍中间分隔符）。
const ESC_TO_INTERRUPT_REGEX = /esc\s*to\s*interrupt/u;
// 经过时长计时器，如 `(12s`、`( 5 s`、`(12s ·`。
const ELAPSED_TIMER_REGEX = /\(\s*\d+\s*s\b/u;
// token / 费用 / auto-compact 计量行（spinner footer，正文极少出现这类措辞）。
const TOKEN_METER_REGEX = /\b\d[\d.,]*\s*k?\s*tokens?\b/u;
const COST_METER_REGEX = /\$\s?\d[\d.,]*/u;
const AUTO_COMPACT_REGEX = /context\s+left\s+until\s+auto-?compact/u;
// 整行仅由框线 / 分隔 / 输入框 chrome 字符（含空 `>` 提示符、`?` 帮助标记）组成 → chrome。
// 注：带字母的 markdown 引用行 `> quote` 因含词字符不会命中（命中要求整行皆 chrome 字符）。
const CHROME_ONLY_LINE_REGEX = /^[\s>?·•╭╮╰╯─━│┃┄┅┈┉╌╍═║╔╗╚╝▏▕▔▁↑↓…]*$/u;
// 「内容行」必须含一段 >=3 连续词字符（字母 / 数字），否则视为纯符号 chrome。
const CONTENT_WORD_RUN_REGEX = /[\p{L}\p{N}]{3,}/u;

// 单行是否为 TUI 装饰性 chrome（命中任一规则即是）。已先经调用方 trim。
function isChromeLine(trimmedLine: string): boolean {
	if (trimmedLine.length === 0) {
		return true;
	}
	const lower = trimmedLine.toLowerCase();
	return (
		BRAILLE_SPINNER_REGEX.test(trimmedLine) ||
		SPINNER_LEADING_GLYPH_REGEX.test(trimmedLine) ||
		ESC_TO_INTERRUPT_REGEX.test(lower) ||
		ELAPSED_TIMER_REGEX.test(lower) ||
		TOKEN_METER_REGEX.test(lower) ||
		COST_METER_REGEX.test(lower) ||
		AUTO_COMPACT_REGEX.test(lower) ||
		CHROME_ONLY_LINE_REGEX.test(trimmedLine)
	);
}

// 从 decoded chunk 抽出「实质内容行签名」（归一化后的小写折空白串）。
// 管线：stripAnsiAndControl（保留 \n/\r/\t 行结构）→ 按 [\r\n]+ 切行 → 丢 chrome 行 →
// 仅保留含 >=3 连续词字符的行 → 归一化为签名（trim + 小写 + 折叠空白）。
// 返回空数组即「本 chunk 无任何实质内容行」。
export function extractAgentOutputContentSignatures(decodedChunk: string): string[] {
	const stripped = stripAnsiAndControl(decodedChunk);
	const signatures: string[] = [];
	for (const rawSegment of stripped.split(/[\r\n]+/u)) {
		const trimmed = rawSegment.trim();
		if (isChromeLine(trimmed)) {
			continue;
		}
		const normalized = trimmed.toLowerCase().replace(/\s+/gu, " ");
		if (!CONTENT_WORD_RUN_REGEX.test(normalized)) {
			continue;
		}
		signatures.push(normalized);
	}
	return signatures;
}

// 无状态判据：这段 chunk 是否含**任何**实质内容行（不考虑是否「最近见过」）。
// 供单测钉住 chrome 掩码语义；生产路径用带记忆的 detectFreshSubstantiveAgentOutput。
export function isSubstantiveAgentOutput(decodedChunk: string): boolean {
	return extractAgentOutputContentSignatures(decodedChunk).length > 0;
}

// 每会话的实质输出新鲜度记忆（in-memory，不进广播 summary）。
export interface AgentOutputSubstanceMemory {
	readonly recentContentSignatures: Set<string>;
}

export function createAgentOutputSubstanceMemory(): AgentOutputSubstanceMemory {
	return { recentContentSignatures: new Set<string>() };
}

// 带记忆判据：这段 chunk 是否带来「最近未见过的新实质内容」，并把本 chunk 的内容行签名
// 写回记忆（最近见过的 chrome 静态重绘因此被持续抑制）。
//   - 返回 true ⟺ 至少一条内容行签名不在记忆中（＝真有新产出 → 推进 lastSubstantiveOutputAt）。
//   - 复现签名会被「移到最新」（LRU 刷新），使周期性 footer 永不被淘汰、长期保持「非新鲜」。
//   - spinner 状态行每帧不同，本就被 chrome 规则拦在内容行之外，永不进入记忆。
export function detectFreshSubstantiveAgentOutput(memory: AgentOutputSubstanceMemory, decodedChunk: string): boolean {
	const signatures = extractAgentOutputContentSignatures(decodedChunk);
	let hasFreshContent = false;
	const recent = memory.recentContentSignatures;
	for (const signature of signatures) {
		if (!recent.has(signature)) {
			hasFreshContent = true;
		}
		// LRU 刷新：删除后重新插入，使复现的静态 chrome 始终停留在「最新」端、不被 FIFO 淘汰。
		recent.delete(signature);
		recent.add(signature);
		while (recent.size > MAX_RECENT_CONTENT_SIGNATURES) {
			const oldest = recent.values().next().value;
			if (oldest === undefined) {
				break;
			}
			recent.delete(oldest);
		}
	}
	return hasFreshContent;
}
