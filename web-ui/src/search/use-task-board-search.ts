import { useEffect, useMemo, useRef, useState } from "react";

import {
	buildTaskBoardSearchDocuments,
	createTaskBoardSearchState,
	findFuzzyTaskBoardSearchResults,
	mergeTaskBoardSearchResults,
	normalizeSearchQuery,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMode,
	type TaskBoardSearchResult,
	type TaskBoardSearchState,
} from "@/search/task-board-search";
import {
	createTaskBoardSemanticSearchIndex,
	type TaskBoardSemanticSearchIndex,
} from "@/search/task-board-semantic-search";
import type { BoardData } from "@/types";
import { useDebouncedEffect } from "@/utils/react-use";

export type TaskBoardSemanticSearchStatus = "idle" | "loading" | "ready" | "error";

export interface UseTaskBoardSearchResult extends TaskBoardSearchState {
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

export function useTaskBoardSearch({
	board,
	query,
	mode,
}: {
	board: BoardData;
	query: string;
	mode: TaskBoardSearchMode;
}): UseTaskBoardSearchResult {
	const normalizedQuery = normalizeSearchQuery(query);
	const isSearchActive = normalizedQuery.length > 0;
	// 语义索引以 documents 引用为缓存键；board 实时流每 tick 换引用会让 TF/Orama 索引反复从零重建（agent 边跑边搜
	// 时尤甚）。故按可搜索内容（taskId+title+prompt）算签名，内容未变则保持旧引用，索引不再无谓重建、也不重触发搜索。
	const documentsSignatureRef = useRef<string>("");
	const documentsRef = useRef<TaskBoardSearchDocument[]>([]);
	const documents = useMemo(() => {
		const next = buildTaskBoardSearchDocuments(board);
		const nextSignature = next.map((doc) => `${doc.taskId}\t${doc.title}\t${doc.prompt}`).join("\n");
		if (nextSignature === documentsSignatureRef.current) {
			return documentsRef.current;
		}
		documentsSignatureRef.current = nextSignature;
		documentsRef.current = next;
		return next;
	}, [board]);
	const fuzzyResults = useMemo(() => {
		if (!isSearchActive || mode === "semantic") {
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

	const displayedResults = useMemo(() => {
		if (!isSearchActive) {
			return [] satisfies TaskBoardSearchResult[];
		}
		if (mode === "fuzzy") {
			return fuzzyResults;
		}
		if (mode === "semantic") {
			return (
				semanticResults ??
				(semanticSearchStatus === "error" ? findFuzzyTaskBoardSearchResults(documents, normalizedQuery) : [])
			);
		}
		if (semanticSearchStatus === "error") {
			return fuzzyResults;
		}
		return mergeTaskBoardSearchResults(fuzzyResults, semanticResults ?? []);
	}, [documents, fuzzyResults, isSearchActive, mode, normalizedQuery, semanticResults, semanticSearchStatus]);

	const searchState = useMemo(
		() => createTaskBoardSearchState(board, displayedResults, isSearchActive),
		[board, displayedResults, isSearchActive],
	);

	return {
		...searchState,
		semanticSearchStatus,
	};
}
