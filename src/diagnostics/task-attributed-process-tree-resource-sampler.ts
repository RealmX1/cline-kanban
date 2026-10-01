// 按 task 归因的进程资源采样器：定时读进程表，归因到 task，维护生命周期注册表，写 journal、推实时快照。
// 本文件只负责「时序 + I/O」；归因、分类、聚合都在同目录的纯函数模块里（各自有单测）。
//
// 每个 tick（15 秒）：
//   1. 读进程表资源列（不含 argv，~50ms）；
//   2. 第一遍归因，拿到「缺 argv / 缺 cwd / 缺 env」的清单，按清单定向补读，结果按进程身份键缓存；
//   3. 第二遍归因，推进注册表：消失的进程写一条生命周期 episode；
//   4. 每 10 分钟低频补读 harness 根进程与 RSS 前几名的 phys_footprint；
//   5. 每 5 分钟每个会话写一条聚合快照；
//   6. 实时快照交给回调（供看板药丸）。
// 采样器停止时把仍存活进程的生命周期冲刷成 episode（endedBy = sampler_stopped），否则长寿进程永远写不出记录。

import type { TaskResourceUsageAttributionRootEnumeration } from "../server/task-resource-usage-attribution-root-enumeration";
import { readDarwinPhysicalFootprintBytesForProcessIds } from "./darwin-process-physical-footprint-low-frequency-sampler";
import {
	buildProcessLifetimeIdentityKey,
	type PosixProcessResourceTableRow,
	readCurrentWorkingDirectoriesForProcessIds,
	readKanbanEnvironmentVariablesForProcessIds,
	readPosixProcessResourceTable,
	readProcessCommandLinesForProcessIds,
} from "./posix-process-table-with-resource-columns-reader";
import {
	extractAgentShellToolInnerCommandFromWrapperCommandLine,
	type ProcessCommandLineDiagnosticJournalSummary,
	summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided,
	summarizeProcessCommandLineForDiagnosticJournal,
} from "./process-command-line-text-truncation-and-secret-redaction";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
	type DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";
import {
	processCommandLineCarriesAgentHarnessPromptArguments,
	processCommandLineServesAsAgentHarnessRootArgumentTailReference,
	type TaskAttributedProcessClassification,
} from "./task-attributed-process-classification-rules";
import {
	advanceTaskAttributedProcessLifetimeRegistry,
	applyPhysicalFootprintSamplesToRegistry,
	buildLiveTaskResourceUsageSnapshots,
	buildTaskAttributedProcessLifetimeEpisodeJournalPayload,
	buildTaskAttributedProcessTreePeriodicResourceSnapshots,
	type LiveTaskResourceUsageSnapshot,
	type TaskAttributedProcessLifetimeEndedBy,
	type TaskAttributedProcessLifetimeRegistryEntry,
} from "./task-attributed-process-lifetime-registry";
import {
	attributeProcessTableSampleToTasks,
	type TaskAttributedProcessAttribution,
	type TaskAttributedProcessTreeSampleAttributionInput,
} from "./task-attributed-process-tree-sample-attribution";

// EXPERIMENT_NODE: 采样周期 15 秒——越短越能看到中等寿命命令的峰值，代价是 ps 调用频率（全表 ~50ms/次）。
export const TASK_ATTRIBUTED_PROCESS_TREE_SAMPLE_INTERVAL_MS = 15_000;
// EXPERIMENT_NODE: 周期快照落盘间隔 5 分钟——决定事后时间序列的分辨率与 journal 体积（~5 MB/天 @ 25 会话）。
const TASK_ATTRIBUTED_PROCESS_TREE_PERIODIC_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
// EXPERIMENT_NODE: footprint 周期 10 分钟、额外覆盖 RSS 前 5 名——top 读 30 个 pid 实测 3.5 秒，不能更频繁。
const PHYSICAL_FOOTPRINT_SAMPLE_INTERVAL_MS = 10 * 60_000;
const PHYSICAL_FOOTPRINT_EXTRA_LARGEST_PROCESS_COUNT = 5;

