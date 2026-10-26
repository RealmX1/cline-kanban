import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";

export type DailyWorkProgressCollectionCostStage =
	| "refresh"
	| "celebration_claim"
	| "project_discovery"
	| "workspace_board_read"
	| "workspace_sessions_read"
	| "injection_ledger_read"
	| "injection_ledger_parse_and_normalize"
	| "workspace_json_parse"
	| "workspace_schema_validation"
	| "receipt_target_grouping"
	| "statistics_summary_projection"
	| "persisted_json_text_decode"
	| "relation_ledger_catch_up"
	| "transcript_increment"
	| "transcript_body_read"
	| "transcript_record_fold"
	| "transcript_decode"
	| "codex_directory_discovery"
	| "codex_prefix_validation"
	| "receipt_index_build"
	| "receipt_match"
	| "statistics_lock_wait"
	| "statistics_read"
	| "statistics_parse"
	| "statistics_stringify"
	| "statistics_write";
export type DailyWorkProgressCollectionCostCounter =
	| "receipt_comparisons"
	| "receipt_candidate_queries"
	| "receipt_indexed_entries"
	| "codex_directory_enumerations"
	| "codex_directory_metadata_checks"
	| "codex_directory_candidate_filter_entries"
	| "codex_verified_history_cache_hits"
	| "codex_verified_history_cache_invalidations"
	| "transcript_records";
interface DailyWorkProgressCollectionStageCost {
	calls: number;
	failures: number;
	wallTimeMs: number;
	synchronousWallTimeMs: number;
	readOperations: number;
	readBytes: number;
	writeOperations: number;
	writtenBytes: number;
}
export interface DailyWorkProgressCollectionCostWindow {
	schemaVersion: "daily-work-progress-collection-cost-window/v1";
	collectorInstanceId: string;
	runtimeIdentity?: { runtimeProcessInstanceId: string; runtimeOrigin: string };
	windowStartedAtEpochMs: number;
	windowDurationMs: number;
	flushReason: "interval" | "closed" | "explicit";
	stages: Partial<Record<DailyWorkProgressCollectionCostStage, DailyWorkProgressCollectionStageCost>>;
	counters: Partial<Record<DailyWorkProgressCollectionCostCounter, number>>;
	inFlightOperations: number;
	inFlightAsynchronousStages: number;
}
interface DailyWorkProgressCollectionCostContext {
	acceptsCostObservations: boolean;
	changeInFlightAsynchronousStageCount: (delta: number) => void;
	stage: DailyWorkProgressCollectionCostStage;
	stageCost: (stage: DailyWorkProgressCollectionCostStage) => DailyWorkProgressCollectionStageCost;
	count: (counter: DailyWorkProgressCollectionCostCounter, amount: number) => void;
}
const activeDailyWorkProgressCollectionCostContext = new AsyncLocalStorage<DailyWorkProgressCollectionCostContext>();

function getActiveDailyWorkProgressCollectionCostContext() {
	const context = activeDailyWorkProgressCollectionCostContext.getStore();
	return context?.acceptsCostObservations ? context : undefined;
}

/** 只在采集刻度开启的作用域读取 Buffer，计量解码前的真实字节；其它路径沿用原 UTF-8 API。 */
export async function readUtf8FileWithDailyWorkProgressCostObservation(path: string): Promise<string> {
	if (!getActiveDailyWorkProgressCollectionCostContext()) return readFile(path, "utf8");
	const bytes = await readFile(path);
	recordDailyWorkProgressFileRead(bytes.byteLength);
	return measureDailyWorkProgressSynchronousStage("persisted_json_text_decode", () => bytes.toString("utf8"));
}

