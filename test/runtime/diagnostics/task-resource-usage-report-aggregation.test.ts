import { describe, expect, it } from "vitest";

import { parseDiagnosticEventJournalRecordsFromJsonlText } from "../../../src/diagnostics/diagnostic-event-journal-record-reader";
import {
	aggregateTaskResourceUsageReport,
	type TaskResourceUsageReportInput,
} from "../../../src/diagnostics/task-resource-usage-report-aggregation";
import { renderTaskResourceUsageReportAsText } from "../../../src/diagnostics/task-resource-usage-report-text-rendering";

const GENERATED_AT = Date.parse("2026-09-30T12:00:00.000Z");

function snapshot(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		recordedAtIso: "2026-09-30T10:05:00.000Z",
		workspaceId: "repo",
		attributedTaskCardId: "ab12c",
		sessionTaskId: "ab12c",
		attributionRootProcessId: 100,
		snapshotWindowEndedAtIso: "2026-09-30T10:05:00.000Z",
		residentSetSizeKibibytesSumUpperBound: 1_000_000,
		residentSetSizeKibibytesSumUpperBoundByProcessClassification: { agent_harness_root_process: 300_000 },
		cpuTimeSecondsConsumedInSnapshotWindow: 10,
		cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification: { agent_harness_root_process: 10 },
		agentHarnessRootPhysicalFootprintBytes: null,
		mcpServerInstances: [],
		...overrides,
	};
}

function emptyInput(overrides: Partial<TaskResourceUsageReportInput>): TaskResourceUsageReportInput {
	return {
		processLifetimeEpisodeRecords: [],
		periodicResourceSnapshotRecords: [],
		toolCallExecutionOutcomeRecords: [],
		hookCliInvocationResourceUsageRecords: [],
		kanbanRuntimeProcessSelfResourceSampleRecords: [],
		modelTokenUsageCumulativeSnapshotRecords: [],
		worktreeDiskUsageMeasurementRecords: [],
		filter: { attributedTaskCardId: null, workspaceId: null },
		reportWindowStartedAtEpochMs: null,
		reportGeneratedAtEpochMs: GENERATED_AT,
		...overrides,
	};
}

