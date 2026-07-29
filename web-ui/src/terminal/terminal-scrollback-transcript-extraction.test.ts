import { describe, expect, it } from "vitest";

import {
	extractTerminalScrollbackTranscriptLogicalLines,
	hasTerminalScrollbackTranscriptContent,
	type TerminalScrollbackTranscriptSource,
} from "@/terminal/terminal-scrollback-transcript-extraction";

// 模拟 xterm 的定宽 buffer 行：`translateToString(false)` 返回补齐到列宽的整行，
// `translateToString(true)` 裁掉右侧空白。拼接续行时是否保留右侧空白正是本模块的关键行为。
function createTranscriptSource(input: {
	rows: number;
	cols: number;
	lines: { text: string; isWrapped?: boolean }[];
}): TerminalScrollbackTranscriptSource {
	const bufferLines = input.lines.map((line) => {
		const paddedText = line.text.padEnd(input.cols, " ");
		return {
			isWrapped: line.isWrapped ?? false,
			translateToString: (trimRight?: boolean) => (trimRight ? paddedText.replace(/\s+$/, "") : paddedText),
		};
	});
	return {
		rows: input.rows,
		buffer: {
			normal: {
				length: bufferLines.length,
				getLine: (lineIndex: number) => bufferLines[lineIndex],
			},
		},
	};
}

describe("extractTerminalScrollbackTranscriptLogicalLines", () => {
	it("keeps unwrapped physical lines as separate logical lines", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 12,
			lines: [{ text: "first" }, { text: "second" }, { text: "third" }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([
			{ text: "first", sourceBufferRowIndex: 0 },
			{ text: "second", sourceBufferRowIndex: 1 },
			{ text: "third", sourceBufferRowIndex: 2 },
		]);
	});

	it("joins wrapped continuation rows back into one logical line", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [{ text: "hello worl" }, { text: "d again", isWrapped: true }, { text: "next" }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([
			{ text: "hello world again", sourceBufferRowIndex: 0 },
			{ text: "next", sourceBufferRowIndex: 2 },
		]);
	});

	it("preserves trailing spaces of a wrapped segment so the join does not glue words together", () => {
		// 若中间段按 trimRight 提取，"foo bar   " 会变成 "foo bar"，拼出 "foo barbaz"。
		const source = createTranscriptSource({
			rows: 2,
			cols: 10,
			lines: [{ text: "foo bar" }, { text: "baz", isWrapped: true }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([
			{ text: "foo bar   baz", sourceBufferRowIndex: 0 },
		]);
	});

	it("starts a new logical line when the very first row is flagged wrapped", () => {
		// scrollback 被裁剪后顶行可能保留 wrapped 标记，而它的前驱已不在 buffer 中。
		const source = createTranscriptSource({
			rows: 2,
			cols: 10,
			lines: [{ text: "orphaned", isWrapped: true }, { text: "after" }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([
			{ text: "orphaned", sourceBufferRowIndex: 0 },
			{ text: "after", sourceBufferRowIndex: 1 },
		]);
	});

	it("trims the trailing blank rows a TUI leaves at the bottom of the buffer", () => {
		const source = createTranscriptSource({
			rows: 4,
			cols: 10,
			lines: [{ text: "content" }, { text: "" }, { text: "" }, { text: "" }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([
			{ text: "content", sourceBufferRowIndex: 0 },
		]);
	});

	it("keeps blank rows that sit between content", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [{ text: "before" }, { text: "" }, { text: "after" }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([
			{ text: "before", sourceBufferRowIndex: 0 },
			{ text: "", sourceBufferRowIndex: 1 },
			{ text: "after", sourceBufferRowIndex: 2 },
		]);
	});

	it("returns an empty list for an all-blank buffer", () => {
		const source = createTranscriptSource({
			rows: 2,
			cols: 10,
			lines: [{ text: "" }, { text: "" }],
		});

		expect(extractTerminalScrollbackTranscriptLogicalLines(source)).toEqual([]);
	});
});

describe("hasTerminalScrollbackTranscriptContent", () => {
	it("is false when the buffer has not grown past one screen", () => {
		// alt-screen agent（Codex 等）的 normal buffer 停在初始一屏，入口应隐藏。
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [{ text: "" }, { text: "" }, { text: "" }],
		});

		expect(hasTerminalScrollbackTranscriptContent(source)).toBe(false);
	});

	it("is true once rows have been pushed out of the viewport into scrollback", () => {
		const source = createTranscriptSource({
			rows: 3,
			cols: 10,
			lines: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
		});

		expect(hasTerminalScrollbackTranscriptContent(source)).toBe(true);
	});
});
