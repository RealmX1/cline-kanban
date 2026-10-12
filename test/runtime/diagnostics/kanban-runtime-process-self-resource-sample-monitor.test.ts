import { describe, expect, it } from "vitest";

import { buildKanbanRuntimeProcessSelfResourceSamplePayload } from "../../../src/diagnostics/kanban-runtime-process-self-resource-sample-monitor";

function resourceUsage(userCPUTime: number, systemCPUTime: number): NodeJS.ResourceUsage {
	return { ...process.resourceUsage(), userCPUTime, systemCPUTime, maxRSS: 720_000 };
}

const MEMORY_USAGE: NodeJS.MemoryUsage = {
	rss: 700 * 1024 ** 2,
	heapUsed: 180 * 1024 ** 2,
	heapTotal: 220 * 1024 ** 2,
	external: 40 * 1024 ** 2,
	arrayBuffers: 12 * 1024 ** 2,
};

describe("buildKanbanRuntimeProcessSelfResourceSamplePayload", () => {
	it("reports the CPU consumed since the previous sample so a busy window stands out", () => {
		const payload = buildKanbanRuntimeProcessSelfResourceSamplePayload({
			memoryUsage: MEMORY_USAGE,
			resourceUsage: resourceUsage(12_000_000, 3_000_000),
			previousResourceUsage: resourceUsage(10_000_000, 2_500_000),
			processUptimeSeconds: 3600.4,
			liveInProcessClineSdkSessionCount: 2,
			liveSessionWithOsProcessCount: 17,
		});

		expect(payload).toMatchObject({
			residentSetSizeBytes: 700 * 1024 ** 2,
			heapUsedBytes: 180 * 1024 ** 2,
			lifetimeMaximumResidentSetSizeKibibytes: 720_000,
			cumulativeUserCpuTimeSeconds: 12,
			cumulativeSystemCpuTimeSeconds: 3,
			cpuTimeSecondsConsumedSincePreviousSample: 2.5,
			processUptimeSeconds: 3600,
			liveInProcessClineSdkSessionCount: 2,
			liveSessionWithOsProcessCount: 17,
		});
	});

	it("leaves the CPU delta empty for the baseline sample", () => {
		expect(
			buildKanbanRuntimeProcessSelfResourceSamplePayload({
				memoryUsage: MEMORY_USAGE,
				resourceUsage: resourceUsage(1, 1),
				previousResourceUsage: null,
				processUptimeSeconds: 1,
				liveInProcessClineSdkSessionCount: 0,
				liveSessionWithOsProcessCount: 0,
			}).cpuTimeSecondsConsumedSincePreviousSample,
		).toBeNull();
	});
});
