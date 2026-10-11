// 启动清扫（排队 prompt 版）：先收敛被重启撂下的在途投递，再给跨过重启的条目盖章。
//
// 钉住的几条：
//   - 在途投递按「超期」判，不按「本进程刚起来」判——并存实例此刻真正在途的投递不能被判失败；
//   - handed_to_transport 落 settled_failed（可能已发出，交给人），claimed_for_dispatch 释放回 queued；
//   - 已判「可能发出去了」的条目不再被盖 restart-crossing 章（先收敛、后盖章的顺序）；
//   - 盖章只盖托管实例已不在心跳里的条目；读不到心跳时按「谁都不活」多盖（fail-safe）；
//   - 延迟复扫只收敛在途，不盖章。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const {
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	markQueuedTaskPromptDeliveryHandedToTransport,
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} = await import("../../../src/state/queued-task-prompt-delivery-store");
const { getThisRuntimeProcessInstanceId } = await import(
	"../../../src/state/runtime-process-instance-heartbeat-registry"
);
const { sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces } = await import(
	"../../../src/server/stale-queued-task-prompt-delivery-startup-sweep"
);

const WORKSPACE_ID = "workspace-alpha";
const NOW = 1_700_000_000_000;
const BUDGET_MS = 200_000;
// 条目由「本测试进程」入队，于是托管者 = getThisRuntimeProcessInstanceId()。
// 下面用「活着的实例集合里有没有它」来模拟「排队的那个实例还在 / 已经死了」。
const SWEEPING_INSTANCE_ID = "instance-that-just-started";

async function enqueue(taskId: string, queueEntryId: string, nowEpochMs: number) {
	await mutateWorkspaceQueuedTaskPromptDeliveries(
		WORKSPACE_ID,
		{ kind: "enqueue_prompt_for_delivery_after_current_turn", taskId, queueEntryId, text: `正文 ${queueEntryId}` },
		nowEpochMs,
	);
}

async function claim(taskId: string, nowEpochMs: number) {
	return await claimNextQueuedTaskPromptDeliveryRunForDispatch({
		workspaceId: WORKSPACE_ID,
		taskId,
		sessionIncarnationId: "incarnation-1",
		turnSequence: 1,
		nowEpochMs,
	});
}

async function handOff(taskId: string, queueEntryId: string, nowEpochMs: number) {
	await claim(taskId, nowEpochMs);
	await markQueuedTaskPromptDeliveryHandedToTransport({
		workspaceId: WORKSPACE_ID,
		taskId,
		queueEntryIds: [queueEntryId],
		dispatchIdempotencyKey: `idem-${queueEntryId}`,
		nowEpochMs,
	});
}

