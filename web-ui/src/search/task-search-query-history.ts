/**
 * ⌘K Spotlight 的「最近检索过的查询串」。纯数据层：只管去重、置顶、截断与反序列化容错，
 * 不碰存储与 React。
 *
 * 记录时机刻意放在**终止事件**上（打开某个结果、关掉弹层），而不是每次按键：逐键记录会把
 * `k` / `ka` / `kan` 这些前缀全塞进历史，真正想回看的那条反而被自己的前缀挤掉。
 */

/** 历史条数上限。够覆盖「昨天那条搜索」，又不至于让 chips 行变成第二个结果列表。 */
export const TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES = 12;

/** 单条查询串的长度上限——防止误粘贴一整段日志把 localStorage 撑爆。 */
const TASK_SEARCH_QUERY_HISTORY_MAX_ENTRY_LENGTH = 200;

/**
 * localStorage 里读回来的东西一律当作不可信：手改过、跨版本残留、被别的标签页写坏都可能。
 * 任何不是「字符串数组」的东西都退化成空历史，而不是让 Spotlight 在渲染 chips 时炸掉。
 */
export function normalizeTaskSearchQueryHistory(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const normalizedEntries: string[] = [];
	const seenLowerCasedEntries = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const trimmedEntry = entry.trim().slice(0, TASK_SEARCH_QUERY_HISTORY_MAX_ENTRY_LENGTH);
		if (trimmedEntry.length === 0) {
			continue;
		}
		const lowerCasedEntry = trimmedEntry.toLowerCase();
		if (seenLowerCasedEntries.has(lowerCasedEntry)) {
			continue;
		}
		seenLowerCasedEntries.add(lowerCasedEntry);
		normalizedEntries.push(trimmedEntry);
		if (normalizedEntries.length >= TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES) {
			break;
		}
	}
	return normalizedEntries;
}

/**
 * 把一次用过的查询串置顶。空串/纯空白不入历史；已存在的条目按**大小写无关**判重后移到队首，
 * 并采用本次的书写形式（用户最后一次是怎么打的，回看时就该看到那个形状）。
 *
 * 无变化时原样返回入参引用，调用方据此可以跳过一次 localStorage 写入。
 */
export function appendTaskSearchQueryToHistory(history: readonly string[], query: string): readonly string[] {
	const trimmedQuery = query.trim().slice(0, TASK_SEARCH_QUERY_HISTORY_MAX_ENTRY_LENGTH);
	if (trimmedQuery.length === 0) {
		return history;
	}
	if (history[0] === trimmedQuery) {
		return history;
	}
	const lowerCasedQuery = trimmedQuery.toLowerCase();
	const remainingEntries = history.filter((entry) => entry.toLowerCase() !== lowerCasedQuery);
	return [trimmedQuery, ...remainingEntries].slice(0, TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES);
}

/** 移除单条历史（chips 上的 × ）。无命中时原样返回入参引用。 */
export function removeTaskSearchQueryFromHistory(history: readonly string[], query: string): readonly string[] {
	const remainingEntries = history.filter((entry) => entry !== query);
	return remainingEntries.length === history.length ? history : remainingEntries;
}
