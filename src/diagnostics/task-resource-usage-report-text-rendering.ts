// 把 TaskResourceUsageReport 渲染成终端可读的文本。机器消费请用 `--json`。

import type {
	PerTaskResourceUsageReport,
	ProcessLifetimeEpisodeReportEntry,
	TaskResourceUsageReport,
} from "./task-resource-usage-report-aggregation";

export function formatKibibytesAsHumanReadable(kibibytes: number | null): string {
	if (kibibytes === null) {
		return "—";
	}
	if (kibibytes >= 1024 * 1024) {
		return `${(kibibytes / (1024 * 1024)).toFixed(2)} GiB`;
	}
	if (kibibytes >= 1024) {
		return `${(kibibytes / 1024).toFixed(0)} MiB`;
	}
	return `${kibibytes} KiB`;
}

function formatBytesAsHumanReadable(bytes: number | null): string {
	return bytes === null ? "—" : formatKibibytesAsHumanReadable(Math.round(bytes / 1024));
}

function formatTokenCount(tokenCount: number): string {
	if (tokenCount >= 1_000_000) {
		return `${(tokenCount / 1_000_000).toFixed(2)}M`;
	}
	if (tokenCount >= 1_000) {
		return `${(tokenCount / 1_000).toFixed(1)}k`;
	}
	return String(tokenCount);
}

