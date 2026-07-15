// Shared normalization for scanning decoded terminal output (ANSI-stripped).
//
// Terminal agents redraw status lines in place using carriage returns and ANSI
// escape sequences, so a naive `stripAnsi` leaves `\r`-spliced fragments that
// defeat substring/regex matching. `stripAnsiAndControl` removes ANSI CSI/OSC
// sequences and non-printable control bytes (keeping `\n` / `\r` / `\t`), and
// `normalizeTerminalText` then lowercases and collapses all whitespace (including
// the redraw `\r`s) into single spaces so pattern matchers see a stable line.
//
// Used by workspace-trust detection, the output-reactions framework's
// connection-error matching, and any other decoded-output scanner.

const ESCAPE_CODE_UNIT = 0x1b;
const BELL_CODE_UNIT = 0x07;
const DELETE_CODE_UNIT = 0x7f;
const LINE_FEED_CODE_UNIT = 0x0a;
const CARRIAGE_RETURN_CODE_UNIT = 0x0d;
const HORIZONTAL_TAB_CODE_UNIT = 0x09;
const CSI_OPEN_BRACKET_CODE_UNIT = 0x5b; // "["
const OSC_CLOSE_BRACKET_CODE_UNIT = 0x5d; // "]"
const BACKSLASH_CODE_UNIT = 0x5c; // "\\"

// index 处是否为一对完整的 UTF-16 代理对（高位后紧跟低位）。charCodeAt 越界返回 NaN，
// 比较自然为 false，无需显式边界检查。
function isSurrogatePairAt(text: string, index: number): boolean {
	const highCodeUnit = text.charCodeAt(index);
	if (highCodeUnit < 0xd800 || highCodeUnit > 0xdbff) {
		return false;
	}
	const lowCodeUnit = text.charCodeAt(index + 1);
	return lowCodeUnit >= 0xdc00 && lowCodeUnit <= 0xdfff;
}

// 状态机语义与历史逐码点实现（`for...of` + `output += char`）逐字节等价——该函数在终端输出
// 热路径上被每批分析文本调用，逐码点字符串累加在长 chunk 下产生 O(n) 次中间字符串分配，曾是
// 低负载 TUI 卡顿的事件循环单项大头。此实现按「保留 run 起止索引」切片 + join，分配次数降为
// O(run 数)。既有怪癖刻意保留（下游 substance / connection-error 语义依赖逐字节等价）：
//   - 两字节转义（如 `ESC ( B` 字符集切换）只消费 ESC 后第一个字符即回 text，末字节 `B` 漏进
//     正文——不得「顺手修正」。
//   - C1 控制符（0x80–0x9F）按可打印保留（历史行为：code >= 32 即保留）。
export function stripAnsiAndControl(input: string): string {
	const inputLength = input.length;
	const retainedSegments: string[] = [];
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	// 当前未收尾的「保留 run」起点；-1 表示不在 run 中。
	let retainedRunStartIndex = -1;
	let index = 0;
	while (index < inputLength) {
		const codeUnit = input.charCodeAt(index);
		if (mode === "text") {
			if (codeUnit === ESCAPE_CODE_UNIT) {
				if (retainedRunStartIndex >= 0) {
					retainedSegments.push(input.slice(retainedRunStartIndex, index));
					retainedRunStartIndex = -1;
				}
				mode = "escape";
				index += 1;
				continue;
			}
			if (
				(codeUnit >= 32 && codeUnit !== DELETE_CODE_UNIT) ||
				codeUnit === LINE_FEED_CODE_UNIT ||
				codeUnit === CARRIAGE_RETURN_CODE_UNIT ||
				codeUnit === HORIZONTAL_TAB_CODE_UNIT
			) {
				if (retainedRunStartIndex < 0) {
					retainedRunStartIndex = index;
				}
			} else if (retainedRunStartIndex >= 0) {
				retainedSegments.push(input.slice(retainedRunStartIndex, index));
				retainedRunStartIndex = -1;
			}
			index += 1;
			continue;
		}
		if (mode === "escape") {
			if (codeUnit === CSI_OPEN_BRACKET_CODE_UNIT) {
				mode = "csi";
				index += 1;
				continue;
			}
			if (codeUnit === OSC_CLOSE_BRACKET_CODE_UNIT) {
				mode = "osc";
				index += 1;
				continue;
			}
			// 历史实现按码点（for...of）消费 ESC 后的这个字符再回 text——代理对整对吞掉。
			mode = "text";
			index += isSurrogatePairAt(input, index) ? 2 : 1;
			continue;
		}
		if (mode === "csi") {
			if (codeUnit >= 64 && codeUnit <= 126) {
				mode = "text";
			}
			index += 1;
			continue;
		}
		if (mode === "osc") {
			if (codeUnit === BELL_CODE_UNIT) {
				mode = "text";
			} else if (codeUnit === ESCAPE_CODE_UNIT) {
				mode = "osc_escape";
			}
			index += 1;
			continue;
		}
		// mode === "osc_escape"
		mode = codeUnit === BACKSLASH_CODE_UNIT ? "text" : "osc";
		index += 1;
	}
	if (retainedRunStartIndex >= 0) {
		retainedSegments.push(input.slice(retainedRunStartIndex, inputLength));
	}
	// 整串都是保留内容（最常见：纯文本 chunk）时直接返回原串，零分配。
	if (retainedSegments.length === 1 && retainedSegments[0]?.length === inputLength) {
		return input;
	}
	return retainedSegments.join("");
}

export function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

// Convenience: strip + lowercase + collapse whitespace in one call.
export function normalizeDecodedTerminalOutput(input: string): string {
	return normalizeTerminalText(stripAnsiAndControl(input));
}
