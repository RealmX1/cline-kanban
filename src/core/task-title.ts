export const DEFAULT_TASK_TITLE_MAX_CHARS = 80;

function normalizeTaskTitleWhitespace(value: string): string {
	return value.replaceAll(/\s+/g, " ").trim();
}

function truncateTaskTitle(value: string, maxChars: number): string {
	if (maxChars <= 0) {
		return "";
	}
	if (value.length <= maxChars) {
		return value;
	}
	return `${value.slice(0, maxChars).trimEnd()}…`;
}

function stripOuterUserInputTag(value: string): string {
	return value
		.replace(/^<user_input(?:\s[^>]*)?>/u, "")
		.replace(/<\/user_input>$/u, "")
		.trim();
}

/**
 * 剥掉一行首尾各一个 XML/HTML 标签（例如 `<user_input mode="act">…</user_input>`）后的正文。
 *
 * 整行就是一个裸标签时（`<trajectory>` 独占一行）返回空串，交由调用方决定要不要看下一行。
 */
function stripOuterMarkupTagsFromLine(line: string): string {
	return normalizeTaskTitleWhitespace(
		line
			.replace(/^<[^>]+>/u, "")
			.replace(/<\/[^>]+>$/u, "")
			.trim(),
	);
}

export function deriveTaskTitleFromPrompt(prompt: string, maxChars = DEFAULT_TASK_TITLE_MAX_CHARS): string {
	// 逐行扫描而不是「只看第一行非空」：描述以伪 HTML 块开头（`<trajectory>` 独占一行）时，第一行剥完
	// 标签就是空串，老写法会直接返回 ""，而 web-ui 的 normalizeCard 遇到空标题会把**整份 prompt** 当标题，
	// 于是卡片标题变成一大坨正文。首行剥完非空的输入走到第一轮就返回，与老实现逐字节一致。
	let normalizedLine = "";
	let hasEncounteredNonEmptyPromptLine = false;
	for (const rawLine of prompt.split(/\r?\n/u)) {
		const trimmedLine = rawLine.trim();
		if (trimmedLine.length === 0) {
			continue;
		}
		const isLeadingTldrHeading = !hasEncounteredNonEmptyPromptLine && trimmedLine === "## TLDR";
		hasEncounteredNonEmptyPromptLine = true;
		if (isLeadingTldrHeading) {
			continue;
		}
		const strippedLine = stripOuterMarkupTagsFromLine(trimmedLine);
		if (strippedLine) {
			normalizedLine = strippedLine;
			break;
		}
	}
	if (!normalizedLine) {
		return "";
	}
	const firstSentenceMatch = normalizedLine.match(/^(.+?[.!?])(?:\s|$)/u);
	const sentenceOrLine = firstSentenceMatch?.[1] ?? normalizedLine;
	return truncateTaskTitle(sentenceOrLine, maxChars);
}

export function resolveTaskTitle(title: string | null | undefined, prompt: string): string {
	const normalizedTitle = normalizeTaskTitleWhitespace(title ?? "");
	if (normalizedTitle) {
		const strippedTitle = stripOuterUserInputTag(normalizedTitle);
		if (strippedTitle) {
			return truncateTaskTitle(strippedTitle, DEFAULT_TASK_TITLE_MAX_CHARS);
		}
		return deriveTaskTitleFromPrompt(prompt);
	}
	return deriveTaskTitleFromPrompt(prompt);
}
