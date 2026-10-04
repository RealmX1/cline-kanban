// 被归因进程的生命周期注册表（纯函数）：把每个 tick 的归因观测折叠成
//   - 生命周期 episode：进程消失（或采样器停止）时一条，记观测到的峰值 RSS、累计 CPU、存活时长、是否活过会话根；
//   - 周期快照：每个会话每 5 分钟一条，按分类聚合；
//   - 实时快照：每个 tick 按卡片聚合，供看板药丸使用（只在内存里，不落盘）。
//
// 口径约束（报告与 UI 必须照此标注）：
//   - RSS 求和会重复计算共享页，只是**上界**；macOS RSS 还不含被压缩 / 换出的页，对长寿进程偏低。
//     整机真实代价看低频采样的 phys_footprint；
//   - 峰值只对寿命不短于采样周期的进程可见；短命令的开销由 hook 的 duration_ms 另行覆盖；
//   - CPU 只计「观测窗口内新增」的部分：采样器启动时早已在跑的进程，其历史 CPU 不计入首个窗口。

import type { RuntimeLiveTaskResourceUsageSnapshot } from "../core/api-contract";
import type { ProcessCommandLineDiagnosticJournalSummary } from "./process-command-line-text-truncation-and-secret-redaction";
import type { TaskAttributedProcessClassification } from "./task-attributed-process-classification-rules";
import type {
	TaskAttributedProcessAttribution,
	TaskAttributedProcessAttributionAnchor,
	TaskAttributedProcessObservation,
} from "./task-attributed-process-tree-sample-attribution";

export interface TaskAttributedProcessLifetimeRegistryEntry {
	processLifetimeIdentityKey: string;
	processId: number;
	processStartedAtEpochMs: number | null;
	attribution: TaskAttributedProcessAttribution;
	latestAttributionAnchor: TaskAttributedProcessAttributionAnchor;
	commandLineSummary: ProcessCommandLineDiagnosticJournalSummary | null;
	firstObservedAtEpochMs: number;
	lastObservedAtEpochMs: number;
	observedSampleCount: number;
	lastObservedResidentSetSizeKibibytes: number;
	peakObservedResidentSetSizeKibibytes: number;
	cumulativeCpuTimeSecondsAtFirstObservation: number;
	cumulativeCpuTimeSecondsAtLastObservation: number;
	// 上一个 tick 的读数；首次观测时为 null（此时 CPU% 只对「本周期内新启动」的进程可算）。
	cumulativeCpuTimeSecondsAtPreviousObservation: number | null;
	cumulativeCpuTimeSecondsAtPreviousPeriodicSnapshot: number | null;
	survivedAttributionRootProcessExit: boolean;
	observedOutsideSessionProcessTree: boolean;
	latestPhysicalFootprintBytes: number | null;
	peakObservedPhysicalFootprintBytes: number | null;
}

export type TaskAttributedProcessLifetimeRegistry = ReadonlyMap<string, TaskAttributedProcessLifetimeRegistryEntry>;

export type TaskAttributedProcessLifetimeEndedBy = "process_exited_between_samples" | "sampler_stopped";

function toIsoOrNull(epochMs: number | null): string | null {
	return epochMs === null ? null : new Date(epochMs).toISOString();
}

// CPU 基线：进程在窗口起点之后才启动 ⇒ 从 0 计；否则用已知的最近读数，绝不把启动前的历史 CPU 算进来。
function resolveCpuTimeBaselineSeconds(
	entry: TaskAttributedProcessLifetimeRegistryEntry,
	windowStartedAtEpochMs: number | null,
	knownBaselineSeconds: number | null,
): number {
	if (
		windowStartedAtEpochMs !== null &&
		entry.processStartedAtEpochMs !== null &&
		entry.processStartedAtEpochMs >= windowStartedAtEpochMs
	) {
		return 0;
	}
	return knownBaselineSeconds ?? entry.cumulativeCpuTimeSecondsAtFirstObservation;
}

