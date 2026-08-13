// oh-my-pi（omp）把会话运行状态编码进 OSC 终端标题，Kanban 据此把 PTY 会话翻进 Review / In Progress。
//
// 为什么是标题而不是刮 TUI 正文：omp 的标题是**结构化**信号（三态 + 稳定字形），而正文提示符会被
// 主题、宽度、动画重绘搅乱。omp 侧的写点是 utils/title-generator.ts 的 setTerminalTitle，
// 写的是 OSC 0（`ESC ] 0 ; <title> BEL`）；标题体由 buildTerminalTitleWithState 组装，
// 格式恒为「品牌 π + 一个状态分隔符 + 可选会话标签」：
//   `π > label`   idle      —— 轮到用户（agent 已交回回合）
//   `π ! label`   attention —— agent 被用户挡住（ask / 授权确认）
//   `π ⠋ label`   working   —— 正在跑（分隔符在 10 个 braille spinner 帧之间循环；Windows 上是 `:`）
//   `π: label`              —— `tui.titleState` 被关掉时的无状态标题，**不是**状态信号，必须忽略
// 无标签时分隔符紧跟品牌（`π >`），状态照样可读。
//
// 两条实现前提（都已在 session-manager 侧坐实，改动前请重新确认）：
//   1. detectOutputTransition 拿到的是**未 strip** 的 batchText，OSC 序列完整可见；
//   2. 落进 lastSubstantiveOutputAt 的正文另经 stripAnsiAndControl 的 osc 模式剥除，
//      因此每 80ms 一帧的 spinner 不会把「agent 上次响应」刷成刚刚。
//
// 扫描按码位状态机手写而不是用带控制符的正则字面量——与 terminal-output-normalization.ts 同一理由：
// 源码里嵌裸 ESC / BEL 字节不可读、也经不起编辑器与格式化工具的往返。
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { SessionTransitionEvent } from "./session-state-machine";

export type OmpTerminalTitleState = "idle" | "working" | "attention";

const ESCAPE_CODE_UNIT = 0x1b;
const BELL_CODE_UNIT = 0x07;
const OSC_CLOSE_BRACKET_CODE_UNIT = 0x5d; // "]"
const BACKSLASH_CODE_UNIT = 0x5c; // "\\"
const SEMICOLON_CODE_UNIT = 0x3b; // ";"

// omp 的 TITLE_SPINNER_FRAMES（title-generator.ts）。逐字复制而非用 braille 区间匹配：
// 区间匹配会把标签里任何 braille 字符误判成 working。
const OMP_TITLE_WORKING_SPINNER_FRAMES: ReadonlySet<string> = new Set([
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
]);
// Windows 上 omp 不做标题动画，working 用静态冒号分隔符。
const OMP_TITLE_WINDOWS_WORKING_SEPARATOR = ":";
const OMP_TITLE_IDLE_SEPARATOR = ">";
const OMP_TITLE_ATTENTION_SEPARATOR = "!";
const OMP_TERMINAL_TITLE_BRAND = "π";

// 品牌 `π` + 空格 + 单字符分隔符 + （空格 + 标签 | 行尾）。
// 刻意要求分隔符与品牌之间有空格：`tui.titleState` 关掉时的 `π: label` 里冒号紧贴品牌，
// 于是匹配不上、被正确地当成「无状态信息」忽略，而不是误读成 Windows 的 working。
export function parseOmpTerminalTitleState(title: string): OmpTerminalTitleState | null {
	const trimmedTitle = title.trim();
	if (!trimmedTitle.startsWith(`${OMP_TERMINAL_TITLE_BRAND} `)) {
		return null;
	}
	const afterBrand = trimmedTitle.slice(OMP_TERMINAL_TITLE_BRAND.length + 1);
	// 分隔符恒是单个码点；标签（若有）以一个空格与它隔开。
	const separator = [...afterBrand][0];
	if (separator === undefined) {
		return null;
	}
	const afterSeparator = afterBrand.slice(separator.length);
	if (afterSeparator !== "" && !afterSeparator.startsWith(" ")) {
		return null;
	}
	if (separator === OMP_TITLE_IDLE_SEPARATOR) {
		return "idle";
	}
	if (separator === OMP_TITLE_ATTENTION_SEPARATOR) {
		return "attention";
	}
	if (separator === OMP_TITLE_WINDOWS_WORKING_SEPARATOR || OMP_TITLE_WORKING_SPINNER_FRAMES.has(separator)) {
		return "working";
	}
	return null;
}