export interface TaskAttributedProcessTreeResourceSamplerDependencies {
	enumerateAttributionRoots: () => TaskResourceUsageAttributionRootEnumeration;
	onLiveTaskResourceUsageSnapshotsUpdated?: (snapshots: LiveTaskResourceUsageSnapshot[]) => void;
	kanbanRuntimeProcessId?: number;
	now?: () => number;
	readProcessResourceTable?: () => Promise<PosixProcessResourceTableRow[]>;
	readProcessCommandLines?: (processIds: readonly number[]) => Promise<Map<number, string>>;
	readCurrentWorkingDirectories?: (processIds: readonly number[]) => Promise<Map<number, string>>;
	readKanbanEnvironment?: (processIds: readonly number[]) => Promise<Map<number, Record<string, string>>>;
	readPhysicalFootprints?: (processIds: readonly number[]) => Promise<Map<number, number>>;
	appendJournalEvent?: (channel: DiagnosticEventJournalChannel, payload: DiagnosticEventJournalPayload) => void;
}

export interface TaskAttributedProcessTreeResourceSampler {
	start: () => void;
	stop: () => void;
	runSampleTick: () => Promise<void>;
	getLatestLiveTaskResourceUsageSnapshots: () => LiveTaskResourceUsageSnapshot[];
}

// 命令文本：agent harness 自身的进程只记可执行文件名 + 参数字符数（argv 里装着 prompt）；Bash 工具外壳只记它
// 包着的那条命令，其余进程记 argv 本身；后两者一律截断 + 脱敏。
function summarizeCommandLineOfAttributedProcess(
	commandLine: string,
	commandLineCarriesAgentHarnessPromptArguments: boolean,
): ProcessCommandLineDiagnosticJournalSummary {
	if (commandLineCarriesAgentHarnessPromptArguments) {
		return summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided(commandLine);
	}
	return summarizeProcessCommandLineForDiagnosticJournal(
		extractAgentShellToolInnerCommandFromWrapperCommandLine(commandLine) ?? commandLine,
	);
}

function retainOnlyLiveKeys<T>(cache: Map<string, T>, liveKeys: ReadonlySet<string>): void {
	for (const key of cache.keys()) {
		if (!liveKeys.has(key)) {
			cache.delete(key);
		}
	}
}