export function advanceTaskAttributedProcessLifetimeRegistry(input: {
	previousRegistry: TaskAttributedProcessLifetimeRegistry;
	observations: readonly TaskAttributedProcessObservation[];
	sampledAtEpochMs: number;
	commandLineSummaryByProcessLifetimeIdentityKey: ReadonlyMap<string, ProcessCommandLineDiagnosticJournalSummary>;
}): {
	nextRegistry: Map<string, TaskAttributedProcessLifetimeRegistryEntry>;
	endedProcessLifetimeEntries: TaskAttributedProcessLifetimeRegistryEntry[];
} {
	const nextRegistry = new Map<string, TaskAttributedProcessLifetimeRegistryEntry>();
	for (const observation of input.observations) {
		const { processTableRow: row } = observation;
		const previousEntry = input.previousRegistry.get(observation.processLifetimeIdentityKey);
		const commandLineSummary =
			input.commandLineSummaryByProcessLifetimeIdentityKey.get(observation.processLifetimeIdentityKey) ??
			previousEntry?.commandLineSummary ??
			null;
		const observedOutsideSessionProcessTree =
			observation.attributionAnchor === "remembered_from_earlier_sample" &&
			observation.attributionRootProcessIsAlive;
		if (!previousEntry) {
			nextRegistry.set(observation.processLifetimeIdentityKey, {
				processLifetimeIdentityKey: observation.processLifetimeIdentityKey,
				processId: row.processId,
				processStartedAtEpochMs: row.processStartedAtEpochMs,
				attribution: observation.attribution,
				latestAttributionAnchor: observation.attributionAnchor,
				commandLineSummary,
				firstObservedAtEpochMs: input.sampledAtEpochMs,
				lastObservedAtEpochMs: input.sampledAtEpochMs,
				observedSampleCount: 1,
				lastObservedResidentSetSizeKibibytes: row.residentSetSizeKibibytes,
				peakObservedResidentSetSizeKibibytes: row.residentSetSizeKibibytes,
				cumulativeCpuTimeSecondsAtFirstObservation: row.cumulativeCpuTimeSeconds,
				cumulativeCpuTimeSecondsAtLastObservation: row.cumulativeCpuTimeSeconds,
				cumulativeCpuTimeSecondsAtPreviousObservation: null,
				cumulativeCpuTimeSecondsAtPreviousPeriodicSnapshot: null,
				survivedAttributionRootProcessExit: !observation.attributionRootProcessIsAlive,
				observedOutsideSessionProcessTree,
				latestPhysicalFootprintBytes: null,
				peakObservedPhysicalFootprintBytes: null,
			});
			continue;
		}
		nextRegistry.set(observation.processLifetimeIdentityKey, {
			...previousEntry,
			// 归因以首次为准；只有从「记忆 / env」升级为进程树直接归因时才更新（更可信）。
			attribution:
				observation.attributionAnchor === "session_root_process_tree"
					? observation.attribution
					: previousEntry.attribution,
			latestAttributionAnchor: observation.attributionAnchor,
			commandLineSummary,
			lastObservedAtEpochMs: input.sampledAtEpochMs,
			observedSampleCount: previousEntry.observedSampleCount + 1,
			lastObservedResidentSetSizeKibibytes: row.residentSetSizeKibibytes,
			peakObservedResidentSetSizeKibibytes: Math.max(
				previousEntry.peakObservedResidentSetSizeKibibytes,
				row.residentSetSizeKibibytes,
			),
			cumulativeCpuTimeSecondsAtPreviousObservation: previousEntry.cumulativeCpuTimeSecondsAtLastObservation,
			cumulativeCpuTimeSecondsAtLastObservation: row.cumulativeCpuTimeSeconds,
			survivedAttributionRootProcessExit:
				previousEntry.survivedAttributionRootProcessExit || !observation.attributionRootProcessIsAlive,
			observedOutsideSessionProcessTree:
				previousEntry.observedOutsideSessionProcessTree || observedOutsideSessionProcessTree,
		});
	}
	const endedProcessLifetimeEntries = Array.from(input.previousRegistry.values()).filter(
		(entry) => !nextRegistry.has(entry.processLifetimeIdentityKey),
	);
	return { nextRegistry, endedProcessLifetimeEntries };
}

