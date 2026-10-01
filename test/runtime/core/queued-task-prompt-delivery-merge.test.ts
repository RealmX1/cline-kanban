import { describe, expect, it } from "vitest";

import type { QueuedTaskPromptDeliveryEntry } from "../../../src/core/api-contract";
import {
	buildMergedQueuedTaskPromptDeliveryText,
	buildQueuedTaskPromptDeliveryTextPreview,
	collectQueuedTaskPromptDeliveryChainFromHead,
} from "../../../src/core/queued-task-prompt-delivery-merge";

function entry(
	queueEntryId: string,
	text: string,
	deliverTogetherWithNextQueuedEntry = false,
): QueuedTaskPromptDeliveryEntry {
	return {
		queueEntryId,
		taskId: "task-1",
		text,
		deliverTogetherWithNextQueuedEntry,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextSha256: null,
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		lastAttemptedAt: null,
		settledAt: null,
		dispatchIdempotencyKey: null,
		claimedForSessionIncarnationId: null,
		claimedAtTurnSequence: null,
		enqueuedAt: 1_000,
		expiresAt: 99_000_000,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
	};
}

describe("queued-task-prompt-delivery-merge — 链收集", () => {
	// 用户选定的默认形态就是「一轮一条」。这条钉住「没人打开合并开关时串长恒为 1」。
	it("默认开关全关时只收 head 一条", () => {
		const chain = collectQueuedTaskPromptDeliveryChainFromHead([entry("a", "A"), entry("b", "B"), entry("c", "C")]);
		expect(chain.map((item) => item.queueEntryId)).toEqual(["a"]);
	});

	it("相邻开关点亮时链式串起来，顺序即数组顺序", () => {
		const chain = collectQueuedTaskPromptDeliveryChainFromHead([
			entry("a", "A", true),
			entry("b", "B", true),
			entry("c", "C"),
			entry("d", "D"),
		]);
		expect(chain.map((item) => item.queueEntryId)).toEqual(["a", "b", "c"]);
	});

	// 链条只在相邻位上成立：中间断一格，后面的即使点亮也不参与本次投递。
	it("链在第一个未点亮处断开，不跨越断点继续收", () => {
		const chain = collectQueuedTaskPromptDeliveryChainFromHead([
			entry("a", "A", true),
			entry("b", "B"),
			entry("c", "C", true),
			entry("d", "D"),
		]);
		expect(chain.map((item) => item.queueEntryId)).toEqual(["a", "b"]);
	});

	// 队尾那条点亮只能意味着「等下一条排进来时一起发」，而那条此刻不存在。不得越界。
	it("队尾条目的开关被忽略，不越界", () => {
		const chain = collectQueuedTaskPromptDeliveryChainFromHead([entry("a", "A", true), entry("b", "B", true)]);
		expect(chain.map((item) => item.queueEntryId)).toEqual(["a", "b"]);
	});

	it("空队列返回空链", () => {
		expect(collectQueuedTaskPromptDeliveryChainFromHead([])).toEqual([]);
	});
});

describe("queued-task-prompt-delivery-merge — 正文拼接", () => {
	it("单条即原文（去首尾空白）", () => {
		expect(buildMergedQueuedTaskPromptDeliveryText([entry("a", "  跑一下测试\n\n")])).toBe("跑一下测试");
	});

	// 刻意不加任何机器生成的分隔标记：agent 读到的每个字节都会被当成用户说的话。
	it("多条以空行连接，且不插入任何分隔标记或抬头", () => {
		const merged = buildMergedQueuedTaskPromptDeliveryText([entry("a", "跑测试"), entry("b", "然后提交")]);
		expect(merged).toBe("跑测试\n\n然后提交");
		expect(merged).not.toContain("---");
		expect(merged).not.toMatch(/queued|item|第\s*\d+\s*条/i);
	});

	it("各段先去首尾空白，用户多敲的回车不会拼出三四个空行", () => {
		expect(buildMergedQueuedTaskPromptDeliveryText([entry("a", "跑测试\n\n\n"), entry("b", "\n\n然后提交")])).toBe(
			"跑测试\n\n然后提交",
		);
	});

	it("整段是空白的条目被跳过，不产生空段", () => {
		expect(
			buildMergedQueuedTaskPromptDeliveryText([entry("a", "跑测试"), entry("b", "   \n  "), entry("c", "然后提交")]),
		).toBe("跑测试\n\n然后提交");
	});
});

describe("queued-task-prompt-delivery-merge — 预览截断", () => {
	it("不超长时原样返回（去首尾空白）", () => {
		expect(buildQueuedTaskPromptDeliveryTextPreview("  短文本 ")).toBe("短文本");
	});

	// 「刚好 200 字」与「后面还有 8000 字」必须一眼可分，否则用户以为自己排的就这么短。
	it("超长时截断到上限并补省略号", () => {
		const preview = buildQueuedTaskPromptDeliveryTextPreview("x".repeat(500));
		expect(preview).toHaveLength(201);
		expect(preview.endsWith("…")).toBe(true);
	});

	it("恰好等于上限时不补省略号", () => {
		const preview = buildQueuedTaskPromptDeliveryTextPreview("x".repeat(200));
		expect(preview).toBe("x".repeat(200));
	});
});
