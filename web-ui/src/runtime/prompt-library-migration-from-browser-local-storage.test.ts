import { beforeEach, describe, expect, it } from "vitest";

import {
	buildPromptLibraryMigrationMarkersWithWorkspaceMarked,
	hasUploadedPromptLibraryToServer,
	PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY,
	readPromptLibraryMigrationPayloadFromBrowserLocalStorage,
} from "@/runtime/prompt-library-migration-from-browser-local-storage";

const PROJECT_ID = "workspace-alpha";

describe("从浏览器 localStorage 读出 Prompt Library 迁移载荷", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("三个键都空时载荷为空", () => {
		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID)).toEqual([]);
	});

	it("按桶标注：global 无 taskId、by-project 记成 repo、by-task 各带自己的 taskId", () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "g", text: "全局", scope: "global", createdAt: 1, updatedAt: 2 }]),
		);
		localStorage.setItem(
			"kanban.prompt-library.by-project.v1",
			JSON.stringify({ [PROJECT_ID]: [{ id: "r", text: "仓库", scope: "repo", createdAt: 3, updatedAt: 4 }] }),
		);
		localStorage.setItem(
			"kanban.prompt-library.by-task.v1",
			JSON.stringify({ "task-1": [{ id: "t", text: "任务", scope: "task", createdAt: 5, updatedAt: 6 }] }),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID)).toEqual([
			{ id: "g", text: "全局", scope: "global", createdAt: 1, updatedAt: 2 },
			{ id: "r", text: "仓库", scope: "repo", createdAt: 3, updatedAt: 4 },
			{ id: "t", text: "任务", scope: "task", taskId: "task-1", createdAt: 5, updatedAt: 6 },
		]);
	});

	// 服务端的 repo 桶是「每个 workspace 一份文件」，别的项目那份等它自己被打开时再搬。
	it("by-project 只搬当前项目那一份", () => {
		localStorage.setItem(
			"kanban.prompt-library.by-project.v1",
			JSON.stringify({
				[PROJECT_ID]: [{ id: "mine", text: "本项目", scope: "repo", createdAt: 1, updatedAt: 1 }],
				"other-workspace": [{ id: "theirs", text: "别的项目", scope: "repo", createdAt: 1, updatedAt: 1 }],
			}),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID).map((prompt) => prompt.id)).toEqual([
			"mine",
		]);
	});

	it("坏条目逐条丢弃，不让一条脏数据把整份迁移带崩", () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([
				{ id: "ok", text: "好的", scope: "global", createdAt: 1, updatedAt: 2 },
				{ id: "no-text", scope: "global", createdAt: 1, updatedAt: 2 },
				{ text: "no-id", scope: "global", createdAt: 1, updatedAt: 2 },
				{ id: "empty-text", text: "", scope: "global", createdAt: 1, updatedAt: 2 },
				"not-an-object",
			]),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID).map((prompt) => prompt.id)).toEqual([
			"ok",
		]);
	});

	it("整份 JSON 坏掉时当作没有历史数据，而不是抛出去把面板打不开", () => {
		localStorage.setItem("kanban.prompt-library.global.v1", "{ 这不是 JSON");

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID)).toEqual([]);
	});

	// 盖上「现在」会让所有历史模板的创建时间变成升级那一刻；补 0 则在服务端的 min(createdAt) 收敛里
	// 表现为「比服务端那份更老」，符合事实。
	it("时间戳缺失时补 0 而不是补当前时间", () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "g", text: "无时间戳", scope: "global" }]),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID)).toEqual([
			{ id: "g", text: "无时间戳", scope: "global", createdAt: 0, updatedAt: 0 },
		]);
	});

	it("createdAt 缺失但 updatedAt 在时，用 updatedAt 兜底", () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "g", text: "只有 updatedAt", scope: "global", updatedAt: 42 }]),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID)[0]).toMatchObject({
			createdAt: 42,
			updatedAt: 42,
		});
	});

	// scope 为 task 却不知道属于哪个任务的话，契约会拒绝**整条**意图——所以在这里就丢掉它。
	it("by-task 之外冒出的 task scope 条目被丢弃，不会连累整份载荷", () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([
				{ id: "stray", text: "错桶的任务条目", scope: "task", createdAt: 1, updatedAt: 1 },
				{ id: "ok", text: "正常全局条目", scope: "global", createdAt: 1, updatedAt: 1 },
			]),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID).map((prompt) => prompt.id)).toEqual([
			"ok",
		]);
	});

	it("条目缺 scope 时按它所在的桶补齐", () => {
		localStorage.setItem(
			"kanban.prompt-library.by-task.v1",
			JSON.stringify({ "task-1": [{ id: "t", text: "无 scope", createdAt: 1, updatedAt: 1 }] }),
		);

		expect(readPromptLibraryMigrationPayloadFromBrowserLocalStorage(PROJECT_ID)[0]).toMatchObject({
			scope: "task",
			taskId: "task-1",
		});
	});
});

describe("已迁移标记", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("未打标记时为假", () => {
		expect(hasUploadedPromptLibraryToServer(PROJECT_ID)).toBe(false);
	});

	it("打过标记后为真，且逐 workspace 独立", () => {
		localStorage.setItem(
			PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY,
			JSON.stringify(buildPromptLibraryMigrationMarkersWithWorkspaceMarked(PROJECT_ID, 123)),
		);

		expect(hasUploadedPromptLibraryToServer(PROJECT_ID)).toBe(true);
		expect(hasUploadedPromptLibraryToServer("another-workspace")).toBe(false);
	});

	it("追加新 workspace 时保留已有的标记", () => {
		localStorage.setItem(PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY, JSON.stringify({ "workspace-old": 1 }));

		expect(buildPromptLibraryMigrationMarkersWithWorkspaceMarked(PROJECT_ID, 2)).toEqual({
			"workspace-old": 1,
			[PROJECT_ID]: 2,
		});
	});

	it("标记文件坏掉时当作没迁移过——重跑迁移是幂等的，代价只是多发一次请求", () => {
		localStorage.setItem(PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY, "{ 坏掉的 JSON");

		expect(hasUploadedPromptLibraryToServer(PROJECT_ID)).toBe(false);
	});
});
