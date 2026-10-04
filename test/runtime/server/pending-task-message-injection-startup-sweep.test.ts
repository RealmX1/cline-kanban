// 注入账本的超期清扫：启动扫一趟之后，runtime 活多久就续排多久（按本轮最早超期时刻 + 周期兜底）。
//
// 钉住的几条（每一条漏掉，调用方手上那条 pending 就要等到下一次重启才收敛）：
//   - 不是「启动 + 一趟复扫」就收手：截止相隔数小时的两条门控记录，后一条也在它自己的上界之后被判掉；
//   - 上一趟扫完之后才出现的 pending（链不认识它）由周期兜底在上界之后一个周期内判掉；
//   - 任何一趟都不在记录自己的上界之前判它（不把手伸进别人的在途投递）；
//   - 一趟意外抛错不掐断链；stop() 之后不再扫。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRuntimeHome = { path: "" };
const WORKSPACE_ID = "workspace-alpha";
vi.mock("../../../src/state/workspace-state", async (importOriginal) => ({
	...(await importOriginal()),
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	listWorkspaceIndexEntries: async () => [{ workspaceId: WORKSPACE_ID, repoPath: "/repo/alpha" }],
}));
vi.mock("../../../src/diagnostics/tui-freeze-logger", () => ({
	logTuiFreezeError: vi.fn(),
	logTuiFreezeWarning: vi.fn(),
}));

const {
	STALE_PENDING_SWEEP_MARGIN_BEYOND_CONTRACT_CONVERGENCE_BOUND_MS,
	STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS,
	startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime,
	sweepStalePendingTaskMessageInjectionsForAllWorkspaces,
} = await import("../../../src/server/pending-task-message-injection-startup-sweep");
const {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} = await import("../../../src/core/task-message-injection-ledger");
const { TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS } = await import(
	"../../../src/terminal/session-manager"
);

const TASK_ID = "task-1";
const NOW = Date.parse("2026-10-01T10:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const STALE_THRESHOLD_MS =
	TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS +
	STALE_PENDING_SWEEP_MARGIN_BEYOND_CONTRACT_CONVERGENCE_BOUND_MS;

function ledgerPath() {
	return getTaskMessageInjectionLedgerPath(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID));
}

// 没有队列条目、也没有任何内存登记的门控 pending：runtime 在「建记录」与「入队」之间崩溃，或条目已被裁掉。
async function seedOrphanedAgentIdleGatedPendingRecord(input: {
	idempotencyKey: string;
	createdAtEpochMs: number;
	waitDeadlineAtEpochMs: number;
}) {
	await withTaskMessageInjectionLedgerLock<null>(ledgerPath(), async (records) => ({
		records: [
			...records,
			createPendingTaskMessageInjectionRecord({
				taskId: TASK_ID,
				source: "rvf",
				idempotencyKey: input.idempotencyKey,
				promptSha256: "sha",
				nowIso: new Date(input.createdAtEpochMs).toISOString(),
				agentIdleGate: {
					waitDeadlineAtIso: new Date(input.waitDeadlineAtEpochMs).toISOString(),
					queueEntryId: `agent-idle-gated-programmatic-injection:${input.idempotencyKey}`,
				},
			}),
		],
		result: null,
	}));
}

async function readLedgerRecord(idempotencyKey: string) {
	return findTaskMessageInjectionRecord(await readTaskMessageInjectionLedger(ledgerPath()), TASK_ID, idempotencyKey);
}

async function flushRealInputOutput() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

// 真实账本清扫外面包一层计数：定时器是假的，账本 IO 是真的，推进假时钟之后要等真 IO 落地。
function createObservedRealLedgerSweep() {
	let completedSweepCount = 0;
	return {
		sweepAllWorkspacesOnce: async () => {
			const result = await sweepStalePendingTaskMessageInjectionsForAllWorkspaces();
			completedSweepCount += 1;
			return result;
		},
		waitForCompletedSweepCount: async (expectedCount: number) => {
			for (let spin = 0; spin < 2_000 && completedSweepCount < expectedCount; spin += 1) {
				await flushRealInputOutput();
			}
			expect(completedSweepCount).toBe(expectedCount);
			// 让「扫完 → 续排下一趟」那一步也落地。
			await flushRealInputOutput();
		},
	};
}

