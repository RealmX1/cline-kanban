// 推流投影：前端能看到的全部队列信息。钉住三件事——正文绝不上广播链路（只有截断预览 + 真实长度）、
// 阻塞原因只给还在等发的条目、「来源条目改过没有」在不知道时说不知道而不是说错。
import { describe, expect, it } from "vitest";

import type { QueuedTaskPromptDeliveryEntry } from "../../../src/core/api-contract";
import { QUEUED_TASK_PROMPT_DELIVERY_TEXT_PREVIEW_MAX_LENGTH } from "../../../src/core/api-contract";
import { QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS } from "../../../src/core/queued-task-prompt-delivery-dispatch-eligibility";
import {
	buildRuntimeQueuedTaskPromptDeliveryProjection,
	buildRuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	isQueuedTaskPromptDeliveryAwaitingHumanReconfirmationAfterRuntimeRestart,
} from "../../../src/core/queued-task-prompt-delivery-projection";

const NOW = 1_700_000_000_000;

function makeEntry(overrides: Partial<QueuedTaskPromptDeliveryEntry> = {}): QueuedTaskPromptDeliveryEntry {
	return {
		queueEntryId: "q1",
		taskId: "task-1",
		text: "跑一下测试",
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
		enqueuedAt: NOW - 1_000,
		expiresAt: NOW + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		...overrides,
	};
}

const baseInput = {
	resolveDispatchBlockReasonForQueuedEntry: () => "agent_still_generating" as const,
	currentPromptLibraryEntryTextSha256ByEntryId: null,
	nowEpochMs: NOW,
};

describe("统一主动投递投影", () => {
	it("即时注入保留类型、来源、策略与真实回执，不冒充等待队列", () => {
		const managedDelivery = {
			messageType: "programmatic_injection" as const,
			deliveryStrategy: "immediate" as const,
			sourceLabel: "rvf_test_source",
			imageAttachmentCount: 0,
			terminalDeliveryReceipt: { status: "delivered_queued_behind_active_agent_turn" as const, reason: null },
		};
		const projection = buildRuntimeQueuedTaskPromptDeliveryProjection(
			makeEntry({ managedDelivery, deliveryState: "settled_delivered" }),
			baseInput,
		);
		expect(projection).toMatchObject({ deliveryId: "q1", managedDelivery, dispatchBlockReason: null });
	});

	it("旧库条目无需迁移即可获得完整分类", () => {
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(
				makeEntry({ sourcePromptLibraryEntryId: "library-1" }),
				baseInput,
			),
		).toMatchObject({
			managedDelivery: { messageType: "prompt_library", deliveryStrategy: "after_agent_turn" },
		});
	});
});

describe("queued-task-prompt-delivery-projection — 正文不上广播链路", () => {
	it("透传最近一次开始投递的真实时间，未尝试时保持 null", () => {
		expect(buildRuntimeQueuedTaskPromptDeliveryProjection(makeEntry(), baseInput)).toHaveProperty(
			"lastAttemptedAt",
			null,
		);
		const lastAttemptedAt = NOW - 500;
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(
				makeEntry({ deliveryAttemptCount: 2, lastAttemptedAt }),
				baseInput,
			),
		).toHaveProperty("lastAttemptedAt", lastAttemptedAt);
	});

	it("长正文只给截断预览 + 真实长度，投影里没有 text 字段", () => {
		const longText = "字".repeat(QUEUED_TASK_PROMPT_DELIVERY_TEXT_PREVIEW_MAX_LENGTH + 500);
		const projected = buildRuntimeQueuedTaskPromptDeliveryProjection(makeEntry({ text: longText }), baseInput);
		expect(projected.textLength).toBe(longText.length);
		expect(projected.textPreview.length).toBeLessThan(longText.length);
		expect(projected).not.toHaveProperty("text");
	});
});

