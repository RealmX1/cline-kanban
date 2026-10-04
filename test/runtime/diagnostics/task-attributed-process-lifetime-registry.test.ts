import { describe, expect, it } from "vitest";

import type { PosixProcessResourceTableRow } from "../../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import type { TaskAttributedProcessClassification } from "../../../src/diagnostics/task-attributed-process-classification-rules";
import {
	advanceTaskAttributedProcessLifetimeRegistry,
	applyPhysicalFootprintSamplesToRegistry,
	buildLiveTaskResourceUsageSnapshots,
	buildTaskAttributedProcessLifetimeEpisodeJournalPayload,
	buildTaskAttributedProcessTreePeriodicResourceSnapshots,
	type TaskAttributedProcessLifetimeRegistry,
} from "../../../src/diagnostics/task-attributed-process-lifetime-registry";
import type { TaskAttributedProcessObservation } from "../../../src/diagnostics/task-attributed-process-tree-sample-attribution";

const SAMPLE_INTERVAL_MS = 15_000;
const T0 = 1_790_000_000_000;
// 采样器启动前一小时就在跑的会话。
const LONG_RUNNING_PROCESS_STARTED_AT_EPOCH_MS = T0 - 3_600_000;

function observation(
	processId: number,
	options: {
		rss?: number;
		cpu?: number;
		startedAt?: number;
		classification?: TaskAttributedProcessClassification;
		mcpLabel?: string | null;
		rootAlive?: boolean;
		anchor?: TaskAttributedProcessObservation["attributionAnchor"];
		taskCardId?: string | null;
	} = {},
): TaskAttributedProcessObservation {
	const processTableRow: PosixProcessResourceTableRow = {
		processId,
		parentProcessId: 1,
		processGroupId: processId,
		residentSetSizeKibibytes: options.rss ?? 1_000,
		cumulativeCpuTimeSeconds: options.cpu ?? 0,
		processStartTimeText: `start-${processId}`,
		processStartedAtEpochMs: options.startedAt ?? LONG_RUNNING_PROCESS_STARTED_AT_EPOCH_MS,
		processStateCode: "S",
	};
	return {
		processLifetimeIdentityKey: `${processId}@start-${processId}`,
		processTableRow,
		attributionAnchor: options.anchor ?? "session_root_process_tree",
		attributionRootProcessIsAlive: options.rootAlive ?? true,
		attribution: {
			workspaceId: "repo",
			attributedTaskCardId: options.taskCardId === undefined ? "ab12c" : options.taskCardId,
			sessionTaskId: "ab12c",
			sessionCategory: "task_card_main_agent_session",
			sessionTransport: "pty_terminal",
			agentId: "claude",
			runtimeSessionIncarnationId: "inc-1",
			attributionRootProcessId: 100,
			attributionRootProcessLifetimeIdentityKey: "100@start-100",
			branchHeadProcessId: processId,
			processClassification: options.classification ?? "agent_harness_root_process",
			mcpServerInstanceLabel: options.mcpLabel ?? null,
		},
	};
}

function advance(
	previousRegistry: TaskAttributedProcessLifetimeRegistry,
	observations: TaskAttributedProcessObservation[],
	sampledAtEpochMs: number,
) {
	return advanceTaskAttributedProcessLifetimeRegistry({
		previousRegistry,
		observations,
		sampledAtEpochMs,
		commandLineSummaryByProcessLifetimeIdentityKey: new Map(),
	});
}