beforeEach(async () => {
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-pending-injection-sweep-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(NOW);
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

describe("startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime（真实账本）", () => {
	it("截止相隔数小时的两条无主门控记录：各自在自己的上界之后被判掉，后一条不必等下一次重启", async () => {
		const nearDeadline = NOW + 10 * MINUTE_MS;
		const farDeadline = NOW + 3 * HOUR_MS;
		await seedOrphanedAgentIdleGatedPendingRecord({
			idempotencyKey: "near",
			createdAtEpochMs: NOW - HOUR_MS,
			waitDeadlineAtEpochMs: nearDeadline,
		});
		await seedOrphanedAgentIdleGatedPendingRecord({
			idempotencyKey: "far",
			createdAtEpochMs: NOW - HOUR_MS,
			waitDeadlineAtEpochMs: farDeadline,
		});
		const nearBecomesStaleAt = nearDeadline + STALE_THRESHOLD_MS;
		const farBecomesStaleAt = farDeadline + STALE_THRESHOLD_MS;

		const observed = createObservedRealLedgerSweep();
		const sweeps = startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime({
			sweepAllWorkspacesOnce: observed.sweepAllWorkspacesOnce,
		});
		let completedSweepCount = 1;
		await observed.waitForCompletedSweepCount(completedSweepCount);
		expect((await readLedgerRecord("near"))?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		expect((await readLedgerRecord("far"))?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");

		while (Date.now() < farBecomesStaleAt) {
			await vi.advanceTimersToNextTimerAsync();
			completedSweepCount += 1;
			await observed.waitForCompletedSweepCount(completedSweepCount);
			const sweptAt = Date.now();
			// 上界之前绝不判；跨过上界的那一趟立刻判（续排正好落在上界上）。
			for (const [idempotencyKey, becomesStaleAt] of [
				["near", nearBecomesStaleAt],
				["far", farBecomesStaleAt],
			] as const) {
				const record = await readLedgerRecord(idempotencyKey);
				if (sweptAt < becomesStaleAt) {
					expect(record?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
				} else {
					expect(record).toMatchObject({
						terminal_delivery_status: "delivery_failed",
						terminal_delivery_failure_reason: "runtime_restarted_before_confirmation",
						terminal_delivery_status_updated_at: new Date(becomesStaleAt).toISOString(),
					});
				}
			}
		}
		expect(Date.now()).toBe(farBecomesStaleAt);
		sweeps.stop();
	});

	it("上一趟扫完之后才出现的无主 pending（续排链不认识它）⇒ 周期兜底在它的上界之后一个周期内判掉", async () => {
		const observed = createObservedRealLedgerSweep();
		const sweeps = startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime({
			sweepAllWorkspacesOnce: observed.sweepAllWorkspacesOnce,
		});
		let completedSweepCount = 1;
		await observed.waitForCompletedSweepCount(completedSweepCount);

		// 启动那一趟账本是空的，之后才冒出来一条（例：落定镜像丢了、终态条目又被 Dismiss 的门控记录）。
		const createdAt = Date.now() + 30_000;
		await vi.advanceTimersByTimeAsync(30_000);
		const waitDeadline = createdAt + 2 * MINUTE_MS;
		await seedOrphanedAgentIdleGatedPendingRecord({
			idempotencyKey: "appeared-later",
			createdAtEpochMs: createdAt,
			waitDeadlineAtEpochMs: waitDeadline,
		});
		const becomesStaleAt = waitDeadline + STALE_THRESHOLD_MS;

		let judgedAt: number | null = null;
		while (judgedAt === null) {
			await vi.advanceTimersToNextTimerAsync();
			completedSweepCount += 1;
			await observed.waitForCompletedSweepCount(completedSweepCount);
			const record = await readLedgerRecord("appeared-later");
			if (record?.terminal_delivery_status === "delivery_failed") {
				judgedAt = Date.now();
			}
			expect(Date.now()).toBeLessThanOrEqual(becomesStaleAt + STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS);
		}
		expect(judgedAt).toBeGreaterThanOrEqual(becomesStaleAt);
		sweeps.stop();
	});
});

describe("startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime（续排节奏）", () => {
	it("每趟扫完按本轮最早超期时刻续排，但最迟不超过周期兜底间隔；不止一趟复扫", async () => {
		const sweptAtEpochMs: number[] = [];
		const interval = STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS;
		const earliestSkippedByPass = [
			NOW + 20_000,
			NOW + 20_000 + 5 * HOUR_MS,
			null,
			NOW + 20_000 + 2 * interval + 15_000,
		];
		const sweeps = startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime({
			sweepAllWorkspacesOnce: async () => {
				sweptAtEpochMs.push(Date.now());
				return {
					earliestSkippedPendingBecomesStaleAtEpochMs: earliestSkippedByPass[sweptAtEpochMs.length - 1] ?? null,
				};
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.advanceTimersByTimeAsync(interval);
		await vi.advanceTimersByTimeAsync(interval);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(sweptAtEpochMs).toEqual([
			NOW,
			// 本轮最早超期在 20s 后 ⇒ 正好那时续排。
			NOW + 20_000,
			// 最早超期在 5 小时后 ⇒ 周期兜底先到。
			NOW + 20_000 + interval,
			// 本轮什么都没放过 ⇒ 仍按周期兜底继续扫（兜「之后才出现」的记录）。
			NOW + 20_000 + 2 * interval,
			// 续排不止一趟：第四趟放过的记录同样按它的超期时刻续排。
			NOW + 20_000 + 2 * interval + 15_000,
		]);
		sweeps.stop();
		await vi.advanceTimersByTimeAsync(10 * interval);
		expect(sweptAtEpochMs).toHaveLength(5);
	});

	it("一趟意外抛错不掐断链：下一趟按周期兜底照排", async () => {
		let passCount = 0;
		const sweeps = startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime({
			sweepAllWorkspacesOnce: async () => {
				passCount += 1;
				if (passCount === 1) {
					throw new Error("ledger index exploded");
				}
				return { earliestSkippedPendingBecomesStaleAtEpochMs: null };
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(passCount).toBe(1);
		await vi.advanceTimersByTimeAsync(STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS);
		expect(passCount).toBe(2);
		sweeps.stop();
	});
});
