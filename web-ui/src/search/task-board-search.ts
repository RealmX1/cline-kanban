import { Fzf, type FzfResultItem } from "fzf";

import type { BoardData } from "@/types";

export type TaskBoardSearchMode = "hybrid" | "fuzzy" | "semantic";
export type TaskBoardSearchMatchSource = "title" | "prompt";

export interface TaskBoardSearchDocument {
	taskId: string;
	columnId: string;
	title: string;
	prompt: string;
	taskSearchSubjectText: string;
	titleSubjectStartIndex: number;
	titleSubjectEndIndex: number;
	promptSubjectStartIndex: number;
	promptSubjectEndIndex: number;
}

export interface TaskBoardSearchResult {
	taskId: string;
	score: number;
	matchSources: TaskBoardSearchMatchSource[];
}

export interface TaskBoardSearchState {
	isSearchActive: boolean;
	filteredBoard: BoardData;
	filteredDependencies: BoardData["dependencies"];
	visibleTaskIds: Set<string>;
	resultByTaskId: Map<string, TaskBoardSearchResult>;
	totalTaskCount: number;
	visibleTaskCount: number;
}

export function normalizeSearchQuery(query: string): string {
	return query.trim().replace(/\s+/gu, " ");
}

function getTaskSearchSubjectText(title: string, prompt: string): string {
	const normalizedTitle = title.trim();
	const normalizedPrompt = prompt.trim();
	if (!normalizedTitle) {
		return normalizedPrompt;
	}
	if (!normalizedPrompt) {
		return normalizedTitle;
	}
	return `${normalizedTitle}\n${normalizedPrompt}`;
}

function collectMatchSourcesFromSubjectPositions(
	document: TaskBoardSearchDocument,
	positions: ReadonlySet<number>,
): Set<TaskBoardSearchMatchSource> {
	const sources = new Set<TaskBoardSearchMatchSource>();
	for (const position of positions) {
		if (position >= document.titleSubjectStartIndex && position < document.titleSubjectEndIndex) {
			sources.add("title");
		}
		if (position >= document.promptSubjectStartIndex && position < document.promptSubjectEndIndex) {
			sources.add("prompt");
		}
	}
	return sources;
}

function collectTokenMatchSources(document: TaskBoardSearchDocument, query: string): Set<TaskBoardSearchMatchSource> {
	const sources = new Set<TaskBoardSearchMatchSource>();
	const tokens = normalizeSearchQuery(query)
		.toLocaleLowerCase()
		.split(" ")
		.filter((token) => token.length > 0);
	const normalizedTitle = document.title.toLocaleLowerCase();
	const normalizedPrompt = document.prompt.toLocaleLowerCase();
	for (const token of tokens) {
		if (normalizedTitle.includes(token)) {
			sources.add("title");
		}
		if (normalizedPrompt.includes(token)) {
			sources.add("prompt");
		}
	}
	return sources;
}

function orderMatchSources(sources: ReadonlySet<TaskBoardSearchMatchSource>): TaskBoardSearchMatchSource[] {
	const orderedSources: TaskBoardSearchMatchSource[] = [];
	if (sources.has("title")) {
		orderedSources.push("title");
	}
	if (sources.has("prompt")) {
		orderedSources.push("prompt");
	}
	return orderedSources;
}

export function buildTaskBoardSearchDocuments(board: BoardData): TaskBoardSearchDocument[] {
	const documents: TaskBoardSearchDocument[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			const title = card.title.trim();
			const prompt = card.prompt.trim();
			const taskSearchSubjectText = getTaskSearchSubjectText(title, prompt);
			const titleSubjectStartIndex = 0;
			const titleSubjectEndIndex = title.length;
			const promptSubjectStartIndex = title.length > 0 && prompt.length > 0 ? title.length + 1 : 0;
			const promptSubjectEndIndex = promptSubjectStartIndex + prompt.length;
			documents.push({
				taskId: card.id,
				columnId: column.id,
				title,
				prompt,
				taskSearchSubjectText,
				titleSubjectStartIndex,
				titleSubjectEndIndex,
				promptSubjectStartIndex,
				promptSubjectEndIndex,
			});
		}
	}
	return documents;
}

export function findFuzzyTaskBoardSearchResults(
	documents: readonly TaskBoardSearchDocument[],
	query: string,
): TaskBoardSearchResult[] {
	const normalizedQuery = normalizeSearchQuery(query);
	if (!normalizedQuery) {
		return [];
	}
	const finder = new Fzf(documents, {
		selector: (document) => document.taskSearchSubjectText,
	});
	return finder.find(normalizedQuery).map((match) => buildFuzzyTaskBoardSearchResult(match, normalizedQuery));
}

function buildFuzzyTaskBoardSearchResult(
	match: FzfResultItem<TaskBoardSearchDocument>,
	query: string,
): TaskBoardSearchResult {
	const sources = collectMatchSourcesFromSubjectPositions(match.item, match.positions);
	for (const source of collectTokenMatchSources(match.item, query)) {
		sources.add(source);
	}
	return {
		taskId: match.item.taskId,
		score: match.score,
		matchSources: orderMatchSources(sources),
	};
}

export function mergeTaskBoardSearchResults(
	primaryResults: readonly TaskBoardSearchResult[],
	secondaryResults: readonly TaskBoardSearchResult[],
): TaskBoardSearchResult[] {
	const resultByTaskId = new Map<string, TaskBoardSearchResult>();
	for (const result of [...primaryResults, ...secondaryResults]) {
		const existingResult = resultByTaskId.get(result.taskId);
		if (!existingResult) {
			resultByTaskId.set(result.taskId, {
				...result,
				matchSources: [...result.matchSources],
			});
			continue;
		}
		const sources = new Set<TaskBoardSearchMatchSource>(existingResult.matchSources);
		for (const source of result.matchSources) {
			sources.add(source);
		}
		resultByTaskId.set(result.taskId, {
			taskId: result.taskId,
			score: Math.max(existingResult.score, result.score),
			matchSources: orderMatchSources(sources),
		});
	}
	return [...resultByTaskId.values()];
}

export function createTaskBoardSearchState(
	board: BoardData,
	results: readonly TaskBoardSearchResult[],
	isSearchActive: boolean,
): TaskBoardSearchState {
	const totalTaskCount = board.columns.reduce((count, column) => count + column.cards.length, 0);
	if (!isSearchActive) {
		return {
			isSearchActive: false,
			filteredBoard: board,
			filteredDependencies: board.dependencies,
			visibleTaskIds: new Set(board.columns.flatMap((column) => column.cards.map((card) => card.id))),
			resultByTaskId: new Map(),
			totalTaskCount,
			visibleTaskCount: totalTaskCount,
		};
	}
	const resultByTaskId = new Map(results.map((result) => [result.taskId, result] as const));
	const visibleTaskIds = new Set(resultByTaskId.keys());
	const filteredBoard: BoardData = {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.filter((card) => visibleTaskIds.has(card.id)),
		})),
	};
	const filteredDependencies = board.dependencies.filter(
		(dependency) => visibleTaskIds.has(dependency.fromTaskId) && visibleTaskIds.has(dependency.toTaskId),
	);
	return {
		isSearchActive: true,
		filteredBoard,
		filteredDependencies,
		visibleTaskIds,
		resultByTaskId,
		totalTaskCount,
		visibleTaskCount: visibleTaskIds.size,
	};
}

export function createEmptyTaskBoardSearchState(board: BoardData): TaskBoardSearchState {
	return createTaskBoardSearchState(board, [], false);
}
