import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";

const BROADCAST_COST_WINDOW_INTERVAL_MS = 60_000;
const BROADCAST_OPERATION_KINDS = ["projects_updated", "workspace_state_updated", "initial_snapshot"] as const;
const BROADCAST_COST_STAGES = [
	"projects_payload_build",
	"workspace_payload_build",
	"payload_json_stringify",
	"projects_fingerprint_compare",
	"websocket_send_loop",
	"payload_utf8_byte_measurement",
] as const;

type BroadcastOperationKind = (typeof BROADCAST_OPERATION_KINDS)[number];
type BroadcastCostStage = (typeof BROADCAST_COST_STAGES)[number];
type BroadcastOperationOutcome =
	| "completed"
	| "deduplicated"
	| "superseded"
	| "no_clients"
	| "client_closed"
	| "failed";
export type RuntimeStateWebSocketSendOutcome = "accepted" | "client_not_open" | "threw";

interface BroadcastStageCost {
	completedStageCount: number;
	failedStageCount: number;
	totalDurationMs: number;
	maximumDurationMs: number;
}

interface BroadcastOperationCost {
	stages: Record<BroadcastCostStage, BroadcastStageCost>;
	serializedPayloadCount: number;
	totalSerializedPayloadBytes: number;
	maximumSerializedPayloadBytes: number;
	webSocketSendAttemptCount: number;
	webSocketAcceptedSendCount: number;
	webSocketClosedClientSkipCount: number;
	webSocketThrownSendCount: number;
	webSocketAcceptedSendPayloadBytes: number;
	initialSnapshotAwaitingClientSkipCount: number;
}

interface BroadcastOperationSample extends BroadcastOperationCost {
	operationSequenceNumber: number;
	operationStartedAtIso: string;
	operationDurationMs: number;
	outcome: BroadcastOperationOutcome;
}

interface BroadcastOperationWindow extends BroadcastOperationCost {
	startedOperationCount: number;
	completedOperationCount: number;
	inFlightOperationCountAtWindowEnd: number;
	totalOperationDurationMs: number;
	maximumOperationDurationMs: number;
	outcomeCounts: Record<BroadcastOperationOutcome, number>;
	firstCompletedOperationSample: BroadcastOperationSample | null;
	slowestCompletedOperationSample: BroadcastOperationSample | null;
}

export interface RuntimeStateBroadcastCostWindowSample {
	schemaVersion: "runtime-state-broadcast-cost-window/v1";
	runtimeStateHubInstanceId: string;
	windowStartedAtIso: string;
	windowEndedAtIso: string;
	observedWindowDurationMs: number;
	flushReason: "interval" | "hub_closed";
	operations: Record<BroadcastOperationKind, BroadcastOperationWindow>;
}

export interface RuntimeStateBroadcastCostOperation {
	measureSynchronousStage: <T>(stage: BroadcastCostStage, action: () => T) => T;
	measureAsynchronousStage: <T>(stage: BroadcastCostStage, action: () => Promise<T>) => Promise<T>;
	serializePayload: (payload: object) => string;
	recordWebSocketSendOutcome: (outcome: RuntimeStateWebSocketSendOutcome) => void;
	recordInitialSnapshotAwaitingClientSkip: () => void;
	finish: (outcome: BroadcastOperationOutcome) => void;
}

export interface RuntimeStateBroadcastCostRecorder {
	beginOperation: (kind: BroadcastOperationKind) => RuntimeStateBroadcastCostOperation;
	recordBroadcastSkippedWithoutClients: (kind: BroadcastOperationKind) => void;
	flushWindow: () => void;
	close: () => void;
}

function createOperationCost(): BroadcastOperationCost {
	return {
		stages: Object.fromEntries(
			BROADCAST_COST_STAGES.map((stage) => [
				stage,
				{ completedStageCount: 0, failedStageCount: 0, totalDurationMs: 0, maximumDurationMs: 0 },
			]),
		) as BroadcastOperationCost["stages"],
		serializedPayloadCount: 0,
		totalSerializedPayloadBytes: 0,
		maximumSerializedPayloadBytes: 0,
		webSocketSendAttemptCount: 0,
		webSocketAcceptedSendCount: 0,
		webSocketClosedClientSkipCount: 0,
		webSocketThrownSendCount: 0,
		webSocketAcceptedSendPayloadBytes: 0,
		initialSnapshotAwaitingClientSkipCount: 0,
	};
}

