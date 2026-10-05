// 注入账本的超期清扫：启动扫一趟之后，runtime 活多久就续排多久（按本轮最早超期时刻 + 周期兜底）。
//
// 钉住的几条（每一条漏掉，调用方手上那条 pending 就要等到下一次重启才收敛）：
//   - 不是「启动 + 一趟复扫」就收手：截止相隔数小时的两条门控记录，后一条也在它自己的上界之后被判掉；
//   - 上一趟扫完之后才出现的 pending（链不认识它）由周期兜底在上界之后一个周期内判掉；
//   - 任何一趟都不在记录自己的上界之前判它（不把手伸进别人的在途投递）；
//   - 一趟意外抛错不掐断链；stop() 之后不再扫。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const { lockedFileSystem } = await import("../../../src/fs/locked-file-system");

// DIAGNOSTIC_458B1：一次性诊断代码，只活在诊断分支上。记录每趟真实账本清扫在各阶段（取锁 / 读 / 写 / 释放）的墙钟耗时，
// 以及旧版「空转 2000 次 setImmediate」预算本会判失败的那些等待：当时在途那一趟停在哪个阶段、有没有假定时器在等、锁文件在不在。
type DiagnosticSweepPassPhase =
	| "before-lock"
	| "acquiring-lock"
	| "reading-ledger"
	| "writing-ledger"
	| "after-write"
	| "releasing-lock"
	| "after-release";
let diagnosticCurrentSweepPass: { marks: Record<string, number>; phase: DiagnosticSweepPassPhase } | null = null;
const diagnosticSweepPassPhaseTimings: Array<Record<string, number | string>> = [];
const diagnosticOldSpinBudgetExceededEvents: string[] = [];
const diagnosticNoopSpinBudgetDurationsMs: number[] = [];
const OLD_SPIN_BUDGET = 2_000;

function diagnosticPercentile(sortedValues: number[], percentile: number): number {
	if (sortedValues.length === 0) {
		return Number.NaN;
	}
	return (
		sortedValues[Math.min(sortedValues.length - 1, Math.floor((percentile / 100) * sortedValues.length))] ??
		Number.NaN
	);
}

function diagnosticDescribeDistribution(values: number[]): string {
	const sorted = values.slice().sort((left, right) => left - right);
	return `n=${sorted.length} p50=${diagnosticPercentile(sorted, 50).toFixed(2)} p90=${diagnosticPercentile(sorted, 90).toFixed(2)} p99=${diagnosticPercentile(sorted, 99).toFixed(2)} max=${(sorted.at(-1) ?? Number.NaN).toFixed(2)}`;
}

function installDiagnosticLockedFileSystemPhaseSpies() {
	const originalWithLock = lockedFileSystem.withLock.bind(lockedFileSystem);
	vi.spyOn(lockedFileSystem, "withLock").mockImplementation(async (request, operation) => {
		const pass = diagnosticCurrentSweepPass;
		if (pass === null) {
			return await originalWithLock(request, operation);
		}
		pass.marks.lockRequested = performance.now();
		pass.phase = "acquiring-lock";
		try {
			return await originalWithLock(request, async () => {
				pass.marks.lockAcquired = performance.now();
				pass.phase = "reading-ledger";
				const operationResult = await operation();
				pass.marks.operationDone = performance.now();
				pass.phase = "releasing-lock";
				return operationResult;
			});
		} finally {
			pass.marks.lockReleased = performance.now();
			pass.phase = "after-release";
		}
	});
	const originalWriteJsonFileAtomic = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
	vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, payload, options) => {
		const pass = diagnosticCurrentSweepPass;
		if (pass !== null) {
			pass.marks.writeStarted = performance.now();
			pass.phase = "writing-ledger";
		}
		try {
			return await originalWriteJsonFileAtomic(path, payload, options);
		} finally {
			if (pass !== null) {
				pass.marks.writeDone = performance.now();
				pass.phase = "after-write";
			}
		}
	});
}

