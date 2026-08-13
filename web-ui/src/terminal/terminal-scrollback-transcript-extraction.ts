// 从 xterm 的 normal buffer 提取「可当作文档阅读的 transcript」，**连同每个字符的颜色与字形属性**。
//
// 为什么读 buffer 而不是解析 ANSI：xterm 已经把 PTY 字节流解析成结构化的行/单元格网格，
// `IBufferCell` 直接给出该格的前景/背景色与 bold/dim/italic/underline/inverse 等属性，
// `IBufferLine.isWrapped` 还额外告诉我们哪些物理行只是上一行超出列宽折下来的续行。
// 所以既不需要服务端下发序列化快照，也不需要引 ANSI 解析库。
//
// **不要退回 `translateToString()`。** 它只返回字符、丢弃全部单元格属性，阅读视图会因此塌成
// 单色等宽文本块 —— agent TUI 恰恰是靠颜色区分「工具输出 / diff 增删 / 消息类型 / 强调」的，
// 丢掉颜色等于丢掉这份 transcript 一半的信息量。本模块因此逐单元格读取并按样式合并成 run。
//
// 为什么固定读 `buffer.normal` 而非 `buffer.active`：
//   - inline agent 的会话历史堆在 normal buffer 的 scrollback 里，正是本视图要读的东西；
//   - alt-screen agent（Claude Code、Codex 等）在 alternate buffer 里原地重绘，normal buffer
//     基本是空的。读 normal 让这类 agent 自然落到「没有可读 transcript」，
//     由调用方隐藏入口，而不是渲染出一个空壳视图。
//
// 注意 Claude Code 归在哪一类是**会变的**：它曾被 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 摁成
// inline，现在默认跑 fullscreen 渲染器（见 src/terminal/agent-session-adapters.ts 的
// resolveClaudeCodeTerminalRenderingModeEnv），故按 alt-screen 对待。本模块的判据是
// buffer 形态而非 agentId，两种形态都已自洽，改渲染器默认时这里无需跟着改。

import { resolveAnsiPaletteColor, resolveTrueColorFromPackedRgb } from "@/terminal/terminal-ansi-color-palette";

