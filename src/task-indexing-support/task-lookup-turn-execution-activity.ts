import type { TaskLookupExecutionActivity, TaskLookupTurn } from "../core/task-lookup-conversation-contract";

export function appendTaskLookupExecutionActivities(
	turn: TaskLookupTurn,
	activities: TaskLookupExecutionActivity[],
): void {
	const combined = [...(turn.executionActivityTimeline ?? []), ...activities];
	const omittedCount = Math.max(0, combined.length - 200);
	turn.executionActivityTimeline = combined.slice(-200);
	turn.omittedExecutionActivityCount = (turn.omittedExecutionActivityCount ?? 0) + omittedCount;
	if (activities.length) turn.lastExecutionActivityAt = activities.at(-1)?.occurredAtEpochMs;
}

/** 只中止本轮等待；无法取消的底层只读操作晚到后也不能再推进轮次或调用模型。 */
export async function awaitTaskLookupOperationOrCancellation<T>(
	signal: AbortSignal,
	operation: Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	let onAbort = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason ?? new Error("查卡已取消。"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
