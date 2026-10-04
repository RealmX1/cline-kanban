// agent 提问（AskUserQuestion）的正文、选项说明与备注是「按行书写」的纯文本：TUI 里每个换行都原样换行，
// 作者也依赖这一点——例如选项说明末尾那行「⚖️ 维度立场：…」必须独占一行。
// 但 markdown 把单个换行视为软换行，列表项后紧跟的非空行还会被「惰性续行」并进该列表项，于是那行立场
// 被粘到最后一个要点后面。这里把代码块之外的单个换行改写成 markdown 硬换行（行尾两个空格），
// 让渲染结果与作者在 TUI 里看到的分行一致；空行（段落分隔）与代码块内容保持原样。
const MARKDOWN_FENCED_CODE_BLOCK_DELIMITER_PATTERN = /^\s*(```|~~~)/;

export function preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks(agentAuthoredText: string): string {
	const lines = agentAuthoredText.split("\n");
	let isInsideFencedCodeBlock = false;
	return lines
		.map((line, lineIndex) => {
			if (MARKDOWN_FENCED_CODE_BLOCK_DELIMITER_PATTERN.test(line)) {
				isInsideFencedCodeBlock = !isInsideFencedCodeBlock;
				return line;
			}
			const nextLine = lines[lineIndex + 1];
			const isFollowedByNonBlankLine = nextLine !== undefined && nextLine.trim().length > 0;
			if (isInsideFencedCodeBlock || !isFollowedByNonBlankLine || line.trim().length === 0) {
				return line;
			}
			return `${line.replace(/\s+$/u, "")}  `;
		})
		.join("\n");
}
