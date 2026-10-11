// hook ingest 携带的资源占用字段 → journal（运行时进程写；hooks CLI 自己绝不写 journal：journal 的写入
// 状态与轮转都是进程内的，几十个并发 CLI 各自轮转会互相踩掉分片，写入方 pid 也会变成 CLI 的 pid）。

import type { RuntimeHookIngestRequest, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionCategoryAndAttributedTaskCardId } from "../server/task-resource-usage-attribution-root-enumeration";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
	type DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";

export function recordHookIngestToolCallAndHookCliResourceUsageToJournal(input: {
	body: RuntimeHookIngestRequest;
	// hook 指向的会话在运行时里找不到（陈旧 hook）时为 null：仍然记录，卡片 id 退回用会话 id 本身。
	summary: RuntimeTaskSessionSummary | null;
	appendJournalEvent?: (channel: DiagnosticEventJournalChannel, payload: DiagnosticEventJournalPayload) => void;
}): void {
	const { body, summary } = input;
	if (!body.agentToolCallExecutionOutcome && !body.hookCliProcessResourceUsage) {
		return;
	}
	const appendJournalEvent = input.appendJournalEvent ?? appendDiagnosticEventToRotatingJsonlJournal;
	const { sessionCategory, attributedTaskCardId } = resolveSessionCategoryAndAttributedTaskCardId(
		summary ?? { taskId: body.taskId },
	);
	const attributionFields = {
		workspaceId: body.workspaceId,
		attributedTaskCardId,
		sessionTaskId: body.taskId,
		sessionCategory,
		agentId: summary?.agentId ?? null,
		runtimeSessionIncarnationId: summary?.runtimeSessionIncarnationId ?? null,
		hookSource: body.metadata?.source ?? null,
		hookEventName: body.metadata?.hookEventName ?? null,
	};
	if (body.agentToolCallExecutionOutcome) {
		appendJournalEvent("agent-tool-call-execution-outcome", {
			...attributionFields,
			agentToolCallExecutionOutcomeSource: "agent_hook_ingest",
			...body.agentToolCallExecutionOutcome,
		});
	}
	if (body.hookCliProcessResourceUsage) {
		appendJournalEvent("kanban-hook-cli-invocation-resource-usage", {
			...attributionFields,
			hookEvent: body.event,
			toolName: body.metadata?.toolName ?? null,
			...body.hookCliProcessResourceUsage,
		});
	}
}
