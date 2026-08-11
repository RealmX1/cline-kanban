// 终端 TUI 输入框读取：定位输入框、抽出框内用户尚未提交的内容。
//
// 三个消费者共用同一份语法，避免「同一套 TUI 画法在多处各写一遍、各自腐烂」：
//   - W1 提示符就绪判据（替代原先靠正则猜画法的 hasClaudeInteractivePrompt）
//   - W1 程序化投递的人机争用让路判据
//   - W2 Ctrl+S 把未提交输入暂存进 Prompt Library
//
// ## 真机实测约束（Claude Code v2.1.227，cols=100，2026-08-11）
//
// 空框：
//     ────────────────────────────────────────  ← 整行 U+2500，宽度 == cols
//     ❯                                          ← U+276F + U+00A0
//     ────────────────────────────────────────
//
// 三条与直觉相反、直接决定本模块实现的事实：
//
// 1. **`isWrapped` 恒为 false。** Claude 是 Ink 类 TUI，自己完成折行并把每个视觉行作为独立
//    buffer line 写出，从不依赖终端软折行。实测 392 字符单行占 5 个 buffer 行，5 行全部
//    `isWrapped === false`（粘贴与手打一致）。因此**不能**用 xterm 的软折行标记还原逻辑行——
//    前端 xterm 与服务端镜像在这点上处境相同，这不是前后端之分。
//
// 2. **软折行与硬换行在 buffer 里长得一模一样**，都是「续行缩进 2 空格」。唯一可用的判据是
//    宽度：TUI 在内容宽度 `cols - 缩进 - 右留白` 处折行，故「上一行已写满到放不下下一个字符」
//    才可能是软折行。这里的「宽度」必须是**终端显示列宽**而不是 JS 字符串长度——CJK / 全角
//    字符一个字占 2 列，48 个中文字就写满 96 列的内容区，按 `String.length` 只数出 48。
//    判据因此是「上一行列宽 + 下一行首字符列宽 > 内容宽度」：正因为那个字符在上一行放不下，
//    TUI 才把它挪到了下一行。写成不等式而不是「== 内容宽度」，是因为宽字符会在行尾留下 1 列
//    放不下任何宽字符的空隙（47 个中文字 + 1 个 ASCII = 95 列即是写满）。
//    一段「行尾落在最后一个字符放不下的位置上」的硬换行与软折行**不可区分**——这是不可消除的
//    歧义，只能如实计数上报（`softWrapJoinCount`），绝不假装没有。
//
// 3. **空框不一定是空的。** Claude 有时在空框里渲染占位提示（如
//    `❯ Try "edit session-manager.ts to..."`），且**出现与否不确定**：同一命令、同一 cwd，
//    一次探针拍到、随后 6 次连拍 12 秒都没有。占位提示的单元格属性因此无法可靠采样，
//    「按 dim 属性识别占位提示」不可靠。
//    ⇒ **本模块不承担判空职责**。判空由输入侧字节跟踪（terminal-input-box-occupancy.ts）负责，
//      本模块只负责「框在哪、框里的文本是什么」。两者在 resolveTerminalInputBoxOccupancy 汇合。

// 框边界行：整行都是横线类盒绘制字符（U+2500 段）。实测 Claude 用 U+2500 且宽度 == cols。
const BOX_BOUNDARY_LINE_PATTERN = /^[─-╿]+$/u;

// 边界行的最小宽度。取一个远低于任何真实终端宽度、又高于零星装饰横线的下限。
const MIN_BOX_BOUNDARY_WIDTH = 10;

