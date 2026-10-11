// Kanban 运行时进程自身的内存 / CPU 基线，每 5 分钟一条。
//
// 两个用途：
//   - 「固定服务器成本」的对照：谈 Kanban 资源占用时，先把它与「随任务数的 agent 进程成本」「随标签页数的
//     前端成本」分开；
//   - 进程内 Cline SDK 会话唯一可见的资源面：它与 Kanban 同进程，无法按 OS 进程拆分，只能从这条基线的
//     heap / CPU 走势间接观察（配合同一条记录里的活跃会话数）。

import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";

const KANBAN_RUNTIME_PROCESS_SELF_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60_000;

export interface KanbanRuntimeProcessSelfResourceSampleContext {
	countLiveInProcessClineSdkSessions: () => number;
	countLiveSessionsWithOsProcess: () => number;
}

export function buildKanbanRuntimeProcessSelfResourceSamplePayload(input: {
	memoryUsage: NodeJS.MemoryUsage;
	resourceUsage: NodeJS.ResourceUsage;
	previousResourceUsage: NodeJS.ResourceUsage | null;
	processUptimeSeconds: number;
	liveInProcessClineSdkSessionCount: number;
	liveSessionWithOsProcessCount: number;
}): Record<string, unknown> {
	const { memoryUsage, resourceUsage, previousResourceUsage } = input;
	const cpuMicrosecondsTotal = resourceUsage.userCPUTime + resourceUsage.systemCPUTime;
	const previousCpuMicrosecondsTotal =
		previousResourceUsage === null ? null : previousResourceUsage.userCPUTime + previousResourceUsage.systemCPUTime;
	return {
		residentSetSizeBytes: memoryUsage.rss,
		heapUsedBytes: memoryUsage.heapUsed,
		heapTotalBytes: memoryUsage.heapTotal,
		externalMemoryBytes: memoryUsage.external,
		arrayBuffersBytes: memoryUsage.arrayBuffers,
		// resourceUsage().maxRSS 单位是 KiB（进程生命周期内的峰值）。
		lifetimeMaximumResidentSetSizeKibibytes: resourceUsage.maxRSS,
		cumulativeUserCpuTimeSeconds: resourceUsage.userCPUTime / 1e6,
		cumulativeSystemCpuTimeSeconds: resourceUsage.systemCPUTime / 1e6,
		cpuTimeSecondsConsumedSincePreviousSample:
			previousCpuMicrosecondsTotal === null ? null : (cpuMicrosecondsTotal - previousCpuMicrosecondsTotal) / 1e6,
		processUptimeSeconds: Math.round(input.processUptimeSeconds),
		liveInProcessClineSdkSessionCount: input.liveInProcessClineSdkSessionCount,
		liveSessionWithOsProcessCount: input.liveSessionWithOsProcessCount,
		sampleIntervalMs: KANBAN_RUNTIME_PROCESS_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
	};
}

export function startKanbanRuntimeProcessSelfResourceSampleMonitor(
	context: KanbanRuntimeProcessSelfResourceSampleContext,
): () => void {
	let previousResourceUsage: NodeJS.ResourceUsage | null = null;
	const recordKanbanRuntimeProcessSelfResourceSample = (): void => {
		try {
			const resourceUsage = process.resourceUsage();
			appendDiagnosticEventToRotatingJsonlJournal(
				"kanban-runtime-process-self-resource-sample",
				buildKanbanRuntimeProcessSelfResourceSamplePayload({
					memoryUsage: process.memoryUsage(),
					resourceUsage,
					previousResourceUsage,
					processUptimeSeconds: process.uptime(),
					liveInProcessClineSdkSessionCount: context.countLiveInProcessClineSdkSessions(),
					liveSessionWithOsProcessCount: context.countLiveSessionsWithOsProcess(),
				}),
			);
			previousResourceUsage = resourceUsage;
		} catch {
			// 诊断探针绝不能影响运行时。
		}
	};
	// 启动即留一个基线点：「本进程起步时占多少」是后续走势的参照。
	recordKanbanRuntimeProcessSelfResourceSample();
	const sampleTimer = setInterval(
		recordKanbanRuntimeProcessSelfResourceSample,
		KANBAN_RUNTIME_PROCESS_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
	);
	sampleTimer.unref();
	return () => {
		clearInterval(sampleTimer);
	};
}
