import {
	deriveMatchSourcesFromPositions,
	normalizeSearchQuery,
	type TaskBoardSearchDocument,
	type TaskBoardSearchResult,
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
 * 朴素直接（子串）匹配：按空白切词，AND 语义——每词大小写不敏感地在 title 或 prompt 命中即算该词命中，
 * 全部词都命中才入选。记录每词在各字段的所有出现位置（全高亮）。
 *
 * 排序：title 有命中 > 仅 prompt 命中；再按 title 最早命中位置、prompt 最早命中位置升序；
 * 平局保持输入序（Array.prototype.sort 稳定，documents 构建时当前项目在前 → 当前项目自动优先）。
 */
export function findDirectSubstringTaskBoardSearchResults(
	documents: readonly TaskBoardSearchDocument[],
	query: string,
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
	const results: TaskBoardSearchResult[] = [];
	for (const document of documents) {
		const titleMatchCharacterPositions = new Set<number>();
		const promptMatchCharacterPositions = new Set<number>();
		let allTokensMatched = true;
		for (const token of tokens) {
			const titleTokenPositions = collectAllSubstringMatchPositions(document.titleLowerCase, token);
			const promptTokenPositions = collectAllSubstringMatchPositions(document.promptLowerCase, token);
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
