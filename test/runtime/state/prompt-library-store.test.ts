import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type WorkspacePromptLibraryMutation,
	type WorkspacePromptLibrarySnapshot,
	workspacePromptLibraryMutationSchema,
} from "../../../src/core/api-contract";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";

// 库落在 ~/.cline/kanban 之下，路径由 workspace-state 解析。测试把这两个解析点重定向到临时目录，
// 而不是去动 homedir()——后者会让本套件在别人的真实 prompt library 上跑。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
}));

const {
	applyWorkspacePromptLibraryMutation,
	getGlobalPromptLibraryPath,
	getWorkspacePromptLibraryPath,
	mutateWorkspacePromptLibrary,
	readWorkspacePromptLibrarySnapshot,
	TASK_SCOPED_PROMPT_BUCKET_KEY_FOR_MUTATIONS_MISSING_TASK_ID,
} = await import("../../../src/state/prompt-library-store");

const WORKSPACE_ID = "workspace-alpha";

function emptySnapshot(): WorkspacePromptLibrarySnapshot {
	return { globalScopedPrompts: [], repoScopedPrompts: [], taskScopedPromptsByTaskId: {} };
}

describe("prompt-library-store — 意图应用（纯函数）", () => {
	it("upsert 新 id 即新建，落进 scope 对应的桶", () => {
		const next = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "写测试", scope: "task", taskId: "task-1" },
			1_000,
		);
		expect(next.taskScopedPromptsByTaskId["task-1"]).toEqual([
			{ id: "p1", text: "写测试", scope: "task", origin: undefined, createdAt: 1_000, updatedAt: 1_000 },
		]);
	});

	// 改正文与换 scope 是两条独立意图。混在一起做，会让「一个标签页正在改文、另一个正在换 scope」
	// 互相把对方的操作撤销掉。
	it("upsert 已存在的 id 只改正文，不动它当前所在的桶，createdAt 保持不变", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "旧文", scope: "global" },
			1_000,
		);
		const next = applyWorkspacePromptLibraryMutation(
			seeded,
			{ kind: "upsert_prompt", promptId: "p1", text: "新文", scope: "task", taskId: "task-1" },
			2_000,
		);
		expect(next.taskScopedPromptsByTaskId).toEqual({});
		expect(next.globalScopedPrompts).toEqual([
			{ id: "p1", text: "新文", scope: "global", origin: undefined, createdAt: 1_000, updatedAt: 2_000 },
		]);
	});

	it("换 scope 是物理搬桶，旧桶不留残影", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "模板", scope: "task", taskId: "task-1" },
			1_000,
		);
		const next = applyWorkspacePromptLibraryMutation(
			seeded,
			{ kind: "set_prompt_scope", promptId: "p1", scope: "global" },
			2_000,
		);
		expect(next.taskScopedPromptsByTaskId).toEqual({});
		expect(next.globalScopedPrompts.map((prompt) => [prompt.id, prompt.scope, prompt.updatedAt])).toEqual([
			["p1", "global", 2_000],
		]);
	});

	// 同为 task scope 但 taskId 变了，是「把模板搬给另一个任务」——意图的 schema 明确暴露了 taskId，
	// 把它当成 no-op 会让条目留在原任务桶下，用户看到的是「搬移按钮点了没反应」。
	it("同为 task scope 但换了 taskId 时物理搬到新任务桶", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "模板", scope: "task", taskId: "task-1" },
			1_000,
		);
		const next = applyWorkspacePromptLibraryMutation(
			seeded,
			{ kind: "set_prompt_scope", promptId: "p1", scope: "task", taskId: "task-2" },
			2_000,
		);
		expect(next.taskScopedPromptsByTaskId["task-1"]).toBeUndefined();
		expect(
			next.taskScopedPromptsByTaskId["task-2"].map((prompt) => [prompt.id, prompt.scope, prompt.updatedAt]),
		).toEqual([["p1", "task", 2_000]]);
	});

	// 搬到「它已经在的那个桶」仍必须是无操作：否则 updatedAt 会被无意义地刷新，排序与冲突判定跟着抖。
	it("scope 与 taskId 都没变时仍是无操作", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "模板", scope: "task", taskId: "task-1" },
			1_000,
		);
		expect(
			applyWorkspacePromptLibraryMutation(
				seeded,
				{ kind: "set_prompt_scope", promptId: "p1", scope: "task", taskId: "task-1" },
				2_000,
			),
		).toBe(seeded);
	});

	it("删除在三个桶里都生效，且不会留下空的 taskId 键", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "模板", scope: "task", taskId: "task-1" },
			1_000,
		);
		const next = applyWorkspacePromptLibraryMutation(seeded, { kind: "remove_prompt", promptId: "p1" }, 2_000);
		expect(next.taskScopedPromptsByTaskId).toEqual({});
	});

	it("未知 id 的删除与换 scope 都是无操作，不抛", () => {
		const snapshot = emptySnapshot();
		expect(applyWorkspacePromptLibraryMutation(snapshot, { kind: "remove_prompt", promptId: "nope" }, 1)).toEqual(
			snapshot,
		);
		expect(
			applyWorkspacePromptLibraryMutation(
				snapshot,
				{ kind: "set_prompt_scope", promptId: "nope", scope: "global" },
				1,
			),
		).toEqual(snapshot);
	});

	// 契约层已经把「scope:task 却没 taskId」挡在边界外，这里测的是存储层的纵深防御：既不能丢掉用户的
	// 文字，也不能把「本该只对某个任务可见」的内容降级成整个仓库可见（那是可见性事故，不是分类不整洁）。
	it("scope 为 task 却没给 taskId 时进隔离桶：不丢内容，也不泄漏给整个仓库", () => {
		const next = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "不能丢的文字", scope: "task" },
			1_000,
		);
		expect(next.repoScopedPrompts).toEqual([]);
		expect(
			next.taskScopedPromptsByTaskId[TASK_SCOPED_PROMPT_BUCKET_KEY_FOR_MUTATIONS_MISSING_TASK_ID].map(
				(prompt) => prompt.text,
			),
		).toEqual(["不能丢的文字"]);
		// 隔离桶键不可能等于任何真实 taskId，于是没有任何任务的可见集合会把它捞出来。
		expect(Object.keys(next.taskScopedPromptsByTaskId)).toEqual([
			TASK_SCOPED_PROMPT_BUCKET_KEY_FOR_MUTATIONS_MISSING_TASK_ID,
		]);
	});

	it("origin 如实落库，供面板区分手写与终端暂存", () => {
		const next = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{
				kind: "upsert_prompt",
				promptId: "p1",
				text: "被抢占时暂存下来的输入",
				scope: "task",
				taskId: "task-1",
				origin: "terminal_stash_preempted_by_programmatic_delivery",
			},
			1_000,
		);
		expect(next.taskScopedPromptsByTaskId["task-1"][0].origin).toBe(
			"terminal_stash_preempted_by_programmatic_delivery",
		);
	});
});

