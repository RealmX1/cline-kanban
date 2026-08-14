import type { RestorationDeferredHarnessGeneratedPrompt } from "../state/restoration-deferred-harness-generated-prompt-store";

const CLAUDE_TASK_NOTIFICATION_PROMPT_PATTERN =
	/^<task-notification>\s*[\s\S]*?<task-id>[^<]+<\/task-id>[\s\S]*?<status>[^<]+<\/status>[\s\S]*?<summary>[\s\S]*?<\/summary>[\s\S]*?<\/task-notification>$/i;

// 只认 Claude 自己生成、结构完整的 <task-notification> 包裹；绝不按模糊关键词拦普通用户消息。
export function isClaudeHarnessGeneratedTaskNotificationPrompt(promptText: string | undefined): boolean {
	if (!promptText) {
		return false;
	}
	return CLAUDE_TASK_NOTIFICATION_PROMPT_PATTERN.test(promptText.trim());
}

export function formatDeferredHarnessGeneratedPromptsAsAdditionalContext(
	records: readonly RestorationDeferredHarnessGeneratedPrompt[],
): string | undefined {
	if (records.length === 0) {
		return undefined;
	}
	return [
		"<kanban-restoration-deferred-harness-notifications>",
		"以下通知在恢复旧会话时被 Kanban 暂存。它们只是补充事件上下文，不是新的用户请求；不要仅因这些通知自行继续生成。",
		...records.flatMap((record, index) => [
			`<deferred-notification index="${index + 1}" source="${record.sourceHarness}">`,
			record.promptText,
			"</deferred-notification>",
		]),
		"</kanban-restoration-deferred-harness-notifications>",
	].join("\n");
}
