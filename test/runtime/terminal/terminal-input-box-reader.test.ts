import { describe, expect, it } from "vitest";

import {
	CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
	locateTerminalInputBox,
	measureTerminalDisplayColumnWidth,
	readTerminalInputBox,
	type TerminalScreenSnapshot,
} from "../../../src/terminal/terminal-input-box-reader";

// 真机实测语法（Claude Code v2.1.227，2026-08-11，cols=100）。
// 这些常数是**外部契约**，会随 Claude 版本漂移——本套件的作用是让漂移在 CI 里炸出来，
// 而不是在一次「投递躺了 49 分钟」的事故里被发现。
const COLUMN_COUNT = 100;
const BOUNDARY_LINE = "─".repeat(COLUMN_COUNT);
const PROMPT_PREFIX = "❯ "; // ❯ + NBSP（**不是**普通空格）
const CONTINUATION_INDENT = "  ";
// TUI 自折宽度 = cols - 左缩进 2 - 右留白 2。实测 392 字符单行拆成 96×4 + 8。
const CONTENT_WIDTH = COLUMN_COUNT - 4;

function screen(lines: string[], columnCount = COLUMN_COUNT): TerminalScreenSnapshot {
	return {
		lines: lines.map((text) => ({ text, isWrapped: false })),
		columnCount,
	};
}

// 真机上框外还有启动横幅与状态行，读框必须在这些噪声里正确定位。
function withSurroundingChrome(boxLines: string[]): string[] {
	return [
		" ▐▛███▜▌   Claude Code v2.1.227",
		"▝▜█████▛▘  Opus 5 (1M context)",
		"",
		...boxLines,
		"  ⚠ Transcript saving is off",
		"  ⏸ manual mode on",
	];
}

describe("locateTerminalInputBox", () => {
	it("在启动横幅与状态行之间定位到输入框", () => {
		const snapshot = screen(withSurroundingChrome([BOUNDARY_LINE, `${PROMPT_PREFIX}hello`, BOUNDARY_LINE]));

		const location = locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(location).not.toBeNull();
		expect(snapshot.lines[(location?.topBoundaryLineIndex ?? 0) + 1].text).toBe(`${PROMPT_PREFIX}hello`);
	});

	it("忽略 agent 输出里的装饰性横线对——只有夹着提示符行的那一对才算输入框", () => {
		const snapshot = screen([
			BOUNDARY_LINE,
			"  这是 agent 打印的表格，不是输入框",
			BOUNDARY_LINE,
			"",
			BOUNDARY_LINE,
			`${PROMPT_PREFIX}真正的输入框`,
			BOUNDARY_LINE,
		]);

		const location = locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(location?.topBoundaryLineIndex).toBe(4);
		expect(location?.bottomBoundaryLineIndex).toBe(6);
	});

	it("屏上没有输入框时返回 null（TUI 尚未渲染 / 被全屏输出覆盖）", () => {
		const snapshot = screen(["agent 正在输出", "还没有画出输入框"]);

		expect(locateTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)).toBeNull();
	});
});