// scope 为 task 却漏传 taskId，不是「分类不整洁」而是**可见性事故**：本该只给某个任务看的文字会被
// 降级成整个仓库可见。这类错误必须在契约边界就报错——存储层无从知道用户原本想给哪个任务看。
describe("prompt-library-store — 意图契约把「scope:task 缺 taskId」挡在边界外", () => {
	it("upsert_prompt 的 scope 为 task 时，taskId 缺失 / 为 null / 为空串都被拒绝", () => {
		const base = { kind: "upsert_prompt", promptId: "p1", text: "只给这个任务看的文字", scope: "task" } as const;
		expect(workspacePromptLibraryMutationSchema.safeParse(base).success).toBe(false);
		expect(workspacePromptLibraryMutationSchema.safeParse({ ...base, taskId: null }).success).toBe(false);
		expect(workspacePromptLibraryMutationSchema.safeParse({ ...base, taskId: "" }).success).toBe(false);
		expect(workspacePromptLibraryMutationSchema.safeParse({ ...base, taskId: "task-1" }).success).toBe(true);
	});

	it("set_prompt_scope 搬进 task scope 时同样必须带 taskId", () => {
		const base = { kind: "set_prompt_scope", promptId: "p1", scope: "task" } as const;
		expect(workspacePromptLibraryMutationSchema.safeParse(base).success).toBe(false);
		expect(workspacePromptLibraryMutationSchema.safeParse({ ...base, taskId: null }).success).toBe(false);
		expect(workspacePromptLibraryMutationSchema.safeParse({ ...base, taskId: "task-2" }).success).toBe(true);
	});

	it("global / repo scope 不要求 taskId", () => {
		expect(
			workspacePromptLibraryMutationSchema.safeParse({
				kind: "upsert_prompt",
				promptId: "p1",
				text: "跨项目模板",
				scope: "global",
			}).success,
		).toBe(true);
		expect(
			workspacePromptLibraryMutationSchema.safeParse({ kind: "set_prompt_scope", promptId: "p1", scope: "repo" })
				.success,
		).toBe(true);
	});
});

