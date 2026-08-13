/**
 * Cursor 会话在**探测不到模型目录时**才用的兜底 model id。
 *
 * 正常路径由 `resolveCursorLaunchDefaultModelId()`（`src/terminal/terminal-agent-model-selection.ts`）
 * 从 `cursor-agent --list-models` 动态解析出「最新一代 grok 的 high 档」，所以这里写死的值只在 CLI 没装 /
 * 超时 / 输出变形时生效。命名刻意点明它是兜底而非默认，避免再次出现「常量落后于上游、却被当成默认值
 * 无条件塞进每次启动」的情况——上一版正是这样把一个上游早已删除的 `grok-4.5-high` 传给了每一次会话。
 */
export const KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID = "cursor-grok-4.6-high";

// 家族判定刻意**版本无关**：只认产品线名，不认代次。
//   - `cursor-` 前缀是上游后加的（`grok-4.5-high` → `cursor-grok-4.6-high`），两种写法都要认；
//   - `[context=…,effort=…]` 参数化后缀是 `cursor-agent --help` 明文支持的写法；
//   - 未来若再出现新的前缀命名空间（`xai/grok-…`），`/` 也按分隔符处理。
const CURSOR_AGENT_GROK_PRODUCT_LINE_PATTERN = /(?:^|[-/])grok(?:[-.[\d]|$)/;
const CURSOR_AGENT_COMPOSER_PRODUCT_LINE_PATTERN = /(?:^|[-/])composer(?:[-.[\d]|$)/;

/**
 * 这个 model id 是否属于 Kanban 放行给 Cursor 会话的家族（auto / composer / grok）。
 *
 * 这是**合法性**判据，不是**展示**判据：它同时管住 zod 契约、启动参数校验与前端的「记住的选择还能不能用」。
 * 因此它必须继续接受已经过时的代次（如 `cursor-grok-4.5-high`）——钉在旧版本的卡片仍要能启动，
 * 只是不再出现在模型选择器的 chip 行里。展示收窄由
 * `filterTerminalAgentModelOptionsToLatestProductLineGeneration` 单独负责，两者刻意分离。
 */
export function isKanbanCursorAgentModelId(modelId: string): boolean {
	const trimmedModelId = modelId.trim().toLowerCase();
	if (!trimmedModelId) {
		return false;
	}
	return (
		trimmedModelId === "auto" ||
		CURSOR_AGENT_GROK_PRODUCT_LINE_PATTERN.test(trimmedModelId) ||
		CURSOR_AGENT_COMPOSER_PRODUCT_LINE_PATTERN.test(trimmedModelId)
	);
}

/** 这个 model id 属不属于 grok 产品线。挑选会话启动默认值时用来把 grok 与 composer / auto 分开。 */
export function isKanbanCursorAgentGrokModelId(modelId: string): boolean {
	return CURSOR_AGENT_GROK_PRODUCT_LINE_PATTERN.test(modelId.trim().toLowerCase());
}
