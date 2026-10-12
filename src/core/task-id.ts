/** 短 task id 的字符长度：生成器与范式谓词的唯一声明点，两边不会漂移。 */
export const SHORT_TASK_ID_CHARACTER_LENGTH = 5;

// 字符集是 [0-9a-z] 而非 [0-9a-f]：主路径 createShortTaskId 取自 uuid 十六进制，
// 但 createUniqueTaskId 的碰撞兜底走 Math.random().toString(36)，会产出 g–z。
const COMPLETE_SHORT_TASK_ID_SHAPE_PATTERN = new RegExp(`^[0-9a-z]{${SHORT_TASK_ID_CHARACTER_LENGTH}}$`, "u");

/**
 * 判定一段文本是否**完整**符合短 task id 的范式。
 * 只认小写：生成器只产小写；要容忍用户粘贴的大写是调用方的责任（自行先 toLocaleLowerCase）。
 */
export function isCompleteShortTaskIdShapedText(text: string): boolean {
	return COMPLETE_SHORT_TASK_ID_SHAPE_PATTERN.test(text);
}

/**
 * 部分 task id 检索的最短查询长度。3 位 hex 子串对单篇文档的偶然命中率 ≈ 3/16³ ≈ 0.07%（500 任务期望 < 0.4 条误命中）；
 * 2 位则 ≈ 1.6%/篇，几乎每次都会把无关任务顶到最前。
 */
// EXPERIMENT_NODE: 部分 task id 检索的最短查询长度取 3 还是 2（2 位召回更早、但误命中噪声高一个数量级）
export const MINIMUM_PARTIAL_TASK_ID_SEARCH_QUERY_CHARACTER_LENGTH = 3;

const PARTIAL_OR_COMPLETE_SHORT_TASK_ID_SEARCH_QUERY_SHAPE_PATTERN = new RegExp(
	`^[0-9a-z]{${MINIMUM_PARTIAL_TASK_ID_SEARCH_QUERY_CHARACTER_LENGTH},${SHORT_TASK_ID_CHARACTER_LENGTH}}$`,
	"u",
);

/**
 * 判定一段搜索文本能否作为 task id 的**片段或整体**参与 ID 检索：长度介于最短部分查询长度与完整长度之间、
 * 字符集同 task id。同样只认小写，大小写容忍由调用方负责。
 */
export function isPartialOrCompleteShortTaskIdShapedSearchQuery(text: string): boolean {
	return PARTIAL_OR_COMPLETE_SHORT_TASK_ID_SEARCH_QUERY_SHAPE_PATTERN.test(text);
}

export function createShortTaskId(randomUuid: () => string): string {
	return randomUuid().replaceAll("-", "").slice(0, SHORT_TASK_ID_CHARACTER_LENGTH);
}

export function createUniqueTaskId(existingIds: Set<string>, randomUuid: () => string): string {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = createShortTaskId(randomUuid);
		if (!existingIds.has(candidate)) {
			return candidate;
		}
	}
	return Math.random()
		.toString(36)
		.slice(2, 2 + SHORT_TASK_ID_CHARACTER_LENGTH);
}