function createOperationWindow(): BroadcastOperationWindow {
	return {
		...createOperationCost(),
		startedOperationCount: 0,
		completedOperationCount: 0,
		inFlightOperationCountAtWindowEnd: 0,
		totalOperationDurationMs: 0,
		maximumOperationDurationMs: 0,
		outcomeCounts: { completed: 0, deduplicated: 0, superseded: 0, no_clients: 0, client_closed: 0, failed: 0 },
		firstCompletedOperationSample: null,
		slowestCompletedOperationSample: null,
	};
}

function createWindowOperations(): RuntimeStateBroadcastCostWindowSample["operations"] {
	return {
		projects_updated: createOperationWindow(),
		workspace_state_updated: createOperationWindow(),
		initial_snapshot: createOperationWindow(),
	};
}

// 只累计固定的三类操作、六个阶段，每类最多两个数值样本；不持有业务 payload 或按工作区增长的 Map。
// 阶段成本归入操作完成的窗口；跨窗未完成项由 started / completed / inFlight 三项显式表示。
export function createRuntimeStateBroadcastCostRecorder(
	dependencies: {
		monotonicNowMs?: () => number;
		epochNowMs?: () => number;
		writeWindowSample?: (sample: RuntimeStateBroadcastCostWindowSample) => void;
	} = {},
): RuntimeStateBroadcastCostRecorder {
	const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
	const epochNowMs = dependencies.epochNowMs ?? Date.now;
	const writeWindowSample =
		dependencies.writeWindowSample ??
		((sample) =>
			appendDiagnosticEventToRotatingJsonlJournal("runtime-state-broadcast-cost-window-sample", { ...sample }));
	const runtimeStateHubInstanceId = randomUUID();
	let windowStartedAtIso = new Date(epochNowMs()).toISOString();
	let windowStartedAtMonotonicMs = monotonicNowMs();
	let operations = createWindowOperations();
	let operationSequenceNumber = 0;
	let closed = false;
	const inFlightOperationCounts: Record<BroadcastOperationKind, number> = {
		projects_updated: 0,
		workspace_state_updated: 0,
		initial_snapshot: 0,
	};

	const flushWindow = (flushReason: RuntimeStateBroadcastCostWindowSample["flushReason"]) => {
		if (closed) return;
		const endedAtMonotonicMs = monotonicNowMs();
		const windowEndedAtIso = new Date(epochNowMs()).toISOString();
		for (const kind of BROADCAST_OPERATION_KINDS) {
			operations[kind].inFlightOperationCountAtWindowEnd = inFlightOperationCounts[kind];
		}
		const sample: RuntimeStateBroadcastCostWindowSample = {
			schemaVersion: "runtime-state-broadcast-cost-window/v1",
			runtimeStateHubInstanceId,
			windowStartedAtIso,
			windowEndedAtIso,
			observedWindowDurationMs: Math.max(0, endedAtMonotonicMs - windowStartedAtMonotonicMs),
			flushReason,
			operations,
		};
		operations = createWindowOperations();
		windowStartedAtIso = windowEndedAtIso;
		windowStartedAtMonotonicMs = endedAtMonotonicMs;
		try {
			writeWindowSample(sample);
		} catch {
			// 诊断失败不传播，不积攒待重试窗口；journal 自身负责有界磁盘轮转。
		}
	};
	const timer = setInterval(() => flushWindow("interval"), BROADCAST_COST_WINDOW_INTERVAL_MS);
	timer.unref();

	return {
		beginOperation: (kind) => {
			operationSequenceNumber += 1;
			const sequenceNumber = operationSequenceNumber;
			const startedAtMonotonicMs = monotonicNowMs();
			const operationStartedAtIso = new Date(epochNowMs()).toISOString();
			const cost = createOperationCost();
			let finished = false;
			let outstandingAsynchronousStageCount = 0;
			let requestedFinishOutcome: BroadcastOperationOutcome | null = null;
			let serializedPayloadBytes = 0;
			if (!closed) {
				operations[kind].startedOperationCount += 1;
				inFlightOperationCounts[kind] += 1;
			}
			const completeStage = (stage: BroadcastCostStage, startedAt: number, failed: boolean) => {
				const durationMs = Math.max(0, monotonicNowMs() - startedAt);
				const stageCost = cost.stages[stage];
				stageCost.completedStageCount += 1;
				stageCost.failedStageCount += Number(failed);
				stageCost.totalDurationMs += durationMs;
				stageCost.maximumDurationMs = Math.max(stageCost.maximumDurationMs, durationMs);
			};
			const measureSynchronousStage: RuntimeStateBroadcastCostOperation["measureSynchronousStage"] = (
				stage,
				action,
			) => {
				const startedAt = monotonicNowMs();
				let failed = true;
				try {
					const result = action();
					failed = false;
					return result;
				} finally {
					completeStage(stage, startedAt, failed);
				}
			};
			const operation: RuntimeStateBroadcastCostOperation = {
				measureSynchronousStage,
				measureAsynchronousStage: async (stage, action) => {
					outstandingAsynchronousStageCount += 1;
					const startedAt = monotonicNowMs();
					let failed = true;
					try {
						const result = await action();
						failed = false;
						return result;
					} finally {
						completeStage(stage, startedAt, failed);
						outstandingAsynchronousStageCount -= 1;
						// Promise.all 的另一支失败时，仍等已启动的阶段自然结束后归账，不改变业务的提前返回。
						if (requestedFinishOutcome !== null) operation.finish(requestedFinishOutcome);
					}
				},
				serializePayload: (payload) => {
					const serializedPayload = measureSynchronousStage("payload_json_stringify", () =>
						JSON.stringify(payload),
					);
					serializedPayloadBytes = measureSynchronousStage("payload_utf8_byte_measurement", () =>
						Buffer.byteLength(serializedPayload, "utf8"),
					);
					cost.serializedPayloadCount += 1;
					cost.totalSerializedPayloadBytes += serializedPayloadBytes;
					cost.maximumSerializedPayloadBytes = Math.max(
						cost.maximumSerializedPayloadBytes,
						serializedPayloadBytes,
					);
					return serializedPayload;
				},
				recordWebSocketSendOutcome: (outcome) => {
					if (outcome === "client_not_open") {
						cost.webSocketClosedClientSkipCount += 1;
					} else {
						cost.webSocketSendAttemptCount += 1;
						if (outcome === "accepted") {
							cost.webSocketAcceptedSendCount += 1;
							cost.webSocketAcceptedSendPayloadBytes += serializedPayloadBytes;
						} else cost.webSocketThrownSendCount += 1;
					}
				},
				recordInitialSnapshotAwaitingClientSkip: () => {
					cost.initialSnapshotAwaitingClientSkipCount += 1;
				},
				finish: (outcome) => {
					if (finished || closed) return;
					if (outstandingAsynchronousStageCount > 0) {
						requestedFinishOutcome = outcome;
						return;
					}
					finished = true;
					inFlightOperationCounts[kind] -= 1;
					const operationDurationMs = Math.max(0, monotonicNowMs() - startedAtMonotonicMs);
					const window = operations[kind];
					window.completedOperationCount += 1;
					window.outcomeCounts[outcome] += 1;
					window.totalOperationDurationMs += operationDurationMs;
					window.maximumOperationDurationMs = Math.max(window.maximumOperationDurationMs, operationDurationMs);
					for (const stage of BROADCAST_COST_STAGES) {
						const target = window.stages[stage];
						const source = cost.stages[stage];
						target.completedStageCount += source.completedStageCount;
						target.failedStageCount += source.failedStageCount;
						target.totalDurationMs += source.totalDurationMs;
						target.maximumDurationMs = Math.max(target.maximumDurationMs, source.maximumDurationMs);
					}
					for (const field of Object.keys(cost) as (keyof BroadcastOperationCost)[]) {
						if (field === "stages") continue;
						if (field === "maximumSerializedPayloadBytes") window[field] = Math.max(window[field], cost[field]);
						else window[field] += cost[field];
					}
					const sample = {
						...cost,
						operationSequenceNumber: sequenceNumber,
						operationStartedAtIso,
						operationDurationMs,
						outcome,
					};
					window.firstCompletedOperationSample ??= sample;
					if (
						!window.slowestCompletedOperationSample ||
						operationDurationMs > window.slowestCompletedOperationSample.operationDurationMs
					) {
						window.slowestCompletedOperationSample = sample;
					}
				},
			};
			return operation;
		},
		recordBroadcastSkippedWithoutClients: (kind) => {
			if (closed) return;
			operations[kind].startedOperationCount += 1;
			operations[kind].completedOperationCount += 1;
			operations[kind].outcomeCounts.no_clients += 1;
		},
		flushWindow: () => flushWindow("interval"),
		close: () => {
			clearInterval(timer);
			flushWindow("hub_closed");
			closed = true;
		},
	};
}