export function createTaskAttributedProcessTreeResourceSampler(
	deps: TaskAttributedProcessTreeResourceSamplerDependencies,
): TaskAttributedProcessTreeResourceSampler {
	const now = deps.now ?? Date.now;
	const kanbanRuntimeProcessId = deps.kanbanRuntimeProcessId ?? process.pid;
	const readProcessResourceTable = deps.readProcessResourceTable ?? readPosixProcessResourceTable;
	const readProcessCommandLines = deps.readProcessCommandLines ?? readProcessCommandLinesForProcessIds;
	const readCurrentWorkingDirectories =
		deps.readCurrentWorkingDirectories ?? readCurrentWorkingDirectoriesForProcessIds;
	const readKanbanEnvironment = deps.readKanbanEnvironment ?? readKanbanEnvironmentVariablesForProcessIds;
	const readPhysicalFootprints = deps.readPhysicalFootprints ?? readDarwinPhysicalFootprintBytesForProcessIds;
	const appendJournalEvent = deps.appendJournalEvent ?? appendDiagnosticEventToRotatingJsonlJournal;

	// 按进程身份键（pid + lstart）缓存的补读结果；每个 tick 裁掉已消失的键，缓存规模 ≈ 当前进程数。
	const commandLineByProcessLifetimeIdentityKey = new Map<string, string>();
	const currentWorkingDirectoryByProcessLifetimeIdentityKey = new Map<string, string>();
	const kanbanEnvironmentByProcessLifetimeIdentityKey = new Map<string, Record<string, string>>();
	const commandLineSummaryByProcessLifetimeIdentityKey = new Map<string, ProcessCommandLineDiagnosticJournalSummary>();
	// 摘要当时依据的分类。一个进程可能先以别的身份被摘要、后来才认出是 harness（会话 summary 晚一拍盖上 pid 时，
	// harness 根先按 cwd 归成「Kanban 拉起的进程」，它 re-exec 出的子进程也跟着归错），所以分类一变就重新判定；
	// 一旦按「harness 参数全部省略」摘要过就不再重算——只升级不降级，episode 写出时拿到的一定是省略后的版本。
	// 分类不变时不重判：判定要切出 harness 根 ~144 KB 的参数尾，不能每个 tick 对每个进程都做一遍。
	const commandLineSummaryBasisByProcessLifetimeIdentityKey = new Map<
		string,
		TaskAttributedProcessClassification | "agent_harness_prompt_arguments_elided"
	>();

	let registry = new Map<string, TaskAttributedProcessLifetimeRegistryEntry>();
	let latestLiveTaskResourceUsageSnapshots: LiveTaskResourceUsageSnapshot[] = [];
	let samplerStartedAtEpochMs: number | null = null;
	let previousSampledAtEpochMs: number | null = null;
	let previousPeriodicSnapshotAtEpochMs: number | null = null;
	let nextPeriodicSnapshotDueAtEpochMs: number | null = null;
	let nextPhysicalFootprintSampleDueAtEpochMs = 0;
	let sampleTimer: NodeJS.Timeout | null = null;
	let sampleTickInFlight = false;
	let stopped = false;
	let firstFailureReported = false;

	const writeEndedProcessLifetimeEpisodes = (
		entries: readonly TaskAttributedProcessLifetimeRegistryEntry[],
		endedBy: TaskAttributedProcessLifetimeEndedBy,
	): void => {
		for (const entry of entries) {
			appendJournalEvent(
				"task-attributed-process-lifetime-episode",
				buildTaskAttributedProcessLifetimeEpisodeJournalPayload(
					entry,
					endedBy,
					TASK_ATTRIBUTED_PROCESS_TREE_SAMPLE_INTERVAL_MS,
				),
			);
		}
	};

	const fillMissingLookups = async (
		processTableRows: readonly PosixProcessResourceTableRow[],
		missing: {
			processIdsMissingCommandLine: number[];
			kanbanRuntimeChildProcessIdsMissingWorkingDirectory: number[];
			orphanCandidateProcessIdsMissingKanbanEnvironment: number[];
		},
	): Promise<void> => {
		const rowsByProcessId = new Map(processTableRows.map((row) => [row.processId, row]));
		const keyOfProcessId = (processId: number): string | null => {
			const row = rowsByProcessId.get(processId);
			return row ? buildProcessLifetimeIdentityKey(row.processId, row.processStartTimeText) : null;
		};
		// 读不到（进程已退出 / 无权读取）的也记一个空值，避免每个 tick 重复补读同一个进程。
		const store = <T>(
			cache: Map<string, T>,
			processIds: readonly number[],
			results: Map<number, T>,
			emptyValue: T,
		) => {
			for (const processId of processIds) {
				const key = keyOfProcessId(processId);
				if (key !== null) {
					cache.set(key, results.get(processId) ?? emptyValue);
				}
			}
		};
		if (missing.processIdsMissingCommandLine.length > 0) {
			store(
				commandLineByProcessLifetimeIdentityKey,
				missing.processIdsMissingCommandLine,
				await readProcessCommandLines(missing.processIdsMissingCommandLine),
				"",
			);
		}
		if (missing.kanbanRuntimeChildProcessIdsMissingWorkingDirectory.length > 0) {
			store(
				currentWorkingDirectoryByProcessLifetimeIdentityKey,
				missing.kanbanRuntimeChildProcessIdsMissingWorkingDirectory,
				await readCurrentWorkingDirectories(missing.kanbanRuntimeChildProcessIdsMissingWorkingDirectory),
				"",
			);
		}
		if (missing.orphanCandidateProcessIdsMissingKanbanEnvironment.length > 0) {
			store(
				kanbanEnvironmentByProcessLifetimeIdentityKey,
				missing.orphanCandidateProcessIdsMissingKanbanEnvironment,
				await readKanbanEnvironment(missing.orphanCandidateProcessIdsMissingKanbanEnvironment),
				{},
			);
		}
	};

	const sampleLowFrequencyPhysicalFootprints = async (sampledAtEpochMs: number): Promise<void> => {
		if (sampledAtEpochMs < nextPhysicalFootprintSampleDueAtEpochMs || registry.size === 0) {
			return;
		}
		nextPhysicalFootprintSampleDueAtEpochMs = sampledAtEpochMs + PHYSICAL_FOOTPRINT_SAMPLE_INTERVAL_MS;
		const entries = Array.from(registry.values());
		const processIds = new Set(
			entries
				.filter((entry) => entry.attribution.processClassification === "agent_harness_root_process")
				.map((entry) => entry.processId),
		);
		for (const entry of entries
			.slice()
			.sort((left, right) => right.lastObservedResidentSetSizeKibibytes - left.lastObservedResidentSetSizeKibibytes)
			.slice(0, PHYSICAL_FOOTPRINT_EXTRA_LARGEST_PROCESS_COUNT)) {
			processIds.add(entry.processId);
		}
		const physicalFootprintBytesByProcessId = await readPhysicalFootprints(Array.from(processIds));
		if (!stopped) {
			registry = applyPhysicalFootprintSamplesToRegistry(registry, physicalFootprintBytesByProcessId);
		}
	};

	const runSampleTickUnguarded = async (): Promise<void> => {
		const processTableRows = await readProcessResourceTable();
		const liveProcessLifetimeIdentityKeys = new Set(
			processTableRows.map((row) => buildProcessLifetimeIdentityKey(row.processId, row.processStartTimeText)),
		);
		retainOnlyLiveKeys(commandLineByProcessLifetimeIdentityKey, liveProcessLifetimeIdentityKeys);
		retainOnlyLiveKeys(currentWorkingDirectoryByProcessLifetimeIdentityKey, liveProcessLifetimeIdentityKeys);
		retainOnlyLiveKeys(kanbanEnvironmentByProcessLifetimeIdentityKey, liveProcessLifetimeIdentityKeys);
		retainOnlyLiveKeys(commandLineSummaryByProcessLifetimeIdentityKey, liveProcessLifetimeIdentityKeys);
		retainOnlyLiveKeys(commandLineSummaryBasisByProcessLifetimeIdentityKey, liveProcessLifetimeIdentityKeys);

		const enumeration = deps.enumerateAttributionRoots();
		const rememberedAttributionByProcessLifetimeIdentityKey = new Map<string, TaskAttributedProcessAttribution>();
		for (const [key, entry] of registry) {
			rememberedAttributionByProcessLifetimeIdentityKey.set(key, entry.attribution);
		}
		const buildAttributionInput = (): TaskAttributedProcessTreeSampleAttributionInput => ({
			processTableRows,
			attributionRoots: enumeration.roots,
			taskWorkingDirectoryAttributions: enumeration.taskWorkingDirectoryAttributions,
			kanbanRuntimeProcessId,
			commandLineByProcessLifetimeIdentityKey,
			currentWorkingDirectoryByProcessLifetimeIdentityKey,
			kanbanEnvironmentByProcessLifetimeIdentityKey,
			rememberedAttributionByProcessLifetimeIdentityKey,
			workspaceIdByWorkspacePath: enumeration.workspaceIdByWorkspacePath,
		});
		// 补读最多两轮：第一轮补齐进程树成员的 argv、Kanban 子进程的 cwd、孤儿候选的 env；只有读到 env 才
		// 认出的孤儿，要到第二轮才知道还得补读它的 argv。
		for (let lookupFillRound = 0; lookupFillRound < 2; lookupFillRound++) {
			const pendingLookups = attributeProcessTableSampleToTasks(buildAttributionInput());
			if (
				pendingLookups.processIdsMissingCommandLine.length === 0 &&
				pendingLookups.kanbanRuntimeChildProcessIdsMissingWorkingDirectory.length === 0 &&
				pendingLookups.orphanCandidateProcessIdsMissingKanbanEnvironment.length === 0
			) {
				break;
			}
			await fillMissingLookups(processTableRows, pendingLookups);
			if (stopped) {
				return;
			}
		}
		const { observations } = attributeProcessTableSampleToTasks(buildAttributionInput());

		// 「是否回显 harness 参数尾」的比对基准：会话树的 harness 根，以及 Kanban 重启后经 env 找回、本身认得出是
		// harness 的孤儿头（它在后续 tick 走「沿用记忆」锚点时归因不变，照样按自身身份键登记）。
		const agentHarnessRootCommandLineByRootProcessLifetimeIdentityKey = new Map<string, string>();
		for (const observation of observations) {
			const commandLine = commandLineByProcessLifetimeIdentityKey.get(observation.processLifetimeIdentityKey);
			if (
				commandLine &&
				processCommandLineServesAsAgentHarnessRootArgumentTailReference({
					processClassification: observation.attribution.processClassification,
					processIsAttributionRoot:
						observation.processLifetimeIdentityKey ===
						observation.attribution.attributionRootProcessLifetimeIdentityKey,
					processCommandLine: commandLine,
				})
			) {
				agentHarnessRootCommandLineByRootProcessLifetimeIdentityKey.set(
					observation.processLifetimeIdentityKey,
					commandLine,
				);
			}
		}
		for (const observation of observations) {
			const key = observation.processLifetimeIdentityKey;
			const commandLine = commandLineByProcessLifetimeIdentityKey.get(key);
			const { processClassification } = observation.attribution;
			const commandLineSummaryBasis = commandLineSummaryBasisByProcessLifetimeIdentityKey.get(key);
			if (
				!commandLine ||
				commandLineSummaryBasis === "agent_harness_prompt_arguments_elided" ||
				commandLineSummaryBasis === processClassification
			) {
				continue;
			}
			const commandLineCarriesAgentHarnessPromptArguments = processCommandLineCarriesAgentHarnessPromptArguments({
				processClassification,
				processCommandLine: commandLine,
				agentHarnessRootCommandLine:
					agentHarnessRootCommandLineByRootProcessLifetimeIdentityKey.get(
						observation.attribution.attributionRootProcessLifetimeIdentityKey,
					) ?? null,
			});
			commandLineSummaryBasisByProcessLifetimeIdentityKey.set(
				key,
				commandLineCarriesAgentHarnessPromptArguments
					? "agent_harness_prompt_arguments_elided"
					: processClassification,
			);
			commandLineSummaryByProcessLifetimeIdentityKey.set(
				key,
				summarizeCommandLineOfAttributedProcess(commandLine, commandLineCarriesAgentHarnessPromptArguments),
			);
		}

		const sampledAtEpochMs = now();
		const { nextRegistry, endedProcessLifetimeEntries } = advanceTaskAttributedProcessLifetimeRegistry({
			previousRegistry: registry,
			observations,
			sampledAtEpochMs,
			commandLineSummaryByProcessLifetimeIdentityKey,
		});
		registry = nextRegistry;
		writeEndedProcessLifetimeEpisodes(endedProcessLifetimeEntries, "process_exited_between_samples");

		await sampleLowFrequencyPhysicalFootprints(sampledAtEpochMs);
		if (stopped) {
			return;
		}

		if (nextPeriodicSnapshotDueAtEpochMs !== null && sampledAtEpochMs >= nextPeriodicSnapshotDueAtEpochMs) {
			const { snapshotJournalPayloads, registryWithUpdatedSnapshotBaselines } =
				buildTaskAttributedProcessTreePeriodicResourceSnapshots({
					registry,
					snapshotAtEpochMs: sampledAtEpochMs,
					previousSnapshotAtEpochMs: previousPeriodicSnapshotAtEpochMs ?? samplerStartedAtEpochMs,
				});
			registry = registryWithUpdatedSnapshotBaselines;
			for (const payload of snapshotJournalPayloads) {
				appendJournalEvent("task-attributed-process-tree-periodic-resource-snapshot", payload);
			}
			previousPeriodicSnapshotAtEpochMs = sampledAtEpochMs;
			nextPeriodicSnapshotDueAtEpochMs =
				sampledAtEpochMs + TASK_ATTRIBUTED_PROCESS_TREE_PERIODIC_SNAPSHOT_INTERVAL_MS;
		}

		latestLiveTaskResourceUsageSnapshots = buildLiveTaskResourceUsageSnapshots({
			registry,
			sampledAtEpochMs,
			previousSampledAtEpochMs,
		});
		previousSampledAtEpochMs = sampledAtEpochMs;
		deps.onLiveTaskResourceUsageSnapshotsUpdated?.(latestLiveTaskResourceUsageSnapshots);
	};

	const runSampleTick = async (): Promise<void> => {
		if (sampleTickInFlight || stopped) {
			return;
		}
		sampleTickInFlight = true;
		try {
			await runSampleTickUnguarded();
		} catch (error) {
			// 诊断采样失败绝不能影响运行时；只在第一次失败时留一行 stderr 供排查（没有 ps 的平台会一直失败）。
			if (!firstFailureReported) {
				firstFailureReported = true;
				try {
					process.stderr.write(
						`[warn] [task-resource-usage-sampler] 采样失败，此后静默重试：${error instanceof Error ? error.message : String(error)}\n`,
					);
				} catch {
					// Best-effort diagnostic logging only.
				}
			}
		} finally {
			sampleTickInFlight = false;
		}
	};

	return {
		start: () => {
			if (sampleTimer !== null || stopped) {
				return;
			}
			samplerStartedAtEpochMs = now();
			nextPeriodicSnapshotDueAtEpochMs =
				samplerStartedAtEpochMs + TASK_ATTRIBUTED_PROCESS_TREE_PERIODIC_SNAPSHOT_INTERVAL_MS;
			void runSampleTick();
			sampleTimer = setInterval(() => {
				void runSampleTick();
			}, TASK_ATTRIBUTED_PROCESS_TREE_SAMPLE_INTERVAL_MS);
			sampleTimer.unref();
		},
		stop: () => {
			if (stopped) {
				return;
			}
			stopped = true;
			if (sampleTimer !== null) {
				clearInterval(sampleTimer);
				sampleTimer = null;
			}
			writeEndedProcessLifetimeEpisodes(Array.from(registry.values()), "sampler_stopped");
			registry = new Map();
		},
		runSampleTick,
		getLatestLiveTaskResourceUsageSnapshots: () => latestLiveTaskResourceUsageSnapshots,
	};
}
