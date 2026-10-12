// 模型 token 用量「累计快照」→ journal 的唯一写点（按 task 归因的资源占用采集，S5）。
//
// 每条记录表示「截至此刻，这个原生会话的累计用量」，而不是增量：报告对每个会话只取最后一条，
// 所以 Kanban 重启后重扫、同一数值重复写都不会重复计数。四种来源写同一条通道：
//   - claude_code_transcript / codex_rollout：由 token 用量监视器读原生会话记录；
//   - cline_sdk_usage_event：进程内 Cline SDK 的 usage-updated 事件（带 harness 自报的累计 cost）；
//   - acp_usage_update：ACP 的 usage_update（上下文占用 + harness 自报的累计 cost）。
// cost 只记 harness 自报的值：不内置价格表（上游定价会漂移，固化进常量就是错的）。

import type { AgentConversationModelTokenUsageTotals } from "../agent-session-history/agent-conversation-model-token-usage-incremental-reader";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
	type DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";

export type TaskAgentConversationModelTokenUsageSource =
	| "claude_code_transcript"
	| "codex_rollout"
	| "cline_sdk_usage_event"
	| "acp_usage_update";

export interface TaskAgentConversationModelTokenUsageCumulativeSnapshot {
	workspaceId: string | null;
	attributedTaskCardId: string | null;
	sessionTaskId: string;
	agentId: string | null;
	modelTokenUsageSource: TaskAgentConversationModelTokenUsageSource;
	nativeSessionId: string | null;
	totals: Partial<AgentConversationModelTokenUsageTotals>;
	harnessReportedCumulativeCostUsd: number | null;
	contextWindowUsedTokens: number | null;
	subagentTranscriptCount: number | null;
}

export function recordTaskAgentConversationModelTokenUsageCumulativeSnapshotToJournal(
	snapshot: TaskAgentConversationModelTokenUsageCumulativeSnapshot,
	appendJournalEvent: (
		channel: DiagnosticEventJournalChannel,
		payload: DiagnosticEventJournalPayload,
	) => void = appendDiagnosticEventToRotatingJsonlJournal,
): void {
	const { totals } = snapshot;
	appendJournalEvent("task-agent-conversation-model-token-usage-cumulative-snapshot", {
		workspaceId: snapshot.workspaceId,
		attributedTaskCardId: snapshot.attributedTaskCardId,
		sessionTaskId: snapshot.sessionTaskId,
		agentId: snapshot.agentId,
		modelTokenUsageSource: snapshot.modelTokenUsageSource,
		nativeSessionId: snapshot.nativeSessionId,
		cumulativeInputTokens: totals.cumulativeInputTokens ?? null,
		cumulativeCacheCreationInputTokens: totals.cumulativeCacheCreationInputTokens ?? null,
		cumulativeCacheReadInputTokens: totals.cumulativeCacheReadInputTokens ?? null,
		cumulativeOutputTokens: totals.cumulativeOutputTokens ?? null,
		cumulativeReasoningOutputTokens: totals.cumulativeReasoningOutputTokens ?? null,
		modelIds: totals.modelIds ?? [],
		assistantMessageCount: totals.assistantMessageCount ?? null,
		codexRateLimitPrimaryUsedPercent: totals.codexRateLimitPrimaryUsedPercent ?? null,
		contextWindowSizeTokens: totals.contextWindowSizeTokens ?? null,
		// 读原生会话记录时因单行超长而整行跳过的行数（> 0 ⇒ 本条累计值是下界）；其余来源为 null。
		transcriptLinesSkippedForExceedingIncrementalReadBudgetCount:
			totals.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount ?? null,
		contextWindowUsedTokens: snapshot.contextWindowUsedTokens,
		harnessReportedCumulativeCostUsd: snapshot.harnessReportedCumulativeCostUsd,
		subagentTranscriptCount: snapshot.subagentTranscriptCount,
	});
}