// 从一批 PTY 输出里取出所有 OSC 0/1/2（icon name / icon / window title）的标题体。
// omp 只写 OSC 0 并以 BEL 收尾；这里连 OSC 1/2 与 ST（`ESC \`）收尾一起认，是为了不被
// 将来换写法或中间层改写打穿。未收尾的尾巴（chunk 边界切断）直接丢弃——下一帧会重发。
function extractOscTerminalTitles(data: string): string[] {
	const titles: string[] = [];
	const dataLength = data.length;
	let index = 0;
	while (index < dataLength) {
		if (data.charCodeAt(index) !== ESCAPE_CODE_UNIT || data.charCodeAt(index + 1) !== OSC_CLOSE_BRACKET_CODE_UNIT) {
			index += 1;
			continue;
		}
		const parameterCharacter = data[index + 2];
		if (parameterCharacter !== "0" && parameterCharacter !== "1" && parameterCharacter !== "2") {
			index += 1;
			continue;
		}
		if (data.charCodeAt(index + 3) !== SEMICOLON_CODE_UNIT) {
			index += 1;
			continue;
		}
		const titleStartIndex = index + 4;
		let scanIndex = titleStartIndex;
		let titleEndIndex = -1;
		let nextScanStartIndex = -1;
		while (scanIndex < dataLength) {
			const codeUnit = data.charCodeAt(scanIndex);
			if (codeUnit === BELL_CODE_UNIT) {
				titleEndIndex = scanIndex;
				nextScanStartIndex = scanIndex + 1;
				break;
			}
			if (codeUnit === ESCAPE_CODE_UNIT) {
				// ST（`ESC \`）收尾；ESC 后不是反斜杠则该序列畸形，就此中断本次采集。
				titleEndIndex = scanIndex;
				nextScanStartIndex = scanIndex + (data.charCodeAt(scanIndex + 1) === BACKSLASH_CODE_UNIT ? 2 : 1);
				break;
			}
			scanIndex += 1;
		}
		if (titleEndIndex === -1) {
			// 未收尾：这一批到此为止。
			break;
		}
		titles.push(data.slice(titleStartIndex, titleEndIndex));
		index = nextScanStartIndex;
	}
	return titles;
}

// 一批 PTY 输出里可能含多次标题写入（omp 的 spinner 每 80ms 写一次，一个 batch 常裹住好几帧）。
// 取**最后一个**能解析出状态的标题：它才是这批字节结束时的真实状态。
export function readLatestOmpTerminalTitleState(data: string): OmpTerminalTitleState | null {
	let latestState: OmpTerminalTitleState | null = null;
	for (const title of extractOscTerminalTitles(data)) {
		const state = parseOmpTerminalTitleState(title);
		if (state !== null) {
			latestState = state;
		}
	}
	return latestState;
}

// 三态 → 会话状态机事件。idle 与 attention 都是「轮到用户」，区别只在人轴的细分：
// attention 是 agent 主动挡住等你拍板（needs_input），idle 是它把回合交回来了（普通 review）。
// 走 reviewReason "hook" 而不是新造一种成因：这与其它 agent 经 `kanban hooks` 上报的自然完成同义，
// 也让 canReturnToRunning 允许下一笔 working 把卡片翻回 In Progress。
export function detectOmpTerminalTitleStateTransition(
	data: string,
	_summary: RuntimeTaskSessionSummary,
): SessionTransitionEvent | null {
	const state = readLatestOmpTerminalTitleState(data);
	if (state === null) {
		return null;
	}
	if (state === "working") {
		return { type: "hook.to_in_progress" };
	}
	if (state === "attention") {
		return { type: "hook.to_review", reviewReason: "hook", userTurnKindOverride: "needs_input" };
	}
	return { type: "hook.to_review", reviewReason: "hook" };
}