describe("advanceTaskAttributedProcessLifetimeRegistry", () => {
	it("tracks the peak RSS across samples and hands a process back as ended once it disappears", () => {
		let { nextRegistry } = advance(
			new Map(),
			[observation(200, { rss: 500, classification: "agent_shell_tool_command_process" })],
			T0,
		);
		({ nextRegistry } = advance(
			nextRegistry,
			[observation(200, { rss: 900_000, classification: "agent_shell_tool_command_process" })],
			T0 + SAMPLE_INTERVAL_MS,
		));
		({ nextRegistry } = advance(
			nextRegistry,
			[observation(200, { rss: 1_000, classification: "agent_shell_tool_command_process" })],
			T0 + 2 * SAMPLE_INTERVAL_MS,
		));
		const { endedProcessLifetimeEntries } = advance(nextRegistry, [], T0 + 3 * SAMPLE_INTERVAL_MS);

		expect(endedProcessLifetimeEntries).toHaveLength(1);
		expect(endedProcessLifetimeEntries[0]).toMatchObject({
			processId: 200,
			observedSampleCount: 3,
			peakObservedResidentSetSizeKibibytes: 900_000,
			lastObservedResidentSetSizeKibibytes: 1_000,
		});
	});

	it("marks a process that stayed alive after its session root exited as surviving the root", () => {
		let { nextRegistry } = advance(new Map(), [observation(200)], T0);
		({ nextRegistry } = advance(
			nextRegistry,
			[observation(200, { rootAlive: false, anchor: "remembered_from_earlier_sample" })],
			T0 + SAMPLE_INTERVAL_MS,
		));

		expect(nextRegistry.get("200@start-200")?.survivedAttributionRootProcessExit).toBe(true);
	});
});

describe("buildTaskAttributedProcessLifetimeEpisodeJournalPayload", () => {
	it("does not bill a long-running process for CPU it burned before the sampler first saw it", () => {
		let { nextRegistry } = advance(new Map(), [observation(200, { cpu: 3_000 })], T0);
		({ nextRegistry } = advance(nextRegistry, [observation(200, { cpu: 3_012 })], T0 + SAMPLE_INTERVAL_MS));
		const entry = nextRegistry.get("200@start-200");
		if (!entry) {
			throw new Error("expected a registry entry");
		}

		const payload = buildTaskAttributedProcessLifetimeEpisodeJournalPayload(
			entry,
			"process_exited_between_samples",
			SAMPLE_INTERVAL_MS,
		);

		expect(payload.cpuTimeSecondsConsumedWhileObserved).toBe(12);
		expect(payload.processLifetimeEndedBy).toBe("process_exited_between_samples");
	});

	it("bills a process that started inside the first sample window for all of its CPU", () => {
		const { nextRegistry } = advance(new Map(), [observation(300, { cpu: 4, startedAt: T0 - 5_000 })], T0);
		const entry = nextRegistry.get("300@start-300");
		if (!entry) {
			throw new Error("expected a registry entry");
		}

		expect(
			buildTaskAttributedProcessLifetimeEpisodeJournalPayload(entry, "sampler_stopped", SAMPLE_INTERVAL_MS)
				.cpuTimeSecondsConsumedWhileObserved,
		).toBe(4);
	});
});

describe("buildTaskAttributedProcessTreePeriodicResourceSnapshots", () => {
	it("aggregates one session into per-classification totals and MCP instances", () => {
		const { nextRegistry } = advance(
			new Map(),
			[
				observation(100, { rss: 300_000 }),
				observation(101, {
					rss: 45_000,
					classification: "mcp_server_launcher_wrapper_process",
					mcpLabel: "@upstash/context7-mcp",
				}),
				observation(102, { rss: 39_000, classification: "mcp_server_process", mcpLabel: "@upstash/context7-mcp" }),
				observation(103, { rss: 900_000, classification: "agent_shell_tool_command_process" }),
			],
			T0,
		);

		const { snapshotJournalPayloads } = buildTaskAttributedProcessTreePeriodicResourceSnapshots({
			registry: nextRegistry,
			snapshotAtEpochMs: T0,
			previousSnapshotAtEpochMs: null,
		});

		expect(snapshotJournalPayloads).toHaveLength(1);
		expect(snapshotJournalPayloads[0]).toMatchObject({
			attributedTaskCardId: "ab12c",
			attributedProcessCount: 4,
			residentSetSizeKibibytesSumUpperBound: 1_284_000,
			largestSingleProcessResidentSetSizeKibibytes: 900_000,
			residentSetSizeKibibytesSumUpperBoundByProcessClassification: {
				agent_harness_root_process: 300_000,
				mcp_server_launcher_wrapper_process: 45_000,
				mcp_server_process: 39_000,
				agent_shell_tool_command_process: 900_000,
			},
			mcpServerInstances: [
				{ mcpServerInstanceLabel: "@upstash/context7-mcp", processCount: 2, residentSetSizeKibibytesSum: 84_000 },
			],
		});
	});

	it("counts only the CPU added since the previous snapshot", () => {
		let { nextRegistry } = advance(new Map(), [observation(100, { cpu: 500 })], T0);
		const first = buildTaskAttributedProcessTreePeriodicResourceSnapshots({
			registry: nextRegistry,
			snapshotAtEpochMs: T0,
			previousSnapshotAtEpochMs: null,
		});
		({ nextRegistry } = advance(
			first.registryWithUpdatedSnapshotBaselines,
			[observation(100, { cpu: 530 })],
			T0 + 300_000,
		));
		const second = buildTaskAttributedProcessTreePeriodicResourceSnapshots({
			registry: nextRegistry,
			snapshotAtEpochMs: T0 + 300_000,
			previousSnapshotAtEpochMs: T0,
		});

		expect(first.snapshotJournalPayloads[0]?.cpuTimeSecondsConsumedInSnapshotWindow).toBe(0);
		expect(second.snapshotJournalPayloads[0]?.cpuTimeSecondsConsumedInSnapshotWindow).toBe(30);
	});
});

