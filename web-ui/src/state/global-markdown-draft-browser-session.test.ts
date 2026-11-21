import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GlobalMarkdownDraft, GlobalMarkdownDraftUpdateInput } from "@/runtime/global-markdown-draft-query";
import { GlobalMarkdownDraftBrowserSession } from "@/state/global-markdown-draft-browser-session";

const { updateDraft, listDrafts } = vi.hoisted(() => ({ updateDraft: vi.fn(), listDrafts: vi.fn() }));
vi.mock("@/runtime/global-markdown-draft-query", () => ({
	globalMarkdownDraftApi: { list: { query: listDrafts }, update: { mutate: updateDraft } },
}));

const recoveryPrefix = "kanban.global-markdown-draft.recovery.";
const makeDraft = (markdown: string, id = crypto.randomUUID()): GlobalMarkdownDraft => ({
	id,
	title: "测试草稿",
	markdown,
	version: 1,
	updatedAt: 1,
});
const savedDraft = (input: GlobalMarkdownDraftUpdateInput) => ({
	status: "saved",
	draft: {
		id: input.id,
		title: input.title,
		markdown: input.markdown,
		version: input.expectedVersion + 1,
		updatedAt: 2,
	},
});
const unavailableDraftWrite = () => new TRPCClientError("草稿写入连接中断");

beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
	listDrafts.mockResolvedValue([]);
	updateDraft.mockImplementation(async (draft: GlobalMarkdownDraftUpdateInput) => savedDraft(draft));
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	updateDraft.mockReset();
	listDrafts.mockReset();
});

it("另一份草稿写入成功后，仍报告未持久保存的恢复副本", async () => {
	const storageSetItem = localStorage.setItem;
	const largeDraft = makeDraft("旧长草稿");
	const shortDraft = makeDraft("旧短草稿");
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
		if (value.includes(largeDraft.id)) throw new DOMException("容量不足", "QuotaExceededError");
		storageSetItem.call(this, key, value);
	});
	updateDraft.mockRejectedValue(unavailableDraftWrite());
	const session = new GlobalMarkdownDraftBrowserSession();
	session.edit(largeDraft, { markdown: "只在内存的新长草稿" });
	session.edit(shortDraft, { markdown: "已持久保存的新短草稿" });
	await vi.advanceTimersByTimeAsync(450);
	expect(session.getSnapshot()).toMatchObject({ recoveryStorageFailed: true, saveFailed: true });
	expect(Object.keys(localStorage).filter((key) => key.startsWith(recoveryPrefix))).toHaveLength(1);
});

it("重开时续存同一旧副本衍生的两个分支，每次重放沿用原请求身份", async () => {
	const draft = makeDraft("旧正文");
	const parentRevisionId = crypto.randomUUID();
	const firstBranchRequest = crypto.randomUUID();
	const secondBranchRequest = crypto.randomUUID();
	const persist = (markdown: string, desiredSaveRequestId: string, supersedesStorageRevisionId?: string) => {
		const storageRevisionId = supersedesStorageRevisionId ? crypto.randomUUID() : parentRevisionId;
		localStorage.setItem(
			recoveryPrefix + storageRevisionId,
			JSON.stringify({
				storageRevisionId,
				supersedesStorageRevisionId,
				desiredSaveRequestId,
				draft: { ...draft, markdown },
			}),
		);
	};
	persist("已被替换的父版本", parentRevisionId);
	persist("标签页甲", firstBranchRequest, parentRevisionId);
	persist("标签页乙", secondBranchRequest, parentRevisionId);
	const firstTab = new GlobalMarkdownDraftBrowserSession();
	const secondTab = new GlobalMarkdownDraftBrowserSession();
	firstTab.start();
	secondTab.start();
	await vi.advanceTimersByTimeAsync(10);
	expect(updateDraft.mock.calls.map(([input]) => [input.markdown, input.saveRequestId]).sort()).toEqual([
		["标签页乙", secondBranchRequest],
		["标签页乙", secondBranchRequest],
		["标签页甲", firstBranchRequest],
		["标签页甲", firstBranchRequest],
	]);
	expect(Object.keys(localStorage).filter((key) => key.startsWith(recoveryPrefix))).toHaveLength(0);
});

it("写入接口长时间失效后恢复，保持同一请求自动续存", async () => {
	updateDraft.mockRejectedValue(unavailableDraftWrite());
	const session = new GlobalMarkdownDraftBrowserSession();
	const draft = makeDraft("原稿");
	session.edit(draft, { markdown: "等待自动恢复" });
	await vi.advanceTimersByTimeAsync(75_000);
	expect(session.getSnapshot()).toMatchObject({ saveFailed: true, recoveryStorageFailed: false });
	const expectedSaveRequest = updateDraft.mock.calls[0]?.[0];
	updateDraft.mockImplementation(async (input: GlobalMarkdownDraftUpdateInput) => savedDraft(input));
	await vi.advanceTimersByTimeAsync(30_000);
	expect(updateDraft.mock.lastCall?.[0]).toEqual(expectedSaveRequest);
	expect(session.getSnapshot().pendingDraftIds.size).toBe(0);
});

import { KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";

it("重连时舍弃其他标签页已替换的副本，包括中间版本已移除的情况", async () => {
	const draft = makeDraft("原稿");
	const editorTab = new GlobalMarkdownDraftBrowserSession();
	editorTab.edit(draft, { markdown: "第一次编辑" });
	const recoveredTab = new GlobalMarkdownDraftBrowserSession();
	recoveredTab.start();
	editorTab.edit(draft, { markdown: "第二次编辑" });
	editorTab.edit(draft, { markdown: "最终稿" });
	recoveredTab.retry();
	await vi.advanceTimersByTimeAsync(500);
	expect(updateDraft.mock.calls.length).toBeGreaterThan(0);
	expect(updateDraft.mock.calls.map(([input]) => input.markdown)).toEqual(updateDraft.mock.calls.map(() => "最终稿"));
	expect(new Set(updateDraft.mock.calls.map(([input]) => input.saveRequestId)).size).toBe(1);
});

it("签发新 nonce 暂时失败后自动重试旧请求", async () => {
	const unknownNonce = Object.assign(
		new TRPCClientError(KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE),
		{ shape: {}, data: { code: "PRECONDITION_FAILED", httpStatus: 412 } },
	);
	updateDraft.mockRejectedValueOnce(unknownNonce);
	const session = new GlobalMarkdownDraftBrowserSession();
	session.edit(makeDraft("原稿"), { markdown: "等待新 nonce" });
	await vi.advanceTimersByTimeAsync(450);
	expect(session.getSnapshot().saveFailed).toBe(true);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(updateDraft.mock.calls[0]?.[0]).toEqual(updateDraft.mock.calls[1]?.[0]);
	expect(session.getSnapshot().pendingDraftIds.size).toBe(0);
});
