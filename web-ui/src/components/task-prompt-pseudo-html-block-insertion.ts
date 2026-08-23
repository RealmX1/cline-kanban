// 建卡描述区「插入伪 HTML 块」的纯文本运算。
//
// 与 React 完全无关：输入是当前描述文本 + 选区 + 块名，输出是新文本 + 新选区。放在组件之外是为了
// 让「插到哪、补几个换行、插完选中什么」这些容易出错的边界条件能被单测钉死，而不是靠点开对话框肉眼看。

/** 块名允许的字符集之外的一切都会被丢掉；空白先折成下划线，避免 `<my block>` 这种破标签。 */
const PSEUDO_HTML_BLOCK_NAME_DISALLOWED_CHARACTERS = /[^A-Za-z0-9_-]/gu;

/**
 * 把用户随手输入的块名归一成一个能直接写进尖括号的名字。
 *
 * 归一不出任何字符时返回 `null`（调用方据此不插入），而不是回落成某个默认名——静默插一个用户没要的
 * `<block>` 比什么都不做更难察觉。
 */
export function normalizePseudoHtmlBlockName(rawName: string): string | null {
	const normalized = rawName
		.trim()
		.replaceAll(/\s+/gu, "_")
		.replaceAll(PSEUDO_HTML_BLOCK_NAME_DISALLOWED_CHARACTERS, "");
	return normalized.length > 0 ? normalized : null;
}

export interface TaskPromptWithPseudoHtmlBlockInserted {
	nextPromptValue: string;
	/** 插入后应当选中/落点的起始位置——块的**内层**，不是标签本身。 */
	nextSelectionStart: number;
	nextSelectionEnd: number;
}

/**
 * 块与上下文之间需要补几个换行。
 *
 * 只补不删：邻接文本已经自带的换行原样保留，避免「插一个块顺手吃掉用户敲的空行」。
 */
function resolveBlockSeparator(adjacentText: string, side: "before" | "after"): string {
	if (adjacentText.length === 0) {
		return "";
	}
	const hasBlankLineAdjacent = side === "before" ? adjacentText.endsWith("\n\n") : adjacentText.startsWith("\n\n");
	if (hasBlankLineAdjacent) {
		return "";
	}
	const hasLineBreakAdjacent = side === "before" ? adjacentText.endsWith("\n") : adjacentText.startsWith("\n");
	return hasLineBreakAdjacent ? "\n" : "\n\n";
}

/**
 * 丢掉选区首尾那些**整行皆空白**的行，其余内容逐字节原样保留。
 *
 * 只丢整行，不做 `trim()`：`trim()` 会连带吃掉首行的缩进与末行的尾部空白，而那些是用户明确选中的内容
 * （典型受害者是「选中一段缩进代码块」——首行缩进被吃掉后整块代码就对不齐了）。而首尾那些整行皆空白的
 * 行确实该丢：它们只会跟模板自带的 `<name>\n` / `\n</name>` 叠加成多余空行。
 */
function dropWhollyBlankLinesAtSelectionEdges(selectedText: string): string {
	const lines = selectedText.split("\n");
	const isWhollyBlankLineAt = (lineIndex: number): boolean => (lines[lineIndex] ?? "").trim().length === 0;
	let firstLineIndexWithContent = 0;
	let lastLineIndexWithContent = lines.length - 1;
	while (firstLineIndexWithContent <= lastLineIndexWithContent && isWhollyBlankLineAt(firstLineIndexWithContent)) {
		firstLineIndexWithContent += 1;
	}
	while (lastLineIndexWithContent >= firstLineIndexWithContent && isWhollyBlankLineAt(lastLineIndexWithContent)) {
		lastLineIndexWithContent -= 1;
	}
	if (firstLineIndexWithContent > lastLineIndexWithContent) {
		return "";
	}
	return lines.slice(firstLineIndexWithContent, lastLineIndexWithContent + 1).join("\n");
}

/**
 * 在光标处插入 `<name>…</name>`，或把当前选区包进这样一个块。
 *
 * 两条语义：
 *   - 有选区 → 选中内容成为块的内层，插入后**继续选中那段原文**，方便接着改；
 *   - 无选区 → 插入一个空块，光标落在中间那一空行上。
 *
 * 选区两侧只剩空白时把那段空白丢掉（典型场景：描述框全空、或光标停在末尾的换行之后），否则块会带着
 * 一截前导缩进落下来。选区**内部**只丢首尾整行皆空白的行（见
 * `dropWhollyBlankLinesAtSelectionEdges`），带内容的行一律逐字节保留。
 */
export function buildTaskPromptWithPseudoHtmlBlockInserted({
	promptValue,
	selectionStart,
	selectionEnd,
	blockName,
}: {
	promptValue: string;
	selectionStart: number;
	selectionEnd: number;
	blockName: string;
}): TaskPromptWithPseudoHtmlBlockInserted {
	const clampedStart = Math.max(0, Math.min(selectionStart, promptValue.length));
	const clampedEnd = Math.max(clampedStart, Math.min(selectionEnd, promptValue.length));
	const rawTextBefore = promptValue.slice(0, clampedStart);
	const rawTextAfter = promptValue.slice(clampedEnd);
	const textBefore = rawTextBefore.trim().length === 0 ? "" : rawTextBefore;
	const textAfter = rawTextAfter.trim().length === 0 ? "" : rawTextAfter;
	const innerText = dropWhollyBlankLinesAtSelectionEdges(promptValue.slice(clampedStart, clampedEnd));

	const openingTag = `<${blockName}>`;
	const closingTag = `</${blockName}>`;
	const leadingSeparator = resolveBlockSeparator(textBefore, "before");
	const trailingSeparator = resolveBlockSeparator(textAfter, "after");
	const blockText = `${openingTag}\n${innerText}\n${closingTag}`;

	const nextSelectionStart = textBefore.length + leadingSeparator.length + openingTag.length + 1;
	return {
		nextPromptValue: `${textBefore}${leadingSeparator}${blockText}${trailingSeparator}${textAfter}`,
		nextSelectionStart,
		nextSelectionEnd: nextSelectionStart + innerText.length,
	};
}