export function applyPhysicalFootprintSamplesToRegistry(
	registry: TaskAttributedProcessLifetimeRegistry,
	physicalFootprintBytesByProcessId: ReadonlyMap<number, number>,
): Map<string, TaskAttributedProcessLifetimeRegistryEntry> {
	const nextRegistry = new Map<string, TaskAttributedProcessLifetimeRegistryEntry>();
	for (const [key, entry] of registry) {
		const physicalFootprintBytes = physicalFootprintBytesByProcessId.get(entry.processId);
		nextRegistry.set(
			key,
			physicalFootprintBytes === undefined
				? entry
				: {
						...entry,
						latestPhysicalFootprintBytes: physicalFootprintBytes,
						peakObservedPhysicalFootprintBytes: Math.max(
							entry.peakObservedPhysicalFootprintBytes ?? 0,
							physicalFootprintBytes,
						),
					},
		);
	}
	return nextRegistry;
}

// 生命周期 episode 的 journal 载荷。字段名刻意冗长：这些记录要被脱离上下文的 jq / 报告读取。
export function buildTaskAttributedProcessLifetimeEpisodeJournalPayload(
	entry: TaskAttributedProcessLifetimeRegistryEntry,
	endedBy: TaskAttributedProcessLifetimeEndedBy,
	sampleIntervalMs: number,
): Record<string, unknown> {
	const { attribution } = entry;
	return {
		workspaceId: attribution.workspaceId,
		attributedTaskCardId: attribution.attributedTaskCardId,
		sessionTaskId: attribution.sessionTaskId,
		sessionCategory: attribution.sessionCategory,
		sessionTransport: attribution.sessionTransport,
		agentId: attribution.agentId,
		runtimeSessionIncarnationId: attribution.runtimeSessionIncarnationId,
		processClassification: attribution.processClassification,
		mcpServerInstanceLabel: attribution.mcpServerInstanceLabel,
		attributionAnchor: entry.latestAttributionAnchor,
		processId: entry.processId,
		processStartedAtIso: toIsoOrNull(entry.processStartedAtEpochMs),
		attributionRootProcessId: attribution.attributionRootProcessId,
		branchHeadProcessId: attribution.branchHeadProcessId,
		commandLineTextForJournal: entry.commandLineSummary?.commandLineTextForJournal ?? null,
		originalCommandLineCharacterCount: entry.commandLineSummary?.originalCommandLineCharacterCount ?? null,
		commandLineTextWasTruncated: entry.commandLineSummary?.commandLineTextWasTruncated ?? null,
		firstObservedAtIso: new Date(entry.firstObservedAtEpochMs).toISOString(),
		lastObservedAtIso: new Date(entry.lastObservedAtEpochMs).toISOString(),
		processLifetimeMsAtLastObservation:
			entry.processStartedAtEpochMs === null ? null : entry.lastObservedAtEpochMs - entry.processStartedAtEpochMs,
		observedSampleCount: entry.observedSampleCount,
		peakObservedResidentSetSizeKibibytes: entry.peakObservedResidentSetSizeKibibytes,
		lastObservedResidentSetSizeKibibytes: entry.lastObservedResidentSetSizeKibibytes,
		cumulativeCpuTimeSecondsAtLastObservation: entry.cumulativeCpuTimeSecondsAtLastObservation,
		cpuTimeSecondsConsumedWhileObserved: Math.max(
			0,
			entry.cumulativeCpuTimeSecondsAtLastObservation -
				resolveCpuTimeBaselineSeconds(entry, entry.firstObservedAtEpochMs - sampleIntervalMs, null),
		),
		peakObservedPhysicalFootprintBytes: entry.peakObservedPhysicalFootprintBytes,
		survivedAttributionRootProcessExit: entry.survivedAttributionRootProcessExit,
		observedOutsideSessionProcessTree: entry.observedOutsideSessionProcessTree,
		processLifetimeEndedBy: endedBy,
		sampleIntervalMs,
	};
}

