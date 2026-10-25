import { setTimeout as waitWithAbortSignal } from "node:timers/promises";
import {
	type AllProjectsTaskGroupQueryFilters,
	type AllProjectsTaskGroupQueryResult,
	buildAllProjectsTaskGroupQueryResult,
} from "../core/all-projects-task-group-query";
import type { RuntimeAllProjectsTaskGroupQuerySnapshot } from "../core/api-contract";
import { safeErrorMessage } from "../core/cli-process-guards";

const QUERY_UNAVAILABLE_RECOVERY_BUDGET_MS = 60_000;
const QUERY_UNAVAILABLE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;
const INTERRUPTED_STOP_EVENT_OUTPUT_TIMEOUT_MS = 500;

export class AllProjectsTaskGroupQueryRuntimeCompatibilityError extends Error {}

type MonitorStopReason =
	| "selected_result_empty_confirmed"
	| "query_unavailable_budget_exhausted"
	| "runtime_incompatible"
	| "interrupted";
export type AllProjectsTaskGroupMonitorEvent =
	| (AllProjectsTaskGroupQueryResult & { eventType: "all_projects_task_group_snapshot" })
	| { eventType: "all_projects_task_group_query_unavailable"; ok: false; error: string; unavailableSinceMs: number }
	| { eventType: "all_projects_task_group_monitor_stopped"; reason: MonitorStopReason; exitCode: number };

// 读取器和输出器都可能不响应取消；外层不能把结束资格依赖于它们是否配合。
async function runMonitorOperationWithCancellation<Result>(
	operation: (signal: AbortSignal) => Promise<Result>,
	signal: AbortSignal,
): Promise<Result> {
	signal.throwIfAborted();
	let removeAbortListener = () => {};
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return operation(signal);
			}),
			new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}),
		]);
	} finally {
		removeAbortListener();
	}
}

export async function runAllProjectsTaskGroupMonitor(input: {
	querySnapshot: (signal: AbortSignal) => Promise<RuntimeAllProjectsTaskGroupQuerySnapshot>;
	filters: AllProjectsTaskGroupQueryFilters;
	intervalMs: number;
	exitWhenEmpty: boolean;
	signal: AbortSignal;
	emit: (event: AllProjectsTaskGroupMonitorEvent, signal: AbortSignal) => Promise<void>;
	requestTimeoutMs?: number;
	now?: () => number;
	wait?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<number> {
	const now = input.now ?? Date.now;
	const wait =
		input.wait ??
		(async (durationMs, signal) => {
			await waitWithAbortSignal(durationMs, undefined, { signal });
		});
	let unavailableSinceMs: number | null = null;
	let consecutiveUnavailableAttempts = 0;
	let consecutiveCompleteEmptySnapshots = 0;
	const emit = (event: AllProjectsTaskGroupMonitorEvent, signal = input.signal) =>
		runMonitorOperationWithCancellation((operationSignal) => input.emit(event, operationSignal), signal);
	const stopInterrupted = async () => {
		const exitCode = input.signal.reason === "SIGTERM" ? 143 : 130;
		const stopEventOutputController = new AbortController();
		const stopEventOutputTimeout = setTimeout(
			() => stopEventOutputController.abort(new Error("中断停止事件输出超时")),
			INTERRUPTED_STOP_EVENT_OUTPUT_TIMEOUT_MS,
		);
		try {
			// 原信号已经取消；给停止事件独立的短预算，保留可读下游的完整 NDJSON。
			await emit(
				{ eventType: "all_projects_task_group_monitor_stopped", reason: "interrupted", exitCode },
				stopEventOutputController.signal,
			);
		} catch {
			// 中断后的输出只能尽力而为，写入失败也不能覆盖信号退出码。
		} finally {
			clearTimeout(stopEventOutputTimeout);
		}
		return exitCode;
	};
	const stop = async (reason: MonitorStopReason, exitCode: number) => {
		if (input.signal.aborted) return await stopInterrupted();
		try {
			await emit({ eventType: "all_projects_task_group_monitor_stopped", reason, exitCode });
			return exitCode;
		} catch (error) {
			if (!input.signal.aborted) throw error;
			return await stopInterrupted();
		}
	};
	while (!input.signal.aborted) {
		if (unavailableSinceMs !== null && now() - unavailableSinceMs >= QUERY_UNAVAILABLE_RECOVERY_BUDGET_MS) {
			return await stop("query_unavailable_budget_exhausted", 1);
		}
		const attemptStartedAtMs = now();
		const remainingRecoveryBudgetMs =
			unavailableSinceMs === null
				? QUERY_UNAVAILABLE_RECOVERY_BUDGET_MS
				: QUERY_UNAVAILABLE_RECOVERY_BUDGET_MS - (now() - unavailableSinceMs);
		const requestController = new AbortController();
		const requestTimeout = setTimeout(
			() => requestController.abort(new Error("任务组查询请求超时")),
			Math.min(input.requestTimeoutMs ?? 28_000, remainingRecoveryBudgetMs),
		);
		let result: AllProjectsTaskGroupQueryResult | undefined;
		let queryFailure: unknown;
		try {
			const snapshot = await runMonitorOperationWithCancellation(
				input.querySnapshot,
				AbortSignal.any([input.signal, requestController.signal]),
			);
			result = buildAllProjectsTaskGroupQueryResult(snapshot, input.filters);
		} catch (error) {
			queryFailure = error;
		} finally {
			clearTimeout(requestTimeout);
		}
		if (input.signal.aborted) break;
		try {
			if (result) {
				await emit({ eventType: "all_projects_task_group_snapshot", ...result });
			} else {
				await emit({
					eventType: "all_projects_task_group_query_unavailable",
					ok: false,
					error: safeErrorMessage(queryFailure),
					unavailableSinceMs: unavailableSinceMs ?? attemptStartedAtMs,
				});
			}
		} catch (error) {
			if (!input.signal.aborted) throw error;
			break;
		}
		if (input.signal.aborted) break;
		if (queryFailure instanceof AllProjectsTaskGroupQueryRuntimeCompatibilityError)
			return await stop("runtime_incompatible", 1);
		let nextQueryDelayMs = input.intervalMs;
		if (result?.ok) {
			unavailableSinceMs = null;
			consecutiveUnavailableAttempts = 0;
			consecutiveCompleteEmptySnapshots = result.count === 0 ? consecutiveCompleteEmptySnapshots + 1 : 0;
			if (input.exitWhenEmpty && consecutiveCompleteEmptySnapshots >= 2)
				return await stop("selected_result_empty_confirmed", 0);
		} else {
			consecutiveCompleteEmptySnapshots = 0;
			unavailableSinceMs ??= attemptStartedAtMs;
			nextQueryDelayMs = Math.min(
				QUERY_UNAVAILABLE_RETRY_DELAYS_MS[
					Math.min(consecutiveUnavailableAttempts++, QUERY_UNAVAILABLE_RETRY_DELAYS_MS.length - 1)
				],
				Math.max(0, QUERY_UNAVAILABLE_RECOVERY_BUDGET_MS - (now() - unavailableSinceMs)),
			);
		}
		try {
			await wait(nextQueryDelayMs, input.signal);
		} catch (error) {
			if (!input.signal.aborted) throw error;
		}
	}
	return await stopInterrupted();
}