describe("prompt-library-store — 落盘", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-prompt-library-"));
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("库不存在时读出空库而不是抛", async () => {
		expect(await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID)).toEqual(emptySnapshot());
	});

	it("global 桶落在 kanban 根目录、repo/task 桶落在 workspace 目录", async () => {
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "g1", text: "跨项目模板", scope: "global" },
			1_000,
		);
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "t1", text: "任务模板", scope: "task", taskId: "task-1" },
			1_000,
		);
		const globalFile = JSON.parse(await readFile(getGlobalPromptLibraryPath(), "utf8"));
		const workspaceFile = JSON.parse(await readFile(getWorkspacePromptLibraryPath(WORKSPACE_ID), "utf8"));
		expect(globalFile.globalScopedPrompts.map((prompt: { id: string }) => prompt.id)).toEqual(["g1"]);
		expect(workspaceFile.taskScopedPromptsByTaskId["task-1"].map((prompt: { id: string }) => prompt.id)).toEqual([
			"t1",
		]);
		// 全局条目**不能**同时被写进 workspace 文件：那样换个项目打开就会看到两份。
		expect(workspaceFile.repoScopedPrompts).toEqual([]);
	});

	it("同一 workspace 的另一个 taskId 看得到 global 与 repo 桶，看不到别的任务的条目", async () => {
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "t1", text: "任务一的模板", scope: "task", taskId: "task-1" },
			1_000,
		);
		const snapshot = await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "r1", text: "仓库级模板", scope: "repo" },
			1_000,
		);
		expect(Object.keys(snapshot.taskScopedPromptsByTaskId)).toEqual(["task-1"]);
		expect(snapshot.repoScopedPrompts.map((prompt) => prompt.id)).toEqual(["r1"]);
	});

	// 意图式写入的核心价值：并发写合并而不是互相覆盖。整份 PUT 在这里必然丢掉其中一条。
	it("并发写各自的意图后两条都在（合并而非后写覆盖）", async () => {
		await Promise.all([
			mutateWorkspacePromptLibrary(
				WORKSPACE_ID,
				{ kind: "upsert_prompt", promptId: "p1", text: "标签页 A 加的", scope: "repo" },
				1_000,
			),
			mutateWorkspacePromptLibrary(
				WORKSPACE_ID,
				{ kind: "upsert_prompt", promptId: "p2", text: "标签页 B 加的", scope: "repo" },
				1_000,
			),
		]);
		const snapshot = await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID);
		expect(snapshot.repoScopedPrompts.map((prompt) => prompt.id).sort()).toEqual(["p1", "p2"]);
	});

	// 一条被手工编辑坏的记录不该连累其余全部模板——库整个读不出来等于用户资产凭空消失。
	it("坏条目被逐条丢弃，同文件里的好条目照常读出", async () => {
		const workspacePath = getWorkspacePromptLibraryPath(WORKSPACE_ID);
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "ok", text: "好条目", scope: "repo" },
			1_000,
		);
		const corrupted = JSON.parse(await readFile(workspacePath, "utf8"));
		corrupted.repoScopedPrompts.push({ id: "broken", text: 42 });
		await writeFile(workspacePath, JSON.stringify(corrupted), "utf8");
		const snapshot = await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID);
		expect(snapshot.repoScopedPrompts.map((prompt) => prompt.id)).toEqual(["ok"]);
	});

	it("文件内容根本不是 JSON 时退化成空库而不是让面板打不开", async () => {
		const workspacePath = getWorkspacePromptLibraryPath(WORKSPACE_ID);
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "ok", text: "好条目", scope: "repo" },
			1_000,
		);
		await writeFile(workspacePath, "{ not json at all", "utf8");
		expect(await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID)).toEqual(emptySnapshot());
	});
});