export function recordDailyWorkProgressFileRead(content: string | number): void {
	const context = getActiveDailyWorkProgressCollectionCostContext();
	if (!context) return;
	const cost = context.stageCost(context.stage);
	cost.readOperations++;
	cost.readBytes += typeof content === "number" ? content : Buffer.byteLength(content);
}
export function recordDailyWorkProgressFileWrite(content: string | number): void {
	const context = getActiveDailyWorkProgressCollectionCostContext();
	if (!context) return;
	const cost = context.stageCost(context.stage);
	cost.writeOperations++;
	cost.writtenBytes += typeof content === "number" ? content : Buffer.byteLength(content);
}
export function countDailyWorkProgressCollectionCost(
	counter: DailyWorkProgressCollectionCostCounter,
	amount = 1,
): void {
	getActiveDailyWorkProgressCollectionCostContext()?.count(counter, amount);
}
export function measureDailyWorkProgressSynchronousStage<T>(
	stage: DailyWorkProgressCollectionCostStage,
	operation: () => T,
): T {
	const context = getActiveDailyWorkProgressCollectionCostContext();
	if (!context) return operation();
	const stageContext = { ...context, stage, acceptsCostObservations: true };
	const start = performance.now();
	let failed = true;
	try {
		const result = activeDailyWorkProgressCollectionCostContext.run(stageContext, operation);
		failed = false;
		return result;
	} finally {
		stageContext.acceptsCostObservations = false;
		const cost = context.stageCost(stage);
		cost.calls++;
		cost.failures += Number(failed);
		const elapsed = performance.now() - start;
		cost.wallTimeMs += elapsed;
		cost.synchronousWallTimeMs += elapsed;
	}
}
export async function measureDailyWorkProgressAsynchronousStage<T>(
	stage: DailyWorkProgressCollectionCostStage,
	operation: () => Promise<T>,
): Promise<T> {
	const context = getActiveDailyWorkProgressCollectionCostContext();
	if (!context) return operation();
	const stageContext = { ...context, stage, acceptsCostObservations: true };
	context.changeInFlightAsynchronousStageCount(1);
	const start = performance.now();
	let failed = true;
	try {
		const result = await activeDailyWorkProgressCollectionCostContext.run(stageContext, operation);
		failed = false;
		return result;
	} finally {
		stageContext.acceptsCostObservations = false;
		context.changeInFlightAsynchronousStageCount(-1);
		const cost = context.stageCost(stage);
		cost.calls++;
		cost.failures += Number(failed);
		cost.wallTimeMs += performance.now() - start;
	}
}

// 异步阶段只记经过时间；进程 CPU 由隔离实验在整个窗口采样，不能归给某一个 await。
// 只聚合固定阶段和计数器，不保留路径、会话身份、prompt 或逐条事件。
export function createDailyWorkProgressCollectionCostRecorder(
	options: {
		enabled?: boolean;
		writeWindow?: (window: DailyWorkProgressCollectionCostWindow) => void;
		readRuntimeIdentity?: () => NonNullable<DailyWorkProgressCollectionCostWindow["runtimeIdentity"]>;
	} = {},
) {
	const enabled = options.enabled ?? process.env.KANBAN_DAILY_WORK_PROGRESS_COST_RECORDING_DISABLED !== "1";
	const collectorInstanceId = randomUUID();
	let windowStartedAtEpochMs = Date.now();
	let windowStartedAt = performance.now();
	let stages: DailyWorkProgressCollectionCostWindow["stages"] = {};
	let counters: DailyWorkProgressCollectionCostWindow["counters"] = {};
	let inFlightOperations = 0;
	let inFlightAsynchronousStages = 0;
	let closed = false;
	const context: DailyWorkProgressCollectionCostContext = {
		acceptsCostObservations: false,
		changeInFlightAsynchronousStageCount: (delta) => {
			inFlightAsynchronousStages += delta;
		},
		stage: "refresh",
		stageCost: (stage) => {
			stages[stage] ??= {
				calls: 0,
				failures: 0,
				wallTimeMs: 0,
				synchronousWallTimeMs: 0,
				readOperations: 0,
				readBytes: 0,
				writeOperations: 0,
				writtenBytes: 0,
			};
			return stages[stage];
		},
		count: (counter, amount) => {
			counters[counter] = (counters[counter] ?? 0) + amount;
		},
	};
	function flush(flushReason: DailyWorkProgressCollectionCostWindow["flushReason"] = "explicit"): void {
		if (!enabled || closed) return;
		const sample: DailyWorkProgressCollectionCostWindow = {
			schemaVersion: "daily-work-progress-collection-cost-window/v1",
			collectorInstanceId,
			windowStartedAtEpochMs,
			windowDurationMs: performance.now() - windowStartedAt,
			flushReason,
			stages,
			counters,
			inFlightOperations,
			inFlightAsynchronousStages,
		};
		stages = {};
		counters = {};
		windowStartedAtEpochMs = Date.now();
		windowStartedAt = performance.now();
		try {
			sample.runtimeIdentity = options.readRuntimeIdentity?.();
			if (options.writeWindow) options.writeWindow(sample);
			else
				appendDiagnosticEventToRotatingJsonlJournal("daily-work-progress-collection-cost-window-sample", {
					...sample,
				});
		} catch {
			/* 诊断故障不影响采集或积累重试。 */
		}
	}
	const timer = enabled ? setInterval(() => flush("interval"), 60_000) : null;
	timer?.unref();
	return {
		async run<T>(stage: "refresh" | "celebration_claim", operation: () => Promise<T>): Promise<T> {
			if (!enabled || closed) return operation();
			inFlightOperations++;
			const operationContext = { ...context, acceptsCostObservations: true };
			try {
				return await activeDailyWorkProgressCollectionCostContext.run(operationContext, () =>
					measureDailyWorkProgressAsynchronousStage(stage, operation),
				);
			} finally {
				operationContext.acceptsCostObservations = false;
				inFlightOperations--;
			}
		},
		flush,
		close() {
			if (timer) clearInterval(timer);
			flush("closed");
			closed = true;
		},
	};
}
