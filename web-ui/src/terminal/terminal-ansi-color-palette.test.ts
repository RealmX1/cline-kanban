import { describe, expect, it } from "vitest";

import {
	resolveAnsiPaletteColor,
	resolveTrueColorFromPackedRgb,
	TERMINAL_ANSI_BASE_16_COLORS,
	TERMINAL_ANSI_THEME,
} from "@/terminal/terminal-ansi-color-palette";

describe("resolveAnsiPaletteColor", () => {
	it("returns the base 16 colors verbatim", () => {
		expect(resolveAnsiPaletteColor(0)).toBe("#000000");
		expect(resolveAnsiPaletteColor(2)).toBe("#0DBC79");
		expect(resolveAnsiPaletteColor(9)).toBe("#F14C4C");
		expect(resolveAnsiPaletteColor(15)).toBe("#FFFFFF");
	});

	it("maps the 6x6x6 cube with xterm's non-uniform channel levels", () => {
		// 通道值取自 [0, 95, 135, 175, 215, 255]，不是等距的 0/51/102/…，
		// 按等距算出来的红绿蓝会整体偏暗，diff 的增删色一眼就不对。
		expect(resolveAnsiPaletteColor(16)).toBe("#000000");
		expect(resolveAnsiPaletteColor(196)).toBe("#FF0000");
		expect(resolveAnsiPaletteColor(46)).toBe("#00FF00");
		expect(resolveAnsiPaletteColor(21)).toBe("#0000FF");
		expect(resolveAnsiPaletteColor(231)).toBe("#FFFFFF");
	});

	it("maps the 24-step grayscale ramp", () => {
		expect(resolveAnsiPaletteColor(232)).toBe("#080808");
		expect(resolveAnsiPaletteColor(255)).toBe("#EEEEEE");
	});

	it("falls back to a base color for out-of-range indices instead of throwing", () => {
		// 这条路径跑在渲染循环里，宁可显示错色也不该炸掉整个阅读视图。
		expect(resolveAnsiPaletteColor(-1)).toBe("#000000");
		expect(resolveAnsiPaletteColor(999)).toBe("#000000");
	});
});

describe("resolveTrueColorFromPackedRgb", () => {
	it("unpacks 0xRRGGBB", () => {
		expect(resolveTrueColorFromPackedRgb(0x1234ab)).toBe("#1234AB");
		expect(resolveTrueColorFromPackedRgb(0x000000)).toBe("#000000");
		expect(resolveTrueColorFromPackedRgb(0xffffff)).toBe("#FFFFFF");
	});

	it("pads single-digit channels so the hex string stays 6 wide", () => {
		expect(resolveTrueColorFromPackedRgb(0x010203)).toBe("#010203");
	});

	it("keeps returning the right color after the memoization cache overflows", () => {
		// 解析结果是按 packed 色值记忆化的，缓存满了会整表清空；无论命中、清空还是重算，
		// 同一个色值都必须给出同一个字符串。
		expect(resolveTrueColorFromPackedRgb(0x1234ab)).toBe("#1234AB");
		for (let packedRgbColor = 0; packedRgbColor < 5000; packedRgbColor += 1) {
			resolveTrueColorFromPackedRgb(packedRgbColor);
		}
		expect(resolveTrueColorFromPackedRgb(0x1234ab)).toBe("#1234AB");
		expect(resolveTrueColorFromPackedRgb(0x010203)).toBe("#010203");
	});
});

describe("TERMINAL_ANSI_THEME", () => {
	it("stays in sync with the indexed palette xterm and the reader view share", () => {
		// 两者一旦漂移，同一段输出在 xterm 画布与阅读视图里就是两种配色，
		// 用户会以为自己读到的是另一份内容。
		expect(TERMINAL_ANSI_THEME.green).toBe(TERMINAL_ANSI_BASE_16_COLORS[2]);
		expect(TERMINAL_ANSI_THEME.brightRed).toBe(TERMINAL_ANSI_BASE_16_COLORS[9]);
		expect(TERMINAL_ANSI_THEME.brightWhite).toBe(TERMINAL_ANSI_BASE_16_COLORS[15]);
	});
});
