import { describe, expect, it } from "vitest";

import { getTerminalThemeColors } from "@/hooks/use-theme";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";

describe("createKanbanTerminalOptions", () => {
	it("enables richer terminal capability reporting", () => {
		const options = createKanbanTerminalOptions({
			cursorColor: "#abcdef",
			isMacPlatform: true,
			terminalBackgroundColor: "#101112",
			themeColors: getTerminalThemeColors("default"),
		});

		expect(options.allowProposedApi).toBe(true);
		expect(options.cursorBlink).toBe(false);
		expect(options.cursorInactiveStyle).toBe("outline");
		expect(options.cursorStyle).toBe("block");
		expect(options.scrollback).toBe(100_000);
		expect(options.macOptionIsMeta).toBe(true);
		expect(options.windowOptions).toEqual({
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		});
		expect(options.theme?.background).toBe("#101112");
		expect(options.theme?.cursor).toBe("#abcdef");
	});

	it("defines ANSI colors instead of relying on browser defaults", () => {
		const options = createKanbanTerminalOptions({
			cursorColor: "#abcdef",
			isMacPlatform: false,
			terminalBackgroundColor: "#101112",
			themeColors: getTerminalThemeColors("default"),
		});

		expect(options.theme?.red).toBe("#CD3131");
		expect(options.theme?.green).toBe("#0DBC79");
		expect(options.theme?.blue).toBe("#2472C8");
		expect(options.theme?.brightRed).toBe("#F14C4C");
		expect(options.theme?.brightGreen).toBe("#23D18B");
		expect(options.theme?.brightBlue).toBe("#3B8EEA");
	});
});
