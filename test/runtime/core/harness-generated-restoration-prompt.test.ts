import { describe, expect, it } from "vitest";

import {
	isClaudeHarnessGeneratedTaskNotificationPrompt,
	isTaskNotificationOrphanedByPreviousAgentSessionIncarnation,
} from "../../../src/core/harness-generated-restoration-prompt";

// 下面两组样本抄自真实落盘账本（~/.cline/kanban/workspaces/*/restoration-deferred-harness-generated-prompts.json
// 与 2026-08-16 的被拦记录），不是构造出来的：收窄前它们被同一条规则一视同仁地拦下，而它们的语义截然相反。

// 【该拦】上一个会话活体遗留的孤儿：多个 task-id、无 tool-use-id、无 output-file、status=stopped。
const ORPHAN_NOTIFICATION_FROM_PREVIOUS_SESSION = [
	"<task-notification>",
	"<task-id>af3d5269800ca51ca</task-id>",
	"<task-id>a5036ca9fcab9662d</task-id>",
	"<task-id>ac4ee8c0463a17f42</task-id>",
	"<status>stopped</status>",
	'<summary>No completion record was found for 3 background agents from the previous session: "Validate/fix RVF-001"',
	"(af3d5269800ca51ca), ... they may have been running when the previous Claude Code process exited.</summary>",
	"</task-notification>",
].join("\n");

// 【该拦】同一本账本里的单 agent 孤儿：一个 task-id、有 output-file、无 tool-use-id、status=stopped。
const ORPHAN_SUBAGENT_NOTIFICATION_WITH_OUTPUT_FILE_FROM_PREVIOUS_SESSION = [
	"<task-notification>",
	"<task-id>ab7043516fe1a7a93</task-id>",
	"<output-file>/private/tmp/claude-503/tasks/ab7043516fe1a7a93.output</output-file>",
	"<status>stopped</status>",
	'<summary>No completion record was found for background agent "探索决策点横幅带外投递链路" from the previous',
	"session. It may have been stopped, or it may have been running when the previous Claude Code process exited",
	"— either way its transcript is saved on disk, so its progress is not lost.</summary>",
	"</task-notification>",
].join("\n");

// 【该拦】后台 shell 命令形态的跨会话孤儿：**带** tool-use-id、status=stopped，summary 写着 harness 自己的
// 「from the previous session」标记。原判据用「无 tool-use-id 且 status≠completed」的合取，恰好放行了这一条
// —— 真实账本 8 条里 5 条真孤儿只认出 4 条，漏的就是它。样本逐字抄自落盘账本第 8 条。
const ORPHAN_BACKGROUND_SHELL_COMMAND_NOTIFICATION_CARRYING_PREVIOUS_INCARNATION_TOOL_USE_ID = [
	"<task-notification>",
	"<task-id>bmle09xet</task-id>",
	"<tool-use-id>toolu_0129peZuEiMdW5YyAnQTyZps</tool-use-id>",
	"<status>stopped</status>",
	"<summary>No completion record was found for this background shell command from the previous session. It may have",
	"been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have",
	"been running when the previous Claude Code process exited. Check the output file for partial results before",
	"assuming it completed.</summary>",
	"</task-notification>",
].join("\n");

// 【该放】本活体自己 dispatch 的子 agent 完成通知。
const LIVE_SUBAGENT_COMPLETION_NOTIFICATION = [
	"<task-notification>",
	"<task-id>a1d72cfe25022a92d</task-id>",
	"<tool-use-id>toolu_01ERgGWXo4AUPRDKotuhrEHP</tool-use-id>",
	"<output-file>/private/tmp/claude-503/tasks/a1d72cfe25022a92d.output</output-file>",
	"<status>completed</status>",
	'<summary>Agent "验证修复 RVF-002 + RVF-003" finished</summary>',
	"</task-notification>",
].join("\n");

// 【该放】本活体自己挂的后台命令完成通知——收窄前正是这条把 agent 自己的唤醒信号掐死在半路。
const LIVE_BACKGROUND_COMMAND_COMPLETION_NOTIFICATION = [
	"<task-notification>",
	"<task-id>bj4rg1gqu</task-id>",
	"<tool-use-id>toolu_0179FwHJfFwerciyDKEkvRn4</tool-use-id>",
	"<output-file>/private/tmp/claude-503/tasks/bj4rg1gqu.output</output-file>",
	"<status>completed</status>",
	'<summary>Background command "后台等待两个 attempt 落定" completed (exit code 0)</summary>',
	"</task-notification>",
].join("\n");