/** 本模块所需的 xterm 单元格能力子集（结构化类型，便于单测造假对象）。 */
export interface TerminalScrollbackTranscriptSourceBufferCell {
	getWidth(): number;
	getChars(): string;
	getFgColor(): number;
	getBgColor(): number;
	isFgDefault(): boolean;
	isBgDefault(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isStrikethrough(): number;
	isInverse(): number;
	isInvisible(): number;
}

/** 本模块所需的 xterm buffer 行能力子集。 */
export interface TerminalScrollbackTranscriptSourceBufferLine {
	readonly isWrapped: boolean;
	readonly length: number;
	getCell(
		cellIndex: number,
		reusableCell?: TerminalScrollbackTranscriptSourceBufferCell,
	): TerminalScrollbackTranscriptSourceBufferCell | undefined;
}

/** 本模块所需的 xterm buffer 能力子集。 */
export interface TerminalScrollbackTranscriptSourceBuffer {
	readonly length: number;
	getLine(lineIndex: number): TerminalScrollbackTranscriptSourceBufferLine | undefined;
}

/** 本模块所需的 xterm Terminal 能力子集。真实 `Terminal` 结构上即满足此接口。 */
export interface TerminalScrollbackTranscriptSource {
	readonly rows: number;
	/**
	 * 当前列数。**必需**：`IBufferLine.length` 在终端缩窄后并不跟着变小
	 * （xterm 不裁剪行数组），只有拿 `cols` 钳位才知道每行到底有几格是当前内容。
	 */
	readonly cols: number;
	readonly buffer: {
		readonly normal: TerminalScrollbackTranscriptSourceBuffer;
	};
}

/**
 * 一段同样式的连续字符（run）。相邻单元格样式相同即合并，故一条逻辑行通常只有个位数的 run。
 *
 * `foregroundColor` / `backgroundColor` 为 `null` 表示「用视图的默认色」；`isInverse` 也
 * **不**在此处折算，一并交给渲染方 —— 只有渲染方知道自己的默认前景/背景是什么，
 * 提取层保持与主题无关才能被别的视图复用。
 */
export interface TerminalScrollbackTranscriptStyledSegment {
	text: string;
	foregroundColor: string | null;
	backgroundColor: string | null;
	isBold: boolean;
	isDim: boolean;
	isItalic: boolean;
	isUnderline: boolean;
	isStrikethrough: boolean;
	isInverse: boolean;
	isInvisible: boolean;
}

export interface TerminalScrollbackTranscriptLogicalLine {
	/** 已把 isWrapped 续行拼回的完整逻辑行纯文本，右侧空白已裁掉。过滤/搜索读这一份。 */
	text: string;
	/** 与 `text` 逐字符对齐的样式分段。拼接各段 `text` 恒等于上面的 `text`。 */
	segments: TerminalScrollbackTranscriptStyledSegment[];
	/** 该逻辑行首个物理行在 normal buffer 中的下标，供定位/调试用。 */
	sourceBufferRowIndex: number;
}

/**
 * 是否存在值得单独阅读的 scrollback。
 *
 * `buffer.normal.length` 在终端初始化时就等于 `rows`（buffer 预置了一屏的行），
 * 因此严格大于 rows 才说明确有内容被推出视口 —— 这正是「移动端只看得到最新几行」
 * 所抱怨的场景。alt-screen agent 的 normal buffer 不增长，故此处返回 false。
 */
export function hasTerminalScrollbackTranscriptContent(terminal: TerminalScrollbackTranscriptSource): boolean {
	return terminal.buffer.normal.length > terminal.rows;
}

/**
 * 把 normal buffer 的物理行折叠成带样式的逻辑行。
 *
 * 拼接时中间段一律保留整行宽度（不逐行裁右侧空白）—— 若对中间段裁掉右侧空白，跨行折断处的
 * 空格会丢失，把 `foo bar` 拼成 `foobar`。整条逻辑行拼完后再统一裁一次尾部空白。
 */
export function extractTerminalScrollbackTranscriptLogicalLines(
	terminal: TerminalScrollbackTranscriptSource,
): TerminalScrollbackTranscriptLogicalLine[] {
	const buffer = terminal.buffer.normal;
	const logicalLines: TerminalScrollbackTranscriptLogicalLine[] = [];
	const extractionState = createTranscriptExtractionState();
	let pendingSourceBufferRowIndex = 0;

	const flushPendingLogicalLine = (): void => {
		if (extractionState.segments.length === 0) {
			return;
		}
		logicalLines.push(buildLogicalLineFromSegments(extractionState.segments, pendingSourceBufferRowIndex));
		extractionState.segments = [];
	};

	for (let bufferRowIndex = 0; bufferRowIndex < buffer.length; bufferRowIndex += 1) {
		const bufferLine = buffer.getLine(bufferRowIndex);
		if (!bufferLine) {
			continue;
		}
		// 首行永远开启一条新逻辑行，即便 xterm 把它标成 wrapped（scrollback 被裁剪后
		// 顶行可能保留着 wrapped 标记，而它的前驱已经不在 buffer 里）。
		if (!bufferLine.isWrapped || extractionState.segments.length === 0) {
			flushPendingLogicalLine();
			pendingSourceBufferRowIndex = bufferRowIndex;
		}
		appendBufferLineCellsToSegments(bufferLine, terminal.cols, extractionState);
	}
	flushPendingLogicalLine();

	return trimTrailingBlankLogicalLines(logicalLines);
}

/**
 * 逐单元格遍历时跨物理行延续的状态。
 *
 * `currentRunStyle` 是「最后一段 run 的原始样式」，用来 O(1) 判断下一格能否并入上一段 ——
 * 存的是 xterm 直接给出的色号与属性位，**不是**解析后的十六进制字符串：解析一次颜色要拼字符串，
 * 而合并判断每格都要做一次，把解析放进判断里会让整段提取慢上两个数量级。
 * 十六进制只在真正开启一段新 run 时解析一次。
 */
interface TerminalScrollbackTranscriptExtractionState {
	segments: TerminalScrollbackTranscriptStyledSegment[];
	currentRunStyle: TerminalCellStyleFingerprint;
	/**
	 * xterm 明确建议在遍历大量单元格时复用同一个 cell 对象，否则每格都要新建对象；
	 * 20k 行 × 上百列的快照下这个差别是实打实的。
	 */
	reusableCell: TerminalScrollbackTranscriptSourceBufferCell | undefined;
}

/** 单元格样式的原始指纹：色号照抄 xterm，字形属性压成一个位掩码，比较时只做数字相等判断。 */
interface TerminalCellStyleFingerprint {
	foregroundColorMode: number;
	foregroundColorValue: number;
	backgroundColorMode: number;
	backgroundColorValue: number;
	attributeFlags: number;
}

const TERMINAL_CELL_COLOR_MODE_DEFAULT = 0;
const TERMINAL_CELL_COLOR_MODE_PALETTE = 1;
const TERMINAL_CELL_COLOR_MODE_TRUE_COLOR = 2;

const TERMINAL_CELL_ATTRIBUTE_FLAG_BOLD = 1 << 0;
const TERMINAL_CELL_ATTRIBUTE_FLAG_DIM = 1 << 1;
const TERMINAL_CELL_ATTRIBUTE_FLAG_ITALIC = 1 << 2;
const TERMINAL_CELL_ATTRIBUTE_FLAG_UNDERLINE = 1 << 3;
const TERMINAL_CELL_ATTRIBUTE_FLAG_STRIKETHROUGH = 1 << 4;
const TERMINAL_CELL_ATTRIBUTE_FLAG_INVERSE = 1 << 5;
const TERMINAL_CELL_ATTRIBUTE_FLAG_INVISIBLE = 1 << 6;

function createTranscriptExtractionState(): TerminalScrollbackTranscriptExtractionState {
	return {
		segments: [],
		// segments 为空时这份指纹不参与判断，故初值取什么都行。
		currentRunStyle: {
			foregroundColorMode: TERMINAL_CELL_COLOR_MODE_DEFAULT,
			foregroundColorValue: 0,
			backgroundColorMode: TERMINAL_CELL_COLOR_MODE_DEFAULT,
			backgroundColorValue: 0,
			attributeFlags: 0,
		},
		reusableCell: undefined,
	};
}

/** 把一个物理行的单元格追加进 run 序列，样式相同即并入上一段。 */
function appendBufferLineCellsToSegments(
	bufferLine: TerminalScrollbackTranscriptSourceBufferLine,
	columnCount: number,
	state: TerminalScrollbackTranscriptExtractionState,
): void {
	// `IBufferLine.length` 的文档原文：缩窄终端后行数组不会被裁剪，故它可能大于当前列数，
	// 必须拿 `Terminal.cols` 钳位。不钳位的话 200 列缩到 80 列后，第 80..199 格的旧内容
	// 会被一并读出、追加到每条逻辑行尾 —— 只有恰好是空白时才会被裁尾掩盖过去。
	const readableCellCount = Math.min(bufferLine.length, columnCount);
	const currentRunStyle = state.currentRunStyle;
	for (let cellIndex = 0; cellIndex < readableCellCount; cellIndex += 1) {
		const cell = bufferLine.getCell(cellIndex, state.reusableCell);
		if (!cell) {
			continue;
		}
		state.reusableCell = cell;
		// 宽字符（CJK / emoji）占两格，后一格 width 为 0 且无字符 —— 它的字形已随前一格给出，
		// 再输出一次会让整行错位。
		if (cell.getWidth() === 0) {
			continue;
		}
		// 空单元格的 getChars() 返回空串，语义上是「一个空格宽的空白」。
		const cellText = cell.getChars() || " ";
		const foregroundColorMode = readCellForegroundColorMode(cell);
		const backgroundColorMode = readCellBackgroundColorMode(cell);
		const foregroundColorValue = foregroundColorMode === TERMINAL_CELL_COLOR_MODE_DEFAULT ? 0 : cell.getFgColor();
		const backgroundColorValue = backgroundColorMode === TERMINAL_CELL_COLOR_MODE_DEFAULT ? 0 : cell.getBgColor();
		const attributeFlags = readCellAttributeFlags(cell);
		const lastSegment = state.segments[state.segments.length - 1];
		if (
			lastSegment &&
			currentRunStyle.foregroundColorMode === foregroundColorMode &&
			currentRunStyle.foregroundColorValue === foregroundColorValue &&
			currentRunStyle.backgroundColorMode === backgroundColorMode &&
			currentRunStyle.backgroundColorValue === backgroundColorValue &&
			currentRunStyle.attributeFlags === attributeFlags
		) {
			lastSegment.text += cellText;
			continue;
		}
		currentRunStyle.foregroundColorMode = foregroundColorMode;
		currentRunStyle.foregroundColorValue = foregroundColorValue;
		currentRunStyle.backgroundColorMode = backgroundColorMode;
		currentRunStyle.backgroundColorValue = backgroundColorValue;
		currentRunStyle.attributeFlags = attributeFlags;
		state.segments.push({
			text: cellText,
			foregroundColor: resolveStyledSegmentColor(foregroundColorMode, foregroundColorValue),
			backgroundColor: resolveStyledSegmentColor(backgroundColorMode, backgroundColorValue),
			isBold: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_BOLD) !== 0,
			isDim: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_DIM) !== 0,
			isItalic: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_ITALIC) !== 0,
			isUnderline: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_UNDERLINE) !== 0,
			isStrikethrough: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_STRIKETHROUGH) !== 0,
			isInverse: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_INVERSE) !== 0,
			isInvisible: (attributeFlags & TERMINAL_CELL_ATTRIBUTE_FLAG_INVISIBLE) !== 0,
		});
	}
}

