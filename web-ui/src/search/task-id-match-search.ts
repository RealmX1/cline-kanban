import { isCompleteShortTaskIdShapedText } from "@runtime-task-id";

import {
	EMPTY_MATCH_CHARACTER_POSITIONS,
	normalizeSearchQuery,
	orderMatchSources,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMatchSource,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";

/**
 * 按 task id 检索：**仅当** query 归一化后整体符合完整 task id 范式（5 位 `[0-9a-z]`）时才启用，否则一律返回空。
 * 这道闸门保证任何普通文本查询都走不进这里 —— 既有 direct / fuzzy / semantic 行为零变化。
 *
 * 结果顺序沿用 documents 入参顺序。controller 把当前项目文档拼在前面
 * （use-task-spotlight-search-controller.ts 的 documents useMemo），
 * 因此跨项目同 taskId 碰撞时当前项目那条天然排在前 —— 这条契约不可随手改拼接顺序。
 *
 * 多 token 查询（如 "94c87 fix"）天然不命中：normalizeSearchQuery 把内部空白压成单空格，
 * 而范式正则不含空格。「同时按 id 和文本过滤」是明确的非目标。
 *
 * 已知局限（不为其放宽闸门）：经 addTaskToColumn 的 explicitTaskId 创建的自定义 id 若不符 5 位范式则搜不到；
 * 跨项目开关默认关闭，别的项目里的 id 需先开 All projects。
 */
export function findTaskIdExactMatchedSearchResults(
	documents: readonly TaskBoardSearchDocument[],
	query: string,
): TaskBoardSearchResult[] {
	// 谓词只认小写，粘贴来的大写 id 在这里归一（容忍大写是调用方的责任，见 isCompleteShortTaskIdShapedText）。
	const normalizedTaskIdQuery = normalizeSearchQuery(query).toLocaleLowerCase();
	if (!isCompleteShortTaskIdShapedText(normalizedTaskIdQuery)) {
		return [];
	}
	const taskIdMatchedResults: TaskBoardSearchResult[] = [];
	for (const document of documents) {
		if (document.taskId.toLocaleLowerCase() !== normalizedTaskIdQuery) {
			continue;
		}
		taskIdMatchedResults.push({
			document,
			// score 不参与：置顶层叠在各模式排序**之后**，不与文本分数同场竞技。
			score: 0,
			matchSources: ["taskId"],
			titleMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
			promptMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
		});
	}
	return taskIdMatchedResults;
}

/**
 * 把 task id 全等命中的结果提到列表最前，并把「base 里根本没有」的那些补进结果集
 * （query 是一个 id 时 title / prompt 通常都不含它，base 很可能是空的）。
 *
 * 三条不可退让的约束：
 * 1. 无 ID 命中时**原样返回入参同一引用**（而非浅拷贝）。direct 模式的 orderedResults 就是 directResults 本体，
 *    无谓复制会削弱 controller `useEffect([results]) → setActiveIndex(0)` 的引用稳定性，↑↓ 导航有被钉死在第 0 行的风险。
 * 2. 已在 base 里的那条**合并而非替换**：保留它原有的 title / prompt 高亮位置。prompt 里互相引用 task id 很常见
 *    （「接着 94c87 的改动继续…」），提上去之后 prompt 高亮消失是明显退化。
 * 3. 去重按 **document 引用**（与 mergeTaskBoardSearchResults 同一约定，不能按 taskId）：跨项目同 taskId 是两篇不同
 *    文档，都要保留；而同一篇文档绝不能出现两次，否则结果列表的 `projectId:taskId` key 会重复。
 */
export function hoistTaskIdExactMatchedResultsToTop(
	baseOrderedResults: TaskBoardSearchResult[],
	documents: readonly TaskBoardSearchDocument[],
	query: string,
): TaskBoardSearchResult[] {
	const taskIdMatchedResults = findTaskIdExactMatchedSearchResults(documents, query);
	if (taskIdMatchedResults.length === 0) {
		return baseOrderedResults;
	}
	const baseResultByDocument = new Map<TaskBoardSearchDocument, TaskBoardSearchResult>();
	for (const baseResult of baseOrderedResults) {
		baseResultByDocument.set(baseResult.document, baseResult);
	}
	const hoistedResults = taskIdMatchedResults.map((taskIdMatchedResult) => {
		const baseResult = baseResultByDocument.get(taskIdMatchedResult.document);
		if (!baseResult) {
			return taskIdMatchedResult;
		}
		const sources = new Set<TaskBoardSearchMatchSource>(baseResult.matchSources);
		sources.add("taskId");
		return { ...baseResult, matchSources: orderMatchSources(sources) };
	});
	const hoistedDocuments = new Set(taskIdMatchedResults.map((result) => result.document));
	return [...hoistedResults, ...baseOrderedResults.filter((result) => !hoistedDocuments.has(result.document))];
}
