// 每个 project 一个的「runtime 预分配建卡 id」池（dd2db Y-EVENT-12）。
//
// 新卡 id 只能由 runtime 分配：runtime 在保存时锁内校验，漏斗里新建的卡若用了被别的卡 / 别的 workspace 占用、
// 或被删卡用过的 id，整次保存失败。所以浏览器绝不再本地随机造 id。为了让「点一下就出卡」保持同步、零等待，
// 这里提前向 runtime 要好几个 id 备着：用掉一个就异步补一个。
//
// 池空（首次加载还没补上、批量建卡一次要的比池里多、runtime 暂时连不上、或 runtime 没有关系账本分配不出 id）时，
// take 不返回任何 id，并按需求量触发补池——由建卡入口如实提示并阻止这次建卡（用户输入保持原样，稍后再点即可），
// 而不是回退到本地随机 id 静默保存。
//
// 分配给本 workspace 但还没用过的 id 在 runtime 侧持久保留（登记簿落在关系账本里），所以池子跨重连 / runtime 重启
// 都不用作废。

import { allocateRuntimeTaskIdForNewWebUiTaskCard } from "@/runtime/task-id-allocation-for-new-web-ui-task-card-query";

// EXPERIMENT_NODE: 每个 project 常备几个预分配 id——越大越不容易在连续 / 批量建卡时池空，越小越少在 runtime 侧留下未用的预留 id。
export const RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE = 3;

type MostRecentRuntimeTaskIdAllocationOutcome =
	| "allocated"
	| "runtime_declined_because_relation_ledger_is_unavailable"
	| "allocation_request_failed";

interface RuntimeAllocatedTaskIdPrefetchPoolForOneWorkspace {
	runtimeAllocatedTaskIdsReadyForNewTaskCards: string[];
	inFlightRuntimeTaskIdAllocationRequestCount: number;
	mostRecentRuntimeTaskIdAllocationOutcome: MostRecentRuntimeTaskIdAllocationOutcome | null;
}

export type RuntimeAllocatedTaskIdsTakeResultForNewWebUiTaskCards =
	| { status: "taken"; runtimeAllocatedTaskIds: string[] }
	// 池里不够这么多；已按需求量触发补池。
	| { status: "not_enough_runtime_allocated_task_ids_prefetched_yet" }
	// 最近一次分配被 runtime 明确拒绝（没有关系账本）；已再试一次补池，但大概率仍拿不到。
	| { status: "runtime_cannot_allocate_task_ids_because_relation_ledger_is_unavailable" };

const runtimeAllocatedTaskIdPrefetchPoolByWorkspaceId = new Map<
	string,
	RuntimeAllocatedTaskIdPrefetchPoolForOneWorkspace
>();

function getOrCreateRuntimeAllocatedTaskIdPrefetchPool(
	workspaceId: string,
): RuntimeAllocatedTaskIdPrefetchPoolForOneWorkspace {
	const existing = runtimeAllocatedTaskIdPrefetchPoolByWorkspaceId.get(workspaceId);
	if (existing) {
		return existing;
	}
	const created: RuntimeAllocatedTaskIdPrefetchPoolForOneWorkspace = {
		runtimeAllocatedTaskIdsReadyForNewTaskCards: [],
		inFlightRuntimeTaskIdAllocationRequestCount: 0,
		mostRecentRuntimeTaskIdAllocationOutcome: null,
	};
	runtimeAllocatedTaskIdPrefetchPoolByWorkspaceId.set(workspaceId, created);
	return created;
}

async function requestOneRuntimeAllocatedTaskIdIntoPool(
	workspaceId: string,
	pool: RuntimeAllocatedTaskIdPrefetchPoolForOneWorkspace,
): Promise<void> {
	try {
		const allocatedTaskId = await allocateRuntimeTaskIdForNewWebUiTaskCard(workspaceId);
		if (allocatedTaskId === null) {
			pool.mostRecentRuntimeTaskIdAllocationOutcome = "runtime_declined_because_relation_ledger_is_unavailable";
			return;
		}
		pool.mostRecentRuntimeTaskIdAllocationOutcome = "allocated";
		if (!pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.includes(allocatedTaskId)) {
			pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.push(allocatedTaskId);
		}
	} catch {
		// 失败不自动重试（避免 runtime 不在时打转）；下一次需求（打开建卡框、建卡、换项目）会再补。
		pool.mostRecentRuntimeTaskIdAllocationOutcome = "allocation_request_failed";
	} finally {
		pool.inFlightRuntimeTaskIdAllocationRequestCount -= 1;
	}
}

// 把池补到至少 minimumReadyTaskIdCount 个（已备好 + 在途合计），缺多少就并发要多少（httpBatchLink 会合成一次请求）。
export function ensureRuntimeAllocatedTaskIdPrefetchPoolFilled(
	workspaceId: string,
	minimumReadyTaskIdCount: number = RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE,
): void {
	const pool = getOrCreateRuntimeAllocatedTaskIdPrefetchPool(workspaceId);
	const missingTaskIdCount =
		minimumReadyTaskIdCount -
		pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.length -
		pool.inFlightRuntimeTaskIdAllocationRequestCount;
	for (let index = 0; index < missingTaskIdCount; index += 1) {
		pool.inFlightRuntimeTaskIdAllocationRequestCount += 1;
		void requestOneRuntimeAllocatedTaskIdIntoPool(workspaceId, pool);
	}
}

/** 分析采纳了一个尚未预取的项目时，直接等待一次分配，不用计时轮询。 */
export async function ensureOneRuntimeAllocatedTaskIdReadyForTaskEditorSubmission(workspaceId: string): Promise<void> {
	const pool = getOrCreateRuntimeAllocatedTaskIdPrefetchPool(workspaceId);
	if (pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.length > 0) return;
	pool.inFlightRuntimeTaskIdAllocationRequestCount++;
	await requestOneRuntimeAllocatedTaskIdIntoPool(workspaceId, pool);
	if (!pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.length)
		throw new Error("运行时尚未分配任务 ID，草稿已保留，请重试。");
}

// 一次取走 count 个；不够就一个都不取（批量建卡要么全用 runtime id、要么整批不建），并按需求量补池。
export function takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards(
	workspaceId: string,
	count: number,
): RuntimeAllocatedTaskIdsTakeResultForNewWebUiTaskCards {
	const pool = getOrCreateRuntimeAllocatedTaskIdPrefetchPool(workspaceId);
	if (pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.length < count) {
		const mostRecentOutcomeBeforeRefill = pool.mostRecentRuntimeTaskIdAllocationOutcome;
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled(
			workspaceId,
			Math.max(count, RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE),
		);
		if (mostRecentOutcomeBeforeRefill === "runtime_declined_because_relation_ledger_is_unavailable") {
			return { status: "runtime_cannot_allocate_task_ids_because_relation_ledger_is_unavailable" };
		}
		return { status: "not_enough_runtime_allocated_task_ids_prefetched_yet" };
	}
	const runtimeAllocatedTaskIds = pool.runtimeAllocatedTaskIdsReadyForNewTaskCards.splice(0, count);
	ensureRuntimeAllocatedTaskIdPrefetchPoolFilled(workspaceId);
	return { status: "taken", runtimeAllocatedTaskIds };
}

export function resetRuntimeAllocatedTaskIdPrefetchPoolsForTests(): void {
	runtimeAllocatedTaskIdPrefetchPoolByWorkspaceId.clear();
}
