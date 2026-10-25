import { afterEach, describe, expect, it } from "vitest";
import { readCodexTerminalComposerOccupancy } from "../../../src/terminal/codex-terminal-composer-occupancy";
import type { TerminalScreenSnapshot } from "../../../src/terminal/terminal-input-box-reader";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

const mirrors: TerminalStateMirror[] = [];
afterEach(() => {
	for (const mirror of mirrors.splice(0)) mirror.dispose();
});

describe("Codex 活动输入框的保守判空", () => {
	it.each([
		["dim 占位文案", "› Ask Codex to do anything", 2, [[2, 26]], "empty"],
		["与占位文案同文的真实草稿", "› Ask Codex to do anything", 2, [], "nonempty"],
		["光标在草稿末尾", "› abc", 5, [], "nonempty"],
		["光标回到草稿开头", "› abc", 2, [], "nonempty"],
		["裸提示符缺少占位证据", "› ", 2, [], "unreadable"],
		["只有空格的草稿", "›   ", 4, [], "nonempty"],
		["换行后的光标不在提示符行", "  后续行", 2, [], "unreadable"],
	] as const)("%s", (_label, text, cursorColumn, dimmedTextColumnRanges, expected) => {
		const snapshot: TerminalScreenSnapshot = {
			columnCount: 80,
			cursorRow: 0,
			cursorColumn,
			lines: [{ text, isWrapped: false, dimmedTextColumnRanges: dimmedTextColumnRanges.map(([a, b]) => [a, b]) }],
		};
		expect(readCodexTerminalComposerOccupancy(snapshot)).toBe(expected);
	});

	it("不以历史提示符或缺失光标的屏幕认定当前空框", () => {
		const lines: TerminalScreenSnapshot["lines"] = [
			{ text: "› Ask Codex to do anything", isWrapped: false, dimmedTextColumnRanges: [[2, 26]] },
		];
		expect(readCodexTerminalComposerOccupancy({ lines, columnCount: 80 })).toBe("unreadable");
		expect(
			readCodexTerminalComposerOccupancy({
				lines: [...lines, { text: "正在执行…", isWrapped: false }],
				columnCount: 80,
				cursorRow: 1,
				cursorColumn: 0,
			}),
		).toBe("unreadable");
	});

	it("真实 headless 终端保留 dim 范围与光标；同文手输不会被认成占位符", async () => {
		const mirror = new TerminalStateMirror(80, 24);
		mirrors.push(mirror);
		mirror.applyOutput(Buffer.from("› \u001b[2mAsk Codex to do anything\u001b[0m\r\u001b[2C"));
		const placeholder = await mirror.getScreenSnapshot({ includeDimmedTextColumnRanges: true });
		expect(readCodexTerminalComposerOccupancy(placeholder)).toBe("empty");
		expect((await mirror.getScreenSnapshot()).lines[0]?.dimmedTextColumnRanges).toBeUndefined();
		mirror.applyOutput(Buffer.from("\r\u001b[2K› Ask Codex to do anything\r\u001b[2C"));
		expect(
			readCodexTerminalComposerOccupancy(await mirror.getScreenSnapshot({ includeDimmedTextColumnRanges: true })),
		).toBe("nonempty");
	});
});
