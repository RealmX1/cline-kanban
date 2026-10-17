export type PromptDraftUserPromptMatchKind = "normalized_exact" | "exact_substring" | "approximate_substring";

// EXPERIMENT_NODE: 近似匹配的 90% 相似度、32 字符下限与每对文本 200 万格预算需按实际草稿校准
const MINIMUM_APPROXIMATE_DRAFT_CHARACTER_COUNT = 32;
const MINIMUM_EXACT_SUBSTRING_DRAFT_CHARACTER_COUNT = 16;
const MAXIMUM_APPROXIMATE_MATCH_DYNAMIC_PROGRAMMING_CELLS = 2_000_000;

export function normalizePromptTextForUsageMatching(text: string): string {
	return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** 局部编辑距离：前后额外内容免费，但草稿本身必须至少有 90% 的文字被覆盖。 */
export function matchPromptDraftAgainstSubmittedUserPrompt(
	draftText: string,
	userPromptText: string,
): PromptDraftUserPromptMatchKind | null {
	const draft = normalizePromptTextForUsageMatching(draftText);
	const submitted = normalizePromptTextForUsageMatching(userPromptText);
	if (!draft || !submitted) return null;
	if (draft === submitted) return "normalized_exact";
	const draftCharacters = Array.from(draft);
	if (draftCharacters.length >= MINIMUM_EXACT_SUBSTRING_DRAFT_CHARACTER_COUNT && submitted.includes(draft)) {
		return "exact_substring";
	}
	if (draftCharacters.length < MINIMUM_APPROXIMATE_DRAFT_CHARACTER_COUNT) return null;
	if (draftCharacters.length * Math.ceil(submitted.length / 2) > MAXIMUM_APPROXIMATE_MATCH_DYNAMIC_PROGRAMMING_CELLS)
		return null;
	const submittedCharacters = Array.from(submitted);
	if (draftCharacters.length * submittedCharacters.length > MAXIMUM_APPROXIMATE_MATCH_DYNAMIC_PROGRAMMING_CELLS) {
		return null;
	}
	const maximumEditCount = Math.floor(draftCharacters.length * 0.1);
	if (submittedCharacters.length < draftCharacters.length - maximumEditCount) return null;
	let previousRow = new Uint32Array(submittedCharacters.length + 1);
	let currentRow = new Uint32Array(submittedCharacters.length + 1);
	for (let draftIndex = 1; draftIndex <= draftCharacters.length; draftIndex += 1) {
		currentRow[0] = draftIndex;
		for (let submittedIndex = 1; submittedIndex <= submittedCharacters.length; submittedIndex += 1) {
			currentRow[submittedIndex] = Math.min(
				previousRow[submittedIndex] + 1,
				currentRow[submittedIndex - 1] + 1,
				previousRow[submittedIndex - 1] +
					(draftCharacters[draftIndex - 1] === submittedCharacters[submittedIndex - 1] ? 0 : 1),
			);
		}
		[previousRow, currentRow] = [currentRow, previousRow];
	}
	return previousRow.some((editCount) => editCount <= maximumEditCount) ? "approximate_substring" : null;
}