function readCellAttributeFlags(cell: TerminalScrollbackTranscriptSourceBufferCell): number {
	let attributeFlags = 0;
	if (cell.isBold() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_BOLD;
	}
	if (cell.isDim() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_DIM;
	}
	if (cell.isItalic() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_ITALIC;
	}
	if (cell.isUnderline() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_UNDERLINE;
	}
	if (cell.isStrikethrough() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_STRIKETHROUGH;
	}
	if (cell.isInverse() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_INVERSE;
	}
	if (cell.isInvisible() !== 0) {
		attributeFlags |= TERMINAL_CELL_ATTRIBUTE_FLAG_INVISIBLE;
	}
	return attributeFlags;
}

// 判定顺序照抄原来的解析顺序：default 优先，其次真彩色，最后调色板；三者都不是就当默认色。
function readCellForegroundColorMode(cell: TerminalScrollbackTranscriptSourceBufferCell): number {
	if (cell.isFgDefault()) {
		return TERMINAL_CELL_COLOR_MODE_DEFAULT;
	}
	if (cell.isFgRGB()) {
		return TERMINAL_CELL_COLOR_MODE_TRUE_COLOR;
	}
	if (cell.isFgPalette()) {
		return TERMINAL_CELL_COLOR_MODE_PALETTE;
	}
	return TERMINAL_CELL_COLOR_MODE_DEFAULT;
}