// 两把文件锁只串行化 writer，**不**提供跨文件原子性：换 scope 的落盘是两次彼此独立的原子写。进程若崩在
// 两次写之间，结果完全由写序决定——先写条目要**进入**的那份文件，坏结果是「条目在两处暂时重复」（用户看得
// 见、能自己删）；先写它要**离开**的那份文件，坏结果是「条目永久丢失」（用户无从恢复）。所以写序是刻意的，
// 这组测试就是把它钉住，免得后人按字母序或按代码书写顺序把两次写重排回去。
describe("prompt-library-store — 从浏览器 localStorage 合并迁移", () => {
	it("空库时整份采纳，并沿用载荷自带的时间戳而不是盖上「现在」", () => {
		const next = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: [
					{ id: "b1", text: "全局模板", scope: "global", createdAt: 1_000, updatedAt: 2_000 },
					{ id: "b2", text: "任务模板", scope: "task", taskId: "task-1", createdAt: 3_000, updatedAt: 4_000 },
				],
			},
			9_999_999,
		);

		expect(next.globalScopedPrompts).toEqual([
			{ id: "b1", text: "全局模板", scope: "global", createdAt: 1_000, updatedAt: 2_000 },
		]);
		expect(next.taskScopedPromptsByTaskId["task-1"]).toEqual([
			{ id: "b2", text: "任务模板", scope: "task", createdAt: 3_000, updatedAt: 4_000 },
		]);
	});

	// 去重键必须是「桶 + 正文」。各 origin 的 id 各自随机生成，按 id 去重等于一条都去不掉。
	it("同一个桶里同正文不重复新增，且时间戳收敛成最早创建 + 最晚更新", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: [{ id: "from-origin-a", text: "同一段文字", scope: "global", createdAt: 5_000, updatedAt: 6_000 }],
			},
			0,
		);

		const next = applyWorkspacePromptLibraryMutation(
			seeded,
			{
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: [{ id: "from-origin-b", text: "同一段文字", scope: "global", createdAt: 1_000, updatedAt: 9_000 }],
			},
			0,
		);

		expect(next.globalScopedPrompts).toEqual([
			{ id: "from-origin-a", text: "同一段文字", scope: "global", createdAt: 1_000, updatedAt: 9_000 },
		]);
	});

	it("同正文但不同桶各留一份——它们本就是两条不同的模板", () => {
		const next = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: [
					{ id: "g", text: "同文", scope: "global", createdAt: 1_000, updatedAt: 1_000 },
					{ id: "r", text: "同文", scope: "repo", createdAt: 1_000, updatedAt: 1_000 },
					{ id: "t1", text: "同文", scope: "task", taskId: "task-1", createdAt: 1_000, updatedAt: 1_000 },
					{ id: "t2", text: "同文", scope: "task", taskId: "task-2", createdAt: 1_000, updatedAt: 1_000 },
				],
			},
			0,
		);

		expect(next.globalScopedPrompts).toHaveLength(1);
		expect(next.repoScopedPrompts).toHaveLength(1);
		expect(next.taskScopedPromptsByTaskId["task-1"]).toHaveLength(1);
		expect(next.taskScopedPromptsByTaskId["task-2"]).toHaveLength(1);
	});

	it("幂等：同一份载荷重跑不新增条目、也不改动已收敛的时间戳", () => {
		const payload: WorkspacePromptLibraryMutation = {
			kind: "merge_prompts_migrated_from_browser_local_storage",
			prompts: [{ id: "b1", text: "模板", scope: "global", createdAt: 1_000, updatedAt: 2_000 }],
		};

		const once = applyWorkspacePromptLibraryMutation(emptySnapshot(), payload, 0);
		const twice = applyWorkspacePromptLibraryMutation(once, payload, 0);

		expect(twice.globalScopedPrompts).toEqual(once.globalScopedPrompts);
	});

	// origin 记录的是这条**最初**从哪来（手写 / 终端暂存）。被另一个 origin 的同正文条目改写会让它失真。
	it("命中既有条目时保留既有条目的 origin，不被载荷改写", () => {
		const seeded = applyWorkspacePromptLibraryMutation(
			emptySnapshot(),
			{ kind: "upsert_prompt", promptId: "p1", text: "暂存来的", scope: "global", origin: "terminal_stash_by_user" },
			1_000,
		);

		const next = applyWorkspacePromptLibraryMutation(
			seeded,
			{
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: [
					{ id: "b1", text: "暂存来的", scope: "global", origin: "manual", createdAt: 500, updatedAt: 3_000 },
				],
			},
			0,
		);

		expect(next.globalScopedPrompts).toEqual([
			{
				id: "p1",
				text: "暂存来的",
				scope: "global",
				origin: "terminal_stash_by_user",
				createdAt: 500,
				updatedAt: 3_000,
			},
		]);
	});

	it("契约层拒绝 scope 为 task 却漏传 taskId 的条目——那是可见性事故，不是分类不整洁", () => {
		const parsed = workspacePromptLibraryMutationSchema.safeParse({
			kind: "merge_prompts_migrated_from_browser_local_storage",
			prompts: [{ id: "b1", text: "任务模板", scope: "task", createdAt: 1_000, updatedAt: 1_000 }],
		});

		expect(parsed.success).toBe(false);
	});
});

