import { Fzf, type FzfResultItem } from "fzf";

import type { RuntimeAgentId } from "@/runtime/types";
import type { BoardData } from "@/types";

export type TaskBoardSearchMode = "direct" | "hybrid" | "fuzzy" | "semantic";
// taskId 是一条独立于文本的命中来源：仅当查询串整体就是一个完整 task id 时才产生（见 task-id-match-search.ts），
// 不参与 direct 的分词、不进 fuzzy 的合并主体、不进语义索引。
export type TaskBoardSearchMatchSource = "taskId" | "title" | "prompt";

/** 可做文本匹配的字段（taskId 不是文本命中来源，见上）。 */
export type TaskSearchMatchableTextField = Exclude<TaskBoardSearchMatchSource, "taskId">;

/**
 * 文本匹配的字段范围：默认 title 与 prompt 都参与，用户可收窄到只匹配其一。四种模式通用——
 * direct 只在允许的字段里找子串、fuzzy 换 fzf 的匹配主体、semantic / hybrid 丢弃范围外字段的向量命中。
 * task id 全等置顶不受它约束（taskId 是独立于文本的命中来源）。
 */
export type TaskSearchMatchedTextFieldScope = "title_and_prompt" | "title_only" | "prompt_only";

export const DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE: TaskSearchMatchedTextFieldScope = "title_and_prompt";

export function isTaskSearchTextFieldIncludedInMatchedTextFieldScope(
	textField: TaskSearchMatchableTextField,
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope,
): boolean {
	if (matchedTextFieldScope === "title_only") {
		return textField === "title";
	}
	if (matchedTextFieldScope === "prompt_only") {
		return textField === "prompt";
	}
	return true;
}

/** 全体 producer 共用的空命中位置集：语义清晰且免重复分配。 */
export const EMPTY_MATCH_CHARACTER_POSITIONS: ReadonlySet<number> = new Set<number>();

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
	// 下面四个字段**只**参与排序与结果行展示，一律不进 taskSearchSubjectText、不进语义索引、
	// 不参与 direct 分词——加宽文档不得改变任何一种模式的命中集合。
	taskCreatedAtEpochMs: number;
	// 用户可见的「上次修改时间」：建卡 / 跨列移动 / 用户编辑才 bump。**不是** agent 活跃时间
	// （后台观测刻意不写它，见 src/core/task-board-mutations.ts 的注释）——名字写长就是为了防止
	// 再有人把它当成「最近活跃」来排序。
	taskLastModifiedAtEpochMs: number;
	// 用户为这张卡做的 per-task agent 覆盖；null = 跟随所属项目的默认 agent。
	taskAgentOverrideAgentId: RuntimeAgentId | null;
	// runtime 观测值：本卡最近一次真正启动成功的会话用的是哪个 agent。跨项目行没有 live session，
	// 它是「这个任务实际在用哪个 agent」唯一可得的事实。
	mostRecentlyLaunchedAgentSessionAgentId: RuntimeAgentId | null;
	// 跨项目行的「对话上次推进」时刻（跨项目索引按需拉取时由 runtime 从会话摘要投影而来）。
	// **当前项目的文档恒为 null**：当前项目读实时会话推流叠加层（controller），不读这份快照——
	// 推进时刻每 tick 都可能前进，放进 documents 会让语义索引反复重建。
	crossProjectAgentConversationProgressAtEpochMs: number | null;
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
	// taskId 排最前：它是最强信号（全等命中即唯一确定一个任务）。
	// 这个分支不可省——mergeTaskBoardSearchResults 的合并分支会过本函数，漏了会把 "taskId" 静默丢弃。
	if (sources.has("taskId")) {
		orderedSources.push("taskId");
	}
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
	taskCreatedAtEpochMs: number;
	taskLastModifiedAtEpochMs: number;
	taskAgentOverrideAgentId: RuntimeAgentId | null;
	mostRecentlyLaunchedAgentSessionAgentId: RuntimeAgentId | null;
	crossProjectAgentConversationProgressAtEpochMs: number | null;
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
		taskCreatedAtEpochMs: params.taskCreatedAtEpochMs,
		taskLastModifiedAtEpochMs: params.taskLastModifiedAtEpochMs,
		taskAgentOverrideAgentId: params.taskAgentOverrideAgentId,
		mostRecentlyLaunchedAgentSessionAgentId: params.mostRecentlyLaunchedAgentSessionAgentId,
		crossProjectAgentConversationProgressAtEpochMs: params.crossProjectAgentConversationProgressAtEpochMs,
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
					taskCreatedAtEpochMs: card.createdAt,
					taskLastModifiedAtEpochMs: card.updatedAt,
					taskAgentOverrideAgentId: card.agentId ?? null,
					mostRecentlyLaunchedAgentSessionAgentId: card.mostRecentlyLaunchedAgentSessionAgentId ?? null,
					// 当前项目 board 卡：推进时刻走实时会话叠加层，见字段注释。
					crossProjectAgentConversationProgressAtEpochMs: null,
				}),
			);
		}
	}
	return documents;
}

/**
 * 按字段范围选 fzf 的匹配主体。收窄范围时**换主体**而不是「在合并主体上匹配再按字段后过滤」：
 * 子序列匹配会跨过 title / prompt 的边界，后过滤要么误收（一半字符落在被排除的字段里）、要么误删。
 */
function selectFuzzyMatchSubjectText(
	document: TaskBoardSearchDocument,
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope,
): string {
	if (matchedTextFieldScope === "title_only") {
		return document.title;
	}
	if (matchedTextFieldScope === "prompt_only") {
		return document.prompt;
	}
	return document.taskSearchSubjectText;
}

export function findFuzzyTaskBoardSearchResults(
	documents: readonly TaskBoardSearchDocument[],
	query: string,
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope = DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
): TaskBoardSearchResult[] {
	const normalizedQuery = normalizeSearchQuery(query);
	if (!normalizedQuery) {
		return [];
	}
	const finder = new Fzf(documents, {
		selector: (document) => selectFuzzyMatchSubjectText(document, matchedTextFieldScope),
	});
	return finder.find(normalizedQuery).map((match) => buildFuzzyTaskBoardSearchResult(match, matchedTextFieldScope));
}

function buildFuzzyTaskBoardSearchResult(
	match: FzfResultItem<TaskBoardSearchDocument>,
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope,
): TaskBoardSearchResult {
	const document = match.item;
	const titleMatchCharacterPositions = new Set<number>();
	const promptMatchCharacterPositions = new Set<number>();
	// 单字段主体：positions 本就是该字段内的局部下标，原样归给它。
	if (matchedTextFieldScope !== "title_and_prompt") {
		const matchedFieldPositions =
			matchedTextFieldScope === "title_only" ? titleMatchCharacterPositions : promptMatchCharacterPositions;
		for (const position of match.positions) {
			matchedFieldPositions.add(position);
		}
		return {
			document,
			score: match.score,
			matchSources: deriveMatchSourcesFromPositions(titleMatchCharacterPositions, promptMatchCharacterPositions),
			titleMatchCharacterPositions,
			promptMatchCharacterPositions,
		};
	}
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
