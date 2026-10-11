import { useEffect, useMemo, useRef, useState } from "react";

import {
	EMPTY_MATCH_CHARACTER_POSITIONS,
	findFuzzyTaskBoardSearchResults,
	mergeTaskBoardSearchResults,
	normalizeSearchQuery,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMode,
	type TaskBoardSearchResult,
	type TaskSearchMatchedTextFieldScope,
} from "@/search/task-board-search";
import {
	createTaskBoardSemanticSearchIndex,
	type TaskBoardSemanticSearchIndex,
} from "@/search/task-board-semantic-search";
import { findDirectSubstringTaskBoardSearchResults } from "@/search/task-direct-substring-search";
import { hoistTaskIdExactMatchedResultsToTop } from "@/search/task-id-match-search";
import {
	resolveEffectiveTaskSearchResultSortOrder,
	sortTaskSearchResults,
	sortTaskSearchResultsByAgentConversationProgressThenLastModified,
	type TaskSearchResultSortOrder,
} from "@/search/task-search-result-ordering";
import { useDebouncedEffect } from "@/utils/react-use";

export type TaskBoardSemanticSearchStatus = "idle" | "loading" | "ready" | "error";

export interface UseTaskBoardSearchResult {
	isSearchActive: boolean;
	/** 查询串为空、正在按排序档浏览全量任务（而不是「什么都不显示」）。与 isSearchActive 互斥。 */
	isBrowsingAllTasksWithoutQuery: boolean;
	orderedResults: TaskBoardSearchResult[];
	/** 这一刻真正生效的排序档：浏览态下 relevance 会回落，分段控件要据此标注实际生效的那一档。 */
	effectiveSortOrder: TaskSearchResultSortOrder;
	semanticSearchStatus: TaskBoardSemanticSearchStatus;
}

interface TaskBoardSemanticSearchIndexCacheEntry {
	documents: readonly TaskBoardSearchDocument[];
	indexPromise: Promise<TaskBoardSemanticSearchIndex>;
	abortController: AbortController;
}

interface TaskBoardSemanticSearchResultSnapshot {
	documents: readonly TaskBoardSearchDocument[];
	mode: Extract<TaskBoardSearchMode, "hybrid" | "semantic">;
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope;
	query: string;
	results: TaskBoardSearchResult[];
}

function sortResultsByScoreDescending(results: readonly TaskBoardSearchResult[]): TaskBoardSearchResult[] {
	return [...results].sort((first, second) => second.score - first.score);
}

/**
 * 浏览态（空查询）下把每篇文档原样包成一条「无命中」结果：score 0、无高亮位置、matchSources 空。
 * 顺序沿用 documents 顺序（当前项目在前 → 列顺序 → 卡序），随后由排序层重排。
 */
function buildBrowseAllTasksResults(documents: readonly TaskBoardSearchDocument[]): TaskBoardSearchResult[] {
	return documents.map((document) => ({
		document,
		score: 0,
		matchSources: [],
		titleMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
		promptMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
	}));
}

/**
 * 任务搜索计算核心：吃已装配好的 documents（当前项目在前、可含跨项目），按 mode 分发匹配，产出有序结果。
 *
 * documents 的内容签名稳定化（实时 board 流每 tick 换引用却内容不变时保持旧引用、免语义索引反复重建）
 * 由调用方（controller）负责——本 hook 的语义索引缓存直接以 documents 引用相等为键。
 */
