// 程序化排队投递「队列条目 → 注入账本」镜像规则的真值表。
//
// 钉住的几条：
//   - 由状态推出的回执里**没有任何一格**是「已送达」以外的送达——推错方向 = 调用方重投、同一段话送两遍；
//   - 出队引擎存下的真实终端回执优先于按状态推（确认 vs 排在回合后面、具体哪种失败只有它知道）；
//   - 非终态条目随任务被丢弃 ⇒ session_ended_before_delivery；终态条目保留期满被裁掉 ⇒ 什么都不写；
//   - 人排的条目永远不碰账本。
import { describe, expect, it } from "vitest";

import type {
	QueuedTaskPromptDeliveryEntry,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../../../src/core/api-contract";
import {
	buildQueuedProgrammaticInjectionQueueEntryId,
	collectInjectionLedgerUpdatesForQueueSnapshotTransition,
	resolveInjectionLedgerReceiptForSettledProgrammaticInjection,
} from "../../../src/core/queued-programmatic-injection-ledger-receipt-mirroring";

const NOW = 1_700_000_000_000;
const TASK_ID = "task-1";
const KEY = "rvf-decision-point-key";

function entry(overrides: Partial<QueuedTaskPromptDeliveryEntry> = {}): QueuedTaskPromptDeliveryEntry {
	return {
		queueEntryId: buildQueuedProgrammaticInjectionQueueEntryId(KEY),
		taskId: TASK_ID,
		text: "边界标记",
		deliverTogetherWithNextQueuedEntry: false,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextSha256: null,
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		lastAttemptedAt: null,
		settledAt: null,
		dispatchIdempotencyKey: null,
		claimedForSessionIncarnationId: null,
		claimedAtTurnSequence: null,
		enqueuedAt: NOW,
		expiresAt: NOW + 60_000,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		programmaticInjectionLedgerReceiptLink: {
			injectionLedgerIdempotencyKey: KEY,
			injectionSource: "rvf",
			settledTerminalDeliveryReceipt: null,
		},
		...overrides,
	};
}

function humanEntry(overrides: Partial<QueuedTaskPromptDeliveryEntry> = {}): QueuedTaskPromptDeliveryEntry {
	return entry({ queueEntryId: "human-1", programmaticInjectionLedgerReceiptLink: null, ...overrides });
}

function snapshotOf(...entries: QueuedTaskPromptDeliveryEntry[]): WorkspaceQueuedTaskPromptDeliverySnapshot {
	return entries.length === 0 ? { entriesByTaskId: {} } : { entriesByTaskId: { [TASK_ID]: entries } };
}

describe("resolveInjectionLedgerReceiptForSettledProgrammaticInjection — 由状态推回执", () => {
	it.each([
		["expired", { status: "delivery_failed", reason: "agent_never_became_idle_before_queued_delivery_deadline" }],
		["cancelled", { status: "delivery_failed", reason: "cancelled_before_delivery" }],
		["settled_failed", { status: "delivery_failed", reason: "runtime_restarted_before_confirmation" }],
		["settled_delivered", { status: "delivered_and_submit_confirmed", reason: null }],
	] as const)("%s → %o", (deliveryState, expected) => {
		expect(resolveInjectionLedgerReceiptForSettledProgrammaticInjection(entry({ deliveryState }))).toEqual(expected);
	});

	it.each(["queued", "claimed_for_dispatch", "handed_to_transport"] as const)(
		"未落定（%s）→ null",
		(deliveryState) => {
			expect(resolveInjectionLedgerReceiptForSettledProgrammaticInjection(entry({ deliveryState }))).toBeNull();
		},
	);

	it("出队引擎存下的真实回执优先于按状态推", () => {
		const settled = entry({
			deliveryState: "settled_failed",
			programmaticInjectionLedgerReceiptLink: {
				injectionLedgerIdempotencyKey: KEY,
				injectionSource: "rvf",
				settledTerminalDeliveryReceipt: { status: "delivery_failed", reason: "human_terminal_contention_timeout" },
			},
		});
		expect(resolveInjectionLedgerReceiptForSettledProgrammaticInjection(settled)).toEqual({
			status: "delivery_failed",
			reason: "human_terminal_contention_timeout",
		});
	});

	it("人排的条目 → null（不碰账本）", () => {
		expect(
			resolveInjectionLedgerReceiptForSettledProgrammaticInjection(humanEntry({ deliveryState: "cancelled" })),
		).toBeNull();
	});
});

describe("collectInjectionLedgerUpdatesForQueueSnapshotTransition — 一次写盘该镜像什么", () => {
	it("同一份快照 → 无改动", () => {
		const snapshot = snapshotOf(entry());
		expect(collectInjectionLedgerUpdatesForQueueSnapshotTransition(snapshot, snapshot, NOW)).toEqual([]);
	});

	it("queued → cancelled ⇒ 记 cancelled_before_delivery", () => {
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(entry()),
				snapshotOf(entry({ deliveryState: "cancelled", settledAt: NOW })),
				NOW,
			),
		).toEqual([
			{
				kind: "record_terminal_delivery_outcome",
				taskId: TASK_ID,
				injectionLedgerIdempotencyKey: KEY,
				receipt: { status: "delivery_failed", reason: "cancelled_before_delivery" },
			},
		]);
	});

	it("claimed → handed_to_transport ⇒ 记通过空闲门的时刻（取 lastAttemptedAt）", () => {
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(entry({ deliveryState: "claimed_for_dispatch" })),
				snapshotOf(entry({ deliveryState: "handed_to_transport", lastAttemptedAt: NOW + 5 })),
				NOW + 10,
			),
		).toEqual([
			{
				kind: "record_agent_idle_gate_passed",
				taskId: TASK_ID,
				injectionLedgerIdempotencyKey: KEY,
				passedAtEpochMs: NOW + 5,
			},
		]);
	});

	it("handed → settled_delivered 带 queued_behind 回执 ⇒ 原样镜像", () => {
		const delivered = entry({
			deliveryState: "settled_delivered",
			programmaticInjectionLedgerReceiptLink: {
				injectionLedgerIdempotencyKey: KEY,
				injectionSource: "rvf",
				settledTerminalDeliveryReceipt: { status: "delivered_queued_behind_active_agent_turn", reason: null },
			},
		});
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(entry({ deliveryState: "handed_to_transport" })),
				snapshotOf(delivered),
				NOW,
			),
		).toEqual([
			{
				kind: "record_terminal_delivery_outcome",
				taskId: TASK_ID,
				injectionLedgerIdempotencyKey: KEY,
				receipt: { status: "delivered_queued_behind_active_agent_turn", reason: null },
			},
		]);
	});

	it("非终态条目随任务被整条丢弃 ⇒ session_ended_before_delivery", () => {
		expect(collectInjectionLedgerUpdatesForQueueSnapshotTransition(snapshotOf(entry()), snapshotOf(), NOW)).toEqual([
			{
				kind: "record_terminal_delivery_outcome",
				taskId: TASK_ID,
				injectionLedgerIdempotencyKey: KEY,
				receipt: { status: "delivery_failed", reason: "session_ended_before_delivery" },
			},
		]);
	});

	it("终态条目保留期满被裁掉 ⇒ 什么都不写（落定那次已经写过）", () => {
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(entry({ deliveryState: "expired", settledAt: NOW })),
				snapshotOf(),
				NOW,
			),
		).toEqual([]);
	});

	it("新排进来就已过期（重发时截止已到）⇒ 记 agent_never_became_idle…", () => {
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(),
				snapshotOf(entry({ deliveryState: "expired", settledAt: NOW })),
				NOW,
			),
		).toEqual([
			{
				kind: "record_terminal_delivery_outcome",
				taskId: TASK_ID,
				injectionLedgerIdempotencyKey: KEY,
				receipt: { status: "delivery_failed", reason: "agent_never_became_idle_before_queued_delivery_deadline" },
			},
		]);
	});

	it("已落定的条目再被改写（例：dismiss 之外的无关写）⇒ 不重复写", () => {
		const settled = entry({ deliveryState: "cancelled", settledAt: NOW });
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(settled),
				snapshotOf({ ...settled, lastDeliveryFailureNote: "x" }),
				NOW,
			),
		).toEqual([]);
	});

	it("人排的条目的任何变化都不产生账本改动", () => {
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(
				snapshotOf(humanEntry()),
				snapshotOf(humanEntry({ deliveryState: "cancelled", settledAt: NOW })),
				NOW,
			),
		).toEqual([]);
		expect(
			collectInjectionLedgerUpdatesForQueueSnapshotTransition(snapshotOf(humanEntry()), snapshotOf(), NOW),
		).toEqual([]);
	});
});