afterAll(() => {
	const phaseNames = [
		"preLockMs",
		"acquireLockMs",
		"readLedgerMs",
		"writeLedgerMs",
		"releaseLockMs",
		"afterReleaseMs",
		"totalMs",
	];
	const lines = [`DIAG_458B1 summary passes=${diagnosticSweepPassPhaseTimings.length}`];
	for (const phaseName of phaseNames) {
		lines.push(
			`DIAG_458B1 phase ${phaseName}: ${diagnosticDescribeDistribution(diagnosticSweepPassPhaseTimings.map((timing) => Number(timing[phaseName])))}`,
		);
	}
	lines.push(
		`DIAG_458B1 noop ${OLD_SPIN_BUDGET}-spin duration ms: ${diagnosticDescribeDistribution(diagnosticNoopSpinBudgetDurationsMs)}`,
	);
	lines.push(`DIAG_458B1 old-spin-budget-exceeded waits=${diagnosticOldSpinBudgetExceededEvents.length}`);
	for (const event of diagnosticOldSpinBudgetExceededEvents) {
		lines.push(`DIAG_458B1 old-spin-budget-exceeded ${event}`);
	}
	const slowestPasses = diagnosticSweepPassPhaseTimings
		.slice()
		.sort((left, right) => Number(right.totalMs) - Number(left.totalMs))
		.slice(0, 10);
	for (const pass of slowestPasses) {
		lines.push(`DIAG_458B1 slowest-pass ${JSON.stringify(pass)}`);
	}
	const summaryText = lines.join("\n");
	console.log(summaryText);
	const diagnosticOutputDirectory = process.env.DIAG_458B1_OUTPUT_DIRECTORY;
	if (diagnosticOutputDirectory) {
		mkdirSync(diagnosticOutputDirectory, { recursive: true });
		writeFileSync(
			join(diagnosticOutputDirectory, `summary-pid-${process.pid}-${Date.now()}.txt`),
			`${summaryText}\n`,
		);
		writeFileSync(
			join(diagnosticOutputDirectory, `pass-phase-timings-pid-${process.pid}-${Date.now()}.json`),
			JSON.stringify(diagnosticSweepPassPhaseTimings),
		);
	}
});

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

// 等一趟真实账本清扫落地的墙钟上限。这是单档的「终会发生」等待（test/README.md「负载敏感的墙钟 / 资源断言」）：
// 正常一趟约 1ms，上限只兜「真卡住了」。
// 不按轮数设上限：旧版空转 2000 次 setImmediate，在 GitHub Actions ubuntu 上只合约 5ms，线程池上的 fs 操作一抖就超（458b1）。
// setTimeout 与 Date 都是假的，所以用 performance.now() 计时、用 setImmediate 让出；也不能用 vi.waitFor，它每轮都推进假时钟。
// EXPERIMENT_NODE: 上限取 5s；更长 = 真卡住时更晚失败，更短 = 慢 runner 上把慢 IO 判成失败。
const REAL_LEDGER_SWEEP_PASS_COMPLETION_WALL_CLOCK_BOUND_MS = 5_000;

async function waitForConditionWithinRealLedgerSweepPassCompletionWallClockBound(
	isConditionSatisfied: () => boolean,
	diagnosticWaitLabel = "",
): Promise<{ satisfied: boolean; elapsedMs: number }> {
	const waitStartedAt = performance.now();
	let diagnosticSpinCount = 0;
	let diagnosticSnapshotAtOldSpinBudget: string | null = null;
	while (!isConditionSatisfied()) {
		if (performance.now() - waitStartedAt >= REAL_LEDGER_SWEEP_PASS_COMPLETION_WALL_CLOCK_BOUND_MS) {
			if (diagnosticSnapshotAtOldSpinBudget !== null) {
				diagnosticOldSpinBudgetExceededEvents.push(
					`${diagnosticSnapshotAtOldSpinBudget} never-completed-within-bound`,
				);
			}
			return { satisfied: false, elapsedMs: performance.now() - waitStartedAt };
		}
		if (diagnosticSpinCount === OLD_SPIN_BUDGET) {
			diagnosticSnapshotAtOldSpinBudget =
				`test=${JSON.stringify(expect.getState().currentTestName)} wait=${diagnosticWaitLabel} ` +
				`elapsedAtOldBudgetMs=${(performance.now() - waitStartedAt).toFixed(2)} ` +
				`inFlightPhase=${diagnosticCurrentSweepPass?.phase ?? "none"} fakeTimerCount=${vi.getTimerCount()} ` +
				`lockFileExists=${existsSync(`${ledgerPath()}.lock`)}`;
		}
		diagnosticSpinCount += 1;
		await flushRealInputOutput();
	}
	if (diagnosticSnapshotAtOldSpinBudget !== null) {
		diagnosticOldSpinBudgetExceededEvents.push(
			`${diagnosticSnapshotAtOldSpinBudget} completedAfterMs=${(performance.now() - waitStartedAt).toFixed(2)} spins=${diagnosticSpinCount}`,
		);
	}
	return { satisfied: true, elapsedMs: performance.now() - waitStartedAt };
}

// 本用例启动的真实账本清扫链，由 afterEach 收尾：先停链、等在途那一趟落地，再卸假时钟、删目录。
// 用例中途断言失败时，用例体末尾的 stop() 执行不到，在途那一趟会拖到下一个用例里才落地（testRuntimeHome.path 是模块级的），
// 再把下一趟续排到下一个用例的假时钟上。这个定时器和下一个用例自己的定时器同一时刻到期、但建得更早，
// 会先被 advanceTimersToNextTimerAsync 触发，于是下一个用例的计数停住。CI 上第二例的 `1≠2` 就是这样连带出来的（458b1）。
const settleRealLedgerSweepChainsStartedInCurrentTest: Array<() => Promise<void>> = [];

