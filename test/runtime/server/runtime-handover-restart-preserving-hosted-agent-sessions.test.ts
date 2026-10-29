// runtime 退出流程的编排契约：步骤先后、handover 才有的等待与标记、显式全停才有的「让 host 连同未接管会话一起收尾」。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentSessionCountsAffectedByRuntimeExit } from "../../../src/core/api-contract";
import { readFreshKanbanRuntimeHandoverRestartInProgressMarker } from "../../../src/core/kanban-runtime-handover-restart-in-progress-marker";
import type {
	HostedAgentSessionDispositionForRuntimeShutdown,
	RuntimeShutdownTrigger,
} from "../../../src/core/runtime-shutdown-trigger";
import {
	type KanbanRuntimeExitSequenceDependencies,
	PLANNED_HANDOVER_HOSTED_SESSION_STARTUP_TERMINAL_QUERY_WINDOW_MS,
	PLANNED_HANDOVER_WAIT_FOR_UNSETTLED_PROGRAMMATIC_INPUT_DELIVERIES_MAXIMUM_MS,
	runKanbanRuntimeExitSequence,
} from "../../../src/server/runtime-handover-restart-preserving-hosted-agent-sessions";

const AGENT_SESSION_COUNTS: RuntimeAgentSessionCountsAffectedByRuntimeExit = {
	agentSessionsHostedByAgentSessionPtyHost: 2,
	agentSessionsWithPtyOwnedByRuntimeProcess: 0,
	conversationAgentSessionsRunningInsideRuntimeProcess: 0,
	inFlightExplorationThreadGraphMaintenanceJobs: 1,
};

let markerDirectoryPath: string;

beforeEach(() => {
	markerDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-runtime-exit-sequence-"));
});

afterEach(() => {
	rmSync(markerDirectoryPath, { recursive: true, force: true });
});

function createExitSequenceDependencies(input: {
	trigger: RuntimeShutdownTrigger;
	hostedAgentSessionDisposition: HostedAgentSessionDispositionForRuntimeShutdown;
	unsettledDeliveryTaskIdsByPoll?: string[][];
	spawnedAtEpochMsOfHostedSessions?: number[];
	queuedDispatchSettlesAfterMs?: number | null;
	backgroundServicesShutdown?: Promise<void>;
}) {
	let nowEpochMs = 1_700_000_000_000;
	const stepLog: string[] = [];
	const sleepDurationsMs: number[] = [];
	const unsettledDeliveryTaskIdsByPoll = [...(input.unsettledDeliveryTaskIdsByPoll ?? [])];
	const markerPath = join(markerDirectoryPath, "marker.json");
	const dispatchSettlementAt =
		input.queuedDispatchSettlesAfterMs === null
			? Number.POSITIVE_INFINITY
			: nowEpochMs + (input.queuedDispatchSettlesAfterMs ?? 0);
	let finishQueuedDispatch: (() => void) | undefined;
	const queuedDispatchSettled =
		dispatchSettlementAt === nowEpochMs
			? Promise.resolve()
			: new Promise<void>((resolve) => {
					finishQueuedDispatch = resolve;
				});
	const deps: KanbanRuntimeExitSequenceDependencies = {
		trigger: input.trigger,
		hostedAgentSessionDisposition: input.hostedAgentSessionDisposition,
		agentSessionPtyHostRuntimeFacade: {
			refuseNewSpawnsBecauseRuntimeIsShuttingDown: () => stepLog.push("refuse_new_spawns"),
			freezeHostedSessionEventRoutingAndStopHookSpoolDrainsForRuntimeHandover: async () => {
				stepLog.push("freeze_host_links");
			},
			requestEveryGenerationHostToTerminateAllHostedSessionsAndExit: () => {
				stepLog.push("terminate_all_in_every_host");
				return 1;
			},
			closeControllerConnectionsAfterFlushingPendingFrames: async () => {
				stepLog.push("close_host_connections");
			},
		},
		runtimeServer: {
			stopAcceptingNewWorkBeforeRuntimeExit: ({ closeBrowserConnectionsBecauseRuntimeIsRestarting }) => {
				stepLog.push(`stop_accepting_new_work(1012=${closeBrowserConnectionsBecauseRuntimeIsRestarting})`);
				return {
					waitForRuntimeOwnedBackgroundServicesToStopBeforeSessionDetach: async () => {
						stepLog.push("wait_for_background_services");
						await input.backgroundServicesShutdown;
					},
					waitForAlreadyStartedQueuedPromptDispatchAttemptsToSettle: () => {
						stepLog.push("wait_for_started_queue_dispatches");
						return queuedDispatchSettled;
					},
					stopRemainingQueuedPromptDispatchAttemptsBeforeSessionDetach: () => {
						stepLog.push("prevent_late_queue_writes");
					},
				};
			},
			countAgentSessionsAffectedByRuntimeExit: () => AGENT_SESSION_COUNTS,
			stopAllActiveRuntimeSessionsForShutdown: async (hostedAgentSessionDisposition) => {
				stepLog.push(`stop_sessions(${hostedAgentSessionDisposition})`);
				return [];
			},
			close: async () => {
				stepLog.push("close_runtime_server");
			},
		},
		listTerminalSessionManagers: () => [
			{
				listTaskIdsWithUnsettledProgrammaticTaskChatInputDelivery: () =>
					unsettledDeliveryTaskIdsByPoll.shift() ?? [],
				listSpawnedAtEpochMsOfActiveHostedPtySessions: () => input.spawnedAtEpochMsOfHostedSessions ?? [],
			},
		],
		handoverRestartInProgressMarker: {
			markerPath,
			marker: { handoverRestartStartedAtEpochMs: nowEpochMs, previousRuntimeProcessId: 4242, runtimePort: 3497 },
		},
		log: () => {},
		warn: vi.fn(),
		readNowEpochMs: () => nowEpochMs,
		sleep: async (milliseconds) => {
			sleepDurationsMs.push(milliseconds);
			nowEpochMs += milliseconds;
			if (nowEpochMs >= dispatchSettlementAt) finishQueuedDispatch?.();
		},
		// 只走协调器里与编排有关的两步；真实协调器会读真实 HOME 的 workspace 索引。
		shutdownRuntimeServer: async (coordinatorDeps) => {
			await coordinatorDeps.stopAllActiveRuntimeSessionsForShutdown(
				coordinatorDeps.hostedAgentSessionDisposition ?? "terminate_hosted_agent_sessions",
			);
			await coordinatorDeps.closeRuntimeServer();
			return { detachedHostedAgentSessionCount: 0 };
		},
	};
	return { deps, stepLog, sleepDurationsMs, markerPath, readNowEpochMs: () => nowEpochMs };
}

