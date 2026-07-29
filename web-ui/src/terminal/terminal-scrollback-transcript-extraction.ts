// 从 xterm 的 normal buffer 提取「可当作文档阅读的 transcript」。
//
// 为什么读 buffer 而不是解析 ANSI：xterm 已经把 PTY 字节流解析成结构化的
// 行/单元格网格，`IBufferLine.translateToString()` 直接给出去掉全部转义序列的
// 纯文本，`IBufferLine.isWrapped` 还额外告诉我们哪些物理行只是上一行超出列宽
// 折下来的续行。所以既不需要服务端下发序列化快照，也不需要引 ANSI 解析库。
//
// 为什么固定读 `buffer.normal` 而非 `buffer.active`：
//   - inline agent（Claude Code 被 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 强制 inline）
//     的会话历史堆在 normal buffer 的 scrollback 里，正是本视图要读的东西；
//   - alt-screen agent（Codex 等）在 alternate buffer 里原地重绘，normal buffer
//     基本是空的。读 normal 让这类 agent 自然落到「没有可读 transcript」，
//     由调用方隐藏入口，而不是渲染出一个空壳视图。

/** 本模块所需的 xterm buffer 行能力子集（结构化类型，便于单测造假对象）。 */
export interface TerminalScrollbackTranscriptSourceBufferLine {
	readonly isWrapped: boolean;
	translateToString(trimRight?: boolean): string;
}

/** 本模块所需的 xterm buffer 能力子集。 */
export interface TerminalScrollbackTranscriptSourceBuffer {
	readonly length: number;
	getLine(lineIndex: number): TerminalScrollbackTranscriptSourceBufferLine | undefined;
}

/** 本模块所需的 xterm Terminal 能力子集。真实 `Terminal` 结构上即满足此接口。 */
export interface TerminalScrollbackTranscriptSource {
	readonly rows: number;
	readonly buffer: {
		readonly normal: TerminalScrollbackTranscriptSourceBuffer;
	};
}

export interface TerminalScrollbackTranscriptLogicalLine {
	/** 已把 isWrapped 续行拼回的完整逻辑行，右侧空白已裁掉。 */
	text: string;
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
 * 把 normal buffer 的物理行折叠成逻辑行。
 *
 * 拼接时中间段一律用 `translateToString(false)` 保留整行宽度 —— 若对中间段裁掉
 * 右侧空白，跨行折断处的空格会丢失，把 `foo bar` 拼成 `foobar`。整条逻辑行拼完
 * 后再统一 `trimEnd()`。
 */
export function extractTerminalScrollbackTranscriptLogicalLines(
	terminal: TerminalScrollbackTranscriptSource,
): TerminalScrollbackTranscriptLogicalLine[] {
	const buffer = terminal.buffer.normal;
	const logicalLines: TerminalScrollbackTranscriptLogicalLine[] = [];
	let pendingSegments: string[] = [];
	let pendingSourceBufferRowIndex = 0;

	const flushPendingLogicalLine = (): void => {
		if (pendingSegments.length === 0) {
			return;
		}
		logicalLines.push({
			text: pendingSegments.join("").trimEnd(),
			sourceBufferRowIndex: pendingSourceBufferRowIndex,
		});
		pendingSegments = [];
	};

	for (let bufferRowIndex = 0; bufferRowIndex < buffer.length; bufferRowIndex += 1) {
		const bufferLine = buffer.getLine(bufferRowIndex);
		if (!bufferLine) {
			continue;
		}
		// 首行永远开启一条新逻辑行，即便 xterm 把它标成 wrapped（scrollback 被裁剪后
		// 顶行可能保留着 wrapped 标记，而它的前驱已经不在 buffer 里）。
		if (bufferLine.isWrapped && pendingSegments.length > 0) {
			pendingSegments.push(bufferLine.translateToString(false));
			continue;
		}
		flushPendingLogicalLine();
		pendingSourceBufferRowIndex = bufferRowIndex;
		pendingSegments.push(bufferLine.translateToString(false));
	}
	flushPendingLogicalLine();

	return trimTrailingBlankLogicalLines(logicalLines);
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
