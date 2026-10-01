// `kanban diagnostics task-resource-usage-report` 的聚合（纯函数）：把各资源占用 journal 通道的记录
// 汇成「按 task」与「跨 task」两层结论。只读输入、不碰文件系统，便于用夹具测。

import type { DiagnosticEventJournalRecord } from "./diagnostic-event-journal-record-reader";

const TOP_ENTRY_COUNT = 5;

export const TASK_RESOURCE_USAGE_REPORT_MEASUREMENT_CAVEATS: readonly string[] = [
	"RSS 求和是上界：多个进程共享的页被重复计数；macOS 的 RSS 不含被压缩 / 换出的页，长寿进程会偏低。整机真实代价以 footprint 为准（harness 根进程每 10 分钟采一次）。",
	"进程峰值只覆盖寿命不短于采样周期（15 秒）的进程；更短命令的开销只体现在工具调用耗时里。",
	"进程内 Cline SDK 会话与 Kanban 同进程，其内存 / CPU 无法按 task 拆分，只能看 Kanban 运行时基线。",
	"模型 token 是各会话从开始至今的累计值，不按报告时间窗切分；cost 只列 harness 自报的值（Cline SDK / ACP），Claude Code 与 Codex 不自报 cost。",
	"worktree 磁盘体积不跟随符号链接（node_modules 等软链不计入），是最近一次测量值。",
	"带 --workspace-id 时，workspace 归属未知的记录（Cline SDK / ACP 的工具调用与 token 等）不计入；不按 workspace 过滤时它们照常按卡片展示。",
];

export interface TaskResourceUsageReportFilter {
	attributedTaskCardId: string | null;
	workspaceId: string | null;
}

export interface TaskResourceUsageReportInput {
	processLifetimeEpisodeRecords: readonly DiagnosticEventJournalRecord[];
	periodicResourceSnapshotRecords: readonly DiagnosticEventJournalRecord[];
	toolCallExecutionOutcomeRecords: readonly DiagnosticEventJournalRecord[];
	hookCliInvocationResourceUsageRecords: readonly DiagnosticEventJournalRecord[];
	kanbanRuntimeProcessSelfResourceSampleRecords: readonly DiagnosticEventJournalRecord[];
	modelTokenUsageCumulativeSnapshotRecords: readonly DiagnosticEventJournalRecord[];
	worktreeDiskUsageMeasurementRecords: readonly DiagnosticEventJournalRecord[];
	filter: TaskResourceUsageReportFilter;
	reportWindowStartedAtEpochMs: number | null;
	reportGeneratedAtEpochMs: number;
}

export interface ProcessLifetimeEpisodeReportEntry {
	processClassification: string | null;
	mcpServerInstanceLabel: string | null;
	commandLineTextForJournal: string | null;
	peakObservedResidentSetSizeKibibytes: number;
	cpuTimeSecondsConsumedWhileObserved: number;
	processLifetimeMsAtLastObservation: number | null;
	lastObservedAtIso: string | null;
	processLifetimeEndedBy: string | null;
}

export interface ToolCallReportEntry {
	toolName: string;
	commandLineTextForJournal: string | null;
	toolExecutionDurationMs: number;
	recordedAtIso: string | null;
}

export interface PerTaskResourceUsageReport {
	workspaceId: string | null;
	// null = workspace 级（home agent、首页终端）。
	attributedTaskCardId: string | null;
	periodicSnapshotCount: number;
	peakProcessTreeResidentSetSizeKibibytesSumUpperBound: number | null;
	averageProcessTreeResidentSetSizeKibibytesSumUpperBound: number | null;
	cpuTimeSecondsConsumedInWindow: number;
	peakAgentHarnessRootPhysicalFootprintBytes: number | null;
	peakResidentSetSizeKibibytesSumUpperBoundByProcessClassification: Record<string, number>;
	cpuTimeSecondsConsumedByProcessClassification: Record<string, number>;
	mcpServerInstances: Array<{ mcpServerInstanceLabel: string; peakResidentSetSizeKibibytesSum: number }>;
	mostMemoryIntensiveProcesses: ProcessLifetimeEpisodeReportEntry[];
	mostCpuIntensiveProcesses: ProcessLifetimeEpisodeReportEntry[];
	processesThatSurvivedTheirSessionRoot: ProcessLifetimeEpisodeReportEntry[];
	completedToolCallCount: number;
	failedToolCallCount: number;
	interruptedToolCallCount: number;
	totalToolExecutionDurationMs: number;
	toolCallsByToolName: Array<{ toolName: string; callCount: number; totalDurationMs: number; maxDurationMs: number }>;
	slowestToolCalls: ToolCallReportEntry[];
	hookCliInvocationCount: number;
	modelTokenUsage: TaskModelTokenUsageReport | null;
	latestWorktreeDiskUsage: {
		measuredAtIso: string | null;
		worktreeTotalBytes: number;
		largestTopLevelEntries: Array<{ entryName: string; totalBytes: number }>;
		measurementWasCutShortByTimeBudget: boolean;
	} | null;
}

