import { useEffect, useMemo, useRef, useState } from "react";

import {
	findFuzzyTaskBoardSearchResults,
	mergeTaskBoardSearchResults,
	normalizeSearchQuery,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMode,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
import {
	createTaskBoardSemanticSearchIndex,
	type TaskBoardSemanticSearchIndex,
} from "@/search/task-board-semantic-search";
import { findDirectSubstringTaskBoardSearchResults } from "@/search/task-direct-substring-search";
import { hoistTaskIdExactMatchedResultsToTop } from "@/search/task-id-match-search";
import { useDebouncedEffect } from "@/utils/react-use";

export type TaskBoardSemanticSearchStatus = "idle" | "loading" | "ready" | "error";

export interface UseTaskBoardSearchResult {
	isSearchActive: boolean;
	orderedResults: TaskBoardSearchResult[];
	semanticSearchStatus: TaskBoardSemanticSearchStatus;
}

interface TaskBoardSemanticSearchIndexCacheEntry {
	documents: readonly TaskBoardSearchDocument[];
	indexPromise: Promise<TaskBoardSemanticSearchIndex>;
}

interface TaskBoardSemanticSearchResultSnapshot {
	documents: readonly TaskBoardSearchDocument[];
	mode: Extract<TaskBoardSearchMode, "hybrid" | "semantic">;
	query: string;
	results: TaskBoardSearchResult[];
}

function sortResultsByScoreDescending(results: readonly TaskBoardSearchResult[]): TaskBoardSearchResult[] {
	return [...results].sort((first, second) => second.score - first.score);
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
}: {
	documents: readonly TaskBoardSearchDocument[];
	query: string;
	mode: TaskBoardSearchMode;
}): UseTaskBoardSearchResult {
	const normalizedQuery = normalizeSearchQuery(query);
	const isSearchActive = normalizedQuery.length > 0;

	const directResults = useMemo(() => {
		if (!isSearchActive || mode !== "direct") {
			return [] satisfies TaskBoardSearchResult[];
		}
		return findDirectSubstringTaskBoardSearchResults(documents, normalizedQuery);
	}, [documents, isSearchActive, mode, normalizedQuery]);

	const fuzzyResults = useMemo(() => {
		if (!isSearchActive || mode === "direct" || mode === "semantic") {
			return [] satisfies TaskBoardSearchResult[];
		}
		return findFuzzyTaskBoardSearchResults(documents, normalizedQuery);
	}, [documents, isSearchActive, mode, normalizedQuery]);

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
		semanticResultSnapshot.mode === mode
			? semanticResultSnapshot.results
			: null;

	useEffect(() => {
		semanticSearchRequestIdRef.current += 1;
		setSemanticSearchStatus(shouldRunSemanticSearch ? "loading" : "idle");
	}, [documents, mode, normalizedQuery, shouldRunSemanticSearch]);

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
				semanticSearchIndexCacheRef.current = {
					documents,
					indexPromise: createTaskBoardSemanticSearchIndex(documents),
				};
			}
			void semanticSearchIndexCacheRef.current.indexPromise
				.then((index) => index.findResults(normalizedQuery, mode))
				.then((results) => {
					if (semanticSearchRequestIdRef.current !== requestId) {
						return;
					}
					setSemanticResultSnapshot({
						documents,
						mode,
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
					setSemanticSearchStatus("error");
				});
		},
		220,
		[documents, mode, normalizedQuery, shouldRunSemanticSearch],
	);

	const orderedResults = useMemo(() => {
		if (!isSearchActive) {
			return [] satisfies TaskBoardSearchResult[];
		}
		function resolveBaseOrderedResultsForCurrentMode(): TaskBoardSearchResult[] {
			if (mode === "direct") {
				// direct 已按 D2 位置规则排好序，不再按 score 重排。
				return directResults;
			}
			if (mode === "fuzzy") {
				// fzf.find 已按分数降序返回。
				return fuzzyResults;
			}
			if (mode === "semantic") {
				const results =
					semanticResults ??
					(semanticSearchStatus === "error" ? findFuzzyTaskBoardSearchResults(documents, normalizedQuery) : []);
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
		return hoistTaskIdExactMatchedResultsToTop(resolveBaseOrderedResultsForCurrentMode(), documents, normalizedQuery);
	}, [
		directResults,
		documents,
		fuzzyResults,
		isSearchActive,
		mode,
		normalizedQuery,
		semanticResults,
		semanticSearchStatus,
	]);

	return {
		isSearchActive,
		orderedResults,
		semanticSearchStatus,
	};
}