describe("runKanbanRuntimeExitSequence", () => {
	it("runs a planned handover in order: refuse spawns, stop new work with 1012, wait, freeze, detach, close", async () => {
		const { deps, stepLog, markerPath } = createExitSequenceDependencies({
			trigger: {
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			},
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
		});

		const outcome = await runKanbanRuntimeExitSequence(deps);

		expect(stepLog).toEqual([
			"refuse_new_spawns",
			"stop_accepting_new_work(1012=true)",
			"wait_for_background_services",
			"wait_for_started_queue_dispatches",
			"prevent_late_queue_writes",
			"freeze_host_links",
			"stop_sessions(detach_hosted_agent_sessions_for_successor_runtime)",
			"close_runtime_server",
			"close_host_connections",
		]);
		expect(outcome.agentSessionCountsAffectedByRuntimeExit).toEqual(AGENT_SESSION_COUNTS);
		// 标记写下了（下一个 runtime 开始监听后才删）：窗口内的 CLI 写动词据此等待。
		expect(readFreshKanbanRuntimeHandoverRestartInProgressMarker(markerPath, 1_700_000_001_000)).toMatchObject({
			previousRuntimeProcessId: 4242,
		});
	});

	it("后台服务仍有在途领域动作时不提前冻结或 detach", async () => {
		let finishBackgroundShutdown!: () => void;
		const { deps, stepLog } = createExitSequenceDependencies({
			trigger: {
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			},
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			backgroundServicesShutdown: new Promise<void>((resolve) => {
				finishBackgroundShutdown = resolve;
			}),
		});
		const shutdown = runKanbanRuntimeExitSequence(deps);
		await vi.waitFor(() => expect(stepLog).toContain("wait_for_background_services"));
		expect(stepLog).not.toContain("freeze_host_links");
		expect(stepLog).not.toContain("stop_sessions(detach_hosted_agent_sessions_for_successor_runtime)");
		finishBackgroundShutdown();
		await shutdown;
		expect(stepLog.indexOf("wait_for_background_services")).toBeLessThan(stepLog.indexOf("freeze_host_links"));
	});

	it("handover 在冻结 host 前等待尚未进入 PTY receipt 的队列投递", async () => {
		const { deps, stepLog, sleepDurationsMs } = createExitSequenceDependencies({
			trigger: {
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			},
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			queuedDispatchSettlesAfterMs: 300,
		});

		await runKanbanRuntimeExitSequence(deps);

		expect(sleepDurationsMs.reduce((total, duration) => total + duration, 0)).toBe(300);
		expect(stepLog.indexOf("prevent_late_queue_writes")).toBeLessThan(stepLog.indexOf("freeze_host_links"));
	});

	it("队列与 PTY receipt 共用排空预算，超时后先拦截迟到写入再 detach", async () => {
		const { deps, stepLog, sleepDurationsMs } = createExitSequenceDependencies({
			trigger: {
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			},
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			queuedDispatchSettlesAfterMs: null,
			unsettledDeliveryTaskIdsByPoll: Array.from({ length: 1_000 }, () => ["task-stuck"]),
		});

		await runKanbanRuntimeExitSequence(deps);

		expect(sleepDurationsMs.reduce((total, duration) => total + duration, 0)).toBe(
			PLANNED_HANDOVER_WAIT_FOR_UNSETTLED_PROGRAMMATIC_INPUT_DELIVERIES_MAXIMUM_MS,
		);
		expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("queue dispatch"));
		expect(stepLog.indexOf("prevent_late_queue_writes")).toBeLessThan(stepLog.indexOf("freeze_host_links"));
	});

	it("waits for unsettled programmatic deliveries and for a just-started session to leave its startup window before detaching", async () => {
		const { deps, sleepDurationsMs, readNowEpochMs } = createExitSequenceDependencies({
			trigger: {
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			},
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			unsettledDeliveryTaskIdsByPoll: [["task-pasting"], ["task-pasting"], []],
			spawnedAtEpochMsOfHostedSessions: [1_700_000_000_000 - 60_000, 1_700_000_000_000 - 1_000],
		});

		await runKanbanRuntimeExitSequence(deps);

		// 两轮轮询等投递落定（各 100ms），再等最年轻的会话满启动窗口。
		expect(sleepDurationsMs).toEqual([
			100,
			100,
			PLANNED_HANDOVER_HOSTED_SESSION_STARTUP_TERMINAL_QUERY_WINDOW_MS - 1_200,
		]);
		expect(readNowEpochMs()).toBe(
			1_700_000_000_000 - 1_000 + PLANNED_HANDOVER_HOSTED_SESSION_STARTUP_TERMINAL_QUERY_WINDOW_MS,
		);
	});

	it("stops waiting for deliveries at the bound and proceeds with a warning", async () => {
		const neverSettlingPolls = Array.from({ length: 1_000 }, () => ["task-stuck"]);
		const { deps, sleepDurationsMs } = createExitSequenceDependencies({
			trigger: {
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "process_signal_sigusr2",
			},
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			unsettledDeliveryTaskIdsByPoll: neverSettlingPolls,
		});

		await runKanbanRuntimeExitSequence(deps);

		expect(sleepDurationsMs.reduce((total, duration) => total + duration, 0)).toBe(
			PLANNED_HANDOVER_WAIT_FOR_UNSETTLED_PROGRAMMATIC_INPUT_DELIVERIES_MAXIMUM_MS,
		);
		expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("task-stuck"));
	});

	it("detaches on a signal stop without the handover waits, browser restart notice or marker", async () => {
		const { deps, stepLog, sleepDurationsMs, markerPath } = createExitSequenceDependencies({
			trigger: { kind: "process_signal", signal: "SIGTERM" },
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			unsettledDeliveryTaskIdsByPoll: [["task-pasting"]],
			spawnedAtEpochMsOfHostedSessions: [1_700_000_000_000],
		});

		await runKanbanRuntimeExitSequence(deps);

		expect(sleepDurationsMs).toEqual([]);
		expect(stepLog).toContain("stop_accepting_new_work(1012=false)");
		expect(stepLog).toContain("freeze_host_links");
		expect(readFreshKanbanRuntimeHandoverRestartInProgressMarker(markerPath, 1_700_000_000_000)).toBeNull();
	});

	it("terminates sessions on an explicit stop and has every host end the sessions this runtime did not adopt", async () => {
		const { deps, stepLog } = createExitSequenceDependencies({
			trigger: { kind: "explicit_stop_terminating_hosted_agent_sessions", requestedVia: "runtime_trpc_procedure" },
			hostedAgentSessionDisposition: "terminate_hosted_agent_sessions",
		});

		await runKanbanRuntimeExitSequence(deps);

		expect(stepLog).toEqual([
			"refuse_new_spawns",
			"stop_accepting_new_work(1012=false)",
			"prevent_late_queue_writes",
			"stop_sessions(terminate_hosted_agent_sessions)",
			"close_runtime_server",
			"terminate_all_in_every_host",
			"close_host_connections",
		]);
	});
});