export interface TaskModelTokenUsageReport {
	sessionCount: number;
	cumulativeInputTokens: number;
	cumulativeCacheCreationInputTokens: number;
	cumulativeCacheReadInputTokens: number;
	cumulativeOutputTokens: number;
	harnessReportedCumulativeCostUsd: number | null;
	modelIds: string[];
}

export interface TaskResourceUsageReport {
	reportWindowStartedAtIso: string | null;
	reportGeneratedAtIso: string;
	measurementCaveats: readonly string[];
	perTaskReports: PerTaskResourceUsageReport[];
	mcpServerInstanceResidentCostAcrossTasks: Array<{
		mcpServerInstanceLabel: string;
		observedSessionCount: number;
		averageResidentSetSizeKibibytesPerInstance: number;
		peakResidentSetSizeKibibytesPerInstance: number;
	}>;
	hookCliInvocationOverhead: {
		invocationCount: number;
		averageLifetimeMaximumResidentSetSizeKibibytes: number;
		averageHookCliProcessUptimeMs: number;
		p95HookCliProcessUptimeMs: number;
		retriedInvocationCount: number;
	} | null;
	kanbanRuntimeProcessBaseline: {
		sampleCount: number;
		latestResidentSetSizeBytes: number | null;
		peakResidentSetSizeBytes: number | null;
		latestHeapUsedBytes: number | null;
		cpuTimeSecondsConsumedInWindow: number;
	} | null;
}