describe("queued-task-prompt-delivery-projection — 阻塞原因", () => {
	it("只给仍在等发的条目", () => {
		expect(buildRuntimeQueuedTaskPromptDeliveryProjection(makeEntry(), baseInput).dispatchBlockReason).toBe(
			"agent_still_generating",
		);
		for (const deliveryState of [
			"handed_to_transport",
			"settled_delivered",
			"settled_failed",
			"cancelled",
		] as const) {
			expect(
				buildRuntimeQueuedTaskPromptDeliveryProjection(makeEntry({ deliveryState }), baseInput).dispatchBlockReason,
			).toBeNull();
		}
	});

	// 与出队判据同一口径：UI 不能显示一条「排队中」、而运行时其实已经不会再发它的条目。
	it("过了保质期还没被收敛的 queued 条目显示成 expired，且不给阻塞原因", () => {
		const projected = buildRuntimeQueuedTaskPromptDeliveryProjection(makeEntry({ expiresAt: NOW - 1 }), baseInput);
		expect(projected.deliveryState).toBe("expired");
		expect(projected.dispatchBlockReason).toBeNull();
		expect(projected.settledAt).toBe(NOW - 1);
	});
});

describe("queued-task-prompt-delivery-projection — 重启后待确认", () => {
	it("盖了章、人还没确认的非终态条目 ⇒ 需要提醒", () => {
		expect(
			isQueuedTaskPromptDeliveryAwaitingHumanReconfirmationAfterRuntimeRestart(
				makeEntry({ survivedRuntimeRestartAtEpochMs: NOW - 10 }),
			),
		).toBe(true);
	});

	it("已确认的不再提醒", () => {
		expect(
			isQueuedTaskPromptDeliveryAwaitingHumanReconfirmationAfterRuntimeRestart(
				makeEntry({ survivedRuntimeRestartAtEpochMs: NOW - 10, humanReconfirmedAfterRuntimeRestartAtEpochMs: NOW }),
			),
		).toBe(false);
	});

	// 已经落定的条目没有什么可确认的，让它们也闪一下只会把注意力引到一条早就不会再发的记录上。
	it("终态条目即便盖过章也不提醒", () => {
		expect(
			isQueuedTaskPromptDeliveryAwaitingHumanReconfirmationAfterRuntimeRestart(
				makeEntry({ survivedRuntimeRestartAtEpochMs: NOW - 10, deliveryState: "settled_failed" }),
			),
		).toBe(false);
	});
});

describe("queued-task-prompt-delivery-projection — 来源条目改过没有", () => {
	const sourced = makeEntry({
		sourcePromptLibraryEntryId: "prompt-7",
		sourcePromptLibraryEntryTextSha256: "sha-at-enqueue",
	});

	it("库里那条正文的 sha 变了 ⇒ true；没变 ⇒ false", () => {
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(sourced, {
				...baseInput,
				currentPromptLibraryEntryTextSha256ByEntryId: new Map([["prompt-7", "sha-now"]]),
			}).sourcePromptLibraryEntryTextChangedSinceEnqueue,
		).toBe(true);
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(sourced, {
				...baseInput,
				currentPromptLibraryEntryTextSha256ByEntryId: new Map([["prompt-7", "sha-at-enqueue"]]),
			}).sourcePromptLibraryEntryTextChangedSinceEnqueue,
		).toBe(false);
	});

	// 说不知道，比说错强：库读不到 / 那条已被删 / 没有来源，都不下结论。
	it("库读不到、来源条目已删、没有来源 ⇒ null", () => {
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(sourced, baseInput)
				.sourcePromptLibraryEntryTextChangedSinceEnqueue,
		).toBeNull();
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(sourced, {
				...baseInput,
				currentPromptLibraryEntryTextSha256ByEntryId: new Map(),
			}).sourcePromptLibraryEntryTextChangedSinceEnqueue,
		).toBeNull();
		expect(
			buildRuntimeQueuedTaskPromptDeliveryProjection(makeEntry(), {
				...baseInput,
				currentPromptLibraryEntryTextSha256ByEntryId: new Map([["prompt-7", "sha"]]),
			}).sourcePromptLibraryEntryTextChangedSinceEnqueue,
		).toBeNull();
	});
});

describe("queued-task-prompt-delivery-projection — 按 task 分组", () => {
	it("保持队列顺序，空 task 不出现在结果里", () => {
		const projected = buildRuntimeQueuedTaskPromptDeliveryProjectionsByTaskId({
			...baseInput,
			snapshot: {
				entriesByTaskId: {
					"task-1": [makeEntry({ queueEntryId: "a" }), makeEntry({ queueEntryId: "b" })],
					"task-2": [],
				},
			},
		});
		expect(Object.keys(projected)).toEqual(["task-1"]);
		expect(projected["task-1"].map((entry) => entry.queueEntryId)).toEqual(["a", "b"]);
	});
});
