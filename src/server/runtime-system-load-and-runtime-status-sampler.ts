import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import type { RuntimeSystemLoadAndRuntimeStatusSnapshot, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";

export function startRuntimeSystemLoadAndRuntimeStatusSampler(deps: {
	dataDirectoryPath: string;
	listAgentSessionSummaries: () => RuntimeTaskSessionSummary[];
	onSnapshot: (snapshot: RuntimeSystemLoadAndRuntimeStatusSnapshot) => void;
}): () => void {
	let previousCpuTimes: { idle: number; total: number }[] | null = null;
	let sampleCollectionInProgress = false;
	let samplerStopped = false;

	const readCpuUsagePercent = (): number | null => {
		try {
			const currentCpuTimes = cpus().map(({ times }) => ({
				idle: times.idle,
				total: times.user + times.nice + times.sys + times.idle + times.irq,
			}));
			const previousCpuTimesSample = previousCpuTimes;
			previousCpuTimes = currentCpuTimes;
			if (
				!previousCpuTimesSample ||
				currentCpuTimes.length === 0 ||
				currentCpuTimes.length !== previousCpuTimesSample.length
			)
				return null;
			let totalDelta = 0;
			let idleDelta = 0;
			for (const [index, cpu] of currentCpuTimes.entries()) {
				const total = cpu.total - previousCpuTimesSample[index].total;
				const idle = cpu.idle - previousCpuTimesSample[index].idle;
				if (total < 0 || idle < 0 || idle > total) return null;
				totalDelta += total;
				idleDelta += idle;
			}
			return totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null;
		} catch {
			previousCpuTimes = null;
			return null;
		}
	};
	const readOrUnavailable = <T>(read: () => T): T | null => {
		try {
			return read();
		} catch {
			return null;
		}
	};
	const collectAndPublishSystemLoadAndRuntimeStatusSnapshot = async () => {
		if (sampleCollectionInProgress || samplerStopped) return;
		sampleCollectionInProgress = true;
		try {
			const snapshot: RuntimeSystemLoadAndRuntimeStatusSnapshot = {
				sampledAtEpochMs: Date.now(),
				cpuUsagePercent: readCpuUsagePercent(),
				memory: readOrUnavailable(() => {
					const totalBytes = totalmem();
					const usedBytes = totalBytes - freemem();
					return totalBytes > 0 && usedBytes >= 0 && usedBytes <= totalBytes ? { usedBytes, totalBytes } : null;
				}),
				disk: null,
				runtimeUptimeSeconds: readOrUnavailable(() => process.uptime()),
				liveAgentSessionCount: readOrUnavailable(
					() =>
						deps
							.listAgentSessionSummaries()
							.filter((summary) => summary.agentId !== null && resolveSessionFacets(summary).liveness === "live")
							.length,
				),
			};
			try {
				const disk = await statfs(deps.dataDirectoryPath);
				const availableBytes = disk.bavail * disk.bsize;
				const totalBytes = disk.blocks * disk.bsize;
				if (totalBytes > 0 && availableBytes >= 0 && availableBytes <= totalBytes)
					snapshot.disk = { availableBytes, totalBytes };
			} catch {
				// 单项失败保留未知值，下一轮继续读取同一数据目录。
			}
			if (!samplerStopped) deps.onSnapshot(snapshot);
		} finally {
			sampleCollectionInProgress = false;
		}
	};
	void collectAndPublishSystemLoadAndRuntimeStatusSnapshot();
	const systemStatusSamplingTimer = setInterval(() => {
		void collectAndPublishSystemLoadAndRuntimeStatusSnapshot();
	}, 5_000);
	systemStatusSamplingTimer.unref();
	return () => {
		samplerStopped = true;
		clearInterval(systemStatusSamplingTimer);
	};
}
