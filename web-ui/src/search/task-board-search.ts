import { Fzf, type FzfResultItem } from "fzf";

import type { BoardData } from "@/types";

export type TaskBoardSearchMode = "direct" | "hybrid" | "fuzzy" | "semantic";
export type TaskBoardSearchMatchSource = "title" | "prompt";

/** 文档所属项目的身份信息：taskId 仅在单 board 内唯一（5 hex），跨项目合并/跳转必须携带 project 身份。 */
export interface TaskBoardSearchProjectContext {
	projectId: string;
	projectName: string;
}

export interface TaskBoardSearchDocument {
	projectId: string;
	projectName: string;
	taskId: string;
	columnId: string;
	title: string;
	prompt: string;
	// direct 子串匹配每键都要 lowercase 两个字段，预计算免每次搜索重复归一。
	titleLowerCase: string;
	promptLowerCase: string;
	// fuzzy（fzf）在 title+"\n"+prompt 合并主体上做子序列匹配；下面的偏移用于把主体命中位置拆回 title/prompt。
	taskSearchSubjectText: string;
	titleSubjectStartIndex: number;
	titleSubjectEndIndex: number;
	promptSubjectStartIndex: number;
	promptSubjectEndIndex: number;
}

export interface TaskBoardSearchResult {
	// 携带 document 引用（而非裸 taskId）：跨项目同 taskId 不碰撞，merge/去重按引用，列表 key 用 projectId:taskId。
	document: TaskBoardSearchDocument;
	score: number;
	matchSources: TaskBoardSearchMatchSource[];
	// 命中字符位置集：相对各自字段（title / prompt）的字符下标，供 renderFuzzyHighlightedText 高亮。
	titleMatchCharacterPositions: ReadonlySet<number>;
	promptMatchCharacterPositions: ReadonlySet<number>;
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

export function orderMatchSources(sources: ReadonlySet<TaskBoardSearchMatchSource>): TaskBoardSearchMatchSource[] {
	const orderedSources: TaskBoardSearchMatchSource[] = [];
	if (sources.has("title")) {
		orderedSources.push("title");
	}
	if (sources.has("prompt")) {
		orderedSources.push("prompt");
	}
	return orderedSources;
}

/** 从命中位置集推导 matchSources（direct / fuzzy 用；semantic 无位置集，自行给出 sources）。 */
export function deriveMatchSourcesFromPositions(
	titleMatchCharacterPositions: ReadonlySet<number>,
	promptMatchCharacterPositions: ReadonlySet<number>,
): TaskBoardSearchMatchSource[] {
	const sources = new Set<TaskBoardSearchMatchSource>();
	if (titleMatchCharacterPositions.size > 0) {
		sources.add("title");
	}
	if (promptMatchCharacterPositions.size > 0) {
		sources.add("prompt");
	}
	return orderMatchSources(sources);
}

/** 从单个任务的原始字段装配一篇搜索文档（当前项目 board 卡与跨项目索引条目共用，避免偏移/归一逻辑漂移）。 */
export function buildTaskBoardSearchDocument(params: {
	projectId: string;
	projectName: string;
	taskId: string;
	columnId: string;
	title: string;
	prompt: string;
}): TaskBoardSearchDocument {
	const title = params.title.trim();
	const prompt = params.prompt.trim();
	const taskSearchSubjectText = getTaskSearchSubjectText(title, prompt);
	const titleSubjectStartIndex = 0;
	const titleSubjectEndIndex = title.length;
	const promptSubjectStartIndex = title.length > 0 && prompt.length > 0 ? title.length + 1 : 0;
	const promptSubjectEndIndex = promptSubjectStartIndex + prompt.length;
	return {
		projectId: params.projectId,
		projectName: params.projectName,
		taskId: params.taskId,
		columnId: params.columnId,
		title,
		prompt,
		titleLowerCase: title.toLocaleLowerCase(),
		promptLowerCase: prompt.toLocaleLowerCase(),
		taskSearchSubjectText,
		titleSubjectStartIndex,
		titleSubjectEndIndex,
		promptSubjectStartIndex,
		promptSubjectEndIndex,
	};
}

export function buildTaskBoardSearchDocuments(
	board: BoardData,
	projectContext: TaskBoardSearchProjectContext,
): TaskBoardSearchDocument[] {
	const documents: TaskBoardSearchDocument[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			documents.push(
				buildTaskBoardSearchDocument({
					projectId: projectContext.projectId,
					projectName: projectContext.projectName,
					taskId: card.id,
					columnId: column.id,
					title: card.title,
					prompt: card.prompt,
				}),
			);
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
	return finder.find(normalizedQuery).map((match) => buildFuzzyTaskBoardSearchResult(match));
}

function buildFuzzyTaskBoardSearchResult(match: FzfResultItem<TaskBoardSearchDocument>): TaskBoardSearchResult {
	const document = match.item;
	const titleMatchCharacterPositions = new Set<number>();
	const promptMatchCharacterPositions = new Set<number>();
	// fzf 的 positions 是合并主体上的字符下标；减去各字段在主体中的起始偏移，还原为字段内局部下标。
	for (const position of match.positions) {
		if (position >= document.titleSubjectStartIndex && position < document.titleSubjectEndIndex) {
			titleMatchCharacterPositions.add(position - document.titleSubjectStartIndex);
		}
		if (position >= document.promptSubjectStartIndex && position < document.promptSubjectEndIndex) {
			promptMatchCharacterPositions.add(position - document.promptSubjectStartIndex);
		}
	}
	return {
		document,
		score: match.score,
		matchSources: deriveMatchSourcesFromPositions(titleMatchCharacterPositions, promptMatchCharacterPositions),
		titleMatchCharacterPositions,
		promptMatchCharacterPositions,
	};
}

export function mergeTaskBoardSearchResults(
	primaryResults: readonly TaskBoardSearchResult[],
	secondaryResults: readonly TaskBoardSearchResult[],
): TaskBoardSearchResult[] {
	// 按 document 引用合并（fuzzy 与 semantic 结果均引用同一 documents 数组的对象，引用相等即同一任务）。
	const resultByDocument = new Map<TaskBoardSearchDocument, TaskBoardSearchResult>();
	for (const result of [...primaryResults, ...secondaryResults]) {
		const existingResult = resultByDocument.get(result.document);
		if (!existingResult) {
			resultByDocument.set(result.document, {
				document: result.document,
				score: result.score,
				matchSources: [...result.matchSources],
				titleMatchCharacterPositions: new Set(result.titleMatchCharacterPositions),
				promptMatchCharacterPositions: new Set(result.promptMatchCharacterPositions),
			});
			continue;
		}
		const sources = new Set<TaskBoardSearchMatchSource>(existingResult.matchSources);
		for (const source of result.matchSources) {
			sources.add(source);
		}
		const titleMatchCharacterPositions = new Set(existingResult.titleMatchCharacterPositions);
		for (const position of result.titleMatchCharacterPositions) {
			titleMatchCharacterPositions.add(position);
		}
		const promptMatchCharacterPositions = new Set(existingResult.promptMatchCharacterPositions);
		for (const position of result.promptMatchCharacterPositions) {
			promptMatchCharacterPositions.add(position);
		}
		resultByDocument.set(result.document, {
			document: result.document,
			score: Math.max(existingResult.score, result.score),
			matchSources: orderMatchSources(sources),
			titleMatchCharacterPositions,
			promptMatchCharacterPositions,
		});
	}
	return [...resultByDocument.values()];
}
