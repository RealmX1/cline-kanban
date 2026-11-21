import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LockedFileSystem } from "../../../src/fs/locked-file-system";
import { GlobalMarkdownDraftStore } from "../../../src/state/global-markdown-draft-store";

let directory: string;
let store: GlobalMarkdownDraftStore;
let filePath: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "kanban-global-markdown-drafts-"));
	filePath = join(directory, "global-markdown-drafts.json");
	store = new GlobalMarkdownDraftStore(filePath, await LockedFileSystem.forIsolatedTestDirectory(directory));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

it("持久保存多份草稿，重试创建或删除不覆盖或复活草稿", async () => {
	const firstDraft = { id: randomUUID(), title: "第一份", markdown: "# 正文" };
	const secondDraft = { id: randomUUID(), title: "第二份", markdown: "" };
	expect(await store.create(firstDraft)).toMatchObject({ ...firstDraft, version: 1 });
	await store.create(secondDraft);
	const reopened = new GlobalMarkdownDraftStore(filePath, await LockedFileSystem.forIsolatedTestDirectory(directory));
	expect(await reopened.list()).toHaveLength(2);
	expect(await reopened.create({ ...firstDraft, markdown: "旧请求" })).toMatchObject(firstDraft);
	expect(await reopened.delete({ id: firstDraft.id, expectedVersion: 2 })).toMatchObject({ status: "conflict" });
	expect(await reopened.delete({ id: firstDraft.id, expectedVersion: 1 })).toEqual({ status: "deleted" });
	expect(await reopened.delete({ id: firstDraft.id, expectedVersion: 1 })).toEqual({ status: "deleted" });
	expect(await reopened.create(firstDraft)).toBeNull();
	expect(await store.list()).toEqual([expect.objectContaining(secondDraft)]);
});

it("并发修改保留服务端正文，重复提交只创建一份恢复草稿", async () => {
	const draft = { id: randomUUID(), title: "并发草稿", markdown: "" };
	await store.create(draft);
	const first = {
		...draft,
		expectedVersion: 1,
		saveRequestId: randomUUID(),
		saveWriterId: randomUUID(),
		saveSequence: 1,
		markdown: "**首个版本**",
	};
	const second = {
		...first,
		saveRequestId: randomUUID(),
		saveWriterId: randomUUID(),
		title: "改名",
		markdown: "> 待恢复正文",
	};
	const results = await Promise.all([store.update(first), store.update(second)]);
	expect(results.map(({ status }) => status).sort()).toEqual(["recovered", "saved"]);
	const savedRequest = results[0]?.status === "saved" ? first : second;
	const conflictedRequest = savedRequest === first ? second : first;
	expect(await store.update(savedRequest)).toMatchObject({ status: "saved", draft: { version: 2 } });
	expect(await store.update(conflictedRequest)).toMatchObject({
		status: "recovered",
		currentDraft: { id: draft.id, markdown: savedRequest.markdown, version: 2 },
		draft: { title: `恢复草稿 · ${conflictedRequest.title}`, markdown: conflictedRequest.markdown, version: 1 },
	});
	expect(await store.list()).toHaveLength(2);
	const newest = {
		...savedRequest,
		expectedVersion: 2,
		saveRequestId: randomUUID(),
		saveSequence: 2,
		markdown: "更新版本",
	};
	expect(await store.update(newest)).toMatchObject({ status: "saved", draft: { version: 3 } });
	expect(await store.update(savedRequest)).toMatchObject({
		status: "saved",
		draft: { markdown: "更新版本", version: 3 },
	});
	await store.delete({ id: draft.id, expectedVersion: 3 });
	expect(await store.update(savedRequest)).toEqual({ status: "saved", draft: null });
	expect(await store.list()).toHaveLength(1);
});

it("连续自动保存只为同一编辑者保留一条水位，仍确认很早的重复请求", async () => {
	const draft = { id: randomUUID(), title: "写入回执", markdown: "" };
	await store.create(draft);
	const first = {
		...draft,
		saveWriterId: randomUUID(),
		saveRequestId: randomUUID(),
		saveSequence: 1,
		expectedVersion: 1,
	};
	await store.update(first);
	for (let saveSequence = 2; saveSequence <= 12; saveSequence++) {
		await store.update({ ...first, saveSequence, expectedVersion: saveSequence, saveRequestId: randomUUID() });
	}
	const stored = JSON.parse(await readFile(filePath, "utf8"));
	expect(stored.drafts[0].appliedSaveSequenceByWriter).toEqual({ [first.saveWriterId]: 12 });
	expect(await store.update(first)).toMatchObject({ status: "saved", draft: { version: 13 } });
	expect(await store.list()).toHaveLength(1);
});

it("读取失败时保护原始存储内容", async () => {
	await writeFile(filePath, "{无效");
	await expect(store.create({ id: randomUUID(), title: "草稿", markdown: "" })).rejects.toThrow();
	expect(await readFile(filePath, "utf8")).toBe("{无效");
});