interface MutableClassificationTotals {
	processCountByProcessClassification: Partial<Record<TaskAttributedProcessClassification, number>>;
	residentSetSizeKibibytesSumUpperBoundByProcessClassification: Partial<
		Record<TaskAttributedProcessClassification, number>
	>;
	mcpServerInstanceTotalsByLabel: Map<string, { processCount: number; residentSetSizeKibibytesSum: number }>;
	attributedProcessCount: number;
	residentSetSizeKibibytesSumUpperBound: number;
	largestSingleProcessResidentSetSizeKibibytes: number;
	survivedSessionRootExitProcessCount: number;
	survivedSessionRootExitResidentSetSizeKibibytesSum: number;
	agentHarnessRootPhysicalFootprintBytes: number | null;
}

function createClassificationTotals(): MutableClassificationTotals {
	return {
		processCountByProcessClassification: {},
		residentSetSizeKibibytesSumUpperBoundByProcessClassification: {},
		mcpServerInstanceTotalsByLabel: new Map(),
		attributedProcessCount: 0,
		residentSetSizeKibibytesSumUpperBound: 0,
		largestSingleProcessResidentSetSizeKibibytes: 0,
		survivedSessionRootExitProcessCount: 0,
		survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
		agentHarnessRootPhysicalFootprintBytes: null,
	};
}

function accumulateEntryIntoClassificationTotals(
	totals: MutableClassificationTotals,
	entry: TaskAttributedProcessLifetimeRegistryEntry,
): void {
	const classification = entry.attribution.processClassification;
	const rss = entry.lastObservedResidentSetSizeKibibytes;
	totals.attributedProcessCount += 1;
	totals.residentSetSizeKibibytesSumUpperBound += rss;
	totals.largestSingleProcessResidentSetSizeKibibytes = Math.max(
		totals.largestSingleProcessResidentSetSizeKibibytes,
		rss,
	);
	totals.processCountByProcessClassification[classification] =
		(totals.processCountByProcessClassification[classification] ?? 0) + 1;
	totals.residentSetSizeKibibytesSumUpperBoundByProcessClassification[classification] =
		(totals.residentSetSizeKibibytesSumUpperBoundByProcessClassification[classification] ?? 0) + rss;
	if (entry.attribution.mcpServerInstanceLabel !== null) {
		const mcpTotals = totals.mcpServerInstanceTotalsByLabel.get(entry.attribution.mcpServerInstanceLabel) ?? {
			processCount: 0,
			residentSetSizeKibibytesSum: 0,
		};
		mcpTotals.processCount += 1;
		mcpTotals.residentSetSizeKibibytesSum += rss;
		totals.mcpServerInstanceTotalsByLabel.set(entry.attribution.mcpServerInstanceLabel, mcpTotals);
	}
	if (entry.survivedAttributionRootProcessExit) {
		totals.survivedSessionRootExitProcessCount += 1;
		totals.survivedSessionRootExitResidentSetSizeKibibytesSum += rss;
	}
	if (classification === "agent_harness_root_process" && entry.latestPhysicalFootprintBytes !== null) {
		totals.agentHarnessRootPhysicalFootprintBytes =
			(totals.agentHarnessRootPhysicalFootprintBytes ?? 0) + entry.latestPhysicalFootprintBytes;
	}
}

function serializeMcpServerInstanceTotals(
	mcpServerInstanceTotalsByLabel: MutableClassificationTotals["mcpServerInstanceTotalsByLabel"],
): Array<{ mcpServerInstanceLabel: string; processCount: number; residentSetSizeKibibytesSum: number }> {
	return Array.from(mcpServerInstanceTotalsByLabel, ([mcpServerInstanceLabel, totals]) => ({
		mcpServerInstanceLabel,
		...totals,
	})).sort((left, right) => right.residentSetSizeKibibytesSum - left.residentSetSizeKibibytesSum);
}