export function useTaskBoardSearch({
	documents,
	query,
	mode,
	matchedTextFieldScope,
	sortOrder,
	resolveAgentConversationProgressAtEpochMs,
	isBrowsingAllTasksWithoutQueryEnabled,
}: {
	documents: readonly TaskBoardSearchDocument[];
	query: string;
	mode: TaskBoardSearchMode;
	/** 文本匹配的字段范围。换范围只重查、不重建语义索引（索引缓存只以 documents 为键）。 */
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope;
	sortOrder: TaskSearchResultSortOrder;
	/**
	 * 取「这个任务的对话上次真正往前走」的时刻：agent 活跃档与 direct 的 relevance 档用。当前项目读会话推流，
	 * 跨项目读索引快照；从没推进过的返回 null。调用方必须给一个**引用稳定**的实现（否则每 tick 重排一次）。
	 */
	resolveAgentConversationProgressAtEpochMs: (document: TaskBoardSearchDocument) => number | null;
	/** 空查询时是否浏览全量任务。由调用方按「弹层开着」门控，关着时不做这份无用的全量包装。 */
	isBrowsingAllTasksWithoutQueryEnabled: boolean;
}): UseTaskBoardSearchResult {
	const normalizedQuery = normalizeSearchQuery(query);
	const isSearchActive = normalizedQuery.length > 0;
	const isBrowsingAllTasksWithoutQuery = !isSearchActive && isBrowsingAllTasksWithoutQueryEnabled;
	const effectiveSortOrder = resolveEffectiveTaskSearchResultSortOrder(sortOrder, {
		isBrowsingWithoutQuery: isBrowsingAllTasksWithoutQuery,
	});

	const directResults = useMemo(() => {
		if (!isSearchActive || mode !== "direct") {
			return [] satisfies TaskBoardSearchResult[];
		}
		return findDirectSubstringTaskBoardSearchResults(documents, normalizedQuery, matchedTextFieldScope);
	}, [documents, isSearchActive, matchedTextFieldScope, mode, normalizedQuery]);

	const fuzzyResults = useMemo(() => {
		if (!isSearchActive || mode === "direct" || mode === "semantic") {
			return [] satisfies TaskBoardSearchResult[];
		}
		return findFuzzyTaskBoardSearchResults(documents, normalizedQuery, matchedTextFieldScope);
	}, [documents, isSearchActive, matchedTextFieldScope, mode, normalizedQuery]);

	const [semanticResultSnapshot, setSemanticResultSnapshot] = useState<TaskBoardSemanticSearchResultSnapshot | null>(
		null,
	);
	const [semanticSearchStatus, setSemanticSearchStatus] = useState<TaskBoardSemanticSearchStatus>("idle");
	const semanticSearchRequestIdRef = useRef(0);
	const semanticSearchIndexCacheRef = useRef<TaskBoardSemanticSearchIndexCacheEntry | null>(null);
	const shouldRunSemanticSearch = isSearchActive && (mode === "hybrid" || mode === "semantic");
	const semanticResults =
		semanticResultSnapshot?.documents === documents &&
		semanticResultSnapshot.query === normalizedQuery &&
		semanticResultSnapshot.mode === mode &&
		semanticResultSnapshot.matchedTextFieldScope === matchedTextFieldScope
			? semanticResultSnapshot.results
			: null;

	useEffect(() => {
		semanticSearchRequestIdRef.current += 1;
		setSemanticSearchStatus(shouldRunSemanticSearch ? "loading" : "idle");
	}, [documents, matchedTextFieldScope, mode, normalizedQuery, shouldRunSemanticSearch]);

	// 换项目/文档、离开语义模式或关闭搜索时释放 Worker，包括尚未完成的模型下载。
	useEffect(
		() => () => {
			semanticSearchRequestIdRef.current += 1;
			semanticSearchIndexCacheRef.current?.abortController.abort();
			semanticSearchIndexCacheRef.current = null;
		},
		[documents, shouldRunSemanticSearch],
	);

	useDebouncedEffect(
		() => {
			semanticSearchRequestIdRef.current += 1;
			const requestId = semanticSearchRequestIdRef.current;
			if (!shouldRunSemanticSearch) {
				setSemanticResultSnapshot(null);
				setSemanticSearchStatus("idle");
				return;
			}
			setSemanticSearchStatus("loading");
			if (semanticSearchIndexCacheRef.current?.documents !== documents) {
				const abortController = new AbortController();
				semanticSearchIndexCacheRef.current = {
					documents,
					abortController,
					indexPromise: createTaskBoardSemanticSearchIndex(documents, abortController.signal),
				};
			}
			void semanticSearchIndexCacheRef.current.indexPromise
				.then((index) =>
					semanticSearchRequestIdRef.current === requestId
						? index.findResults(normalizedQuery, mode, matchedTextFieldScope)
						: [],
				)
				.then((results) => {
					if (semanticSearchRequestIdRef.current !== requestId) {
						return;
					}
					setSemanticResultSnapshot({
						documents,
						mode,
						matchedTextFieldScope,
						query: normalizedQuery,
						results,
					});
					setSemanticSearchStatus("ready");
				})
				.catch(() => {
					if (semanticSearchRequestIdRef.current !== requestId) {
						return;
					}
					setSemanticResultSnapshot(null);
					semanticSearchIndexCacheRef.current?.abortController.abort();
					semanticSearchIndexCacheRef.current = null;
					setSemanticSearchStatus("error");
				});
		},
		220,
		[documents, matchedTextFieldScope, mode, normalizedQuery, shouldRunSemanticSearch],
	);

	const browseAllTasksResults = useMemo(() => {
		if (!isBrowsingAllTasksWithoutQuery) {
			return [] satisfies TaskBoardSearchResult[];
		}
		return buildBrowseAllTasksResults(documents);
	}, [documents, isBrowsingAllTasksWithoutQuery]);

	const orderedResults = useMemo(() => {
		if (!isSearchActive) {
			// 浏览态：不跑任何匹配器、更不建语义索引（shouldRunSemanticSearch 本就含 isSearchActive），
			// 只把全量文档交给排序层。
			return sortTaskSearchResults({
				results: browseAllTasksResults,
				sortOrder: effectiveSortOrder,
				resolveAgentConversationProgressAtEpochMs,
			});
		}
		function resolveBaseOrderedResultsForCurrentMode(): TaskBoardSearchResult[] {
			if (mode === "direct") {
				// direct 的子串命中只决定入不入选、不分高低（score 恒 0）：relevance 档按「最近活跃」排，
				// 匹配器给出的位置序只在同一时刻之间决胜。非 relevance 档随后由排序层整体重排，这里不必白算一遍。
				if (effectiveSortOrder !== "relevance") {
					return directResults;
				}
				return sortTaskSearchResultsByAgentConversationProgressThenLastModified({
					results: directResults,
					resolveAgentConversationProgressAtEpochMs,
				});
			}
			if (mode === "fuzzy") {
				// fzf.find 已按分数降序返回。
				return fuzzyResults;
			}
			if (mode === "semantic") {
				const results =
					semanticResults ??
					(semanticSearchStatus === "error"
						? findFuzzyTaskBoardSearchResults(documents, normalizedQuery, matchedTextFieldScope)
						: []);
				return sortResultsByScoreDescending(results);
			}
			if (semanticSearchStatus === "error") {
				return fuzzyResults;
			}
			return sortResultsByScoreDescending(mergeTaskBoardSearchResults(fuzzyResults, semanticResults ?? []));
		}
		// task id 置顶层跨全部四种模式统一叠加：用户从地址栏 ?task= 或 worktree 路径拷来一个 id 时，
		// 不该被迫先切模式。它只做「提到最前 + 补进结果集」，不改动任何模式自身的排序规则；
		// query 不是完整 id 范式时原样返回入参引用，既有行为零变化。
		// 刻意叠在 mode 分发**之外**：hybrid / semantic 的语义结果落地前后，被顶到第 0 位的都是同一个
		// document，顶行因此永远不动（不会因 semantic 落地而闪烁重排）。
		//
		// 排序档层夹在两者之间（各模式排序之后、ID 置顶之前）：换档只重排正文结果，
		// 「粘贴一个完整 task id → 回车直达」在任意档下都仍然置顶。
		return hoistTaskIdExactMatchedResultsToTop(
			sortTaskSearchResults({
				results: resolveBaseOrderedResultsForCurrentMode(),
				sortOrder: effectiveSortOrder,
				resolveAgentConversationProgressAtEpochMs,
			}),
			documents,
			normalizedQuery,
		);
	}, [
		browseAllTasksResults,
		directResults,
		documents,
		effectiveSortOrder,
		fuzzyResults,
		isSearchActive,
		matchedTextFieldScope,
		mode,
		normalizedQuery,
		resolveAgentConversationProgressAtEpochMs,
		semanticResults,
		semanticSearchStatus,
	]);

	return {
		isSearchActive,
		isBrowsingAllTasksWithoutQuery,
		orderedResults,
		effectiveSortOrder,
		semanticSearchStatus,
	};
}