async function entryOf(taskId: string) {
	return (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[taskId]?.[0];
}

function sweep(overrides: {
	liveRuntimeProcessInstanceIds?: ReadonlySet<string>;
	stamp?: boolean;
	now?: number;
	onWorkspaceQueueRewritten?: (workspaceId: string) => void;
	readLiveFails?: boolean;
}) {
	return sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces({
		runtimeProcessStartedAtEpochMs: (overrides.now ?? NOW) - 1_000,
		sweepingRuntimeProcessInstanceId: SWEEPING_INSTANCE_ID,
		stampEntriesThatSurvivedRuntimeRestart: overrides.stamp ?? true,
		inFlightSettlementBudgetMs: BUDGET_MS,
		listWorkspaceIds: async () => [WORKSPACE_ID],
		readLiveRuntimeProcessInstanceIds: async () => {
			if (overrides.readLiveFails) {
				throw new Error("心跳目录读不出来");
			}
			return overrides.liveRuntimeProcessInstanceIds ?? new Set([SWEEPING_INSTANCE_ID]);
		},
		onWorkspaceQueueRewritten: overrides.onWorkspaceQueueRewritten,
		nowEpochMs: () => overrides.now ?? NOW,
	});
}

beforeEach(async () => {
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-prompt-startup-sweep-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
});

afterEach(async () => {
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

describe("stale-queued-task-prompt-delivery-startup-sweep — 在途投递收敛", () => {
	it("超期的 handed_to_transport 落 settled_failed（可能已发出，交给人），且不再被盖章", async () => {
		await enqueue("task-1", "q1", NOW - BUDGET_MS * 3);
		await handOff("task-1", "q1", NOW - BUDGET_MS * 2);
		const result = await sweep({ liveRuntimeProcessInstanceIds: new Set([SWEEPING_INSTANCE_ID]) });
		expect(result.failedStrandedDeliveryCount).toBe(1);
		expect(result.stampedCount).toBe(0);
		const entry = await entryOf("task-1");
		expect(entry?.deliveryState).toBe("settled_failed");
		expect(entry?.lastDeliveryFailureNote).toContain("may or may not have reached the agent");
		expect(entry?.survivedRuntimeRestartAtEpochMs).toBeNull();
	});

	it("超期的 claimed_for_dispatch 释放回 queued（一个字节都没写出去），不计尝试", async () => {
		await enqueue("task-1", "q1", NOW - BUDGET_MS * 3);
		await claim("task-1", NOW - BUDGET_MS * 2);
		const result = await sweep({});
		expect(result.releasedClaimCount).toBe(1);
		expect(await entryOf("task-1")).toMatchObject({ deliveryState: "queued", deliveryAttemptCount: 0 });
	});

	// 并存实例此刻真正在途的投递：年龄还在预算内，绝不能被判成不可纠正的假失败。
	it("还年轻的在途投递不动，并报告它最早何时跨过预算（供延迟复扫）", async () => {
		await enqueue("task-1", "q1", NOW - 5_000);
		await handOff("task-1", "q1", NOW - 5_000);
		const result = await sweep({ liveRuntimeProcessInstanceIds: new Set([getThisRuntimeProcessInstanceId()]) });
		expect(result.failedStrandedDeliveryCount).toBe(0);
		expect((await entryOf("task-1"))?.deliveryState).toBe("handed_to_transport");
		expect(result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs).toBe(NOW - 5_000 + BUDGET_MS);
	});
});

describe("stale-queued-task-prompt-delivery-startup-sweep — restart-crossing 盖章", () => {
	it("托管实例已不在心跳里 ⇒ 盖章、清确认、托管权转给做清扫的实例", async () => {
		await enqueue("task-1", "q1", NOW - 60_000);
		const result = await sweep({ liveRuntimeProcessInstanceIds: new Set([SWEEPING_INSTANCE_ID]) });
		expect(result.stampedCount).toBe(1);
		expect(await entryOf("task-1")).toMatchObject({
			survivedRuntimeRestartAtEpochMs: NOW,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
			custodianRuntimeProcessInstanceId: SWEEPING_INSTANCE_ID,
		});
	});

	// dev:full / dogfood / 集成测试在常驻实例活着时启动：常驻实例正常排着的队一条都不能动。
	it("托管实例还活着 ⇒ 不盖章", async () => {
		await enqueue("task-1", "q1", NOW - 60_000);
		const result = await sweep({
			liveRuntimeProcessInstanceIds: new Set([SWEEPING_INSTANCE_ID, getThisRuntimeProcessInstanceId()]),
		});
		expect(result.stampedCount).toBe(0);
		expect((await entryOf("task-1"))?.survivedRuntimeRestartAtEpochMs).toBeNull();
	});

	// 漏盖 = 重启后不提醒直接发，正是这套机制要防的那件事；多盖只是多让人确认一次。
	it("心跳读不出来 ⇒ 按「谁都不活」多盖（fail-safe）", async () => {
		await enqueue("task-1", "q1", NOW - 60_000);
		const result = await sweep({ readLiveFails: true });
		expect(result.stampedCount).toBe(1);
	});

	it("延迟复扫只收敛在途，不盖章", async () => {
		await enqueue("task-1", "q1", NOW - 60_000);
		const result = await sweep({ stamp: false, liveRuntimeProcessInstanceIds: new Set() });
		expect(result.stampedCount).toBe(0);
		expect((await entryOf("task-1"))?.survivedRuntimeRestartAtEpochMs).toBeNull();
	});

	it("有改动才通知调用方刷新缓存", async () => {
		const rewritten: string[] = [];
		await enqueue("task-1", "q1", NOW - 60_000);
		await sweep({
			liveRuntimeProcessInstanceIds: new Set([SWEEPING_INSTANCE_ID, getThisRuntimeProcessInstanceId()]),
			onWorkspaceQueueRewritten: (workspaceId) => rewritten.push(workspaceId),
		});
		expect(rewritten).toEqual([]);
		await sweep({
			liveRuntimeProcessInstanceIds: new Set([SWEEPING_INSTANCE_ID]),
			onWorkspaceQueueRewritten: (workspaceId) => rewritten.push(workspaceId),
		});
		expect(rewritten).toEqual([WORKSPACE_ID]);
	});
});
