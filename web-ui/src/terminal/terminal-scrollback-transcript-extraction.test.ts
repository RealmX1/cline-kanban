import { describe, expect, it } from "vitest";

import {
	extractTerminalScrollbackTranscriptLogicalLines,
	hasTerminalScrollbackTranscriptContent,
	type TerminalScrollbackTranscriptSource,
	type TerminalScrollbackTranscriptSourceBufferCell,
} from "@/terminal/terminal-scrollback-transcript-extraction";

/** 一段同样式的字符，用来拼出假的 buffer 行。省略的属性一律取终端默认。 */
interface FakeStyledRun {
	text: string;
	foregroundPaletteIndex?: number;
	foregroundRgb?: number;
	backgroundPaletteIndex?: number;
	isBold?: boolean;
	isDim?: boolean;
	isItalic?: boolean;
	isUnderline?: boolean;
	isStrikethrough?: boolean;
	isInverse?: boolean;
	isInvisible?: boolean;
	/** 宽字符（CJK/emoji）占两格，后一格 width 为 0 且无字符。 */
	isDoubleWidth?: boolean;
}

interface FakeBufferLineSpec {
	runs: FakeStyledRun[];
	isWrapped?: boolean;
	/**
	 * 排在当前列数之后的残留单元格：终端从更宽的列数缩窄后，xterm 不裁剪行数组，
	 * 旧宽度位置上的内容仍留在 `IBufferLine.length` 覆盖的范围里。
	 */
	staleRunsBeyondColumns?: FakeStyledRun[];
}

function createFakeCell(
	run: FakeStyledRun | null,
	chars: string,
	width: number,
): TerminalScrollbackTranscriptSourceBufferCell {
	const flag = (value: boolean | undefined): number => (value ? 1 : 0);
	return {
		getWidth: () => width,
		getChars: () => chars,
		getFgColor: () => run?.foregroundRgb ?? run?.foregroundPaletteIndex ?? 0,
		getBgColor: () => run?.backgroundPaletteIndex ?? 0,
		isFgDefault: () => run?.foregroundPaletteIndex === undefined && run?.foregroundRgb === undefined,
		isBgDefault: () => run?.backgroundPaletteIndex === undefined,
		isFgPalette: () => run?.foregroundPaletteIndex !== undefined,
		isBgPalette: () => run?.backgroundPaletteIndex !== undefined,
		isFgRGB: () => run?.foregroundRgb !== undefined,
		isBgRGB: () => false,
		isBold: () => flag(run?.isBold),
		isDim: () => flag(run?.isDim),
		isItalic: () => flag(run?.isItalic),
		isUnderline: () => flag(run?.isUnderline),
		isStrikethrough: () => flag(run?.isStrikethrough),
		isInverse: () => flag(run?.isInverse),
		isInvisible: () => flag(run?.isInvisible),
	};
}

/**
 * 模拟 xterm 的定宽单元格网格：每行按 cols 补齐默认样式的空格 —— 真实 TUI 的 buffer 行
 * 也是这样右侧铺满空白单元格的，尾部裁剪与续行拼接的行为都依赖这一点。
 */
function createTranscriptSource(input: {
	rows: number;
	cols: number;
	lines: FakeBufferLineSpec[];
}): TerminalScrollbackTranscriptSource {
	const appendRunCells = (cells: TerminalScrollbackTranscriptSourceBufferCell[], runs: FakeStyledRun[]): void => {
		for (const run of runs) {
			for (const character of run.text) {
				cells.push(createFakeCell(run, character, run.isDoubleWidth ? 2 : 1));
				if (run.isDoubleWidth) {
					cells.push(createFakeCell(run, "", 0));
				}
			}
		}
	};
	const bufferLines = input.lines.map((lineSpec) => {
		const cells: TerminalScrollbackTranscriptSourceBufferCell[] = [];
		appendRunCells(cells, lineSpec.runs);
		while (cells.length < input.cols) {
			cells.push(createFakeCell(null, "", 1));
		}
		appendRunCells(cells, lineSpec.staleRunsBeyondColumns ?? []);
		return {
			isWrapped: lineSpec.isWrapped ?? false,
			length: cells.length,
			getCell: (cellIndex: number) => cells[cellIndex],
		};
	});
	return {
		rows: input.rows,
		cols: input.cols,
		buffer: {
			normal: {
				length: bufferLines.length,
				getLine: (lineIndex: number) => bufferLines[lineIndex],
			},
		},
	};
}