describe("prompt-library-store — 换 scope 的落盘写序：目的地文件先写、来源文件后写", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-prompt-library-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	// spyOn 默认透传到真实实现，所以这里只是旁听落盘顺序，不改变任何行为。
	async function recordPromptLibraryFilePathsInWriteOrderDuring(operation: () => Promise<unknown>): Promise<string[]> {
		const atomicWriteSpy = vi.spyOn(lockedFileSystem, "writeJsonFileAtomic");
		await operation();
		const writtenPaths = atomicWriteSpy.mock.calls.map((call) => call[0]);
		atomicWriteSpy.mockRestore();
		return writtenPaths;
	}

	it("global → repo 搬移时，workspace 文件先于 global 文件落盘", async () => {
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "p1", text: "跨项目模板", scope: "global" },
			1_000,
		);
		const writtenPaths = await recordPromptLibraryFilePathsInWriteOrderDuring(async () => {
			await mutateWorkspacePromptLibrary(
				WORKSPACE_ID,
				{ kind: "set_prompt_scope", promptId: "p1", scope: "repo" },
				2_000,
			);
		});
		// 两份文件都必须被写到——只写一份说明搬移压根没落盘完整。
		expect(writtenPaths).toEqual([getWorkspacePromptLibraryPath(WORKSPACE_ID), getGlobalPromptLibraryPath()]);
	});

	it("repo → global 搬移时，global 文件先于 workspace 文件落盘", async () => {
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "p1", text: "仓库级模板", scope: "repo" },
			1_000,
		);
		const writtenPaths = await recordPromptLibraryFilePathsInWriteOrderDuring(async () => {
			await mutateWorkspacePromptLibrary(
				WORKSPACE_ID,
				{ kind: "set_prompt_scope", promptId: "p1", scope: "global" },
				2_000,
			);
		});
		expect(writtenPaths).toEqual([getGlobalPromptLibraryPath(), getWorkspacePromptLibraryPath(WORKSPACE_ID)]);
	});

	// 不跨文件的 mutation 只该碰它自己那一份：顺带重写另一份既是无谓争用，也会把无关文件拖进崩溃窗口。
	it("不跨文件的改动只写它自己那一份文件", async () => {
		const writtenPaths = await recordPromptLibraryFilePathsInWriteOrderDuring(async () => {
			await mutateWorkspacePromptLibrary(
				WORKSPACE_ID,
				{ kind: "upsert_prompt", promptId: "t1", text: "任务模板", scope: "task", taskId: "task-1" },
				1_000,
			);
		});
		expect(writtenPaths).toEqual([getWorkspacePromptLibraryPath(WORKSPACE_ID)]);
	});
});

