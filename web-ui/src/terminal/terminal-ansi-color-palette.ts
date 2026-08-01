// 终端 ANSI 调色板的单一真源：xterm 画布与 transcript 阅读视图必须解析出同一组颜色，
// 否则同一段输出在两个视图里配色不一致，用户会以为读到的是另一份内容。
//
// 这里只负责「色号 → 十六进制」。默认前景/背景色随主题走，由 `use-theme.ts` 的
// `getTerminalThemeColors()` 提供（注意各主题的终端色恒为深色：xterm 内部一律按深色渲染，
// 浅色主题靠 globals.css 的画布反相滤镜处理，见 `.kb-terminal-container` 那段注释）。

/** ANSI 前 16 色（VS Code 深色终端配色）。索引即 SGR 30-37 / 90-97 的色号。 */
export const TERMINAL_ANSI_BASE_16_COLORS = [
	"#000000", // 0 black
	"#CD3131", // 1 red
	"#0DBC79", // 2 green
	"#E5E510", // 3 yellow
	"#2472C8", // 4 blue
	"#BC3FBC", // 5 magenta
	"#11A8CD", // 6 cyan
	"#E5E5E5", // 7 white
	"#666666", // 8 bright black
	"#F14C4C", // 9 bright red
	"#23D18B", // 10 bright green
	"#F5F543", // 11 bright yellow
	"#3B8EEA", // 12 bright blue
	"#D670D6", // 13 bright magenta
	"#29B8DB", // 14 bright cyan
	"#FFFFFF", // 15 bright white
] as const;

/** `ITerminalOptions.theme` 需要的具名形式，与上面的索引表同源。 */
export const TERMINAL_ANSI_THEME = {
	black: TERMINAL_ANSI_BASE_16_COLORS[0],
	red: TERMINAL_ANSI_BASE_16_COLORS[1],
	green: TERMINAL_ANSI_BASE_16_COLORS[2],
	yellow: TERMINAL_ANSI_BASE_16_COLORS[3],
	blue: TERMINAL_ANSI_BASE_16_COLORS[4],
	magenta: TERMINAL_ANSI_BASE_16_COLORS[5],
	cyan: TERMINAL_ANSI_BASE_16_COLORS[6],
	white: TERMINAL_ANSI_BASE_16_COLORS[7],
	brightBlack: TERMINAL_ANSI_BASE_16_COLORS[8],
	brightRed: TERMINAL_ANSI_BASE_16_COLORS[9],
	brightGreen: TERMINAL_ANSI_BASE_16_COLORS[10],
	brightYellow: TERMINAL_ANSI_BASE_16_COLORS[11],
	brightBlue: TERMINAL_ANSI_BASE_16_COLORS[12],
	brightMagenta: TERMINAL_ANSI_BASE_16_COLORS[13],
	brightCyan: TERMINAL_ANSI_BASE_16_COLORS[14],
	brightWhite: TERMINAL_ANSI_BASE_16_COLORS[15],
} as const;

/** xterm 256 色立方体的每通道取值（16-231 段用它，非线性、非等距）。 */
const ANSI_256_COLOR_CUBE_CHANNEL_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const ANSI_256_COLOR_CUBE_FIRST_INDEX = 16;
const ANSI_256_GRAYSCALE_FIRST_INDEX = 232;
const ANSI_256_GRAYSCALE_BASE_VALUE = 8;
const ANSI_256_GRAYSCALE_STEP = 10;

/**
 * 把 0-255 的调色板色号解析成十六进制。
 *
 * 三段式与 xterm 内建调色板一致：0-15 为基础 16 色，16-231 为 6×6×6 立方体
 * （index = 16 + 36·r + 6·g + b，通道值取自上面的非等距表），232-255 为 24 级灰阶。
 * 越界色号回落到基础色，不抛异常 —— 这条路径在渲染循环里，宁可显示错色也不该炸掉整个视图。
 */
export function resolveAnsiPaletteColor(paletteColorIndex: number): string {
	const normalizedIndex = Math.trunc(paletteColorIndex);
	// 调色板色号只有 0-255 这么大的取值空间，故整张表在模块加载时一次性算好；
	// 这条路径每帧要被成千上万个单元格调用，退化成一次数组索引后就完全不再参与耗时。
	return ANSI_256_PALETTE_HEX_COLORS[normalizedIndex] ?? TERMINAL_ANSI_BASE_16_COLORS[0];
}

