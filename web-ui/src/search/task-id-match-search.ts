import {
	isCompleteShortTaskIdShapedText,
	isPartialOrCompleteShortTaskIdShapedSearchQuery,
	SHORT_TASK_ID_CHARACTER_LENGTH,
} from "@runtime-task-id";

import {
	EMPTY_MATCH_CHARACTER_POSITIONS,
	normalizeSearchQuery,
	orderMatchSources,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMatchSource,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";

/**
 * task id 命中的强弱分档，数组顺序即置顶顺序（强 → 弱）：
 * - exact：query 与 taskId 全等（粘贴完整 id → 回车直达的主路径）；
 * - prefix：taskId 以 query 开头（边敲边出，不必敲满整个 id）；
 * - substring：taskId 在非开头处包含 query（从路径 / 日志里截了一段）；
 * - single_character_typo：query 恰为完整长度、与 taskId 只差一次替换或一次相邻对调（敲错一位）。
 *   只对完整长度开放：部分长度再叠容错，误命中噪声会高出好几个数量级。
 */
const TASK_ID_MATCH_TIERS_FROM_STRONGEST_TO_WEAKEST = [
	"exact",
	"prefix",
	"substring",
	"single_character_typo",
] as const;

type TaskIdMatchTier = (typeof TASK_ID_MATCH_TIERS_FROM_STRONGEST_TO_WEAKEST)[number];

interface TaskIdMatchOutcome {
	tier: TaskIdMatchTier;
	/** taskId 内被 query 对上的字符下标，供 ID 徽标高亮；typo 档只含对得上的位，缺口即错位。 */
	taskIdMatchCharacterPositions: ReadonlySet<number>;
}

function buildContiguousCharacterPositions(startIndex: number, length: number): ReadonlySet<number> {
	const positions = new Set<number>();
	for (let offset = 0; offset < length; offset += 1) {
		positions.add(startIndex + offset);
	}
	return positions;
}

/** 等长两串之间是否恰好差一次替换或一次相邻对调；是则返回对得上的那些下标，否则 null。 */
function resolveSingleCharacterTypoAgreeingPositions(
	taskIdLowerCase: string,
	normalizedTaskIdQuery: string,
): ReadonlySet<number> | null {
	if (taskIdLowerCase.length !== normalizedTaskIdQuery.length) {
		return null;
	}
	const mismatchedIndices: number[] = [];
	for (let index = 0; index < taskIdLowerCase.length; index += 1) {
		if (taskIdLowerCase[index] !== normalizedTaskIdQuery[index]) {
			mismatchedIndices.push(index);
		}
	}
	const isSingleSubstitution = mismatchedIndices.length === 1;
	const [firstMismatchedIndex, secondMismatchedIndex] = mismatchedIndices;
	const isSingleAdjacentTransposition =
		mismatchedIndices.length === 2 &&
		firstMismatchedIndex !== undefined &&
		secondMismatchedIndex === firstMismatchedIndex + 1 &&
		taskIdLowerCase[firstMismatchedIndex] === normalizedTaskIdQuery[secondMismatchedIndex] &&
		taskIdLowerCase[secondMismatchedIndex] === normalizedTaskIdQuery[firstMismatchedIndex];
	if (!isSingleSubstitution && !isSingleAdjacentTransposition) {
		return null;
	}
	const agreeingPositions = new Set<number>();
	for (let index = 0; index < taskIdLowerCase.length; index += 1) {
		if (!mismatchedIndices.includes(index)) {
			agreeingPositions.add(index);
		}
	}
	return agreeingPositions;
}

function resolveTaskIdMatchOutcome(taskId: string, normalizedTaskIdQuery: string): TaskIdMatchOutcome | null {
	const taskIdLowerCase = taskId.toLocaleLowerCase();
	// 只对生成器范式的 id 做匹配：误命中噪声的估算（见 MINIMUM_PARTIAL_TASK_ID_SEARCH_QUERY_CHARACTER_LENGTH）
	// 建立在「id 是随机 5 位串」之上；explicitTaskId 自定义的可读 id（如 "task-beta"）会让普通单词按子串命中。
	if (!isCompleteShortTaskIdShapedText(taskIdLowerCase)) {
		return null;
	}
	const queryStartIndexInTaskId = taskIdLowerCase.indexOf(normalizedTaskIdQuery);
	if (queryStartIndexInTaskId >= 0) {
		const isExact = taskIdLowerCase.length === normalizedTaskIdQuery.length;
		return {
			tier: isExact ? "exact" : queryStartIndexInTaskId === 0 ? "prefix" : "substring",
			taskIdMatchCharacterPositions: buildContiguousCharacterPositions(
				queryStartIndexInTaskId,
				normalizedTaskIdQuery.length,
			),
		};
	}
	if (normalizedTaskIdQuery.length !== SHORT_TASK_ID_CHARACTER_LENGTH) {
		return null;
	}
	const typoAgreeingPositions = resolveSingleCharacterTypoAgreeingPositions(taskIdLowerCase, normalizedTaskIdQuery);
	return typoAgreeingPositions
		? { tier: "single_character_typo", taskIdMatchCharacterPositions: typoAgreeingPositions }
		: null;
}

/**
 * 按 task id 检索：**仅当** query 归一化后整体是一个 3–5 位 `[0-9a-z]` 片段时才启用（闸门见
 * isPartialOrCompleteShortTaskIdShapedSearchQuery），否则一律返回空 —— 普通文本查询绝大多数走不进来，
 * 既有 direct / fuzzy / semantic 行为不变。
 *
 * 结果先按 TASK_ID_MATCH_TIERS_FROM_STRONGEST_TO_WEAKEST 分档，**同档内**沿用 documents 入参顺序。
 * controller 把当前项目文档拼在前面（use-task-spotlight-search-controller.ts 的 documents useMemo），
 * 因此跨项目同 taskId 碰撞时当前项目那条天然排在前 —— 这条契约不可随手改拼接顺序。
 *
 * 多 token 查询（如 "94c87 fix"）天然不命中：normalizeSearchQuery 把内部空白压成单空格，
 * 而范式正则不含空格。「同时按 id 和文本过滤」是明确的非目标。
 *
 * 已知局限（不为其放宽闸门）：经 addTaskToColumn 的 explicitTaskId 创建的自定义 id 若不符 5 位范式则搜不到；
 * 跨项目开关默认关闭，别的项目里的 id 需先开 All projects。
 */
export function findTaskIdPartialOrExactMatchedSearchResults(
	documents: readonly TaskBoardSearchDocument[],
	query: string,
): TaskBoardSearchResult[] {
	// 谓词只认小写，粘贴来的大写 id 在这里归一。
	const normalizedTaskIdQuery = normalizeSearchQuery(query).toLocaleLowerCase();
	if (!isPartialOrCompleteShortTaskIdShapedSearchQuery(normalizedTaskIdQuery)) {
		return [];
	}
	const taskIdMatchedResultsByTier = new Map<TaskIdMatchTier, TaskBoardSearchResult[]>(
		TASK_ID_MATCH_TIERS_FROM_STRONGEST_TO_WEAKEST.map((tier) => [tier, []]),
	);
	for (const document of documents) {
		const matchOutcome = resolveTaskIdMatchOutcome(document.taskId, normalizedTaskIdQuery);
		if (!matchOutcome) {
			continue;
		}
		taskIdMatchedResultsByTier.get(matchOutcome.tier)?.push({
			document,
			// score 不参与：置顶层叠在各模式排序**之后**，不与文本分数同场竞技；档次即排序依据。
			score: 0,
			matchSources: ["taskId"],
			titleMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
			promptMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
			taskIdMatchCharacterPositions: matchOutcome.taskIdMatchCharacterPositions,
		});
	}
	return TASK_ID_MATCH_TIERS_FROM_STRONGEST_TO_WEAKEST.flatMap((tier) => taskIdMatchedResultsByTier.get(tier) ?? []);
}

/**
 * 把 task id 命中（全等 / 前缀 / 子串 / 单字符容错，按档次排好）的结果提到列表最前，并把「base 里根本没有」
 * 的那些补进结果集（query 是一个 id 或 id 片段时 title / prompt 通常都不含它，base 很可能是空的）。
 *
 * 三条不可退让的约束：
 * 1. 无 ID 命中时**原样返回入参同一引用**（而非浅拷贝）。direct 模式的 orderedResults 就是 directResults 本体，
 *    无谓复制会削弱 controller `useEffect([results]) → setActiveIndex(0)` 的引用稳定性，↑↓ 导航有被钉死在第 0 行的风险。
 * 2. 已在 base 里的那条**合并而非替换**：保留它原有的 title / prompt 高亮位置。prompt 里互相引用 task id 很常见
 *    （「接着 94c87 的改动继续…」），提上去之后 prompt 高亮消失是明显退化。
 * 3. 去重按 **document 引用**（与 mergeTaskBoardSearchResults 同一约定，不能按 taskId）：跨项目同 taskId 是两篇不同
 *    文档，都要保留；而同一篇文档绝不能出现两次，否则结果列表的 `projectId:taskId` key 会重复。
 */
export function hoistTaskIdMatchedResultsToTopByMatchTier(
	baseOrderedResults: TaskBoardSearchResult[],
	documents: readonly TaskBoardSearchDocument[],
	query: string,
): TaskBoardSearchResult[] {
	const taskIdMatchedResults = findTaskIdPartialOrExactMatchedSearchResults(documents, query);
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
		return {
			...baseResult,
			matchSources: orderMatchSources(sources),
			taskIdMatchCharacterPositions: taskIdMatchedResult.taskIdMatchCharacterPositions,
		};
	});
	const hoistedDocuments = new Set(taskIdMatchedResults.map((result) => result.document));
	return [...hoistedResults, ...baseOrderedResults.filter((result) => !hoistedDocuments.has(result.document))];
}
