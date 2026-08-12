import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	isTaskMessageTerminalDeliveryStatusSettled,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";

// 清扫阈值。生产取值由 runtime 启动清扫从 TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS
// 注入（由 session-manager 的 deadline / 让路 / 确认链收敛上界几个常量算出，当前 195s，那边有单测钉住
// 「不低于契约 § 时序保证 1 的 190s」）；本模块不自持这个策略数字，故这里显式传一个等值的常量。
const STALE_PENDING_THRESHOLD_MS = 195_000;

// 账本文件是 CLI 与 runtime 之间唯一的共享真相，且是 RVF 直接 tail 的对象。
// 这套用例钉住三件事：终态写一次即定、旧记录读得进来、runtime 重启后 pending 必然收敛。
describe("task-message-injection-ledger", () => {
	let stateDirectory: string;
	let ledgerPath: string;

	beforeEach(async () => {
		stateDirectory = await mkdtemp(join(tmpdir(), "kanban-injection-ledger-"));
		ledgerPath = getTaskMessageInjectionLedgerPath(stateDirectory);
	});

	afterEach(async () => {
		await rm(stateDirectory, { recursive: true, force: true });
	});

	async function seedPendingRecord(
		taskId: string,
		idempotencyKey: string,
		createdAtIso = "2026-08-12T00:00:00.000Z",
	): Promise<void> {
		await withTaskMessageInjectionLedgerLock<null>(ledgerPath, async (records) => ({
			records: [
				...records,
				createPendingTaskMessageInjectionRecord({
					taskId,
					source: "rvf",
					idempotencyKey,
					promptSha256: "sha-1",
					nowIso: createdAtIso,
				}),
			],
			result: null,
		}));
	}

	it("账本文件不存在时读成空数组（首次投递不该炸）", async () => {
		expect(await readTaskMessageInjectionLedger(ledgerPath)).toEqual([]);
	});

	it("pending 记录写下时 message_id 与遗留 status 镜像都就位", async () => {
		await seedPendingRecord("task-a", "key-a");
		const record = findTaskMessageInjectionRecord(
			await readTaskMessageInjectionLedger(ledgerPath),
			"task-a",
			"key-a",
		);
		expect(record?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		expect(record?.message_id).toBe("terminal:task-a:key-a");
		expect(record?.status).toBe("pending");
		expect(isTaskMessageTerminalDeliveryStatusSettled("accepted_pending_submit_confirmation")).toBe(false);
	});

	// 契约 § 时序保证 3 的实现基石：没有这条，一条记录就可能既被取消又被判送达。
	it("终态写一次即定：首个写终态的一方获胜，晚到者拿到 already_settled 与真实终态", async () => {
		await seedPendingRecord("task-b", "key-b");

		const first = await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-b",
			idempotencyKey: "key-b",
			status: "delivered_and_submit_confirmed",
			nowIso: "2026-08-12T00:00:01.000Z",
		});
		expect(first.outcome).toBe("settled");

		// 晚到的取消：不得覆盖已确认的终态。
		const late = await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-b",
			idempotencyKey: "key-b",
			status: "delivery_failed",
			failureReason: "cancelled_before_delivery",
			nowIso: "2026-08-12T00:00:02.000Z",
		});
		expect(late.outcome).toBe("already_settled");
		expect(late.outcome === "already_settled" && late.record.terminal_delivery_status).toBe(
			"delivered_and_submit_confirmed",
		);

		const persisted = findTaskMessageInjectionRecord(
			await readTaskMessageInjectionLedger(ledgerPath),
			"task-b",
			"key-b",
		);
		expect(persisted?.terminal_delivery_status).toBe("delivered_and_submit_confirmed");
		expect(persisted?.terminal_delivery_failure_reason).toBeUndefined();
		expect(persisted?.status).toBe("started");
	});

	it("失败终态带上 reason，且遗留 status 镜像为新增取值 failed", async () => {
		await seedPendingRecord("task-c", "key-c");
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-c",
			idempotencyKey: "key-c",
			status: "delivery_failed",
			failureReason: "agent_awaiting_user_decision_timeout",
			nowIso: "2026-08-12T00:00:03.000Z",
		});
		const record = findTaskMessageInjectionRecord(
			await readTaskMessageInjectionLedger(ledgerPath),
			"task-c",
			"key-c",
		);
		expect(record?.terminal_delivery_status).toBe("delivery_failed");
		expect(record?.terminal_delivery_failure_reason).toBe("agent_awaiting_user_decision_timeout");
		expect(record?.status).toBe("failed");
	});

	it("未知 key 上报终态 → unknown_idempotency_key，不凭空造记录", async () => {
		const result = await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-missing",
			idempotencyKey: "key-missing",
			status: "delivered_and_submit_confirmed",
			nowIso: "2026-08-12T00:00:04.000Z",
		});
		expect(result.outcome).toBe("unknown_idempotency_key");
		expect(await readTaskMessageInjectionLedger(ledgerPath)).toEqual([]);
	});

	// 旧记录只有遗留 status，且那个 status 是投递**前**读快照推断的，与实际结果无关。
	// 因此 queued/started 一律降级成 pending 交给启动清扫判失败，绝不伪造成已送达。
	it("旧记录归一化：遗留 queued/started 不得被读成已送达终态", async () => {
		await writeFile(
			ledgerPath,
			JSON.stringify([
				{
					task_id: "task-legacy",
					source: "rvf",
					idempotency_key: "key-legacy",
					prompt_sha256: "sha-legacy",
					message_id: "task-legacy-key-legacy",
					status: "queued",
					created_at: "2026-08-08T10:00:00.000Z",
				},
			]),
			"utf8",
		);
		const record = findTaskMessageInjectionRecord(
			await readTaskMessageInjectionLedger(ledgerPath),
			"task-legacy",
			"key-legacy",
		);
		expect(record?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		// 遗留字段原样保留，不篡改既有读者看到的值。
		expect(record?.status).toBe("queued");
		expect(record?.terminal_delivery_status_updated_at).toBe("2026-08-08T10:00:00.000Z");
	});

	it("启动清扫：超期仍 pending 的记录判 runtime_restarted_before_confirmation，已落定的不动", async () => {
		await seedPendingRecord("task-d", "key-pending");
		await seedPendingRecord("task-d", "key-settled");
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-d",
			idempotencyKey: "key-settled",
			status: "delivered_and_submit_confirmed",
			nowIso: "2026-08-12T00:00:05.000Z",
		});

		const swept = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			nowIso: "2026-08-12T01:00:00.000Z",
			stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
		});
		expect(swept.sweptCount).toBe(1);
		expect(swept.earliestSkippedPendingBecomesStaleAtEpochMs).toBeNull();

		const records = await readTaskMessageInjectionLedger(ledgerPath);
		const pending = findTaskMessageInjectionRecord(records, "task-d", "key-pending");
		const settled = findTaskMessageInjectionRecord(records, "task-d", "key-settled");
		expect(pending?.terminal_delivery_status).toBe("delivery_failed");
		expect(pending?.terminal_delivery_failure_reason).toBe("runtime_restarted_before_confirmation");
		expect(pending?.terminal_delivery_status_updated_at).toBe("2026-08-12T01:00:00.000Z");
		expect(settled?.terminal_delivery_status).toBe("delivered_and_submit_confirmed");
	});

	it("清扫无 pending 时不写盘（避免每次启动都无谓改动 RVF 正在 tail 的文件）", async () => {
		await seedPendingRecord("task-e", "key-e");
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task-e",
			idempotencyKey: "key-e",
			status: "delivery_failed",
			failureReason: "no_active_terminal_session",
			nowIso: "2026-08-12T00:00:06.000Z",
		});
		const before = await readFile(ledgerPath, "utf8");

		const swept = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			nowIso: "2026-08-12T02:00:00.000Z",
			stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
		});
		expect(swept.sweptCount).toBe(0);
		expect(await readFile(ledgerPath, "utf8")).toBe(before);
	});

	// 账本是全机共享的（workspaces 根固定在 homedir 下，无实例级隔离），所以「本进程刚起来」
	// 说明不了「这条 pending 归本进程管」：并行 checkout 的 dev:full / dogfood / 起真服务器的集成测试
	// 一启动，就会把常驻实例此刻真正在途的投递全判失败。而终态写一次即定，真正落定的 delivered_*
	// 随后只会拿到 already_settled 被丢弃 ⇒ 假失败不可纠正。判据必须是契约原文的「超期」。
	it("启动清扫放过未超期的 pending：并存实例的在途投递不得被误判成失败", async () => {
		await seedPendingRecord("task-f", "key-in-flight", "2026-08-12T00:00:00.000Z");

		const swept = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			// 记录才 30s 大，远没到最坏预算：此刻它完全可能正被另一个实例投递着。
			nowIso: "2026-08-12T00:00:30.000Z",
			stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
		});
		expect(swept.sweptCount).toBe(0);

		const record = findTaskMessageInjectionRecord(
			await readTaskMessageInjectionLedger(ledgerPath),
			"task-f",
			"key-in-flight",
		);
		expect(record?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");

		// 放过不等于不管：调用方据此排延迟复扫，否则「重启前一秒刚建的记录」会一直躺到下次重启。
		expect(swept.earliestSkippedPendingBecomesStaleAtEpochMs).toBe(
			Date.parse("2026-08-12T00:00:00.000Z") + STALE_PENDING_THRESHOLD_MS,
		);
	});

	// 延迟复扫这一趟：启动时还年轻、但属主进程其实已经死了的记录，跨过预算后必须被补判——
	// 「有界时间内必然收敛」是本轮改动的核心不变量，放过一次不等于永远放过。
	it("延迟复扫：启动时还年轻的 pending 跨过预算后仍会被判失败", async () => {
		await seedPendingRecord("task-g", "key-young-at-startup", "2026-08-12T00:00:00.000Z");
		const startupSweep = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			nowIso: "2026-08-12T00:00:10.000Z",
			stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
		});
		expect(startupSweep.sweptCount).toBe(0);
		expect(startupSweep.earliestSkippedPendingBecomesStaleAtEpochMs).not.toBeNull();

		const followUpSweep = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			nowIso: new Date((startupSweep.earliestSkippedPendingBecomesStaleAtEpochMs ?? 0) + 5_000).toISOString(),
			stalePendingThresholdMs: STALE_PENDING_THRESHOLD_MS,
		});
		expect(followUpSweep.sweptCount).toBe(1);
		expect(followUpSweep.earliestSkippedPendingBecomesStaleAtEpochMs).toBeNull();

		const record = findTaskMessageInjectionRecord(
			await readTaskMessageInjectionLedger(ledgerPath),
			"task-g",
			"key-young-at-startup",
		);
		expect(record?.terminal_delivery_status).toBe("delivery_failed");
		expect(record?.terminal_delivery_failure_reason).toBe("runtime_restarted_before_confirmation");
	});
});
