export interface TaskPromptMatchSnippet {
	text: string;
	// 相对 snippet.text 的命中字符下标（已按截窗起点平移），供 renderFuzzyHighlightedText 高亮。
	matchCharacterPositions: Set<number>;
	hasLeadingEllipsis: boolean;
	hasTrailingEllipsis: boolean;
}

function findEarliestPosition(positions: ReadonlySet<number>): number {
	let earliest = Number.POSITIVE_INFINITY;
	for (const position of positions) {
		if (position < earliest) {
			earliest = position;
		}
	}
	return earliest;
}

/**
 * 为「仅 prompt 命中」的结果行构造以首个命中为中心的截窗片段（约 2×windowRadius 字符），
 * 并把命中位置集平移到片段坐标系；两端超出原文处标记省略号。无命中位置时退回 prompt 开头一窗。
 */
export function buildPromptMatchSnippet(
	prompt: string,
	promptMatchCharacterPositions: ReadonlySet<number>,
	windowRadius: number,
): TaskPromptMatchSnippet {
	const windowSize = Math.max(windowRadius * 2, 1);
	if (promptMatchCharacterPositions.size === 0) {
		const text = prompt.slice(0, windowSize);
		return {
			text,
			matchCharacterPositions: new Set<number>(),
			hasLeadingEllipsis: false,
			hasTrailingEllipsis: text.length < prompt.length,
		};
	}
	const firstMatchPosition = findEarliestPosition(promptMatchCharacterPositions);
	const windowStart = Math.max(0, firstMatchPosition - windowRadius);
	const windowEnd = Math.min(prompt.length, windowStart + windowSize);
	const text = prompt.slice(windowStart, windowEnd);
	const matchCharacterPositions = new Set<number>();
	for (const position of promptMatchCharacterPositions) {
		if (position >= windowStart && position < windowEnd) {
			matchCharacterPositions.add(position - windowStart);
		}
	}
	return {
		text,
		matchCharacterPositions,
		hasLeadingEllipsis: windowStart > 0,
		hasTrailingEllipsis: windowEnd < prompt.length,
	};
}