export function buildTaskAttributedProcessTreePeriodicResourceSnapshots(input: {
	registry: TaskAttributedProcessLifetimeRegistry;
	snapshotAtEpochMs: number;
	previousSnapshotAtEpochMs: number | null;
}): {
	snapshotJournalPayloads: Array<Record<string, unknown>>;
	registryWithUpdatedSnapshotBaselines: Map<string, TaskAttributedProcessLifetimeRegistryEntry>;
} {
	const groups = new Map<
		string,
		{
			attribution: TaskAttributedProcessAttribution;
			totals: MutableClassificationTotals;
			cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification: Partial<
				Record<TaskAttributedProcessClassification, number>
			>;
			cpuTimeSecondsConsumedInSnapshotWindow: number;
			attributionRootProcessIsAlive: boolean;
		}
	>();
	const registryWithUpdatedSnapshotBaselines = new Map<string, TaskAttributedProcessLifetimeRegistryEntry>();
	for (const [key, entry] of input.registry) {
		const { attribution } = entry;
		const groupKey = [
			attribution.workspaceId,
			attribution.attributedTaskCardId,
			attribution.sessionTaskId,
			attribution.attributionRootProcessLifetimeIdentityKey,
		].join("\u0000");
		let group = groups.get(groupKey);
		if (!group) {
			group = {
				attribution,
				totals: createClassificationTotals(),
				cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification: {},
				cpuTimeSecondsConsumedInSnapshotWindow: 0,
				attributionRootProcessIsAlive: input.registry.has(attribution.attributionRootProcessLifetimeIdentityKey),
			};
			groups.set(groupKey, group);
		}
		accumulateEntryIntoClassificationTotals(group.totals, entry);
		const cpuTimeSecondsConsumed = Math.max(
			0,
			entry.cumulativeCpuTimeSecondsAtLastObservation -
				resolveCpuTimeBaselineSeconds(
					entry,
					input.previousSnapshotAtEpochMs,
					entry.cumulativeCpuTimeSecondsAtPreviousPeriodicSnapshot,
				),
		);
		const classification = attribution.processClassification;
		group.cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification[classification] =
			(group.cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification[classification] ?? 0) +
			cpuTimeSecondsConsumed;
		group.cpuTimeSecondsConsumedInSnapshotWindow += cpuTimeSecondsConsumed;
		registryWithUpdatedSnapshotBaselines.set(key, {
			...entry,
			cumulativeCpuTimeSecondsAtPreviousPeriodicSnapshot: entry.cumulativeCpuTimeSecondsAtLastObservation,
		});
	}

	const snapshotJournalPayloads = Array.from(groups.values(), (group) => ({
		workspaceId: group.attribution.workspaceId,
		attributedTaskCardId: group.attribution.attributedTaskCardId,
		sessionTaskId: group.attribution.sessionTaskId,
		sessionCategory: group.attribution.sessionCategory,
		sessionTransport: group.attribution.sessionTransport,
		agentId: group.attribution.agentId,
		runtimeSessionIncarnationId: group.attribution.runtimeSessionIncarnationId,
		attributionRootProcessId: group.attribution.attributionRootProcessId,
		attributionRootProcessIsAlive: group.attributionRootProcessIsAlive,
		snapshotWindowStartedAtIso: toIsoOrNull(input.previousSnapshotAtEpochMs),
		snapshotWindowEndedAtIso: new Date(input.snapshotAtEpochMs).toISOString(),
		attributedProcessCount: group.totals.attributedProcessCount,
		processCountByProcessClassification: group.totals.processCountByProcessClassification,
		residentSetSizeKibibytesSumUpperBound: group.totals.residentSetSizeKibibytesSumUpperBound,
		residentSetSizeKibibytesSumUpperBoundByProcessClassification:
			group.totals.residentSetSizeKibibytesSumUpperBoundByProcessClassification,
		largestSingleProcessResidentSetSizeKibibytes: group.totals.largestSingleProcessResidentSetSizeKibibytes,
		cpuTimeSecondsConsumedInSnapshotWindow: group.cpuTimeSecondsConsumedInSnapshotWindow,
		cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification:
			group.cpuTimeSecondsConsumedInSnapshotWindowByProcessClassification,
		agentHarnessRootPhysicalFootprintBytes: group.totals.agentHarnessRootPhysicalFootprintBytes,
		survivedSessionRootExitProcessCount: group.totals.survivedSessionRootExitProcessCount,
		survivedSessionRootExitResidentSetSizeKibibytesSum:
			group.totals.survivedSessionRootExitResidentSetSizeKibibytesSum,
		mcpServerInstances: serializeMcpServerInstanceTotals(group.totals.mcpServerInstanceTotalsByLabel),
	}));
	return { snapshotJournalPayloads, registryWithUpdatedSnapshotBaselines };
}

