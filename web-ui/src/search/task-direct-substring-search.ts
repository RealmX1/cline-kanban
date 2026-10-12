import {
	DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
	deriveMatchSourcesFromPositions,
	EMPTY_MATCH_CHARACTER_POSITIONS,
	isTaskSearchTextFieldIncludedInMatchedTextFieldScope,
	normalizeSearchQuery,
	type TaskBoardSearchDocument,
	type TaskBoardSearchResult,
	type TaskSearchMatchedTextFieldScope,
} from "@/search/task-board-search";

/**
 * 收集 needle 在 haystack 中每一次出现所覆盖的全部字符下标（大小写须由调用方预先归一）。
 * 步进 +1 而非 +needle.length：允许重叠出现也被完整高亮（例如在 "aaaa" 中搜 "aa"）。
 */
export function collectAllSubstringMatchPositions(haystackLowerCase: string, needleLowerCase: string): Set<number> {
	const positions = new Set<number>();
	if (needleLowerCase.length === 0) {
		return positions;
	}
	let fromIndex = 0;
	for (;;) {
		const matchIndex = haystackLowerCase.indexOf(needleLowerCase, fromIndex);
		if (matchIndex < 0) {
			break;
		}
		for (let offset = 0; offset < needleLowerCase.length; offset += 1) {
			positions.add(matchIndex + offset);
		}
		fromIndex = matchIndex + 1;
	}
	return positions;
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
 * 朴素直接（子串）匹配：按空白切词，AND 语义——每词大小写不敏感地在**字段范围允许的** title / prompt 里命中
 * 即算该词命中，全部词都命中才入选。记录每词在各允许字段的所有出现位置（全高亮）；被范围排除的字段不收集位置。
 *
 * 本函数产出的是**位置序**：title 有命中 > 仅 prompt 命中；再按 title 最早命中位置、prompt 最早命中位置升序；
 * 平局保持输入序（Array.prototype.sort 稳定，documents 构建时当前项目在前 → 当前项目自动优先）。
 * 它不是 direct 模式最终的 relevance 序：use-task-board-search 会在其上按「最近活跃」稳定重排
 * （sortTaskSearchResultsByAgentConversationProgressThenLastModified），位置序只在同一时刻之间决胜。
 */
export function findDirectSubstringTaskBoardSearchResults(
	documents: readonly TaskBoardSearchDocument[],
	query: string,
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope = DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
): TaskBoardSearchResult[] {
	const normalizedQuery = normalizeSearchQuery(query);
	if (!normalizedQuery) {
		return [];
	}
	const tokens = normalizedQuery
		.toLocaleLowerCase()
		.split(" ")
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		return [];
	}
	const isTitleIncludedInMatchedTextFieldScope = isTaskSearchTextFieldIncludedInMatchedTextFieldScope(
		"title",
		matchedTextFieldScope,
	);
	const isPromptIncludedInMatchedTextFieldScope = isTaskSearchTextFieldIncludedInMatchedTextFieldScope(
		"prompt",
		matchedTextFieldScope,
	);
	const results: TaskBoardSearchResult[] = [];
	for (const document of documents) {
		const titleMatchCharacterPositions = new Set<number>();
		const promptMatchCharacterPositions = new Set<number>();
		let allTokensMatched = true;
		for (const token of tokens) {
			const titleTokenPositions = isTitleIncludedInMatchedTextFieldScope
				? collectAllSubstringMatchPositions(document.titleLowerCase, token)
				: EMPTY_MATCH_CHARACTER_POSITIONS;
			const promptTokenPositions = isPromptIncludedInMatchedTextFieldScope
				? collectAllSubstringMatchPositions(document.promptLowerCase, token)
				: EMPTY_MATCH_CHARACTER_POSITIONS;
			if (titleTokenPositions.size === 0 && promptTokenPositions.size === 0) {
				allTokensMatched = false;
				break;
			}
			for (const position of titleTokenPositions) {
				titleMatchCharacterPositions.add(position);
			}
			for (const position of promptTokenPositions) {
				promptMatchCharacterPositions.add(position);
			}
		}
		if (!allTokensMatched) {
			continue;
		}
		results.push({
			document,
			score: 0,
			matchSources: deriveMatchSourcesFromPositions(titleMatchCharacterPositions, promptMatchCharacterPositions),
			titleMatchCharacterPositions,
			promptMatchCharacterPositions,
		});
	}
	return sortDirectSubstringResults(results);
}

function sortDirectSubstringResults(results: TaskBoardSearchResult[]): TaskBoardSearchResult[] {
	return [...results].sort((first, second) => {
		const firstHasTitleHit = first.titleMatchCharacterPositions.size > 0;
		const secondHasTitleHit = second.titleMatchCharacterPositions.size > 0;
		if (firstHasTitleHit !== secondHasTitleHit) {
			return firstHasTitleHit ? -1 : 1;
		}
		const firstTitleEarliest = findEarliestPosition(first.titleMatchCharacterPositions);
		const secondTitleEarliest = findEarliestPosition(second.titleMatchCharacterPositions);
		if (firstTitleEarliest !== secondTitleEarliest) {
			return firstTitleEarliest - secondTitleEarliest;
		}
		const firstPromptEarliest = findEarliestPosition(first.promptMatchCharacterPositions);
		const secondPromptEarliest = findEarliestPosition(second.promptMatchCharacterPositions);
		if (firstPromptEarliest !== secondPromptEarliest) {
			return firstPromptEarliest - secondPromptEarliest;
		}
		return 0;
	});
}