// ── 终端显示列宽 ────────────────────────────────────────────────────────────────
//
// 为什么在这里自带一份实现，而不是复用现成的宽度函数：
//   - `@xterm/headless` 的 wcwidth 只挂在 `IUnicodeVersionProvider` 这个**注册用**接口上；
//     公开的 `Terminal.unicode` 只给 versions / activeVersion / register，读不到活动 provider
//     的宽度函数。绕道「写进一个隐藏终端再读光标列」要走异步 write 回调，会把本模块从
//     纯函数变成有状态的异步件，而纯函数正是它三个消费者都能直接单测的原因。
//   - `@xterm/addon-unicode11` 是 web-ui 的依赖，运行时根项目没装；`string-width` 只是 ora 的
//     传递依赖、并非本项目声明的依赖，直接 import 等于押注一个随时可能被 npm 去重掉的东西。
//   ⇒ 就地放一份最小 East Asian Width 判据，保持本模块「纯函数 + 零新增依赖」。
//
// 已知边界（都不影响中文 / 中英混排这条主用例，但如实记下）：
//   - Ambiguous 宽度（EAW=A，如 § ± 希腊字母）一律按 1 列算。这与 xterm 默认、以及 Claude 所用
//     Ink → string-width 的默认一致；用户若把终端设成「Ambiguous 按双宽」则会与本判据不符。
//   - 只做「码点 + ZWJ 吸收 + 变体选择符」，不做完整 grapheme cluster 切分：肤色修饰、旗帜等
//     多码点拼出的 emoji 序列，宽度可能与终端实际渲染不一致。
//   - 宽字符区段按 Unicode 16 的 W/F 裁剪成大块，此后新增的区段需要跟进；表里按块收录，
//     块内零星的 Ambiguous 码点（如 U+3248–U+324F）被一并当作宽字符。
// 一律写成转义：这两个码点在编辑器里不可见，字面量形式极易被复制粘贴悄悄弄丢。
const ZERO_WIDTH_JOINER = "\u200D";
const EMOJI_PRESENTATION_SELECTOR = "\uFE0F";
// 非间距/圈组记号（组合记号、变体选择符）、格式字符（ZWSP/ZWNJ/ZWJ）与控制字符都不占列。
const ZERO_WIDTH_CODE_POINT_PATTERN = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;
// emoji 形态的符号一律 2 列，覆盖 ⌚ ⭐ ❗ ✅ 🀄 🚀 这些散落在各区段的宽字符。
const EMOJI_PRESENTATION_CODE_POINT_PATTERN = /^\p{Emoji_Presentation}$/u;
// East Asian Wide / Fullwidth 的连续大块（emoji 由上面的 Emoji_Presentation 覆盖，此处不重复收录）。
const WIDE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f], // 谚文字母初声
	[0x2e80, 0x303e], // CJK 部首补充 / 康熙部首 / 表意文字描述符 / CJK 符号和标点
	[0x3041, 0x33ff], // 假名 / 注音 / 谚文兼容字母 / CJK 笔画 / 带圈 CJK / CJK 兼容
	[0x3400, 0x4dbf], // CJK 扩展 A
	[0x4e00, 0x9fff], // CJK 统一表意文字
	[0xa000, 0xa4cf], // 彝文音节与部首
	[0xa960, 0xa97f], // 谚文字母扩展 A
	[0xac00, 0xd7a3], // 谚文音节
	[0xf900, 0xfaff], // CJK 兼容表意文字
	[0xfe10, 0xfe19], // 竖排标点
	[0xfe30, 0xfe6f], // CJK 兼容形式 / 小写变体 / 全角标点变体
	[0xff01, 0xff60], // 全角 ASCII（U+FF61 起的半角片假名是窄的，故止于 U+FF60）
	[0xffe0, 0xffe6], // 全角货币与符号
	[0x17000, 0x18d08], // 西夏文及其部件
	[0x1b000, 0x1b2fb], // 假名补充 / 假名扩展
	[0x1f200, 0x1f265], // 带方框 / 带圈的 CJK 补充
	[0x20000, 0x3fffd], // CJK 扩展 B 及以后、CJK 兼容表意文字补充
];

function isWideCodePoint(codePoint: string): boolean {
	if (EMOJI_PRESENTATION_CODE_POINT_PATTERN.test(codePoint)) {
		return true;
	}
	const value = codePoint.codePointAt(0) ?? 0;
	for (const [start, end] of WIDE_CODE_POINT_RANGES) {
		if (value >= start && value <= end) {
			return true;
		}
	}
	return false;
}

// 单个码点占几列。followingCodePoint 只用来识别变体选择符 U+FE0F——它把文字形态的符号
// （如 ❤ U+2764，本身 1 列）提升为 emoji 形态，宽度随之变成 2 列。
function measureCodePointColumnWidth(codePoint: string, followingCodePoint: string | undefined): 0 | 1 | 2 {
	if (ZERO_WIDTH_CODE_POINT_PATTERN.test(codePoint)) {
		return 0;
	}
	if (followingCodePoint === EMOJI_PRESENTATION_SELECTOR) {
		return 2;
	}
	return isWideCodePoint(codePoint) ? 2 : 1;
}

