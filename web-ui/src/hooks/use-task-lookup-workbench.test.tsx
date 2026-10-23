import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TaskLookupWorkbenchController, useTaskLookupWorkbench } from "@/hooks/use-task-lookup-workbench";
import type { TaskLookupConversation } from "@/runtime/task-lookup-conversation-query";
import { LocalStorageKey, writeLocalStorageItem } from "@/storage/local-storage-store";
import { observeTaskLookupConversationUpdated } from "@/stores/task-lookup-conversation-update-store";

const queries = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	submit: vi.fn(),
	cancel: vi.fn(),
	preview: vi.fn(),
	getSettings: vi.fn(),
	saveSettings: vi.fn(),
}));
vi.mock("@/runtime/task-lookup-conversation-query", () => ({ taskLookupConversationQueries: queries }));
const conversationId = "9fe0ae6d-1c0f-4fde-8aca-3bf417ab7b80";
const conversation = (revision = 1): TaskLookupConversation => ({
	schemaVersion: 1,
	conversationId,
	contextWorkspaceId: "project",
	title: "测试会话",
	scope: { projectIds: [], columnIds: [] },
	createdAt: 1,
	updatedAt: revision,
	revision,
	turns: [],
});
let root: Root;
let container: HTMLDivElement;
let controller: TaskLookupWorkbenchController | null = null;
let eventRevision = 100;
function Harness() {
	controller = useTaskLookupWorkbench({
		workspaceId: "project",
		includeAllProjectsByDefault: true,
		streamSnapshotGeneration: 1,
	});
	return null;
}
function current() {
	if (!controller) throw new Error("缺少 Hook");
	return controller;
}
async function mount() {
	await act(async () => root.render(<Harness />));
	await act(async () => current().open());
}
beforeEach(() => {
	vi.resetAllMocks();
	writeLocalStorageItem(LocalStorageKey.TaskLookupConversationSelection, conversationId);
	queries.list.mockResolvedValue([conversation()]);
	queries.get.mockResolvedValue(conversation());
	queries.getSettings.mockResolvedValue({ agentId: "codex", modelId: null });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	localStorage.removeItem(LocalStorageKey.TaskLookupConversationSelection);
	controller = null;
});

describe("查卡进度订阅与迟到响应", () => {
	it("历史读取失败不会被当前会话的成功读取清除", async () => {
		queries.list.mockRejectedValue(new Error("历史文件损坏"));
		await mount();
		expect(current().conversation?.conversationId).toBe(conversationId);
		expect(current().errorMessage).toBe("历史文件损坏");
	});
	it("仅相关会话更新触发读取，进度事件不重读整份历史", async () => {
		await mount();
		const lists = queries.list.mock.calls.length,
			reads = queries.get.mock.calls.length;
		await act(async () => observeTaskLookupConversationUpdated("another-conversation", ++eventRevision));
		expect(queries.get).toHaveBeenCalledTimes(reads);
		queries.get.mockResolvedValue(conversation(5));
		await act(async () => observeTaskLookupConversationUpdated(conversationId, ++eventRevision));
		expect(current().conversation?.revision).toBe(5);
		expect(queries.list).toHaveBeenCalledTimes(lists);
	});
	it("较旧的提交响应不会覆盖推流已读到的新进度", async () => {
		await mount();
		let resolveSubmit: (value: TaskLookupConversation) => void = () => {};
		queries.submit.mockReturnValue(
			new Promise<TaskLookupConversation>((resolve) => {
				resolveSubmit = resolve;
			}),
		);
		await act(async () => current().setDraftQuestion("等待中的查询"));
		let submission: Promise<void> | undefined;
		await act(async () => {
			submission = current().submitQuestion();
		});
		queries.get.mockResolvedValue(conversation(8));
		await act(async () => observeTaskLookupConversationUpdated(conversationId, ++eventRevision));
		await act(async () => {
			resolveSubmit(conversation(2));
			await submission;
		});
		expect(current().conversation?.revision).toBe(8);
	});
	it("切出返回后重新读取持久进度，不取消执行", async () => {
		await mount();
		await act(async () => current().close());
		queries.get.mockResolvedValue(conversation(9));
		await act(async () => current().open());
		expect(current().conversation?.revision).toBe(9);
		expect(queries.cancel).not.toHaveBeenCalled();
	});
	it("提交错误不会被随后成功的后台读取闪过清除", async () => {
		await mount();
		queries.submit.mockRejectedValue(new Error("无法提交查询"));
		await act(async () => current().setDraftQuestion("失败查询"));
		await act(async () => current().submitQuestion());
		expect(current().errorMessage).toBe("无法提交查询");
	});
});