function formatDurationMs(durationMs: number | null): string {
	if (durationMs === null) {
		return "—";
	}
	if (durationMs >= 3_600_000) {
		return `${(durationMs / 3_600_000).toFixed(1)}h`;
	}
	if (durationMs >= 60_000) {
		return `${(durationMs / 60_000).toFixed(1)}m`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function describeEpisode(entry: ProcessLifetimeEpisodeReportEntry): string {
	const label = entry.mcpServerInstanceLabel ?? entry.commandLineTextForJournal ?? "(命令行不可读)";
	return `${entry.processClassification ?? "?"} · ${label} · 峰值 ${formatKibibytesAsHumanReadable(entry.peakObservedResidentSetSizeKibibytes)} · CPU ${entry.cpuTimeSecondsConsumedWhileObserved.toFixed(1)}s · 存活 ${formatDurationMs(entry.processLifetimeMsAtLastObservation)}`;
}

function renderPerTaskReport(report: PerTaskResourceUsageReport): string[] {
	const title =
		report.attributedTaskCardId === null
			? `workspace ${report.workspaceId ?? "?"}（workspace 级会话）`
			: `task ${report.attributedTaskCardId}${report.workspaceId ? ` @ ${report.workspaceId}` : ""}`;
	const lines = [`## ${title}`];
	lines.push(
		`- 进程树 RSS 上界：峰值 ${formatKibibytesAsHumanReadable(report.peakProcessTreeResidentSetSizeKibibytesSumUpperBound)} / 均值 ${formatKibibytesAsHumanReadable(report.averageProcessTreeResidentSetSizeKibibytesSumUpperBound)}（${report.periodicSnapshotCount} 个快照）`,
		`- harness 根进程 footprint 峰值：${formatBytesAsHumanReadable(report.peakAgentHarnessRootPhysicalFootprintBytes)}`,
		`- CPU 时间：${report.cpuTimeSecondsConsumedInWindow.toFixed(1)}s`,
	);
	const classificationEntries = Object.entries(
		report.peakResidentSetSizeKibibytesSumUpperBoundByProcessClassification,
	).sort((left, right) => right[1] - left[1]);
	if (classificationEntries.length > 0) {
		lines.push("- 按分类的 RSS 峰值 / CPU：");
		for (const [classification, rss] of classificationEntries) {
			const cpuSeconds = report.cpuTimeSecondsConsumedByProcessClassification[classification] ?? 0;
			lines.push(`  - ${classification}: ${formatKibibytesAsHumanReadable(rss)} / ${cpuSeconds.toFixed(1)}s`);
		}
	}
	if (report.mcpServerInstances.length > 0) {
		lines.push(
			`- MCP 实例：${report.mcpServerInstances.map((instance) => `${instance.mcpServerInstanceLabel} ${formatKibibytesAsHumanReadable(instance.peakResidentSetSizeKibibytesSum)}`).join("，")}`,
		);
	}
	if (report.mostMemoryIntensiveProcesses.length > 0) {
		lines.push(
			"- 最吃内存的进程：",
			...report.mostMemoryIntensiveProcesses.map((entry) => `  - ${describeEpisode(entry)}`),
		);
	}
	if (report.mostCpuIntensiveProcesses.length > 0) {
		lines.push(
			"- 最吃 CPU 的进程：",
			...report.mostCpuIntensiveProcesses.map((entry) => `  - ${describeEpisode(entry)}`),
		);
	}
	if (report.processesThatSurvivedTheirSessionRoot.length > 0) {
		lines.push(
			`- ⚠ 活过了会话根的残留进程（${report.processesThatSurvivedTheirSessionRoot.length}）：`,
			...report.processesThatSurvivedTheirSessionRoot.slice(0, 10).map((entry) => `  - ${describeEpisode(entry)}`),
		);
	}
	const completedOrFailed = report.completedToolCallCount + report.failedToolCallCount;
	if (completedOrFailed > 0) {
		lines.push(
			`- 工具调用：${completedOrFailed} 次（失败 ${report.failedToolCallCount}，中断 ${report.interruptedToolCallCount}），合计耗时 ${formatDurationMs(report.totalToolExecutionDurationMs)}`,
			...report.toolCallsByToolName
				.slice(0, 8)
				.map(
					(entry) =>
						`  - ${entry.toolName}: ${entry.callCount} 次 / 合计 ${formatDurationMs(entry.totalDurationMs)} / 最长 ${formatDurationMs(entry.maxDurationMs)}`,
				),
		);
		if (report.slowestToolCalls.length > 0) {
			lines.push(
				"- 最慢的工具调用：",
				...report.slowestToolCalls.map(
					(entry) =>
						`  - ${formatDurationMs(entry.toolExecutionDurationMs)} · ${entry.toolName}${entry.commandLineTextForJournal ? ` · ${entry.commandLineTextForJournal}` : ""}`,
				),
			);
		}
	}
	if (report.hookCliInvocationCount > 0) {
		lines.push(`- kanban hooks CLI 调用：${report.hookCliInvocationCount} 次`);
	}
	if (report.modelTokenUsage) {
		const usage = report.modelTokenUsage;
		lines.push(
			`- 模型 token（${usage.sessionCount} 个会话累计）：输入 ${formatTokenCount(usage.cumulativeInputTokens)} / 缓存写 ${formatTokenCount(usage.cumulativeCacheCreationInputTokens)} / 缓存读 ${formatTokenCount(usage.cumulativeCacheReadInputTokens)} / 输出 ${formatTokenCount(usage.cumulativeOutputTokens)}${usage.harnessReportedCumulativeCostUsd === null ? "" : `；harness 自报 cost $${usage.harnessReportedCumulativeCostUsd.toFixed(2)}`}${usage.modelIds.length > 0 ? `（${usage.modelIds.join("、")}）` : ""}`,
		);
	}
	if (report.latestWorktreeDiskUsage) {
		const diskUsage = report.latestWorktreeDiskUsage;
		lines.push(
			`- worktree 磁盘：${formatBytesAsHumanReadable(diskUsage.worktreeTotalBytes)}${diskUsage.measurementWasCutShortByTimeBudget ? "（超时截断，是下界）" : ""}；${diskUsage.largestTopLevelEntries
				.slice(0, 4)
				.map((entry) => `${entry.entryName} ${formatBytesAsHumanReadable(entry.totalBytes)}`)
				.join("，")}`,
		);
	}
	return lines;
}

export function renderTaskResourceUsageReportAsText(report: TaskResourceUsageReport): string {
	const lines = [
		"# Task 资源占用报告",
		`时间窗：${report.reportWindowStartedAtIso ?? "journal 全部保留期"} → ${report.reportGeneratedAtIso}`,
		"",
		"口径说明：",
		...report.measurementCaveats.map((caveat) => `- ${caveat}`),
		"",
	];
	if (report.perTaskReports.length === 0) {
		lines.push("（时间窗内没有匹配的资源占用记录。采样器随 Kanban 运行时启动，部署后需要运行一段时间才有数据。）");
	}
	for (const perTaskReport of report.perTaskReports) {
		lines.push(...renderPerTaskReport(perTaskReport), "");
	}
	if (report.mcpServerInstanceResidentCostAcrossTasks.length > 0) {
		lines.push("# 跨 task 的 MCP 常驻成本（每实例 RSS 上界 × 出现的会话数）");
		for (const entry of report.mcpServerInstanceResidentCostAcrossTasks) {
			lines.push(
				`- ${entry.mcpServerInstanceLabel}: 均值 ${formatKibibytesAsHumanReadable(entry.averageResidentSetSizeKibibytesPerInstance)} / 峰值 ${formatKibibytesAsHumanReadable(entry.peakResidentSetSizeKibibytesPerInstance)} × ${entry.observedSessionCount} 个会话`,
			);
		}
		lines.push("");
	}
	if (report.hookCliInvocationOverhead) {
		const overhead = report.hookCliInvocationOverhead;
		lines.push(
			"# kanban hooks CLI 开销",
			`- ${overhead.invocationCount} 次调用；平均峰值 RSS ${formatKibibytesAsHumanReadable(overhead.averageLifetimeMaximumResidentSetSizeKibibytes)}；平均存活 ${formatDurationMs(overhead.averageHookCliProcessUptimeMs)}（p95 ${formatDurationMs(overhead.p95HookCliProcessUptimeMs)}）；需要重试的 ${overhead.retriedInvocationCount} 次`,
			"",
		);
	}
	if (report.kanbanRuntimeProcessBaseline) {
		const baseline = report.kanbanRuntimeProcessBaseline;
		lines.push(
			"# Kanban 运行时自身基线（不按 task 拆分）",
			`- RSS 最新 ${formatBytesAsHumanReadable(baseline.latestResidentSetSizeBytes)} / 峰值 ${formatBytesAsHumanReadable(baseline.peakResidentSetSizeBytes)}；heap ${formatBytesAsHumanReadable(baseline.latestHeapUsedBytes)}；时间窗内 CPU ${baseline.cpuTimeSecondsConsumedInWindow.toFixed(1)}s（${baseline.sampleCount} 个样本）`,
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