// 一段文本在终端里占多少列。**不是** `String.length`：后者数的是 UTF-16 码元，
// 中文字会少数一半、组合记号会多数出来（见文件头 2）。
export function measureTerminalDisplayColumnWidth(text: string): number {
	const codePoints = Array.from(text);
	let columnWidth = 0;
	for (let index = 0; index < codePoints.length; index += 1) {
		if (codePoints[index] === ZERO_WIDTH_JOINER) {
			// ZWJ 与它后面那个码点同属一个 emoji 序列，整串只占 2 列——那 2 列已经记在序列首个
			// 码点上了，故连 ZWJ 带被连接的码点一起跳过。
			index += 1;
			continue;
		}
		columnWidth += measureCodePointColumnWidth(codePoints[index], codePoints[index + 1]);
	}
	return columnWidth;
}

// 下一视觉行的首个可见字符要占几列。TUI 正是因为「这个字符在上一行放不下」才把它挪下来的，
// 所以它的宽度是判断上一行是否已写满的必要输入（见文件头 2）。空行返回 0，即「没有被挤下来的
// 字符」，也就不构成软折行。
function measureLeadingCharacterColumnWidth(text: string): number {
	const codePoints = Array.from(text);
	for (let index = 0; index < codePoints.length; index += 1) {
		const columnWidth = measureCodePointColumnWidth(codePoints[index], codePoints[index + 1]);
		if (columnWidth > 0) {
			return columnWidth;
		}
	}
	return 0;
}

export interface TerminalScreenLineSnapshot {
	// 该行的文本，保留行内空白（对应 xterm 的 translateToString(false)）。
	text: string;
	// xterm 的软折行标记。实测 Claude 恒为 false（见文件头 1），保留字段是为了让
	// 真正依赖终端软折行的 agent 能直接复用本模块。
	isWrapped: boolean;
}

export interface TerminalScreenSnapshot {
	lines: TerminalScreenLineSnapshot[];
	columnCount: number;
}

export interface TerminalInputBoxGrammar {
	// 框内首行的提示符前缀，必须锚定行首。捕获组之后即内容起点。
	promptPrefixPattern: RegExp;
	// 续行缩进宽度（列数）。Claude 为 2。缩进由空格构成，故它同时也是要剥掉的**码元**个数——
	// 只要缩进仍是纯 ASCII 空格，列数与码元数就相等；若哪天 TUI 改用宽字符缩进，这两个语义要拆开。
	continuationIndentWidth: number;
	// TUI 自折时在右侧留下的空白列数。Claude 为 2（实测内容宽度 = cols - 2 - 2 = 96）。
	rightMarginWidth: number;
}

export interface TerminalInputBoxLocation {
	topBoundaryLineIndex: number;
	bottomBoundaryLineIndex: number;
}

export interface TerminalInputBoxReading {
	location: TerminalInputBoxLocation;
	// 合并软折行后的逻辑行。
	logicalLines: string[];
	// logicalLines 以换行连接。
	text: string;
	// 按宽度判据接回上一逻辑行的次数。**这不是错误计数**：一条 392 字符的正常长行就会产生 4 次。
	// 它只是「本次读取里有多少处换行是推断出来的」，供需要标注保真度的消费者参考。
	// 判断「有没有还原不了的内容」请用粘贴账本的 unrecoverable 计数，那才是真正的「数据缺失」信号。
	softWrapJoinCount: number;
}

// Claude Code v2.1.227 实测语法。提示符为 U+276F 后跟 U+00A0（**不是**普通空格）。
export const CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR: TerminalInputBoxGrammar = {
	promptPrefixPattern: /^❯[  ]/u,
	continuationIndentWidth: 2,
	rightMarginWidth: 2,
};

function isBoxBoundaryLine(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length >= MIN_BOX_BOUNDARY_WIDTH && BOX_BOUNDARY_LINE_PATTERN.test(trimmed);
}

function stripTrailingWhitespace(text: string): string {
	return text.replace(/\s+$/u, "");
}

// 定位输入框：自下而上找最后一对「中间夹着以提示符开头的行」的边界行。
//
// 要求首个非空内容行以提示符前缀开头，是为了把 agent 输出里的装饰性横线对排除掉——
// 只按「最后一对横线」取会在 agent 打印表格 / 分隔线时误命中。
export function locateTerminalInputBox(
	snapshot: TerminalScreenSnapshot,
	grammar: TerminalInputBoxGrammar,
): TerminalInputBoxLocation | null {
	const boundaryLineIndexes: number[] = [];
	for (let index = 0; index < snapshot.lines.length; index += 1) {
		if (isBoxBoundaryLine(snapshot.lines[index].text)) {
			boundaryLineIndexes.push(index);
		}
	}
	for (let pairIndex = boundaryLineIndexes.length - 1; pairIndex >= 1; pairIndex -= 1) {
		const bottomBoundaryLineIndex = boundaryLineIndexes[pairIndex];
		const topBoundaryLineIndex = boundaryLineIndexes[pairIndex - 1];
		if (bottomBoundaryLineIndex - topBoundaryLineIndex < 2) {
			continue;
		}
		const firstContentLine = snapshot.lines[topBoundaryLineIndex + 1];
		if (firstContentLine && grammar.promptPrefixPattern.test(firstContentLine.text)) {
			return { topBoundaryLineIndex, bottomBoundaryLineIndex };
		}
	}
	return null;
}