/** 只取纯文本，供不关心样式的断言使用。 */
function extractTexts(source: TerminalScrollbackTranscriptSource): { text: string; sourceBufferRowIndex: number }[] {
	return extractTerminalScrollbackTranscriptLogicalLines(source).map((logicalLine) => ({
		text: logicalLine.text,
		sourceBufferRowIndex: logicalLine.sourceBufferRowIndex,
	}));
}

function plain(text: string): FakeBufferLineSpec {
	return { runs: [{ text }] };
}

describe("extractTerminalScrollbackTranscriptLogicalLines", () => {
	it("keeps unwrapped physical lines as separate logical lines", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 12,
			lines: [plain("first"), plain("second"), plain("third")],
		});

		expect(extractTexts(source)).toEqual([
			{ text: "first", sourceBufferRowIndex: 0 },
			{ text: "second", sourceBufferRowIndex: 1 },
			{ text: "third", sourceBufferRowIndex: 2 },
		]);
	});

	it("joins wrapped continuation rows back into one logical line", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [plain("hello worl"), { runs: [{ text: "d again" }], isWrapped: true }, plain("next")],
		});

		expect(extractTexts(source)).toEqual([
			{ text: "hello world again", sourceBufferRowIndex: 0 },
			{ text: "next", sourceBufferRowIndex: 2 },
		]);
	});

	it("preserves trailing spaces of a wrapped segment so the join does not glue words together", () => {
		// 若中间段按 trimRight 提取，"foo bar   " 会变成 "foo bar"，拼出 "foo barbaz"。
		const source = createTranscriptSource({
			rows: 2,
			cols: 10,
			lines: [plain("foo bar"), { runs: [{ text: "baz" }], isWrapped: true }],
		});

		expect(extractTexts(source)).toEqual([{ text: "foo bar   baz", sourceBufferRowIndex: 0 }]);
	});

	it("starts a new logical line when the very first row is flagged wrapped", () => {
		// scrollback 被裁剪后顶行可能保留 wrapped 标记，而它的前驱已不在 buffer 中。
		const source = createTranscriptSource({
			rows: 2,
			cols: 10,
			lines: [{ runs: [{ text: "orphaned" }], isWrapped: true }, plain("after")],
		});

		expect(extractTexts(source)).toEqual([
			{ text: "orphaned", sourceBufferRowIndex: 0 },
			{ text: "after", sourceBufferRowIndex: 1 },
		]);
	});

	it("trims the trailing blank rows a TUI leaves at the bottom of the buffer", () => {
		const source = createTranscriptSource({
			rows: 4,
			cols: 10,
			lines: [plain("content"), plain(""), plain(""), plain("")],
		});

		expect(extractTexts(source)).toEqual([{ text: "content", sourceBufferRowIndex: 0 }]);
	});

	it("keeps blank rows that sit between content", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [plain("before"), plain(""), plain("after")],
		});

		expect(extractTexts(source)).toEqual([
			{ text: "before", sourceBufferRowIndex: 0 },
			{ text: "", sourceBufferRowIndex: 1 },
			{ text: "after", sourceBufferRowIndex: 2 },
		]);
	});

	it("ignores cells past the current column count that a narrowing resize left behind", () => {
		// xterm 的 IBufferLine.length 在缩窄后仍是旧宽度（行数组不裁剪），只有按 Terminal.cols
		// 钳位才不会把 80..199 格的上一轮内容当成本行的一部分接到行尾。
		const source = createTranscriptSource({
			rows: 2,
			cols: 10,
			lines: [
				{ runs: [{ text: "kept" }], staleRunsBeyondColumns: [{ text: "STALE-WIDE" }] },
				{ runs: [{ text: "after" }], staleRunsBeyondColumns: [{ text: "ALSO-STALE" }] },
			],
		});

		expect(extractTexts(source)).toEqual([
			{ text: "kept", sourceBufferRowIndex: 0 },
			{ text: "after", sourceBufferRowIndex: 1 },
		]);
	});

	it("returns an empty list for an all-blank buffer", () => {
		const source = createTranscriptSource({ rows: 2, cols: 10, lines: [plain(""), plain("")] });

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([]);
	});
});