// 真实账本清扫外面包一层计数：定时器是假的，账本 IO 是真的，推进假时钟之后要等真 IO 落地。
function startRealLedgerSweepChainObservedForCurrentTest() {
	let completedSweepCount = 0;
	let sweepPassInFlight = false;
	const describeRealLedgerSweepState = () =>
		`已完成 ${completedSweepCount} 趟，${sweepPassInFlight ? "有" : "没有"}在途的一趟，` +
		`假定时器 ${vi.getTimerCount()} 个，账本锁文件${existsSync(`${ledgerPath()}.lock`) ? "存在" : "不存在"}。` +
		"判读：有在途、锁文件存在且有假定时器 ⇒ 取锁重试挂在了假 setTimeout 上；有在途、没有多出来的假定时器 ⇒ 真实 IO 慢";
	const sweeps = startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime({
		sweepAllWorkspacesOnce: async () => {
			sweepPassInFlight = true;
			const pass: { marks: Record<string, number>; phase: DiagnosticSweepPassPhase } = {
				marks: { passStarted: performance.now() },
				phase: "before-lock",
			};
			diagnosticCurrentSweepPass = pass;
			try {
				const result = await sweepStalePendingTaskMessageInjectionsForAllWorkspaces();
				completedSweepCount += 1;
				return result;
			} finally {
				const passEnded = performance.now();
				const marks = pass.marks;
				const writeLedgerMs = (marks.writeDone ?? 0) - (marks.writeStarted ?? 0);
				diagnosticSweepPassPhaseTimings.push({
					test: String(expect.getState().currentTestName),
					passIndex: completedSweepCount,
					preLockMs: (marks.lockRequested ?? Number.NaN) - marks.passStarted,
					acquireLockMs: (marks.lockAcquired ?? Number.NaN) - (marks.lockRequested ?? Number.NaN),
					readLedgerMs: (marks.operationDone ?? Number.NaN) - (marks.lockAcquired ?? Number.NaN) - writeLedgerMs,
					writeLedgerMs,
					releaseLockMs: (marks.lockReleased ?? Number.NaN) - (marks.operationDone ?? Number.NaN),
					afterReleaseMs: passEnded - (marks.lockReleased ?? Number.NaN),
					totalMs: passEnded - marks.passStarted,
				});
				diagnosticCurrentSweepPass = null;
				sweepPassInFlight = false;
			}
		},
	});
	settleRealLedgerSweepChainsStartedInCurrentTest.push(async () => {
		sweeps.stop();
		const waited = await waitForConditionWithinRealLedgerSweepPassCompletionWallClockBound(
			() => !sweepPassInFlight,
			"settle-after-stop",
		);
		if (!waited.satisfied) {
			throw new Error(
				`清扫链已 stop()，但在途的那一趟 ${waited.elapsedMs.toFixed(1)}ms 内没有落地：${describeRealLedgerSweepState()}`,
			);
		}
	});
	return {
		waitForCompletedSweepCount: async (expectedCount: number) => {
			const waited = await waitForConditionWithinRealLedgerSweepPassCompletionWallClockBound(
				() => completedSweepCount >= expectedCount,
				`completed-sweep-count-${expectedCount}`,
			);
			if (!waited.satisfied) {
				throw new Error(
					`等第 ${expectedCount} 趟真实账本清扫落地，超过墙钟上限 ` +
						`${REAL_LEDGER_SWEEP_PASS_COMPLETION_WALL_CLOCK_BOUND_MS}ms（已等 ${waited.elapsedMs.toFixed(1)}ms）：` +
						describeRealLedgerSweepState(),
				);
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
	installDiagnosticLockedFileSystemPhaseSpies();
});

afterEach(async () => {
	try {
		for (const settleRealLedgerSweepChain of settleRealLedgerSweepChainsStartedInCurrentTest.splice(0)) {
			await settleRealLedgerSweepChain();
		}
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	}
});

for (const diagnosticRepetitionIndex of Array.from({ length: 20 }, (_, index) => index)) {
	describe(`startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime（真实账本）#${diagnosticRepetitionIndex}`, () => {
		beforeAll(async () => {
			const noopSpinStartedAt = performance.now();
			for (let spin = 0; spin < OLD_SPIN_BUDGET; spin += 1) {
				await flushRealInputOutput();
			}
			diagnosticNoopSpinBudgetDurationsMs.push(performance.now() - noopSpinStartedAt);
		});
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

			const observed = startRealLedgerSweepChainObservedForCurrentTest();
			let completedSweepCount = 1;
			await observed.waitForCompletedSweepCount(completedSweepCount);
			expect((await readLedgerRecord("near"))?.terminal_delivery_status).toBe(
				"accepted_pending_submit_confirmation",
			);
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
		});

		it("上一趟扫完之后才出现的无主 pending（续排链不认识它）⇒ 周期兜底在它的上界之后一个周期内判掉", async () => {
			const observed = startRealLedgerSweepChainObservedForCurrentTest();
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
		});
	});
}

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
