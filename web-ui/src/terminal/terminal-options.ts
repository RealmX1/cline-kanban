import type { ITerminalOptions } from "@xterm/xterm";

import type { ThemeTerminalColors } from "@/hooks/use-theme";

interface CreateKanbanTerminalOptionsInput {
	cursorColor: string;
	isMacPlatform: boolean;
	terminalBackgroundColor: string;
	themeColors: ThemeTerminalColors;
}

const TERMINAL_WORD_SEPARATOR = " ()[]{}',\"`";
// 全局「保留最近 2 万行」语义：每个 xterm 主分配的大头就是 scrollback，10 万→2 万行约省 5×/终端。
// 2 万行对 agent 终端 ≈ 400 屏，远超日常往回看需要。须与服务端 mirror 的 TERMINAL_SCROLLBACK
// (src/terminal/terminal-state-mirror.ts) 保持一致，且 server ≥ client，否则恢复时会丢可见历史。
const TERMINAL_SCROLLBACK_LINES = 20_000;
const TERMINAL_FONT_FAMILY =
	"'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace";
const TERMINAL_ANSI_THEME = {
	black: "#000000",
	red: "#CD3131",
	green: "#0DBC79",
	yellow: "#E5E510",
	blue: "#2472C8",
	magenta: "#BC3FBC",
	cyan: "#11A8CD",
	white: "#E5E5E5",
	brightBlack: "#666666",
	brightRed: "#F14C4C",
	brightGreen: "#23D18B",
	brightYellow: "#F5F543",
	brightBlue: "#3B8EEA",
	brightMagenta: "#D670D6",
	brightCyan: "#29B8DB",
	brightWhite: "#FFFFFF",
} as const;

export function createKanbanTerminalOptions({
	cursorColor,
	isMacPlatform,
	terminalBackgroundColor,
	themeColors,
}: CreateKanbanTerminalOptionsInput): ITerminalOptions {
	return {
		allowProposedApi: true,
		allowTransparency: false,
		convertEol: false,
		cursorBlink: false,
		cursorInactiveStyle: "outline",
		cursorStyle: "block",
		disableStdin: false,
		fontFamily: TERMINAL_FONT_FAMILY,
		fontSize: 13,
		fontWeight: "normal",
		fontWeightBold: "bold",
		letterSpacing: 0,
		lineHeight: 1,
		macOptionClickForcesSelection: isMacPlatform,
		macOptionIsMeta: isMacPlatform,
		rightClickSelectsWord: false,
		scrollOnEraseInDisplay: true,
		scrollOnUserInput: true,
		scrollback: TERMINAL_SCROLLBACK_LINES,
		smoothScrollDuration: 0,
		theme: {
			...TERMINAL_ANSI_THEME,
			background: terminalBackgroundColor,
			cursor: cursorColor,
			cursorAccent: terminalBackgroundColor,
			foreground: themeColors.textPrimary,
			selectionBackground: themeColors.selectionBackground,
			selectionForeground: themeColors.selectionForeground,
			selectionInactiveBackground: themeColors.selectionInactiveBackground,
		},
		windowOptions: {
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		},
		wordSeparator: TERMINAL_WORD_SEPARATOR,
	};
}