// 形状即推流契约（api-contract.ts 的 runtimeLiveTaskResourceUsageSnapshotSchema），此处不再另定义一份。
export type LiveTaskResourceUsageSnapshot = RuntimeLiveTaskResourceUsageSnapshot;

export function buildLiveTaskResourceUsageSnapshots(input: {
	registry: TaskAttributedProcessLifetimeRegistry;
	sampledAtEpochMs: number;
	previousSampledAtEpochMs: number | null;
}): LiveTaskResourceUsageSnapshot[] {
	const groups = new Map<
		string,
		{
			workspaceId: string;
			attributedTaskCardId: string | null;
			totals: MutableClassificationTotals;
			cpuSeconds: number;
			cpuComparable: boolean;
		}
	>();
	for (const entry of input.registry.values()) {
		const { workspaceId, attributedTaskCardId } = entry.attribution;
		if (workspaceId === null) {
			continue;
		}
		const groupKey = `${workspaceId}\u0000${attributedTaskCardId ?? ""}`;
		let group = groups.get(groupKey);
		if (!group) {
			group = {
				workspaceId,
				attributedTaskCardId,
				totals: createClassificationTotals(),
				cpuSeconds: 0,
				cpuComparable: false,
			};
			groups.set(groupKey, group);
		}
		accumulateEntryIntoClassificationTotals(group.totals, entry);
		const baselineSeconds =
			entry.cumulativeCpuTimeSecondsAtPreviousObservation !== null
				? entry.cumulativeCpuTimeSecondsAtPreviousObservation
				: input.previousSampledAtEpochMs !== null &&
						entry.processStartedAtEpochMs !== null &&
						entry.processStartedAtEpochMs >= input.previousSampledAtEpochMs
					? 0
					: null;
		if (baselineSeconds !== null) {
			group.cpuSeconds += Math.max(0, entry.cumulativeCpuTimeSecondsAtLastObservation - baselineSeconds);
			group.cpuComparable = true;
		}
	}
	const intervalMs =
		input.previousSampledAtEpochMs === null ? null : input.sampledAtEpochMs - input.previousSampledAtEpochMs;
	return Array.from(groups.values(), (group) => ({
		workspaceId: group.workspaceId,
		attributedTaskCardId: group.attributedTaskCardId,
		sampledAtEpochMs: input.sampledAtEpochMs,
		attributedProcessCount: group.totals.attributedProcessCount,
		residentSetSizeKibibytesSumUpperBound: group.totals.residentSetSizeKibibytesSumUpperBound,
		cpuPercentOfOneCoreOverLastSampleInterval:
			group.cpuComparable && intervalMs !== null && intervalMs > 0
				? Math.round(((group.cpuSeconds * 1000) / intervalMs) * 1000) / 10
				: null,
		survivedSessionRootExitProcessCount: group.totals.survivedSessionRootExitProcessCount,
		survivedSessionRootExitResidentSetSizeKibibytesSum:
			group.totals.survivedSessionRootExitResidentSetSizeKibibytesSum,
		agentHarnessRootPhysicalFootprintBytes: group.totals.agentHarnessRootPhysicalFootprintBytes,
		processCountByProcessClassification: group.totals.processCountByProcessClassification,
		residentSetSizeKibibytesSumUpperBoundByProcessClassification:
			group.totals.residentSetSizeKibibytesSumUpperBoundByProcessClassification,
		mcpServerInstances: serializeMcpServerInstanceTotals(group.totals.mcpServerInstanceTotalsByLabel),
	}));
}