describe("readTerminalInputBox", () => {
	it("空框读成空文本——提示符后是 U+00A0，不能先去尾空白把它一起吃掉", () => {
		const snapshot = screen(withSurroundingChrome([BOUNDARY_LINE, PROMPT_PREFIX, BOUNDARY_LINE]));

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.text).toBe("");
		expect(reading?.logicalLines).toEqual([]);
	});

	it("剥掉首行提示符前缀与续行的 2 空格缩进", () => {
		const snapshot = screen(
			withSurroundingChrome([
				BOUNDARY_LINE,
				`${PROMPT_PREFIX}INDENTPROBE-line-1`,
				`${CONTINUATION_INDENT}INDENTPROBE-line-2`,
				`${CONTINUATION_INDENT}INDENTPROBE-line-3`,
				BOUNDARY_LINE,
			]),
		);

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.logicalLines).toEqual(["INDENTPROBE-line-1", "INDENTPROBE-line-2", "INDENTPROBE-line-3"]);
		// 三行都没写满 ⇒ 全部是硬换行，一次合并都不该发生。
		expect(reading?.softWrapJoinCount).toBe(0);
	});

	it("把 TUI 自折的长行合并回一条逻辑行（isWrapped 恒 false，只能靠宽度判据）", () => {
		// 复刻真机：392 字符单行被 Claude 拆成 96/96/96/96/8 共 5 个 buffer 行。
		const original = `WRAPPROBE${"abcdefghij".repeat(38)}END`;
		expect(original).toHaveLength(392);
		const rows: string[] = [];
		for (let offset = 0; offset < original.length; offset += CONTENT_WIDTH) {
			const chunk = original.slice(offset, offset + CONTENT_WIDTH);
			rows.push(rows.length === 0 ? `${PROMPT_PREFIX}${chunk}` : `${CONTINUATION_INDENT}${chunk}`);
		}
		expect(rows).toHaveLength(5);

		const reading = readTerminalInputBox(
			screen(withSurroundingChrome([BOUNDARY_LINE, ...rows, BOUNDARY_LINE])),
			CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
		);

		expect(reading?.logicalLines).toEqual([original]);
		expect(reading?.softWrapJoinCount).toBe(4);
	});

	it("软折行与硬换行混排时各自归位", () => {
		const wrappedLine = "W".repeat(CONTENT_WIDTH);
		const snapshot = screen(
			withSurroundingChrome([
				BOUNDARY_LINE,
				`${PROMPT_PREFIX}${wrappedLine}`,
				`${CONTINUATION_INDENT}tail`,
				`${CONTINUATION_INDENT}second-hard-line`,
				BOUNDARY_LINE,
			]),
		);

		const reading = readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR);

		expect(reading?.logicalLines).toEqual([`${wrappedLine}tail`, "second-hard-line"]);
		expect(reading?.softWrapJoinCount).toBe(1);
	});

	it("框尾预留的空行不算用户敲出来的空行", () => {
		const snapshot = screen(
			withSurroundingChrome([BOUNDARY_LINE, `${PROMPT_PREFIX}only-line`, "", "", BOUNDARY_LINE]),
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.logicalLines).toEqual(["only-line"]);
	});

	it("保留用户内容中间的空行", () => {
		const snapshot = screen(
			withSurroundingChrome([
				BOUNDARY_LINE,
				`${PROMPT_PREFIX}first`,
				CONTINUATION_INDENT,
				`${CONTINUATION_INDENT}third`,
				BOUNDARY_LINE,
			]),
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.logicalLines).toEqual([
			"first",
			"",
			"third",
		]);
	});

	it("续行缩进不符时原样收下，绝不切掉用户的字", () => {
		const snapshot = screen(
			withSurroundingChrome([BOUNDARY_LINE, `${PROMPT_PREFIX}first`, "no-indent-line", BOUNDARY_LINE]),
		);

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.logicalLines).toEqual([
			"first",
			"no-indent-line",
		]);
	});

	it("提示符后是普通空格时同样识别（容忍 TUI 换掉 NBSP）", () => {
		const snapshot = screen(withSurroundingChrome([BOUNDARY_LINE, "❯ hello", BOUNDARY_LINE]));

		expect(readTerminalInputBox(snapshot, CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR)?.text).toBe("hello");
	});

	// 宽字符是这套宽度判据最容易被 ASCII 用例掩盖的盲区：本仓用户以中文为主，
	// 一个被插入假换行的暂存内容是静默的数据损坏，故单独成组守住。
	describe("宽字符（CJK / 全角）的折行判据", () => {
		it("整行中文写满内容区时合并回一条逻辑行——判据必须是显示列宽而不是 String.length", () => {
			// 48 个中文字 == 96 显示列 == 内容宽度，正好写满并触发 TUI 自折；
			// 但 String.length 只有 48，按码元数判「写满」会漏判、凭空多出一个换行。
			const chineseFullRow = "中".repeat(48);
			expect(chineseFullRow).toHaveLength(CONTENT_WIDTH / 2);
			expect(measureTerminalDisplayColumnWidth(chineseFullRow)).toBe(CONTENT_WIDTH);

			const reading = readTerminalInputBox(
				screen(
					withSurroundingChrome([
						BOUNDARY_LINE,
						`${PROMPT_PREFIX}${chineseFullRow}`,
						`${CONTINUATION_INDENT}尾巴`,
						BOUNDARY_LINE,
					]),
				),
				CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
			);

			expect(reading?.logicalLines).toEqual([`${chineseFullRow}尾巴`]);
			expect(reading?.softWrapJoinCount).toBe(1);
		});

		it("中英混排把行尾卡在 95 列时同样算写满——下一个中文字要 2 列，那 1 列空隙塞不下它", () => {
			const mixedFullRow = `${"中".repeat(47)}a`;
			expect(measureTerminalDisplayColumnWidth(mixedFullRow)).toBe(CONTENT_WIDTH - 1);

			const reading = readTerminalInputBox(
				screen(
					withSurroundingChrome([
						BOUNDARY_LINE,
						`${PROMPT_PREFIX}${mixedFullRow}`,
						`${CONTINUATION_INDENT}续上的中文`,
						BOUNDARY_LINE,
					]),
				),
				CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
			);

			expect(reading?.logicalLines).toEqual([`${mixedFullRow}续上的中文`]);
			expect(reading?.softWrapJoinCount).toBe(1);
		});

		it("中文硬换行不该被合并：短行与「还塞得下一个中文字」的行都判为硬换行", () => {
			// 94 列，右边还剩 2 列、正好还能再放一个中文字 ⇒ TUI 不会在这里自折。
			const nearlyFullChineseRow = "中".repeat(47);
			expect(measureTerminalDisplayColumnWidth(nearlyFullChineseRow)).toBe(CONTENT_WIDTH - 2);

			const reading = readTerminalInputBox(
				screen(
					withSurroundingChrome([
						BOUNDARY_LINE,
						`${PROMPT_PREFIX}第一段中文`,
						`${CONTINUATION_INDENT}${nearlyFullChineseRow}`,
						`${CONTINUATION_INDENT}第三段中文`,
						BOUNDARY_LINE,
					]),
				),
				CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
			);

			expect(reading?.logicalLines).toEqual(["第一段中文", nearlyFullChineseRow, "第三段中文"]);
			expect(reading?.softWrapJoinCount).toBe(0);
		});
	});

	it("终端宽度变化时折行宽度随之变化", () => {
		const narrowColumnCount = 40;
		const narrowContentWidth = narrowColumnCount - 4;
		const original = `${"N".repeat(narrowContentWidth)}tail`;

		const reading = readTerminalInputBox(
			screen(
				[
					BOUNDARY_LINE.slice(0, narrowColumnCount),
					`${PROMPT_PREFIX}${original.slice(0, narrowContentWidth)}`,
					`${CONTINUATION_INDENT}${original.slice(narrowContentWidth)}`,
					BOUNDARY_LINE.slice(0, narrowColumnCount),
				],
				narrowColumnCount,
			),
			CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
		);

		expect(reading?.logicalLines).toEqual([original]);
	});
});

