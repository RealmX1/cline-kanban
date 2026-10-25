import { beforeEach, describe, expect, it, vi } from "vitest";

import { createQueuedTaskPromptDeliveryFullTextReader } from "@/runtime/queued-task-prompt-delivery-query";

const queueReadMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { getTaskPromptDeliveryQueue: { query: queueReadMocks.query } } }),
}));

function queueResponse(entriesByTaskId: Record<string, { queueEntryId: string; text: string }[]>) {
	return { ok: true, queue: { entriesByTaskId } };
}

function createDeferredQueueResponse() {
	let resolveResponse!: (response: ReturnType<typeof queueResponse>) => void;
	const responsePromise = new Promise<ReturnType<typeof queueResponse>>((resolve) => {
		resolveResponse = resolve;
	});
	return { responsePromise, resolveResponse };
}

describe("队列全文读取与缓存", () => {
	beforeEach(() => {
		queueReadMocks.query.mockReset();
	});

	it("并发准备多条正文共用一次请求，已有正文不会随推送重读", async () => {
		queueReadMocks.query.mockResolvedValue(
			queueResponse({
				session: [
					{ queueEntryId: "first", text: "  第一条\n " },
					{ queueEntryId: "second", text: "第二条完整正文" },
				],
			}),
		);
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		expect(await Promise.all([readFullText("first"), readFullText("second")])).toEqual([
			"  第一条\n ",
			"第二条完整正文",
		]);
		expect(await readFullText("first")).toBe("  第一条\n ");
		expect(queueReadMocks.query).toHaveBeenCalledTimes(1);
	});

	it("后加入的条目未被旧在途快照覆盖时自动补读", async () => {
		const firstSnapshot = createDeferredQueueResponse();
		queueReadMocks.query
			.mockReturnValueOnce(firstSnapshot.responsePromise)
			.mockResolvedValueOnce(queueResponse({ session: [{ queueEntryId: "second", text: "新条目全文" }] }));
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		const firstText = readFullText("first");
		const secondText = readFullText("second");
		expect(queueReadMocks.query).toHaveBeenCalledTimes(1);
		firstSnapshot.resolveResponse(queueResponse({ session: [{ queueEntryId: "first", text: "旧快照正文" }] }));
		expect(await firstText).toBe("旧快照正文");
		expect(await secondText).toBe("新条目全文");
		expect(await readFullText("second")).toBe("新条目全文");
		expect(queueReadMocks.query).toHaveBeenCalledTimes(2);
	});

	it("多个后加入的条目共享同一次补读", async () => {
		const firstSnapshot = createDeferredQueueResponse();
		const followUpSnapshot = createDeferredQueueResponse();
		queueReadMocks.query
			.mockReturnValueOnce(firstSnapshot.responsePromise)
			.mockReturnValueOnce(followUpSnapshot.responsePromise);
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		const firstText = readFullText("first");
		const secondText = readFullText("second");
		const thirdText = readFullText("third");
		firstSnapshot.resolveResponse(queueResponse({ session: [{ queueEntryId: "first", text: "第一条" }] }));
		expect(await firstText).toBe("第一条");
		expect(queueReadMocks.query).toHaveBeenCalledTimes(2);
		followUpSnapshot.resolveResponse(
			queueResponse({
				session: [
					{ queueEntryId: "second", text: "第二条" },
					{ queueEntryId: "third", text: "第三条" },
				],
			}),
		);
		expect(await Promise.all([secondText, thirdText])).toEqual(["第二条", "第三条"]);
		expect(queueReadMocks.query).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ outcome: "仍缺少条目", followUp: () => Promise.resolve(queueResponse({ session: [] })) },
		{ outcome: "返回失败", followUp: () => Promise.resolve({ ok: false, queue: null }) },
		{ outcome: "没有队列", followUp: () => Promise.resolve({ ok: true, queue: null }) },
		{ outcome: "断网", followUp: () => Promise.reject(new Error("暂时离线")) },
	])("补读$outcome 时返回未知且不会继续轮询", async ({ followUp }) => {
		const firstSnapshot = createDeferredQueueResponse();
		queueReadMocks.query.mockReturnValueOnce(firstSnapshot.responsePromise).mockImplementation(followUp);
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		const firstText = readFullText("first");
		const missingText = readFullText("missing");
		firstSnapshot.resolveResponse(queueResponse({ session: [{ queueEntryId: "first", text: "第一条" }] }));
		expect(await firstText).toBe("第一条");
		expect(await missingText).toBeNull();
		expect(queueReadMocks.query).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ outcome: "返回失败", response: () => Promise.resolve({ ok: false, queue: null }) },
		{ outcome: "没有队列", response: () => Promise.resolve({ ok: true, queue: null }) },
		{ outcome: "断网", response: () => Promise.reject(new Error("暂时离线")) },
	])("共享的首次快照$outcome 时不自动补读", async ({ response }) => {
		queueReadMocks.query.mockImplementation(response);
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		expect(await Promise.all([readFullText("first"), readFullText("second")])).toEqual([null, null]);
		expect(queueReadMocks.query).toHaveBeenCalledTimes(1);
	});

	it("发起快照的条目确实缺失时不自动补读", async () => {
		queueReadMocks.query.mockResolvedValue(queueResponse({ session: [] }));
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		expect(await readFullText("missing")).toBeNull();
		expect(queueReadMocks.query).toHaveBeenCalledTimes(1);
	});

	it("新条目触发补读，失败不缓存，后续点击可以重试", async () => {
		queueReadMocks.query
			.mockResolvedValueOnce(queueResponse({ session: [{ queueEntryId: "first", text: "第一条" }] }))
			.mockRejectedValueOnce(new Error("暂时离线"))
			.mockResolvedValueOnce(queueResponse({ session: [{ queueEntryId: "second", text: "新条目" }] }));
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		expect(await readFullText("first")).toBe("第一条");
		expect(await readFullText("second")).toBeNull();
		expect(await readFullText("second")).toBe("新条目");
		expect(await readFullText("first")).toBe("第一条");
		expect(queueReadMocks.query).toHaveBeenCalledTimes(3);
	});

	it("缓存按 workspace 和会话隔离，即使条目 ID 相同也不能串用", async () => {
		queueReadMocks.query
			.mockResolvedValueOnce(queueResponse({ session: [{ queueEntryId: "same", text: "原项目正文" }] }))
			.mockResolvedValueOnce(queueResponse({ session: [{ queueEntryId: "same", text: "另一项目正文" }] }))
			.mockResolvedValueOnce(queueResponse({ anotherSession: [{ queueEntryId: "same", text: "子会话正文" }] }));
		expect(await createQueuedTaskPromptDeliveryFullTextReader("firstWorkspace", "session")("same")).toBe(
			"原项目正文",
		);
		expect(await createQueuedTaskPromptDeliveryFullTextReader("secondWorkspace", "session")("same")).toBe(
			"另一项目正文",
		);
		expect(await createQueuedTaskPromptDeliveryFullTextReader("firstWorkspace", "anotherSession")("same")).toBe(
			"子会话正文",
		);
	});

	it("缺失条目和失败响应保留未知，不借用其他会话同 ID 的正文", async () => {
		queueReadMocks.query
			.mockResolvedValueOnce(queueResponse({ unrelated: [{ queueEntryId: "same", text: "不属于本会话" }] }))
			.mockResolvedValueOnce({ ok: false, queue: null });
		const readFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "session");
		expect(await readFullText("same")).toBeNull();
		expect(await readFullText("same")).toBeNull();
	});
});
