import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ensureRuntimeAllocatedTaskIdPrefetchPoolFilled,
	RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE,
	resetRuntimeAllocatedTaskIdPrefetchPoolsForTests,
	takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards,
} from "@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards";

const allocateRuntimeTaskIdForNewWebUiTaskCardMock = vi.hoisted(() =>
	vi.fn<(workspaceId: string) => Promise<string | null>>(),
);

vi.mock("@/runtime/task-id-allocation-for-new-web-ui-task-card-query", () => ({
	allocateRuntimeTaskIdForNewWebUiTaskCard: allocateRuntimeTaskIdForNewWebUiTaskCardMock,
}));

async function flushAllocationResponses(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await Promise.resolve();
	}
}

describe("runtime-allocated task id prefetch pool", () => {
	let allocatedTaskIdSequence = 0;

	beforeEach(() => {
		resetRuntimeAllocatedTaskIdPrefetchPoolsForTests();
		allocatedTaskIdSequence = 0;
		allocateRuntimeTaskIdForNewWebUiTaskCardMock.mockReset();
		allocateRuntimeTaskIdForNewWebUiTaskCardMock.mockImplementation(async (workspaceId) => {
			allocatedTaskIdSequence += 1;
			return `${workspaceId}-id-${allocatedTaskIdSequence}`;
		});
	});

	afterEach(() => {
		resetRuntimeAllocatedTaskIdPrefetchPoolsForTests();
	});

	it("prefetches up to the target size per workspace and does not over-request while allocations are in flight", async () => {
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-a");
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-a");
		expect(allocateRuntimeTaskIdForNewWebUiTaskCardMock).toHaveBeenCalledTimes(
			RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE,
		);
		expect(allocateRuntimeTaskIdForNewWebUiTaskCardMock).toHaveBeenCalledWith("workspace-a");
	});

	it("hands out prefetched runtime ids synchronously and asynchronously refills what was taken", async () => {
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-a");
		await flushAllocationResponses();

		expect(takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-a", 1)).toEqual({
			status: "taken",
			runtimeAllocatedTaskIds: ["workspace-a-id-1"],
		});
		// 用掉一个，立刻补一个。
		expect(allocateRuntimeTaskIdForNewWebUiTaskCardMock).toHaveBeenCalledTimes(
			RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE + 1,
		);
	});

	it("keeps pools per workspace so one project's ids are never used for another", async () => {
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-a");
		await flushAllocationResponses();

		expect(takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-b", 1)).toEqual({
			status: "not_enough_runtime_allocated_task_ids_prefetched_yet",
		});
		expect(allocateRuntimeTaskIdForNewWebUiTaskCardMock).toHaveBeenCalledWith("workspace-b");
	});

	it("takes nothing when a batch needs more ids than are ready, and refills for the whole batch", async () => {
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-a");
		await flushAllocationResponses();
		allocateRuntimeTaskIdForNewWebUiTaskCardMock.mockClear();

		expect(takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-a", 5)).toEqual({
			status: "not_enough_runtime_allocated_task_ids_prefetched_yet",
		});
		expect(allocateRuntimeTaskIdForNewWebUiTaskCardMock).toHaveBeenCalledTimes(
			5 - RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE,
		);
		await flushAllocationResponses();

		const taken = takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-a", 5);
		expect(taken.status).toBe("taken");
		expect(taken.status === "taken" ? new Set(taken.runtimeAllocatedTaskIds).size : 0).toBe(5);
	});

	it("reports honestly when the runtime cannot allocate ids (no relation ledger) instead of inventing one", async () => {
		allocateRuntimeTaskIdForNewWebUiTaskCardMock.mockImplementation(async () => null);
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-without-ledger");
		await flushAllocationResponses();

		expect(takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-without-ledger", 1)).toEqual({
			status: "runtime_cannot_allocate_task_ids_because_relation_ledger_is_unavailable",
		});
	});

	it("does not retry failed allocations on its own; the next demand refills", async () => {
		allocateRuntimeTaskIdForNewWebUiTaskCardMock.mockRejectedValue(new Error("runtime unreachable"));
		ensureRuntimeAllocatedTaskIdPrefetchPoolFilled("workspace-a");
		await flushAllocationResponses();
		expect(allocateRuntimeTaskIdForNewWebUiTaskCardMock).toHaveBeenCalledTimes(
			RUNTIME_ALLOCATED_TASK_ID_PREFETCH_POOL_TARGET_READY_COUNT_PER_WORKSPACE,
		);

		allocateRuntimeTaskIdForNewWebUiTaskCardMock.mockImplementation(async () => "recovered-id");
		expect(takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-a", 1)).toEqual({
			status: "not_enough_runtime_allocated_task_ids_prefetched_yet",
		});
		await flushAllocationResponses();
		expect(takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards("workspace-a", 1)).toEqual({
			status: "taken",
			runtimeAllocatedTaskIds: ["recovered-id"],
		});
	});
});
