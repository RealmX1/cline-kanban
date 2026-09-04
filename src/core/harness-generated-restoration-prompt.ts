import type { RestorationDeferredHarnessGeneratedPrompt } from "../state/restoration-deferred-harness-generated-prompt-store";

const CLAUDE_TASK_NOTIFICATION_PROMPT_PATTERN =
	/^<task-notification>\s*[\s\S]*?<task-id>[^<]+<\/task-id>[\s\S]*?<status>[^<]+<\/status>[\s\S]*?<summary>[\s\S]*?<\/summary>[\s\S]*?<\/task-notification>$/i;
// 非空 tool-use-id 才算「关联得回本活体某次工具调用」；空标签等同缺失。
const CLAUDE_TASK_NOTIFICATION_TOOL_USE_ID_PATTERN = /<tool-use-id>\s*[^<\s][^<]*<\/tool-use-id>/i;
const CLAUDE_TASK_NOTIFICATION_STATUS_PATTERN = /<status>\s*([^<]*?)\s*<\/status>/i;
// 只截第一段 <summary>，刻意不含 <result>：本活体子 agent 的完成通知会把整篇汇报原样塞进 <result>，
// 那段正文完全可能顺口写到「from the previous session」，用整条通知去匹配跨会话标记就会误伤。
const CLAUDE_TASK_NOTIFICATION_SUMMARY_TEXT_PATTERN = /<summary>([\s\S]*?)<\/summary>/i;
// harness 给跨会话遗留孤儿写的明示标记，两种形态都带这一句：
//   子 agent：「No completion record was found for N background agents from the previous session」
//   后台 shell 命令：「No completion record was found for this background shell command from the previous session」
const CLAUDE_TASK_NOTIFICATION_PREVIOUS_SESSION_ORPHAN_MARKER_PATTERN = /from the previous session/i;

// 只认 Claude 自己生成、结构完整的 <task-notification> 包裹；绝不按模糊关键词拦普通用户消息。
export function isClaudeHarnessGeneratedTaskNotificationPrompt(promptText: string | undefined): boolean {
	if (!promptText) {
		return false;
	}
	return CLAUDE_TASK_NOTIFICATION_PROMPT_PATTERN.test(promptText.trim());
}

// 恢复守卫**只**该拦「上一个会话活体遗留下来的孤儿通知」。先用 status 划一刀，再在非 completed 里
// 挑出真正跨了会话活体的那些：
//   1. status=completed 一律放行——本活体自己 dispatch 的子 agent / 后台命令干完了才是这个形态，
//      那是 agent 明确在等的唤醒信号（例如它自己挂的「后台等待两个 attempt 落定」），拦下来等于把它
//      派出去的活儿掐死在半路，这正是收窄前的实际后果；
//   2. 非 completed（实测恒为 stopped）里再分两种：
//      a. 没有 <tool-use-id>——harness 已关联不回本活体的任何一次工具调用，是孤儿；
//      b. **带** <tool-use-id> 但 summary 写着 harness 自己的跨会话标记「from the previous session」——
//         同样是孤儿。后台 shell 命令的遗留通知就是这个形态：它带着上一活体的 tool-use-id 落盘，
//         光看「有没有 tool-use-id」会把它错判成本活体的信号而在恢复窗口直接放行。
// 为什么不干脆只用「status≠completed」一条：那会把本活体内被 TaskStop 掉、或以非 completed 收场的
// 后台工作一并吞掉，而它们仍是 agent 在等的回执。改用 harness 自己写的跨会话标记做析取项，判据的
// 区分度直接来自 harness 的事实声明，不靠我们反推，误伤面也最小。
export function isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(promptText: string | undefined): boolean {
	if (!isClaudeHarnessGeneratedTaskNotificationPrompt(promptText)) {
		return false;
	}
	const notification = (promptText ?? "").trim();
	const status = CLAUDE_TASK_NOTIFICATION_STATUS_PATTERN.exec(notification)?.[1]?.trim().toLowerCase() ?? "";
	if (status === "completed") {
		return false;
	}
	if (!CLAUDE_TASK_NOTIFICATION_TOOL_USE_ID_PATTERN.test(notification)) {
		return true;
	}
	const summaryText = CLAUDE_TASK_NOTIFICATION_SUMMARY_TEXT_PATTERN.exec(notification)?.[1] ?? "";
	return CLAUDE_TASK_NOTIFICATION_PREVIOUS_SESSION_ORPHAN_MARKER_PATTERN.test(summaryText);
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

// 一键放行专用文案。与上面的 additionalContext 版本刻意分开：那一版是「顺带捎给下一条真人 prompt」的
// 补充上下文，措辞必须压住 agent「仅凭通知自行续跑」；而这一版是**用户显式点了放行**，意图恰恰是让
// agent 据此接着干，再说「不要据此继续」就自相矛盾了。
export function formatDeferredHarnessGeneratedPromptsAsExplicitUserReleasedPrompt(
	records: readonly RestorationDeferredHarnessGeneratedPrompt[],
): string | undefined {
	if (records.length === 0) {
		return undefined;
	}
	return [
		"<kanban-user-released-harness-notifications>",
		`以下 ${records.length} 条通知在恢复旧会话时被 Kanban 暂存，现在由用户显式放行。它们是你此前 dispatch 的后台工作的真实回执：请据此继续推进本轮工作。`,
		...records.flatMap((record, index) => [
			`<released-notification index="${index + 1}" source="${record.sourceHarness}">`,
			record.promptText,
			"</released-notification>",
		]),
		"</kanban-user-released-harness-notifications>",
	].join("\n");
}