describe("buildLiveTaskResourceUsageSnapshots", () => {
	it("reports per-card memory, CPU over the last interval, orphans and the harness footprint", () => {
		let { nextRegistry } = advance(
			new Map(),
			[
				observation(100, { rss: 300_000, cpu: 100 }),
				observation(103, { rss: 50_000, cpu: 10, classification: "agent_shell_tool_command_process" }),
			],
			T0,
		);
		({ nextRegistry } = advance(
			nextRegistry,
			[
				observation(100, { rss: 300_000, cpu: 103 }),
				observation(103, {
					rss: 50_000,
					cpu: 10,
					classification: "agent_shell_tool_command_process",
					rootAlive: false,
					anchor: "remembered_from_earlier_sample",
				}),
			],
			T0 + SAMPLE_INTERVAL_MS,
		));
		const registryWithFootprint = applyPhysicalFootprintSamplesToRegistry(
			nextRegistry,
			new Map([[100, 400_000_000]]),
		);

		const [snapshot] = buildLiveTaskResourceUsageSnapshots({
			registry: registryWithFootprint,
			sampledAtEpochMs: T0 + SAMPLE_INTERVAL_MS,
			previousSampledAtEpochMs: T0,
		});

		expect(snapshot).toMatchObject({
			workspaceId: "repo",
			attributedTaskCardId: "ab12c",
			attributedProcessCount: 2,
			residentSetSizeKibibytesSumUpperBound: 350_000,
			// 3 CPU 秒 / 15 秒墙钟 = 单核 20%。
			cpuPercentOfOneCoreOverLastSampleInterval: 20,
			survivedSessionRootExitProcessCount: 1,
			survivedSessionRootExitResidentSetSizeKibibytesSum: 50_000,
			agentHarnessRootPhysicalFootprintBytes: 400_000_000,
		});
	});

	it("reports no CPU figure on the very first sample instead of inventing one", () => {
		const { nextRegistry } = advance(new Map(), [observation(100, { cpu: 100 })], T0);

		expect(
			buildLiveTaskResourceUsageSnapshots({
				registry: nextRegistry,
				sampledAtEpochMs: T0,
				previousSampledAtEpochMs: null,
			})[0]?.cpuPercentOfOneCoreOverLastSampleInterval,
		).toBeNull();
	});

	it("groups workspace-level sessions separately from cards", () => {
		const { nextRegistry } = advance(new Map(), [observation(100), observation(500, { taskCardId: null })], T0);

		expect(
			buildLiveTaskResourceUsageSnapshots({
				registry: nextRegistry,
				sampledAtEpochMs: T0,
				previousSampledAtEpochMs: null,
			})
				.map((snapshot) => snapshot.attributedTaskCardId)
				.sort(),
		).toEqual(["ab12c", null].sort());
	});
});