describe("measureTerminalDisplayColumnWidth", () => {
	it.each([
		["ASCII 逐字符 1 列", "abc", 3],
		["中文一字 2 列", "中文", 4],
		["全角 ASCII 一字 2 列", "ＦＵＬＬ", 8],
		["日文假名一字 2 列", "かなカナ", 8],
		["谚文音节一字 2 列", "한글", 4],
		["中英混排按各自宽度累加", "中a文b", 6],
		["组合记号不占列（e + U+0301 显示成一个 é）", "e\u0301", 1],
		["零宽空格不占列", "a\u200Bb", 2],
		["emoji 2 列（String.length 是 2，恰好蒙对，不能因此退回按码元数）", "🚀", 2],
		["变体选择符把文字形态符号提升为 emoji 形态、宽度随之 2 列", "❤\uFE0F", 2],
		["ZWJ 拼出的 emoji 序列整串算 2 列", "👨\u200D👩\u200D👧", 2],
	])("%s", (_title, text, expectedColumnWidth) => {
		expect(measureTerminalDisplayColumnWidth(text)).toBe(expectedColumnWidth);
	});

	it("宽字符的显示列宽是 String.length 的两倍——这正是旧判据漏判「写满」的根因", () => {
		const chineseFullRow = "中".repeat(48);

		expect(chineseFullRow.length).toBe(48);
		expect(measureTerminalDisplayColumnWidth(chineseFullRow)).toBe(96);
	});
});