describe("isTaskNotificationOrphanedByPreviousAgentSessionIncarnation", () => {
	it("拦下上一个会话活体遗留的孤儿通知", () => {
		expect(
			isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(ORPHAN_NOTIFICATION_FROM_PREVIOUS_SESSION),
		).toBe(true);
	});

	it("拦下带 output-file 的单 agent 孤儿通知", () => {
		expect(
			isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(
				ORPHAN_SUBAGENT_NOTIFICATION_WITH_OUTPUT_FILE_FROM_PREVIOUS_SESSION,
			),
		).toBe(true);
	});

	it("拦下带 tool-use-id 的后台 shell 命令孤儿通知：tool-use-id 证明不了它属于本活体", () => {
		expect(
			isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(
				ORPHAN_BACKGROUND_SHELL_COMMAND_NOTIFICATION_CARRYING_PREVIOUS_INCARNATION_TOOL_USE_ID,
			),
		).toBe(true);
	});

	it("放行本活体自己 dispatch 的子 agent 完成通知", () => {
		expect(isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(LIVE_SUBAGENT_COMPLETION_NOTIFICATION)).toBe(
			false,
		);
	});

	it("放行本活体自己挂的后台命令完成通知", () => {
		expect(
			isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(LIVE_BACKGROUND_COMMAND_COMPLETION_NOTIFICATION),
		).toBe(false);
	});

	it("带 tool-use-id 且 summary 没有跨会话标记的非 completed 通知不算孤儿：那是本活体里被停掉的子 agent", () => {
		const stoppedButCorrelatedToThisIncarnation = [
			"<task-notification>",
			"<task-id>a1d72cfe25022a92d</task-id>",
			"<tool-use-id>toolu_01ERgGWXo4AUPRDKotuhrEHP</tool-use-id>",
			"<status>stopped</status>",
			"<summary>Agent stopped by user</summary>",
			"</task-notification>",
		].join("\n");
		expect(isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(stoppedButCorrelatedToThisIncarnation)).toBe(
			false,
		);
	});

	it("跨会话标记只在 <summary> 里算数：<result> 正文引用同一句话不该把本活体的通知误判成孤儿", () => {
		// 本活体子 agent 的通知会把整篇汇报原样塞进 <result>，而这个仓库的汇报本身就在讨论
		// 「from the previous session」这句 harness 措辞——拿整条通知去匹配标记必然误伤。
		const stoppedNotificationQuotingTheMarkerOnlyInsideItsResult = [
			"<task-notification>",
			"<task-id>a5036ca9fcab9662d</task-id>",
			"<tool-use-id>toolu_01V8tzh1Z9TyxwfRRCHi4ZS3</tool-use-id>",
			"<status>stopped</status>",
			"<summary>Agent stopped by user</summary>",
			"<result>本轮把孤儿判据改成认 summary 里的 from the previous session 标记。</result>",
			"</task-notification>",
		].join("\n");
		expect(
			isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(
				stoppedNotificationQuotingTheMarkerOnlyInsideItsResult,
			),
		).toBe(false);
	});

	it("空 tool-use-id 标签等同缺失，仍按孤儿处理", () => {
		const emptyToolUseId = [
			"<task-notification>",
			"<task-id>af3d5269800ca51ca</task-id>",
			"<tool-use-id></tool-use-id>",
			"<status>stopped</status>",
			"<summary>No completion record was found for 1 background agent from the previous session.</summary>",
			"</task-notification>",
		].join("\n");
		expect(isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(emptyToolUseId)).toBe(true);
	});

	it("普通用户消息既不是 harness 通知也不是孤儿", () => {
		const humanPrompt = "帮我看看 <task-notification> 这个标签是干嘛的";
		expect(isClaudeHarnessGeneratedTaskNotificationPrompt(humanPrompt)).toBe(false);
		expect(isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(humanPrompt)).toBe(false);
	});

	it("两类通知都仍被识别为 harness 生成——收窄的是「拦不拦」，不是「算不算真人提交」", () => {
		expect(isClaudeHarnessGeneratedTaskNotificationPrompt(ORPHAN_NOTIFICATION_FROM_PREVIOUS_SESSION)).toBe(true);
		expect(
			isClaudeHarnessGeneratedTaskNotificationPrompt(
				ORPHAN_BACKGROUND_SHELL_COMMAND_NOTIFICATION_CARRYING_PREVIOUS_INCARNATION_TOOL_USE_ID,
			),
		).toBe(true);
		expect(isClaudeHarnessGeneratedTaskNotificationPrompt(LIVE_SUBAGENT_COMPLETION_NOTIFICATION)).toBe(true);
		expect(isClaudeHarnessGeneratedTaskNotificationPrompt(LIVE_BACKGROUND_COMMAND_COMPLETION_NOTIFICATION)).toBe(
			true,
		);
	});
});