describe("extractTerminalScrollbackTranscriptLogicalLines styling", () => {
	it("resolves palette and true-color foregrounds instead of discarding them", () => {
		// 这是阅读视图相对于纯文本 dump 的全部价值：丢了颜色，agent TUI 用来区分
		// 工具输出 / diff 增删 / 强调的视觉线索就全没了。
		const source = createTranscriptSource({
			rows: 1,
			cols: 20,
			lines: [
				{
					runs: [
						{ text: "+added", foregroundPaletteIndex: 2 },
						{ text: "-gone", foregroundPaletteIndex: 9 },
						{ text: "!rgb", foregroundRgb: 0x1234ab },
					],
				},
			],
		});

		const [logicalLine] = extractTerminalScrollbackTranscriptLogicalLines(source);

		expect(logicalLine?.segments.map((segment) => [segment.text, segment.foregroundColor])).toEqual([
			["+added", "#0DBC79"],
			["-gone", "#F14C4C"],
			["!rgb", "#1234AB"],
		]);
	});

	it("merges adjacent same-style cells into one run and splits on any style change", () => {
		const source = createTranscriptSource({
			rows: 1,
			cols: 20,
			lines: [
				{
					runs: [
						{ text: "aa", foregroundPaletteIndex: 4 },
						{ text: "bb", foregroundPaletteIndex: 4, isBold: true },
						{ text: "cc", foregroundPaletteIndex: 4 },
					],
				},
			],
		});

		const [logicalLine] = extractTerminalScrollbackTranscriptLogicalLines(source);

		expect(logicalLine?.segments.map((segment) => ({ text: segment.text, isBold: segment.isBold }))).toEqual([
			{ text: "aa", isBold: false },
			{ text: "bb", isBold: true },
			{ text: "cc", isBold: false },
		]);
	});

	it("keeps one run across a wrapped row boundary when the style does not change", () => {
		// 合并判断依赖跨物理行延续的「当前 run 样式」；若这份状态在换行处被重置，
		// 每条折行都会在拼接处凭空多切出一段。
		const source = createTranscriptSource({
			rows: 2,
			cols: 6,
			lines: [
				{ runs: [{ text: "abcdef", foregroundPaletteIndex: 3 }] },
				{ runs: [{ text: "ghi", foregroundPaletteIndex: 3 }], isWrapped: true },
			],
		});

		const [logicalLine] = extractTerminalScrollbackTranscriptLogicalLines(source);

		expect(logicalLine?.segments.map((segment) => [segment.text, segment.foregroundColor])).toEqual([
			["abcdefghi", "#E5E510"],
		]);
	});

	it("carries every cell attribute through to the segment", () => {
		const source = createTranscriptSource({
			rows: 1,
			cols: 10,
			lines: [
				{
					runs: [
						{
							text: "x",
							backgroundPaletteIndex: 1,
							isDim: true,
							isItalic: true,
							isUnderline: true,
							isStrikethrough: true,
							isInverse: true,
							isInvisible: true,
						},
					],
				},
			],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)[0]?.segments[0]).toEqual({
			text: "x",
			foregroundColor: null,
			backgroundColor: "#CD3131",
			isBold: false,
			isDim: true,
			isItalic: true,
			isUnderline: true,
			isStrikethrough: true,
			isInverse: true,
			isInvisible: true,
		});
	});

	it("keeps segments and text aligned after trailing whitespace is trimmed", () => {
		// TUI 会把整屏刷成带背景色的空格；若只裁 text 不裁 segments，每行右侧会拖一条色带。
		const source = createTranscriptSource({
			rows: 1,
			cols: 24,
			lines: [
				{
					runs: [
						{ text: "done", foregroundPaletteIndex: 2 },
						{ text: "    ", backgroundPaletteIndex: 4 },
					],
				},
			],
		});

		const [logicalLine] = extractTerminalScrollbackTranscriptLogicalLines(source);

		expect(logicalLine?.text).toBe("done");
		expect(logicalLine?.segments.map((segment) => segment.text).join("")).toBe(logicalLine?.text);
	});

	it("emits a wide character once rather than duplicating it into its zero-width half", () => {
		const source = createTranscriptSource({
			rows: 1,
			cols: 10,
			lines: [{ runs: [{ text: "中文", isDoubleWidth: true }] }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)[0]?.text).toBe("中文");
	});
});

describe("hasTerminalScrollbackTranscriptContent", () => {
	it("is false when the buffer has not grown past one screen", () => {
		// alt-screen agent（Codex 等）的 normal buffer 停在初始一屏，入口应隐藏。
		const source = createTranscriptSource({ rows: 3, cols: 10, lines: [plain(""), plain(""), plain("")] });

		expect(hasTerminalScrollbackTranscriptContent(source)).toBe(false);
	});

	it("is true once rows have been pushed out of the viewport into scrollback", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [plain("a"), plain("b"), plain("c"), plain("d")],
		});

		expect(hasTerminalScrollbackTranscriptContent(source)).toBe(true);
	});
});
