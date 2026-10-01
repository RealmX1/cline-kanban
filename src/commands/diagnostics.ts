// `kanban diagnostics …`：只读地汇总本机诊断 journal。直接读 ~/.cline/kanban/diagnostic-event-journals，
// 不依赖运行时在线（运行时挂了、或者想事后复盘时同样可用）。

import type { Command } from "commander";
import { readDiagnosticEventJournalRecords } from "../diagnostics/diagnostic-event-journal-record-reader";
import {
	aggregateTaskResourceUsageReport,
	type TaskResourceUsageReport,
	type TaskResourceUsageReportFilter,
} from "../diagnostics/task-resource-usage-report-aggregation";
import { renderTaskResourceUsageReportAsText } from "../diagnostics/task-resource-usage-report-text-rendering";

const REPORT_WINDOW_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

// "30m" / "24h" / "7d" → 毫秒；认不出返回 null。
export function parseReportWindowDurationTextToMs(durationText: string): number | null {
	const match = /^(\d+(?:\.\d+)?)([mhd])$/.exec(durationText.trim());
	if (!match) {
		return null;
	}
	const unitMs = REPORT_WINDOW_DURATION_UNIT_MS[match[2] ?? ""];
	return unitMs === undefined ? null : Math.round(Number.parseFloat(match[1] ?? "0") * unitMs);
}

export function buildTaskResourceUsageReportFromDiagnosticJournals(input: {
	filter: TaskResourceUsageReportFilter;
	reportWindowStartedAtEpochMs: number | null;
	reportGeneratedAtEpochMs: number;
}): TaskResourceUsageReport {
	const since = input.reportWindowStartedAtEpochMs;
	return aggregateTaskResourceUsageReport({
		processLifetimeEpisodeRecords: readDiagnosticEventJournalRecords(
			"task-attributed-process-lifetime-episode",
			since,
		),
		periodicResourceSnapshotRecords: readDiagnosticEventJournalRecords(
			"task-attributed-process-tree-periodic-resource-snapshot",
			since,
		),
		toolCallExecutionOutcomeRecords: readDiagnosticEventJournalRecords("agent-tool-call-execution-outcome", since),
		hookCliInvocationResourceUsageRecords: readDiagnosticEventJournalRecords(
			"kanban-hook-cli-invocation-resource-usage",
			since,
		),
		kanbanRuntimeProcessSelfResourceSampleRecords: readDiagnosticEventJournalRecords(
			"kanban-runtime-process-self-resource-sample",
			since,
		),
		// token 是会话累计值、磁盘是最近一次测量：两者都不按时间窗截断，否则窗口外开始的会话会整个消失。
		modelTokenUsageCumulativeSnapshotRecords: readDiagnosticEventJournalRecords(
			"task-agent-conversation-model-token-usage-cumulative-snapshot",
			null,
		),
		worktreeDiskUsageMeasurementRecords: readDiagnosticEventJournalRecords(
			"task-worktree-disk-usage-measurement",
			null,
		),
		filter: input.filter,
		reportWindowStartedAtEpochMs: since,
		reportGeneratedAtEpochMs: input.reportGeneratedAtEpochMs,
	});
}

export function registerDiagnosticsCommand(program: Command): void {
	const diagnostics = program
		.command("diagnostics")
		.description("Read Kanban's local diagnostic journals (read-only; works without the runtime running).");

	diagnostics
		.command("task-resource-usage-report")
		.description(
			"Summarize per-task resource usage: agent harness / MCP / command process memory and CPU, orphaned processes, tool call durations, and Kanban hook overhead.",
		)
		.option("--task-id <id>", "Only include this task card (or session) id.")
		.option("--workspace-id <id>", "Only include this workspace (project) id.")
		.option("--since <duration>", "Time window such as 30m, 24h or 7d. Defaults to everything the journals retain.")
		.option("--json", "Print the report as JSON (for agents and scripts).")
		.action((options: { taskId?: string; workspaceId?: string; since?: string; json?: boolean }) => {
			const nowEpochMs = Date.now();
			let reportWindowStartedAtEpochMs: number | null = null;
			if (options.since !== undefined) {
				const windowMs = parseReportWindowDurationTextToMs(options.since);
				if (windowMs === null) {
					process.stderr.write(`Invalid --since "${options.since}". Use a duration such as 30m, 24h or 7d.\n`);
					process.exitCode = 1;
					return;
				}
				reportWindowStartedAtEpochMs = nowEpochMs - windowMs;
			}
			const report = buildTaskResourceUsageReportFromDiagnosticJournals({
				filter: { attributedTaskCardId: options.taskId ?? null, workspaceId: options.workspaceId ?? null },
				reportWindowStartedAtEpochMs,
				reportGeneratedAtEpochMs: nowEpochMs,
			});
			process.stdout.write(
				options.json ? `${JSON.stringify(report, null, 2)}\n` : renderTaskResourceUsageReportAsText(report),
			);
		});
}