// 读路径把「文件不存在」与「文件读坏了」一起降级成空库是对的（空库是安全默认值）；写路径复用同一份降级
// 快照就不是了——基于空快照原子覆盖那份损坏文件，会把一个还能人工修复的状态变成不可逆的用户资产丢失。
// 这里不断言旁路文件叫什么名字，只断言那份「损坏但正文仍在」的原始字节在覆盖之后仍能从库目录里找回。
describe("prompt-library-store — 读坏的库文件不得被写路径静默覆盖", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-prompt-library-"));
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	async function findFileWhoseContentIsExactly(
		directoryPath: string,
		expectedContent: string,
	): Promise<string | null> {
		for (const entryName of await readdir(directoryPath)) {
			const entryPath = join(directoryPath, entryName);
			if (!(await stat(entryPath)).isFile()) {
				continue;
			}
			if ((await readFile(entryPath, "utf8")) === expectedContent) {
				return entryName;
			}
		}
		return null;
	}

	// 现实里的损坏形态：写到一半被打断、或被别的东西在尾部追加了内容——JSON 解析失败，但用户攒的正文
	// 一个字节都没少，人工就能救回来。
	function corruptWhileKeepingEveryByteOfContent(originalFileText: string): string {
		return `${originalFileText}\n<<<<<<< 被污染的尾巴，JSON 解析必失败`;
	}

	it("workspace 库文件读坏时先把原始字节旁路留存，再写入新条目", async () => {
		const workspacePath = getWorkspacePromptLibraryPath(WORKSPACE_ID);
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "attic", text: "攒了很久的模板", scope: "repo" },
			1_000,
		);
		const corruptedBytes = corruptWhileKeepingEveryByteOfContent(await readFile(workspacePath, "utf8"));
		await writeFile(workspacePath, corruptedBytes, "utf8");

		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "fresh", text: "刚打的字", scope: "repo" },
			2_000,
		);

		expect(await findFileWhoseContentIsExactly(dirname(workspacePath), corruptedBytes)).not.toBeNull();
		// 写入本身不能被损坏文件连累而失败：暂存路径一旦写不进去，用户刚打的字就真没了。
		expect((await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID)).repoScopedPrompts.map((p) => p.id)).toEqual([
			"fresh",
		]);
	});

	it("全局库文件读坏时同样先旁路留存，再写入新条目", async () => {
		const globalPath = getGlobalPromptLibraryPath();
		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "attic", text: "跨项目模板", scope: "global" },
			1_000,
		);
		const corruptedBytes = corruptWhileKeepingEveryByteOfContent(await readFile(globalPath, "utf8"));
		await writeFile(globalPath, corruptedBytes, "utf8");

		await mutateWorkspacePromptLibrary(
			WORKSPACE_ID,
			{ kind: "upsert_prompt", promptId: "fresh", text: "刚打的字", scope: "global" },
			2_000,
		);

		expect(await findFileWhoseContentIsExactly(dirname(globalPath), corruptedBytes)).not.toBeNull();
		expect((await readWorkspacePromptLibrarySnapshot(WORKSPACE_ID)).globalScopedPrompts.map((p) => p.id)).toEqual([
			"fresh",
		]);
	});
});