function readCellBackgroundColorMode(cell: TerminalScrollbackTranscriptSourceBufferCell): number {
	if (cell.isBgDefault()) {
		return TERMINAL_CELL_COLOR_MODE_DEFAULT;
	}
	if (cell.isBgRGB()) {
		return TERMINAL_CELL_COLOR_MODE_TRUE_COLOR;
	}
	if (cell.isBgPalette()) {
		return TERMINAL_CELL_COLOR_MODE_PALETTE;
	}
	return TERMINAL_CELL_COLOR_MODE_DEFAULT;
}

/** 只在开启一段新 run 时调用一次，因此这里做字符串解析是划算的。 */
function resolveStyledSegmentColor(colorMode: number, colorValue: number): string | null {
	if (colorMode === TERMINAL_CELL_COLOR_MODE_TRUE_COLOR) {
		return resolveTrueColorFromPackedRgb(colorValue);
	}
	if (colorMode === TERMINAL_CELL_COLOR_MODE_PALETTE) {
		return resolveAnsiPaletteColor(colorValue);
	}
	return null;
}

/**
 * 裁掉逻辑行尾部空白。TUI 会把整屏刷成带背景色的空格，若不裁，每行右侧都拖着一条色带。
 * 裁的依据是纯文本的 `trimEnd()` 长度，再把 run 序列截到同一长度，保证两者始终对齐。
 */
function buildLogicalLineFromSegments(
	segments: TerminalScrollbackTranscriptStyledSegment[],
	sourceBufferRowIndex: number,
): TerminalScrollbackTranscriptLogicalLine {
	// 逐段拼接而不是 `map().join()`：样式频繁变化的行可以有上百段，
	// 每行都为此新建一个中间数组，在 20k 行的快照上是纯浪费。
	let untrimmedText = "";
	for (const segment of segments) {
		untrimmedText += segment.text;
	}
	const trimmedText = untrimmedText.trimEnd();
	return {
		text: trimmedText,
		segments:
			trimmedText.length === untrimmedText.length
				? segments
				: truncateSegmentsToLength(segments, trimmedText.length),
		sourceBufferRowIndex,
	};
}

function truncateSegmentsToLength(
	segments: TerminalScrollbackTranscriptStyledSegment[],
	keptTextLength: number,
): TerminalScrollbackTranscriptStyledSegment[] {
	const truncatedSegments: TerminalScrollbackTranscriptStyledSegment[] = [];
	let consumedTextLength = 0;
	for (const segment of segments) {
		if (consumedTextLength >= keptTextLength) {
			break;
		}
		const remainingTextLength = keptTextLength - consumedTextLength;
		truncatedSegments.push(
			segment.text.length <= remainingTextLength
				? segment
				: { ...segment, text: segment.text.slice(0, remainingTextLength) },
		);
		consumedTextLength += segment.text.length;
	}
	return truncatedSegments;
}

/**
 * 裁掉尾部连续空行。TUI 的 normal buffer 末尾常留一屏高度的空行（光标所在屏），
 * 直接渲染会让阅读视图打开时停在一大片空白上。
 */
function trimTrailingBlankLogicalLines(
	logicalLines: TerminalScrollbackTranscriptLogicalLine[],
): TerminalScrollbackTranscriptLogicalLine[] {
	let lastNonBlankIndex = logicalLines.length - 1;
	while (lastNonBlankIndex >= 0 && logicalLines[lastNonBlankIndex]?.text.length === 0) {
		lastNonBlankIndex -= 1;
	}
	return logicalLines.slice(0, lastNonBlankIndex + 1);
}