describe("aggregateTaskResourceUsageReport", () => {
	it("adds up a task's concurrent sessions at each snapshot time before taking the peak", () => {
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				periodicResourceSnapshotRecords: [
					snapshot({ residentSetSizeKibibytesSumUpperBound: 800_000 }),
					// 同一时刻的 by-the-way 会话（另一个根进程）。
					snapshot({
						sessionTaskId: "btw-1",
						attributionRootProcessId: 200,
						residentSetSizeKibibytesSumUpperBound: 400_000,
					}),
					snapshot({
						snapshotWindowEndedAtIso: "2026-09-30T10:10:00.000Z",
						residentSetSizeKibibytesSumUpperBound: 600_000,
						agentHarnessRootPhysicalFootprintBytes: 2_000_000_000,
					}),
				],
			}),
		);

		expect(report.perTaskReports).toHaveLength(1);
		expect(report.perTaskReports[0]).toMatchObject({
			attributedTaskCardId: "ab12c",
			periodicSnapshotCount: 3,
			peakProcessTreeResidentSetSizeKibibytesSumUpperBound: 1_200_000,
			averageProcessTreeResidentSetSizeKibibytesSumUpperBound: 900_000,
			cpuTimeSecondsConsumedInWindow: 30,
			peakAgentHarnessRootPhysicalFootprintBytes: 2_000_000_000,
		});
	});

	it("adds up concurrent sessions per process classification and per MCP before taking their peaks", () => {
		const concurrentSessionSnapshot = (overrides: Record<string, unknown>) =>
			snapshot({
				residentSetSizeKibibytesSumUpperBound: 300_000,
				residentSetSizeKibibytesSumUpperBoundByProcessClassification: { mcp_server_process: 300_000 },
				mcpServerInstances: [
					{ mcpServerInstanceLabel: "serena", processCount: 2, residentSetSizeKibibytesSum: 300_000 },
				],
				...overrides,
			});
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				periodicResourceSnapshotRecords: [
					// 同一 tick 里同一 task 的两个会话，各自带一份 300 MiB 量级的 serena。
					concurrentSessionSnapshot({}),
					concurrentSessionSnapshot({ sessionTaskId: "btw-1", attributionRootProcessId: 200 }),
					// 下一个 tick 只剩一个会话，但单会话值更大：峰值仍应是上一 tick 的两会话之和。
					concurrentSessionSnapshot({
						snapshotWindowEndedAtIso: "2026-09-30T10:10:00.000Z",
						residentSetSizeKibibytesSumUpperBound: 500_000,
						residentSetSizeKibibytesSumUpperBoundByProcessClassification: { mcp_server_process: 500_000 },
						mcpServerInstances: [
							{ mcpServerInstanceLabel: "serena", processCount: 2, residentSetSizeKibibytesSum: 500_000 },
						],
					}),
				],
			}),
		);

		const [taskReport] = report.perTaskReports;
		expect(taskReport?.peakProcessTreeResidentSetSizeKibibytesSumUpperBound).toBe(600_000);
		expect(taskReport?.peakResidentSetSizeKibibytesSumUpperBoundByProcessClassification).toEqual({
			mcp_server_process: 600_000,
		});
		expect(taskReport?.mcpServerInstances).toEqual([
			{ mcpServerInstanceLabel: "serena", peakResidentSetSizeKibibytesSum: 600_000 },
		]);
	});

	it("ranks each MCP by its resident cost across sessions", () => {
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				periodicResourceSnapshotRecords: [
					snapshot({
						mcpServerInstances: [
							{ mcpServerInstanceLabel: "serena", processCount: 3, residentSetSizeKibibytesSum: 150_000 },
						],
					}),
					snapshot({
						attributedTaskCardId: "cd34e",
						sessionTaskId: "cd34e",
						attributionRootProcessId: 300,
						mcpServerInstances: [
							{ mcpServerInstanceLabel: "serena", processCount: 3, residentSetSizeKibibytesSum: 250_000 },
						],
					}),
				],
			}),
		);

		expect(report.mcpServerInstanceResidentCostAcrossTasks).toEqual([
			{
				mcpServerInstanceLabel: "serena",
				observedSessionCount: 2,
				averageResidentSetSizeKibibytesPerInstance: 200_000,
				peakResidentSetSizeKibibytesPerInstance: 250_000,
			},
		]);
	});

	it("lists the heaviest processes and the ones that outlived their session root", () => {
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				processLifetimeEpisodeRecords: [
					{
						workspaceId: "repo",
						attributedTaskCardId: "ab12c",
						processClassification: "agent_shell_tool_command_process",
						commandLineTextForJournal: "npx vitest run",
						peakObservedResidentSetSizeKibibytes: 2_000_000,
						cpuTimeSecondsConsumedWhileObserved: 90,
						survivedAttributionRootProcessExit: false,
					},
					{
						workspaceId: "repo",
						attributedTaskCardId: "ab12c",
						processClassification: "agent_shell_tool_command_process",
						commandLineTextForJournal: "npm run dev",
						peakObservedResidentSetSizeKibibytes: 300_000,
						cpuTimeSecondsConsumedWhileObserved: 5,
						survivedAttributionRootProcessExit: true,
					},
				],
			}),
		);

		const [taskReport] = report.perTaskReports;
		expect(taskReport?.mostMemoryIntensiveProcesses.map((entry) => entry.commandLineTextForJournal)).toEqual([
			"npx vitest run",
			"npm run dev",
		]);
		expect(taskReport?.processesThatSurvivedTheirSessionRoot.map((entry) => entry.commandLineTextForJournal)).toEqual(
			["npm run dev"],
		);
	});

	it("counts each tool call once even if a hook was redelivered, and folds Cline SDK records into the known workspace", () => {
		const hookRecord = {
			workspaceId: "repo",
			attributedTaskCardId: "ab12c",
			sessionTaskId: "ab12c",
			toolCallLifecyclePhase: "tool_call_succeeded",
			toolName: "Bash",
			toolUseId: "toolu_01",
			toolExecutionDurationMs: 60_000,
			commandLineTextForJournal: "npm run build",
		};
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				periodicResourceSnapshotRecords: [snapshot({})],
				toolCallExecutionOutcomeRecords: [
					hookRecord,
					hookRecord,
					{ ...hookRecord, toolCallLifecyclePhase: "tool_call_started", toolExecutionDurationMs: null },
					{
						workspaceId: null,
						attributedTaskCardId: "ab12c",
						sessionTaskId: "ab12c",
						toolCallLifecyclePhase: "tool_call_failed",
						toolName: "run_commands",
						toolUseId: "call-9",
						toolExecutionDurationMs: 2_000,
					},
				],
			}),
		);

		expect(report.perTaskReports).toHaveLength(1);
		expect(report.perTaskReports[0]).toMatchObject({
			completedToolCallCount: 1,
			failedToolCallCount: 1,
			totalToolExecutionDurationMs: 62_000,
		});
		expect(report.perTaskReports[0]?.slowestToolCalls[0]?.commandLineTextForJournal).toBe("npm run build");
	});

	it("filters by task id and keeps the unfiltered Kanban baseline", () => {
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				periodicResourceSnapshotRecords: [
					snapshot({}),
					snapshot({ attributedTaskCardId: "other", sessionTaskId: "other" }),
				],
				kanbanRuntimeProcessSelfResourceSampleRecords: [
					{
						residentSetSizeBytes: 700_000_000,
						heapUsedBytes: 100_000_000,
						cpuTimeSecondsConsumedSincePreviousSample: null,
					},
					{
						residentSetSizeBytes: 900_000_000,
						heapUsedBytes: 150_000_000,
						cpuTimeSecondsConsumedSincePreviousSample: 12,
					},
				],
				filter: { attributedTaskCardId: "ab12c", workspaceId: null },
			}),
		);

		expect(report.perTaskReports.map((entry) => entry.attributedTaskCardId)).toEqual(["ab12c"]);
		expect(report.kanbanRuntimeProcessBaseline).toEqual({
			sampleCount: 2,
			latestResidentSetSizeBytes: 900_000_000,
			peakResidentSetSizeBytes: 900_000_000,
			latestHeapUsedBytes: 150_000_000,
			cpuTimeSecondsConsumedInWindow: 12,
		});
	});

	it("keeps an explicit workspace query isolated from records whose workspace is unknown", () => {
		// 两个看板恰好有同一个卡片 id：repo-a 的卡片走 hook，repo-b 的同名卡片走 Cline SDK（workspaceId=null）。
		const recordsFromTwoBoardsSharingOneCardId = emptyInput({
			periodicResourceSnapshotRecords: [snapshot({ workspaceId: "repo-a" })],
			toolCallExecutionOutcomeRecords: [
				{
					workspaceId: "repo-a",
					attributedTaskCardId: "ab12c",
					sessionTaskId: "ab12c",
					toolCallLifecyclePhase: "tool_call_succeeded",
					toolName: "Bash",
					toolUseId: "toolu_a",
					toolExecutionDurationMs: 1_000,
				},
				{
					workspaceId: null,
					sessionWorkspacePath: "/worktrees/repo-b/ab12c",
					attributedTaskCardId: "ab12c",
					sessionTaskId: "ab12c",
					toolCallLifecyclePhase: "tool_call_failed",
					toolName: "run_commands",
					toolUseId: "call-b",
					toolExecutionDurationMs: 2_000,
				},
			],
			modelTokenUsageCumulativeSnapshotRecords: [
				{
					workspaceId: null,
					attributedTaskCardId: "ab12c",
					sessionTaskId: "ab12c",
					modelTokenUsageSource: "cline_sdk_usage_event",
					nativeSessionId: "cline-b",
					cumulativeOutputTokens: 500,
					modelIds: ["cline-model"],
				},
			],
		});

		const workspaceFilteredReport = aggregateTaskResourceUsageReport({
			...recordsFromTwoBoardsSharingOneCardId,
			filter: { attributedTaskCardId: null, workspaceId: "repo-a" },
		});
		expect(workspaceFilteredReport.perTaskReports).toHaveLength(1);
		expect(workspaceFilteredReport.perTaskReports[0]).toMatchObject({
			workspaceId: "repo-a",
			completedToolCallCount: 1,
			failedToolCallCount: 0,
			totalToolExecutionDurationMs: 1_000,
			modelTokenUsage: null,
		});

		// 不按 workspace 过滤时，归属未知的记录照常展示。
		const unfilteredReport = aggregateTaskResourceUsageReport(recordsFromTwoBoardsSharingOneCardId);
		expect(unfilteredReport.perTaskReports.reduce((sum, entry) => sum + entry.failedToolCallCount, 0)).toBe(1);
		expect(
			unfilteredReport.perTaskReports.some((entry) => entry.modelTokenUsage?.cumulativeOutputTokens === 500),
		).toBe(true);
	});

	it("sums the latest cumulative token snapshot of each session and keeps the newest disk measurement", () => {
		const tokenRecord = (
			nativeSessionId: string,
			cumulativeOutputTokens: number,
			extra: Record<string, unknown> = {},
		) => ({
			workspaceId: "repo",
			attributedTaskCardId: "ab12c",
			sessionTaskId: "ab12c",
			modelTokenUsageSource: "claude_code_transcript",
			nativeSessionId,
			cumulativeInputTokens: 10,
			cumulativeCacheCreationInputTokens: 100,
			cumulativeCacheReadInputTokens: 1_000,
			cumulativeOutputTokens,
			harnessReportedCumulativeCostUsd: null,
			modelIds: ["claude-opus-5-5"],
			...extra,
		});
		const report = aggregateTaskResourceUsageReport(
			emptyInput({
				modelTokenUsageCumulativeSnapshotRecords: [
					tokenRecord("s1", 100),
					// 同一会话更晚的累计值：取它，不与上一条相加。
					tokenRecord("s1", 250),
					tokenRecord("s2", 50, {
						modelTokenUsageSource: "cline_sdk_usage_event",
						workspaceId: null,
						harnessReportedCumulativeCostUsd: 1.5,
						modelIds: ["cline-model"],
					}),
				],
				worktreeDiskUsageMeasurementRecords: [
					{
						recordedAtIso: "2026-09-29T00:00:00.000Z",
						workspaceId: "repo",
						attributedTaskCardId: "ab12c",
						worktreeTotalBytes: 1_000,
						largestTopLevelEntries: [],
					},
					{
						recordedAtIso: "2026-09-30T00:00:00.000Z",
						workspaceId: "repo",
						attributedTaskCardId: "ab12c",
						worktreeTotalBytes: 3_000_000_000,
						largestTopLevelEntries: [{ entryName: "dist", totalBytes: 2_000_000_000 }],
						measurementWasCutShortByTimeBudget: false,
					},
				],
			}),
		);

		expect(report.perTaskReports).toHaveLength(1);
		expect(report.perTaskReports[0]?.modelTokenUsage).toEqual({
			sessionCount: 2,
			cumulativeInputTokens: 20,
			cumulativeCacheCreationInputTokens: 200,
			cumulativeCacheReadInputTokens: 2_000,
			cumulativeOutputTokens: 300,
			harnessReportedCumulativeCostUsd: 1.5,
			modelIds: ["claude-opus-5-5", "cline-model"],
		});
		expect(report.perTaskReports[0]?.latestWorktreeDiskUsage).toMatchObject({
			worktreeTotalBytes: 3_000_000_000,
			largestTopLevelEntries: [{ entryName: "dist", totalBytes: 2_000_000_000 }],
		});
		expect(renderTaskResourceUsageReportAsText(report)).toContain("worktree 磁盘：2.79 GiB");
	});

	it("renders a readable report that always carries the measurement caveats", () => {
		const text = renderTaskResourceUsageReportAsText(
			aggregateTaskResourceUsageReport(emptyInput({ periodicResourceSnapshotRecords: [snapshot({})] })),
		);

		expect(text).toContain("RSS 求和是上界");
		expect(text).toContain("## task ab12c @ repo");
		expect(text).toContain("峰值 977 MiB");
	});
});

describe("parseDiagnosticEventJournalRecordsFromJsonlText", () => {
	it("keeps only records inside the window and skips a half-written tail line", () => {
		const records = parseDiagnosticEventJournalRecordsFromJsonlText(
			[
				JSON.stringify({ recordedAtIso: "2026-09-30T09:00:00.000Z", n: 1 }),
				JSON.stringify({ recordedAtIso: "2026-09-30T11:00:00.000Z", n: 2 }),
				'{"recordedAtIso":"2026-09-30T11:30',
			].join("\n"),
			Date.parse("2026-09-30T10:00:00.000Z"),
		);

		expect(records.map((record) => record.n)).toEqual([2]);
	});
});