// 框内每行可容纳的内容列数。参与运算的三个量都是**列**：TUI 在此宽度处自折，故「上一行的显示列宽已经
// 装不下下一行的首字符」是软折行的必要条件（见文件头 2）。
function resolveContentWidth(snapshot: TerminalScreenSnapshot, grammar: TerminalInputBoxGrammar): number {
	return Math.max(1, snapshot.columnCount - grammar.continuationIndentWidth - grammar.rightMarginWidth);
}

// 读框：定位 + 剥前缀/缩进 + 合并软折行。
// 返回 null 表示当前屏上没有可识别的输入框（TUI 尚未渲染、或正被全屏输出覆盖）。
export function readTerminalInputBox(
	snapshot: TerminalScreenSnapshot,
	grammar: TerminalInputBoxGrammar,
): TerminalInputBoxReading | null {
	const location = locateTerminalInputBox(snapshot, grammar);
	if (!location) {
		return null;
	}
	const contentWidth = resolveContentWidth(snapshot, grammar);
	const continuationIndent = " ".repeat(grammar.continuationIndentWidth);

	// 第一遍：把每个 buffer 行剥成「纯内容」，同时量出它占多少显示列（软折行判据的输入）。
	const strippedRows: { content: string; columnWidth: number }[] = [];
	for (let index = location.topBoundaryLineIndex + 1; index < location.bottomBoundaryLineIndex; index += 1) {
		// 先剥前缀再去尾空白：提示符后面那个字符是 U+00A0，会被 `\s` 一并吃掉，
		// 先去尾空白会让空框的首行退化成裸 `❯`、前缀就此匹配不上。
		const rawText = snapshot.lines[index].text;
		let content: string;
		if (strippedRows.length === 0) {
			const promptMatch = rawText.match(grammar.promptPrefixPattern);
			content = promptMatch ? rawText.slice(promptMatch[0].length) : rawText;
		} else if (rawText.startsWith(continuationIndent)) {
			content = rawText.slice(grammar.continuationIndentWidth);
		} else {
			// 缩进不符：可能是 TUI 换了画法，也可能是用户内容本身顶格。保守起见原样收下，
			// 不去猜——错在多留几个空格，好过错在切掉用户的字。
			content = rawText;
		}
		content = stripTrailingWhitespace(content);
		strippedRows.push({ content, columnWidth: measureTerminalDisplayColumnWidth(content) });
	}
	if (strippedRows.length === 0) {
		return null;
	}

	// 第二遍：把软折行接回上一逻辑行。判据只有显示列宽（见文件头 2）。
	const logicalLines: string[] = [strippedRows[0].content];
	let softWrapJoinCount = 0;
	for (let index = 1; index < strippedRows.length; index += 1) {
		const leadingCharacterColumnWidth = measureLeadingCharacterColumnWidth(strippedRows[index].content);
		if (
			leadingCharacterColumnWidth > 0 &&
			strippedRows[index - 1].columnWidth + leadingCharacterColumnWidth > contentWidth
		) {
			// 本行首字符在上一行放不下 ⇒ 上一行已被写满、本行是 TUI 自折出来的续行，接回上一逻辑行。
			// 「一段行尾恰好落在该字符放不下的位置上的硬换行」与软折行在 buffer 里完全同形，此处必然
			// 接错；这是不可消除的歧义，选择接上是因为散文与粘贴文本里软折行远比这种硬换行常见。
			logicalLines[logicalLines.length - 1] += strippedRows[index].content;
			softWrapJoinCount += 1;
			continue;
		}
		logicalLines.push(strippedRows[index].content);
	}

	// 末尾若干空逻辑行是框的预留高度，不是用户敲出来的空行。
	while (logicalLines.length > 0 && logicalLines[logicalLines.length - 1].trim() === "") {
		logicalLines.pop();
	}

	return {
		location,
		logicalLines,
		text: logicalLines.join("\n"),
		softWrapJoinCount,
	};
}