function readString(record: DiagnosticEventJournalRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function readNumber(record: DiagnosticEventJournalRecord, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberRecord(record: DiagnosticEventJournalRecord, key: string): Record<string, number> {
	const value = record[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const numbers: Record<string, number> = {};
	for (const [entryKey, entryValue] of Object.entries(value)) {
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			numbers[entryKey] = entryValue;
		}
	}
	return numbers;
}

function percentile(sortedValues: readonly number[], fraction: number): number {
	if (sortedValues.length === 0) {
		return 0;
	}
	const index = Math.min(sortedValues.length - 1, Math.ceil(fraction * sortedValues.length) - 1);
	return sortedValues[Math.max(0, index)] ?? 0;
}

function recordMatchesFilter(record: DiagnosticEventJournalRecord, filter: TaskResourceUsageReportFilter): boolean {
	// 显式 workspace 查询必须隔离：workspaceId=null 的记录（Cline SDK / ACP 写入时拿不到 workspaceId、env 也
	// 找不回 workspace 的孤儿进程）可能来自任何 workspace——不同看板可以有同一个卡片 id，按卡片 id 也认不回来；
	// token 记录不带任何路径线索，工具调用的 sessionWorkspacePath 在这里也没有可靠的「路径 → workspaceId」映射，
	// 所以不补全，直接不参与显式 workspace 查询。不过滤 workspace 时它们照常按卡片展示。
	if (filter.workspaceId !== null && readString(record, "workspaceId") !== filter.workspaceId) {
		return false;
	}
	if (filter.attributedTaskCardId !== null) {
		return (
			readString(record, "attributedTaskCardId") === filter.attributedTaskCardId ||
			readString(record, "sessionTaskId") === filter.attributedTaskCardId
		);
	}
	return true;
}

function toEpisodeReportEntry(record: DiagnosticEventJournalRecord): ProcessLifetimeEpisodeReportEntry {
	return {
		processClassification: readString(record, "processClassification"),
		mcpServerInstanceLabel: readString(record, "mcpServerInstanceLabel"),
		commandLineTextForJournal: readString(record, "commandLineTextForJournal"),
		peakObservedResidentSetSizeKibibytes: readNumber(record, "peakObservedResidentSetSizeKibibytes") ?? 0,
		cpuTimeSecondsConsumedWhileObserved: readNumber(record, "cpuTimeSecondsConsumedWhileObserved") ?? 0,
		processLifetimeMsAtLastObservation: readNumber(record, "processLifetimeMsAtLastObservation"),
		lastObservedAtIso: readString(record, "lastObservedAtIso"),
		processLifetimeEndedBy: readString(record, "processLifetimeEndedBy"),
	};
}

function createEmptyPerTaskReport(
	workspaceId: string | null,
	attributedTaskCardId: string | null,
): PerTaskResourceUsageReport {
	return {
		workspaceId,
		attributedTaskCardId,
		periodicSnapshotCount: 0,
		peakProcessTreeResidentSetSizeKibibytesSumUpperBound: null,
		averageProcessTreeResidentSetSizeKibibytesSumUpperBound: null,
		cpuTimeSecondsConsumedInWindow: 0,
		peakAgentHarnessRootPhysicalFootprintBytes: null,
		peakResidentSetSizeKibibytesSumUpperBoundByProcessClassification: {},
		cpuTimeSecondsConsumedByProcessClassification: {},
		mcpServerInstances: [],
		mostMemoryIntensiveProcesses: [],
		mostCpuIntensiveProcesses: [],
		processesThatSurvivedTheirSessionRoot: [],
		completedToolCallCount: 0,
		failedToolCallCount: 0,
		interruptedToolCallCount: 0,
		totalToolExecutionDurationMs: 0,
		toolCallsByToolName: [],
		slowestToolCalls: [],
		hookCliInvocationCount: 0,
		modelTokenUsage: null,
		latestWorktreeDiskUsage: null,
	};
}

function addLatestModelTokenUsageRecordIntoReport(
	report: PerTaskResourceUsageReport,
	record: DiagnosticEventJournalRecord,
): void {
	const usage = report.modelTokenUsage ?? {
		sessionCount: 0,
		cumulativeInputTokens: 0,
		cumulativeCacheCreationInputTokens: 0,
		cumulativeCacheReadInputTokens: 0,
		cumulativeOutputTokens: 0,
		harnessReportedCumulativeCostUsd: null,
		modelIds: [],
	};
	usage.sessionCount += 1;
	usage.cumulativeInputTokens += readNumber(record, "cumulativeInputTokens") ?? 0;
	usage.cumulativeCacheCreationInputTokens += readNumber(record, "cumulativeCacheCreationInputTokens") ?? 0;
	usage.cumulativeCacheReadInputTokens += readNumber(record, "cumulativeCacheReadInputTokens") ?? 0;
	usage.cumulativeOutputTokens += readNumber(record, "cumulativeOutputTokens") ?? 0;
	const costUsd = readNumber(record, "harnessReportedCumulativeCostUsd");
	if (costUsd !== null) {
		usage.harnessReportedCumulativeCostUsd = (usage.harnessReportedCumulativeCostUsd ?? 0) + costUsd;
	}
	const modelIds = Array.isArray(record.modelIds)
		? record.modelIds.filter((modelId): modelId is string => typeof modelId === "string")
		: [];
	usage.modelIds = Array.from(new Set([...usage.modelIds, ...modelIds])).sort();
	report.modelTokenUsage = usage;
}

function taskGroupKey(workspaceId: string | null, attributedTaskCardId: string | null): string {
	return `${workspaceId ?? ""}\u0000${attributedTaskCardId ?? ""}`;
}

// task 键 → 快照时刻 → 条目名（进程分类 / MCP label）→ 该时刻各会话的 RSS 和。同一 tick 的全部会话快照
// 由同一个 snapshotAtEpochMs 构建，snapshotWindowEndedAtIso 逐字相同，按它精确分组即可，无需分桶。
type ResidentSetSizeKibibytesSumByEntryNameBySnapshotTimeByTaskKey = Map<string, Map<string, Map<string, number>>>;

function addResidentSetSizeIntoTaskSnapshotTimeEntrySum(
	sumsByTaskKey: ResidentSetSizeKibibytesSumByEntryNameBySnapshotTimeByTaskKey,
	taskKey: string,
	snapshotWindowEndedAtIso: string,
	entryName: string,
	residentSetSizeKibibytes: number,
): void {
	const sumsBySnapshotTime = sumsByTaskKey.get(taskKey) ?? new Map<string, Map<string, number>>();
	const sumsByEntryName = sumsBySnapshotTime.get(snapshotWindowEndedAtIso) ?? new Map<string, number>();
	sumsByEntryName.set(entryName, (sumsByEntryName.get(entryName) ?? 0) + residentSetSizeKibibytes);
	sumsBySnapshotTime.set(snapshotWindowEndedAtIso, sumsByEntryName);
	sumsByTaskKey.set(taskKey, sumsBySnapshotTime);
}

function peakResidentSetSizeKibibytesSumAcrossSnapshotTimesByEntryName(
	sumsBySnapshotTime: ReadonlyMap<string, ReadonlyMap<string, number>> | undefined,
): Map<string, number> {
	const peaksByEntryName = new Map<string, number>();
	for (const sumsByEntryName of sumsBySnapshotTime?.values() ?? []) {
		for (const [entryName, residentSetSizeKibibytesSum] of sumsByEntryName) {
			peaksByEntryName.set(entryName, Math.max(peaksByEntryName.get(entryName) ?? 0, residentSetSizeKibibytesSum));
		}
	}
	return peaksByEntryName;
}

export function aggregateTaskResourceUsageReport(input: TaskResourceUsageReportInput): TaskResourceUsageReport {
	const perTaskReportsByKey = new Map<string, PerTaskResourceUsageReport>();
	const getPerTaskReport = (record: DiagnosticEventJournalRecord): PerTaskResourceUsageReport => {
		const workspaceId = readString(record, "workspaceId");
		const attributedTaskCardId = readString(record, "attributedTaskCardId");
		const key = taskGroupKey(workspaceId, attributedTaskCardId);
		let report = perTaskReportsByKey.get(key);
		if (!report) {
			report = createEmptyPerTaskReport(workspaceId, attributedTaskCardId);
			perTaskReportsByKey.set(key, report);
		}
		return report;
	};
	const matches = (record: DiagnosticEventJournalRecord) => recordMatchesFilter(record, input.filter);

	// 周期快照：同一 task 可能同时有多个会话（主会话 + by-the-way + detail shell），先按快照时刻把各会话
	// 加起来，再在时间轴上取峰值 / 均值。
	const snapshotTotalsByTaskAndTime = new Map<string, Map<string, number>>();
	// 分类 RSS 与 per-task MCP 同理：先按「task + 快照时刻」把并发会话求和，再跨时刻取峰值。
	const processClassificationResidentSetSizeSumsByTaskKey: ResidentSetSizeKibibytesSumByEntryNameBySnapshotTimeByTaskKey =
		new Map();
	const mcpServerInstanceResidentSetSizeSumsByTaskKey: ResidentSetSizeKibibytesSumByEntryNameBySnapshotTimeByTaskKey =
		new Map();
	const mcpSamplesByLabel = new Map<string, { residentSetSizeKibibytesSamples: number[]; sessionKeys: Set<string> }>();
	for (const record of input.periodicResourceSnapshotRecords.filter(matches)) {
		const report = getPerTaskReport(record);
		report.periodicSnapshotCount += 1;
		const windowEndedAtIso = readString(record, "snapshotWindowEndedAtIso") ?? "";
		const key = taskGroupKey(report.workspaceId, report.attributedTaskCardId);
		const totalsByTime = snapshotTotalsByTaskAndTime.get(key) ?? new Map<string, number>();
		totalsByTime.set(
			windowEndedAtIso,
			(totalsByTime.get(windowEndedAtIso) ?? 0) + (readNumber(record, "residentSetSizeKibibytesSumUpperBound") ?? 0),
		);
		snapshotTotalsByTaskAndTime.set(key, totalsByTime);
		report.cpuTimeSecondsConsumedInWindow += readNumber(record, "cpuTimeSecondsConsumedInSnapshotWindow") ?? 0;
		const footprintBytes = readNumber(record, "agentHarnessRootPhysicalFootprintBytes");
		if (footprintBytes !== null) {
			report.peakAgentHarnessRootPhysicalFootprintBytes = Math.max(
				report.peakAgentHarnessRootPhysicalFootprintBytes ?? 0,
				footprintBytes,
			);
		}
		for (const [classification, rss] of Object.entries(
			readNumberRecord(record, "residentSetSizeKibibytesSumUpperBoundByProcessClassification"),
		)) {
			addResidentSetSizeIntoTaskSnapshotTimeEntrySum(
				processClassificationResidentSetSizeSumsByTaskKey,
				key,
				windowEndedAtIso,
				classification,
				rss,
			);
		}
		for (const [classification, cpuSeconds] of Object.entries(
			readNumberRecord(record, "cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification"),
		)) {
			report.cpuTimeSecondsConsumedByProcessClassification[classification] =
				(report.cpuTimeSecondsConsumedByProcessClassification[classification] ?? 0) + cpuSeconds;
		}
		const mcpServerInstances = Array.isArray(record.mcpServerInstances) ? record.mcpServerInstances : [];
		const sessionKey = `${report.workspaceId ?? ""}\u0000${readString(record, "sessionTaskId") ?? ""}\u0000${readNumber(record, "attributionRootProcessId") ?? ""}`;
		for (const instance of mcpServerInstances) {
			if (typeof instance !== "object" || instance === null) {
				continue;
			}
			const instanceRecord = instance as DiagnosticEventJournalRecord;
			const label = readString(instanceRecord, "mcpServerInstanceLabel");
			const rss = readNumber(instanceRecord, "residentSetSizeKibibytesSum");
			if (label === null || rss === null) {
				continue;
			}
			addResidentSetSizeIntoTaskSnapshotTimeEntrySum(
				mcpServerInstanceResidentSetSizeSumsByTaskKey,
				key,
				windowEndedAtIso,
				label,
				rss,
			);
			const samples = mcpSamplesByLabel.get(label) ?? {
				residentSetSizeKibibytesSamples: [],
				sessionKeys: new Set<string>(),
			};
			samples.residentSetSizeKibibytesSamples.push(rss);
			samples.sessionKeys.add(sessionKey);
			mcpSamplesByLabel.set(label, samples);
		}
	}
	for (const report of perTaskReportsByKey.values()) {
		const taskKey = taskGroupKey(report.workspaceId, report.attributedTaskCardId);
		const totals = Array.from(snapshotTotalsByTaskAndTime.get(taskKey)?.values() ?? []);
		if (totals.length > 0) {
			report.peakProcessTreeResidentSetSizeKibibytesSumUpperBound = Math.max(...totals);
			report.averageProcessTreeResidentSetSizeKibibytesSumUpperBound = Math.round(
				totals.reduce((sum, value) => sum + value, 0) / totals.length,
			);
		}
		report.peakResidentSetSizeKibibytesSumUpperBoundByProcessClassification = Object.fromEntries(
			peakResidentSetSizeKibibytesSumAcrossSnapshotTimesByEntryName(
				processClassificationResidentSetSizeSumsByTaskKey.get(taskKey),
			),
		);
		report.mcpServerInstances = Array.from(
			peakResidentSetSizeKibibytesSumAcrossSnapshotTimesByEntryName(
				mcpServerInstanceResidentSetSizeSumsByTaskKey.get(taskKey),
			),
			([mcpServerInstanceLabel, peakResidentSetSizeKibibytesSum]) => ({
				mcpServerInstanceLabel,
				peakResidentSetSizeKibibytesSum,
			}),
		).sort((left, right) => right.peakResidentSetSizeKibibytesSum - left.peakResidentSetSizeKibibytesSum);
	}

	// 进程生命周期 episode。
	const episodesByTaskKey = new Map<string, ProcessLifetimeEpisodeReportEntry[]>();
	const survivorsByTaskKey = new Map<string, ProcessLifetimeEpisodeReportEntry[]>();
	for (const record of input.processLifetimeEpisodeRecords.filter(matches)) {
		const report = getPerTaskReport(record);
		const key = taskGroupKey(report.workspaceId, report.attributedTaskCardId);
		const entry = toEpisodeReportEntry(record);
		episodesByTaskKey.set(key, [...(episodesByTaskKey.get(key) ?? []), entry]);
		if (record.survivedAttributionRootProcessExit === true) {
			survivorsByTaskKey.set(key, [...(survivorsByTaskKey.get(key) ?? []), entry]);
		}
	}
	for (const [key, episodes] of episodesByTaskKey) {
		const report = perTaskReportsByKey.get(key);
		if (!report) {
			continue;
		}
		report.mostMemoryIntensiveProcesses = episodes
			.slice()
			.sort((left, right) => right.peakObservedResidentSetSizeKibibytes - left.peakObservedResidentSetSizeKibibytes)
			.slice(0, TOP_ENTRY_COUNT);
		report.mostCpuIntensiveProcesses = episodes
			.slice()
			.sort((left, right) => right.cpuTimeSecondsConsumedWhileObserved - left.cpuTimeSecondsConsumedWhileObserved)
			.filter((entry) => entry.cpuTimeSecondsConsumedWhileObserved > 0)
			.slice(0, TOP_ENTRY_COUNT);
		report.processesThatSurvivedTheirSessionRoot = survivorsByTaskKey.get(key) ?? [];
	}

	// 工具调用：hook 重投递可能重复，按 会话 + tool_use_id + 阶段 去重；只统计完成 / 失败两种终态。
	const seenToolCallKeys = new Set<string>();
	const toolCallsByTaskKey = new Map<string, ToolCallReportEntry[]>();
	for (const record of input.toolCallExecutionOutcomeRecords.filter(matches)) {
		const phase = readString(record, "toolCallLifecyclePhase");
		if (phase !== "tool_call_succeeded" && phase !== "tool_call_failed") {
			continue;
		}
		const toolUseId = readString(record, "toolUseId");
		if (toolUseId !== null) {
			const dedupeKey = `${readString(record, "sessionTaskId") ?? ""}\u0000${toolUseId}\u0000${phase}`;
			if (seenToolCallKeys.has(dedupeKey)) {
				continue;
			}
			seenToolCallKeys.add(dedupeKey);
		}
		const report = getPerTaskReport(record);
		if (phase === "tool_call_failed") {
			report.failedToolCallCount += 1;
		} else {
			report.completedToolCallCount += 1;
		}
		if (record.toolCallWasInterrupted === true) {
			report.interruptedToolCallCount += 1;
		}
		const toolName = readString(record, "toolName") ?? "unknown";
		const durationMs = readNumber(record, "toolExecutionDurationMs") ?? 0;
		report.totalToolExecutionDurationMs += durationMs;
		const byTool = report.toolCallsByToolName.find((entry) => entry.toolName === toolName);
		if (byTool) {
			byTool.callCount += 1;
			byTool.totalDurationMs += durationMs;
			byTool.maxDurationMs = Math.max(byTool.maxDurationMs, durationMs);
		} else {
			report.toolCallsByToolName.push({
				toolName,
				callCount: 1,
				totalDurationMs: durationMs,
				maxDurationMs: durationMs,
			});
		}
		const key = taskGroupKey(report.workspaceId, report.attributedTaskCardId);
		toolCallsByTaskKey.set(key, [
			...(toolCallsByTaskKey.get(key) ?? []),
			{
				toolName,
				commandLineTextForJournal: readString(record, "commandLineTextForJournal"),
				toolExecutionDurationMs: durationMs,
				recordedAtIso: readString(record, "recordedAtIso"),
			},
		]);
	}
	for (const [key, toolCalls] of toolCallsByTaskKey) {
		const report = perTaskReportsByKey.get(key);
		if (!report) {
			continue;
		}
		report.toolCallsByToolName.sort((left, right) => right.totalDurationMs - left.totalDurationMs);
		report.slowestToolCalls = toolCalls
			.slice()
			.sort((left, right) => right.toolExecutionDurationMs - left.toolExecutionDurationMs)
			.slice(0, TOP_ENTRY_COUNT);
	}

	// 模型 token：累计快照，每个会话（来源 + 原生会话 id）只取最后一条，再按卡片求和。
	const latestModelTokenUsageRecordBySessionKey = new Map<string, DiagnosticEventJournalRecord>();
	for (const record of input.modelTokenUsageCumulativeSnapshotRecords.filter(matches)) {
		const sessionKey = `${readString(record, "modelTokenUsageSource") ?? ""}\u0000${readString(record, "nativeSessionId") ?? readString(record, "sessionTaskId") ?? ""}`;
		latestModelTokenUsageRecordBySessionKey.set(sessionKey, record);
	}
	for (const record of latestModelTokenUsageRecordBySessionKey.values()) {
		addLatestModelTokenUsageRecordIntoReport(getPerTaskReport(record), record);
	}

	// worktree 磁盘：每张卡取最近一次测量。
	for (const record of input.worktreeDiskUsageMeasurementRecords.filter(matches)) {
		const topLevelEntries = Array.isArray(record.largestTopLevelEntries) ? record.largestTopLevelEntries : [];
		getPerTaskReport(record).latestWorktreeDiskUsage = {
			measuredAtIso: readString(record, "recordedAtIso"),
			worktreeTotalBytes: readNumber(record, "worktreeTotalBytes") ?? 0,
			largestTopLevelEntries: topLevelEntries.flatMap((entry) => {
				if (typeof entry !== "object" || entry === null) {
					return [];
				}
				const entryRecord = entry as DiagnosticEventJournalRecord;
				const entryName = readString(entryRecord, "entryName");
				const totalBytes = readNumber(entryRecord, "totalBytes");
				return entryName === null || totalBytes === null ? [] : [{ entryName, totalBytes }];
			}),
			measurementWasCutShortByTimeBudget: record.measurementWasCutShortByTimeBudget === true,
		};
	}

	// hooks CLI 开销。
	const hookRecords = input.hookCliInvocationResourceUsageRecords.filter(matches);
	for (const record of hookRecords) {
		getPerTaskReport(record).hookCliInvocationCount += 1;
	}
	const hookUptimes = hookRecords
		.map((record) => readNumber(record, "hookCliProcessUptimeMs"))
		.filter((value): value is number => value !== null)
		.sort((left, right) => left - right);
	const hookMaxRss = hookRecords
		.map((record) => readNumber(record, "lifetimeMaximumResidentSetSizeKibibytes"))
		.filter((value): value is number => value !== null);

	// Kanban 运行时基线：不按 task 过滤。
	const baselineRecords = input.kanbanRuntimeProcessSelfResourceSampleRecords;
	const baselineRss = baselineRecords
		.map((record) => readNumber(record, "residentSetSizeBytes"))
		.filter((value): value is number => value !== null);
	const latestBaselineRecord = baselineRecords[baselineRecords.length - 1];

	// 同一张卡上 workspaceId 未知的记录（Cline SDK 路径）并入唯一的已知 workspace 组。
	for (const [key, report] of perTaskReportsByKey) {
		if (report.workspaceId !== null || report.attributedTaskCardId === null) {
			continue;
		}
		const knownWorkspaceGroups = Array.from(perTaskReportsByKey.values()).filter(
			(candidate) =>
				candidate.workspaceId !== null && candidate.attributedTaskCardId === report.attributedTaskCardId,
		);
		const [target] = knownWorkspaceGroups;
		if (knownWorkspaceGroups.length !== 1 || !target) {
			continue;
		}
		target.completedToolCallCount += report.completedToolCallCount;
		target.failedToolCallCount += report.failedToolCallCount;
		target.totalToolExecutionDurationMs += report.totalToolExecutionDurationMs;
		target.toolCallsByToolName.push(...report.toolCallsByToolName);
		target.slowestToolCalls = [...target.slowestToolCalls, ...report.slowestToolCalls]
			.sort((left, right) => right.toolExecutionDurationMs - left.toolExecutionDurationMs)
			.slice(0, TOP_ENTRY_COUNT);
		if (report.modelTokenUsage) {
			const usage = report.modelTokenUsage;
			const targetUsage = target.modelTokenUsage;
			target.modelTokenUsage = targetUsage
				? {
						sessionCount: targetUsage.sessionCount + usage.sessionCount,
						cumulativeInputTokens: targetUsage.cumulativeInputTokens + usage.cumulativeInputTokens,
						cumulativeCacheCreationInputTokens:
							targetUsage.cumulativeCacheCreationInputTokens + usage.cumulativeCacheCreationInputTokens,
						cumulativeCacheReadInputTokens:
							targetUsage.cumulativeCacheReadInputTokens + usage.cumulativeCacheReadInputTokens,
						cumulativeOutputTokens: targetUsage.cumulativeOutputTokens + usage.cumulativeOutputTokens,
						harnessReportedCumulativeCostUsd:
							targetUsage.harnessReportedCumulativeCostUsd === null &&
							usage.harnessReportedCumulativeCostUsd === null
								? null
								: (targetUsage.harnessReportedCumulativeCostUsd ?? 0) +
									(usage.harnessReportedCumulativeCostUsd ?? 0),
						modelIds: Array.from(new Set([...targetUsage.modelIds, ...usage.modelIds])).sort(),
					}
				: usage;
		}
		perTaskReportsByKey.delete(key);
	}

	return {
		reportWindowStartedAtIso:
			input.reportWindowStartedAtEpochMs === null
				? null
				: new Date(input.reportWindowStartedAtEpochMs).toISOString(),
		reportGeneratedAtIso: new Date(input.reportGeneratedAtEpochMs).toISOString(),
		measurementCaveats: TASK_RESOURCE_USAGE_REPORT_MEASUREMENT_CAVEATS,
		perTaskReports: Array.from(perTaskReportsByKey.values()).sort(
			(left, right) =>
				(right.peakProcessTreeResidentSetSizeKibibytesSumUpperBound ?? 0) -
				(left.peakProcessTreeResidentSetSizeKibibytesSumUpperBound ?? 0),
		),
		mcpServerInstanceResidentCostAcrossTasks: Array.from(mcpSamplesByLabel, ([mcpServerInstanceLabel, samples]) => ({
			mcpServerInstanceLabel,
			observedSessionCount: samples.sessionKeys.size,
			averageResidentSetSizeKibibytesPerInstance: Math.round(
				samples.residentSetSizeKibibytesSamples.reduce((sum, value) => sum + value, 0) /
					samples.residentSetSizeKibibytesSamples.length,
			),
			peakResidentSetSizeKibibytesPerInstance: Math.max(...samples.residentSetSizeKibibytesSamples),
		})).sort(
			(left, right) =>
				right.averageResidentSetSizeKibibytesPerInstance * right.observedSessionCount -
				left.averageResidentSetSizeKibibytesPerInstance * left.observedSessionCount,
		),
		hookCliInvocationOverhead:
			hookRecords.length === 0
				? null
				: {
						invocationCount: hookRecords.length,
						averageLifetimeMaximumResidentSetSizeKibibytes: Math.round(
							hookMaxRss.reduce((sum, value) => sum + value, 0) / Math.max(1, hookMaxRss.length),
						),
						averageHookCliProcessUptimeMs: Math.round(
							hookUptimes.reduce((sum, value) => sum + value, 0) / Math.max(1, hookUptimes.length),
						),
						p95HookCliProcessUptimeMs: percentile(hookUptimes, 0.95),
						retriedInvocationCount: hookRecords.filter(
							(record) => (readNumber(record, "hookIngestDeliveryAttempt") ?? 1) > 1,
						).length,
					},
		kanbanRuntimeProcessBaseline:
			baselineRecords.length === 0
				? null
				: {
						sampleCount: baselineRecords.length,
						latestResidentSetSizeBytes: latestBaselineRecord
							? readNumber(latestBaselineRecord, "residentSetSizeBytes")
							: null,
						peakResidentSetSizeBytes: baselineRss.length > 0 ? Math.max(...baselineRss) : null,
						latestHeapUsedBytes: latestBaselineRecord ? readNumber(latestBaselineRecord, "heapUsedBytes") : null,
						cpuTimeSecondsConsumedInWindow: baselineRecords.reduce(
							(sum, record) => sum + (readNumber(record, "cpuTimeSecondsConsumedSincePreviousSample") ?? 0),
							0,
						),
					},
	};
}
