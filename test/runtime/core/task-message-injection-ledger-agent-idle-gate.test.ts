// 注入账本里「agent 空闲门控的排队投递」那一类记录（--deliver-when-agent-idle）。
//
// 钉住的几条：
//   - 三个新字段读写往返不丢（normalizeLegacyRecord 是逐字段重建的，漏一个就静默蒸发）；
//   - 「通过空闲门」只记一次、只记仍 pending 的门控记录；
//   - 启动清扫的「超期」从 max(状态时间戳, 等待截止) 起算——否则并存的第二个 runtime 一启动就把常驻实例上
//     还在合法排队的记录写成 runtime_restarted_before_confirmation（终态写一次即定，不可纠正）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	isTaskMessageInjectionRecordGatedUntilAgentIdle,
	readTaskMessageInjectionLedger,
	recordTaskMessageInjectionAgentIdleGatePassed,
	recordTaskMessageTerminalDeliveryOutcome,
	resolvePendingRecordBecomesStaleAtEpochMs,
	sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";

const STALE_PENDING_THRESHOLD_MS = 196_500;
const CREATED_AT_ISO = "2026-10-01T10:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT_ISO);
const ONE_HOUR_MS = 60 * 60 * 1000;

describe("task-message-injection-ledger — agent 空闲门控记录", () => {
	let stateDirectory: string;
	let ledgerPath: string;

	beforeEach(async () => {
		stateDirectory = await mkdtemp(join(tmpdir(), "kanban-injection-ledger-agent-idle-gate-"));
		ledgerPath = getTaskMessageInjectionLedgerPath(stateDirectory);
	});

	afterEach(async () => {
		await rm(stateDirectory, { recursive: true, force: true });
	});

	async function seed(input: { idempotencyKey: string; gated: boolean; waitDeadlineAtIso?: string }): Promise<void> {
		await withTaskMessageInjectionLedgerLock<null>(ledgerPath, async (records) => ({
			records: [
				...records,
				createPendingTaskMessageInjectionRecord({
					taskId: "task-1",
					source: "rvf",
					idempotencyKey: input.idempotencyKey,
					promptSha256: "sha-1",
					nowIso: CREATED_AT_ISO,
					...(input.gated
						? {
								agentIdleGate: {
									waitDeadlineAtIso:
										input.waitDeadlineAtIso ?? new Date(CREATED_AT_MS + ONE_HOUR_MS).toISOString(),
									queueEntryId: `queue-entry-${input.idempotencyKey}`,
								},
							}
						: {}),
				}),
			],
			result: null,
		}));
	}

	async function readRecord(idempotencyKey: string) {
		return findTaskMessageInjectionRecord(await readTaskMessageInjectionLedger(ledgerPath), "task-1", idempotencyKey);
	}

	it("三个门控字段写进去、读回来都在；不带门控的记录没有它们", async () => {
		await seed({ idempotencyKey: "gated", gated: true });
		await seed({ idempotencyKey: "immediate", gated: false });
		const gated = await readRecord("gated");
		expect(gated).toMatchObject({
			terminal_delivery_status: "accepted_pending_submit_confirmation",
			agent_idle_wait_deadline_at: new Date(CREATED_AT_MS + ONE_HOUR_MS).toISOString(),
			agent_idle_gated_queue_entry_id: "queue-entry-gated",
		});
		expect(gated?.agent_idle_gate_passed_at).toBeUndefined();
		expect(gated && isTaskMessageInjectionRecordGatedUntilAgentIdle(gated)).toBe(true);
		const immediate = await readRecord("immediate");
		expect(immediate && isTaskMessageInjectionRecordGatedUntilAgentIdle(immediate)).toBe(false);
		expect(immediate).not.toHaveProperty("agent_idle_wait_deadline_at");
	});

	it("通过空闲门只记第一次；落终态后字段与状态都保留", async () => {
		await seed({ idempotencyKey: "gated", gated: true });
		await recordTaskMessageInjectionAgentIdleGatePassed({
			ledgerPath,
			taskId: "task-1",
			idempotencyKey: "gated",
			nowIso: "2026-10-01T10:05:00.000Z",
		});
		await recordTaskMessageInjectionAgentIdleGatePassed({
			ledgerPath,
			taskId: "task-1",
			idempotencyKey: "gated",
			nowIso: "2026-10-01T10:09:00.000Z",
		});
		expect((await readRecord("gated"))?.agent_idle_gate_passed_at).toBe("2026-10-01T10:05:00.000Z");
		// 「通过空闲门」不是一次状态变化：状态时间戳不动。
		expect((await readRecord("gated"))?.terminal_delivery_status_updated_at).toBe(CREATED_AT_ISO);

		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-1",
			idempotencyKey: "gated",
			status: "delivered_and_submit_confirmed",
			nowIso: "2026-10-01T10:05:03.000Z",
		});
		expect(await readRecord("gated")).toMatchObject({
			terminal_delivery_status: "delivered_and_submit_confirmed",
			agent_idle_gate_passed_at: "2026-10-01T10:05:00.000Z",
			agent_idle_wait_deadline_at: new Date(CREATED_AT_MS + ONE_HOUR_MS).toISOString(),
		});
	});

	it("通过空闲门不写进立即投递的记录，也不写进已落定的门控记录", async () => {
		await seed({ idempotencyKey: "immediate", gated: false });
		await seed({ idempotencyKey: "settled", gated: true });
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-1",
			idempotencyKey: "settled",
			status: "delivery_failed",
			failureReason: "cancelled_before_delivery",
			nowIso: "2026-10-01T10:01:00.000Z",
		});
		for (const idempotencyKey of ["immediate", "settled"]) {
			await recordTaskMessageInjectionAgentIdleGatePassed({
				ledgerPath,
				taskId: "task-1",
				idempotencyKey,
				nowIso: "2026-10-01T10:05:00.000Z",
			});
			expect((await readRecord(idempotencyKey))?.agent_idle_gate_passed_at).toBeUndefined();
		}
	});

	it("两个新失败原因能写进账本、读回来不被降级", async () => {
		await seed({ idempotencyKey: "never-idle", gated: true });
		await seed({ idempotencyKey: "queue-full", gated: true });
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-1",
			idempotencyKey: "never-idle",
			status: "delivery_failed",
			failureReason: "agent_never_became_idle_before_queued_delivery_deadline",
			nowIso: "2026-10-01T11:00:00.000Z",
		});
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-1",
			idempotencyKey: "queue-full",
			status: "delivery_failed",
			failureReason: "agent_idle_gated_delivery_queue_capacity_exhausted",
			nowIso: "2026-10-01T10:00:00.000Z",
		});
		expect((await readRecord("never-idle"))?.terminal_delivery_failure_reason).toBe(
			"agent_never_became_idle_before_queued_delivery_deadline",
		);
		expect((await readRecord("queue-full"))?.terminal_delivery_failure_reason).toBe(
			"agent_idle_gated_delivery_queue_capacity_exhausted",
		);
	});

	describe("启动清扫的超期判据", () => {
		it("门控记录从 max(状态时间戳, 等待截止) 起算；立即投递只看状态时间戳", async () => {
			await seed({ idempotencyKey: "gated", gated: true });
			await seed({ idempotencyKey: "immediate", gated: false });
			const gated = await readRecord("gated");
			const immediate = await readRecord("immediate");
			if (!gated || !immediate) {
				throw new Error("seed failed");
			}
			expect(resolvePendingRecordBecomesStaleAtEpochMs(gated, STALE_PENDING_THRESHOLD_MS)).toBe(
				CREATED_AT_MS + ONE_HOUR_MS + STALE_PENDING_THRESHOLD_MS,
			);
			expect(resolvePendingRecordBecomesStaleAtEpochMs(immediate, STALE_PENDING_THRESHOLD_MS)).toBe(
				CREATED_AT_MS + STALE_PENDING_THRESHOLD_MS,
			);
		});

		// 并存实例的启动清扫：常驻实例上这条已经排了 10 分钟，远超终端投递预算，但仍在调用方给的 1 小时之内。
		it("还在等待截止之内的门控记录不被判失败，并报告它何时才会超期", async () => {
			await seed({ idempotencyKey: "gated", gated: true });
			await seed({ idempotencyKey: "immediate", gated: false });
			const swept = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
				ledgerPath,
				nowIso: new Date(CREATED_AT_MS + 10 * 60 * 1000).toISOString(),
				stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
			});
			expect(swept).toEqual({
				sweptCount: 1,
				earliestSkippedPendingBecomesStaleAtEpochMs: CREATED_AT_MS + ONE_HOUR_MS + STALE_PENDING_THRESHOLD_MS,
			});
			expect((await readRecord("gated"))?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
			expect((await readRecord("immediate"))?.terminal_delivery_failure_reason).toBe(
				"runtime_restarted_before_confirmation",
			);
		});

		it("过了等待截止 + 终端投递预算仍 pending ⇒ 判失败（有界收敛不因门控而失效）", async () => {
			await seed({ idempotencyKey: "gated", gated: true });
			await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
				ledgerPath,
				nowIso: new Date(CREATED_AT_MS + ONE_HOUR_MS + STALE_PENDING_THRESHOLD_MS + 1).toISOString(),
				stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
			});
			expect(await readRecord("gated")).toMatchObject({
				terminal_delivery_status: "delivery_failed",
				terminal_delivery_failure_reason: "runtime_restarted_before_confirmation",
			});
		});

		it("等待截止读不出来 ⇒ 退回只看状态时间戳（偏向判失败）", async () => {
			await seed({ idempotencyKey: "gated", gated: true, waitDeadlineAtIso: "not-a-date" });
			const gated = await readRecord("gated");
			if (!gated) {
				throw new Error("seed failed");
			}
			expect(resolvePendingRecordBecomesStaleAtEpochMs(gated, STALE_PENDING_THRESHOLD_MS)).toBe(
				CREATED_AT_MS + STALE_PENDING_THRESHOLD_MS,
			);
		});
	});
});