/**
 * 把 `IBufferCell.getFgColor()` 在 RGB 模式下返回的 0xRRGGBB 整数解析成十六进制。
 *
 * 真彩色的取值空间有 1600 万种，无法像调色板那样预解析，改为按 packed 色值记忆化：
 * 真实 TUI 输出反复使用的其实只是很少的几十种颜色，缓存命中后连字符串拼接都省掉。
 * 缓存到达上限直接整表清空（而不是逐条淘汰）—— 这条路径宁可偶尔重算，也不该为了
 * 维护 LRU 顺序在每格上多付出指针操作。
 */
export function resolveTrueColorFromPackedRgb(packedRgbColor: number): string {
	const normalizedPackedRgbColor = Math.trunc(packedRgbColor) & 0xffffff;
	const cachedHexColor = trueColorHexColorCache.get(normalizedPackedRgbColor);
	if (cachedHexColor !== undefined) {
		return cachedHexColor;
	}
	const hexColor = formatRgbChannelsAsHexColor(
		(normalizedPackedRgbColor >> 16) & 0xff,
		(normalizedPackedRgbColor >> 8) & 0xff,
		normalizedPackedRgbColor & 0xff,
	);
	if (trueColorHexColorCache.size >= TRUE_COLOR_HEX_COLOR_CACHE_MAX_ENTRY_COUNT) {
		trueColorHexColorCache.clear();
	}
	trueColorHexColorCache.set(normalizedPackedRgbColor, hexColor);
	return hexColor;
}

const TRUE_COLOR_HEX_COLOR_CACHE_MAX_ENTRY_COUNT = 4096;
const trueColorHexColorCache = new Map<number, string>();

/** 0-255 每个字节的两位大写十六进制写法，省掉每次 `toString(16).padStart(2, "0").toUpperCase()`。 */
const UPPERCASE_HEX_BYTE_STRINGS: readonly string[] = Array.from({ length: 256 }, (_unused, byteValue) =>
	byteValue.toString(16).padStart(2, "0").toUpperCase(),
);

// 一律输出大写十六进制。提取层用颜色字符串标注 run，大小写不统一会让同一种颜色在
// 不同来源（调色板 / 真彩色）下写法不一致，下游按字符串比对时会把本该相同的颜色判成不同。
function formatRgbChannelsAsHexColor(red: number, green: number, blue: number): string {
	return `#${formatChannelAsUppercaseHexByte(red)}${formatChannelAsUppercaseHexByte(green)}${formatChannelAsUppercaseHexByte(blue)}`;
}

function formatChannelAsUppercaseHexByte(channelValue: number): string {
	return UPPERCASE_HEX_BYTE_STRINGS[channelValue & 0xff] ?? "00";
}

/** 按 xterm 内建调色板的三段式规则算出 0-255 全部色号的十六进制写法。 */
function buildAnsi256PaletteHexColors(): readonly string[] {
	return Array.from({ length: 256 }, (_unused, paletteColorIndex) => {
		const baseColor = TERMINAL_ANSI_BASE_16_COLORS[paletteColorIndex];
		if (baseColor) {
			return baseColor;
		}
		if (paletteColorIndex >= ANSI_256_GRAYSCALE_FIRST_INDEX) {
			const grayscaleValue =
				ANSI_256_GRAYSCALE_BASE_VALUE +
				(paletteColorIndex - ANSI_256_GRAYSCALE_FIRST_INDEX) * ANSI_256_GRAYSCALE_STEP;
			return formatRgbChannelsAsHexColor(grayscaleValue, grayscaleValue, grayscaleValue);
		}
		const cubeOffset = paletteColorIndex - ANSI_256_COLOR_CUBE_FIRST_INDEX;
		const red = ANSI_256_COLOR_CUBE_CHANNEL_LEVELS[Math.floor(cubeOffset / 36) % 6] ?? 0;
		const green = ANSI_256_COLOR_CUBE_CHANNEL_LEVELS[Math.floor(cubeOffset / 6) % 6] ?? 0;
		const blue = ANSI_256_COLOR_CUBE_CHANNEL_LEVELS[cubeOffset % 6] ?? 0;
		return formatRgbChannelsAsHexColor(red, green, blue);
	});
}

const ANSI_256_PALETTE_HEX_COLORS: readonly string[] = buildAnsi256PaletteHexColors();
