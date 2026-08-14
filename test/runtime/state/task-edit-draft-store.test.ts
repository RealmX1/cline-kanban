import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeTaskEditDraft,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "../../../src/core/api-contract";

// 草稿落在 ~/.cline/kanban/workspaces/<id> 之下，路径由 workspace-state 解析。测试把该解析点重定向到
// 临时目录，而不是去动 homedir()——后者会让本套件在用户真实的草稿上跑。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
}));

const {
	applyWorkspaceTaskEditDraftMutation,
	EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT,
	getWorkspaceTaskEditDraftsPath,
	mutateWorkspaceTaskEditDrafts,
	readWorkspaceTaskEditDraftsSnapshot,
} = await import("../../../src/state/task-edit-draft-store");

const WORKSPACE_ID = "workspace-alpha";

function createDraft(
	overrides: Partial<RuntimeTaskEditDraft> & Pick<RuntimeTaskEditDraft, "taskId">,
): RuntimeTaskEditDraft {
	return {
		prompt: "",
		images: [],
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		branchRef: "main",
		savedAt: 0,
		...overrides,
	};
}

function emptySnapshot(): WorkspaceTaskEditDraftsSnapshot {
	return { draftsByTaskId: {}, supersededDraftCopies: [] };
}

describe("task-edit-draft-store — 意图应用（纯函数）", () => {
	it("保存草稿按 taskId 落位", () => {
		const draft = createDraft({ taskId: "task-1", prompt: "打了一半" });
		const next = applyWorkspaceTaskEditDraftMutation(emptySnapshot(), { kind: "save_task_edit_draft", draft }, 1_000);

		expect(next.draftsByTaskId).toEqual({ "task-1": draft });
	});

	// 用户保存/放弃了这次编辑，不代表他放弃了另一个 origin 里那份还没看过的内容。
	it("清除草稿不动落败副本", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: { "task-1": createDraft({ taskId: "task-1" }) },
			supersededDraftCopies: [
				{ draft: createDraft({ taskId: "task-1", prompt: "落败那份" }), supersededAt: 1, supersededBySavedAt: 2 },
			],
		};

		const next = applyWorkspaceTaskEditDraftMutation(seeded, { kind: "clear_task_edit_draft", taskId: "task-1" }, 0);

		expect(next.draftsByTaskId).toEqual({});
		expect(next.supersededDraftCopies).toHaveLength(1);
	});

	// 任务没了之后，草稿再也没有可以认领它的地方。
	it("任务被删除时草稿与落败副本一起清掉，且不波及别的任务", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: {
				"task-1": createDraft({ taskId: "task-1" }),
				"task-2": createDraft({ taskId: "task-2" }),
			},
			supersededDraftCopies: [
				{ draft: createDraft({ taskId: "task-1" }), supersededAt: 1, supersededBySavedAt: 2 },
				{ draft: createDraft({ taskId: "task-2" }), supersededAt: 1, supersededBySavedAt: 2 },
			],
		};

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{ kind: "discard_all_task_edit_drafts_for_deleted_task", taskId: "task-1" },
			0,
		);

		expect(Object.keys(next.draftsByTaskId)).toEqual(["task-2"]);
		expect(next.supersededDraftCopies.map((copy) => copy.draft.taskId)).toEqual(["task-2"]);
	});

	// §五：副本的删除**只有**用户显式点「丢弃」这一条路径，而且只掉他点的那一份。
	it("丢弃落败副本：只掉指定的那一份，当前草稿与其余副本一个不动", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: { "task-1": createDraft({ taskId: "task-1", prompt: "当前", savedAt: 30 }) },
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: "task-1", prompt: "落败甲", savedAt: 10 }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
				{
					draft: createDraft({ taskId: "task-1", prompt: "落败乙", savedAt: 20 }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
				{
					draft: createDraft({ taskId: "task-2", prompt: "别的任务", savedAt: 10 }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{ kind: "discard_superseded_task_edit_draft_copy", taskId: "task-1", supersededDraftSavedAt: 10 },
			0,
		);

		expect(next.supersededDraftCopies.map((copy) => copy.draft.prompt)).toEqual(["落败乙", "别的任务"]);
		expect(next.draftsByTaskId["task-1"]?.prompt).toBe("当前");
	});

	it("丢弃落败副本幂等：重复丢弃同一份既不报错，也不多写一次盘", () => {
		const discardMutation: WorkspaceTaskEditDraftMutation = {
			kind: "discard_superseded_task_edit_draft_copy",
			taskId: "task-1",
			supersededDraftSavedAt: 10,
		};
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{ draft: createDraft({ taskId: "task-1", savedAt: 10 }), supersededAt: 1, supersededBySavedAt: 30 },
			],
		};

		const afterFirstDiscard = applyWorkspaceTaskEditDraftMutation(seeded, discardMutation, 0);
		const afterSecondDiscard = applyWorkspaceTaskEditDraftMutation(afterFirstDiscard, discardMutation, 0);

		expect(afterFirstDiscard.supersededDraftCopies).toEqual([]);
		// 引用相等是「这条意图什么都没改」的信号，mutateWorkspaceTaskEditDrafts 据此跳过写盘。
		expect(afterSecondDiscard).toBe(afterFirstDiscard);
	});

	// §五 不可让步的语义：「用这份替换当前」**不是**丢弃——被换下来的那份必须按同一规则再进副本，
	// 否则这个按钮自己就成了新的静默丢字点。
	it("提升落败副本：副本升为当前草稿，被顶下来的当前草稿必须转存为副本", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: { "task-1": createDraft({ taskId: "task-1", prompt: "当前这份", savedAt: 30 }) },
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: "task-1", prompt: "另一个 origin 那份", savedAt: 10 }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{
				kind: "promote_superseded_task_edit_draft_copy_to_current_draft",
				taskId: "task-1",
				supersededDraftSavedAt: 10,
			},
			7_777,
		);

		expect(next.draftsByTaskId["task-1"]?.prompt).toBe("另一个 origin 那份");
		expect(next.supersededDraftCopies).toEqual([
			{
				draft: expect.objectContaining({ prompt: "当前这份", savedAt: 30 }),
				supersededAt: 7_777,
				// 顶掉它的正是刚被提升上去的那份，如实记下来用户才看得出两份差了多久。
				supersededBySavedAt: 10,
			},
		]);
	});

	it("提升时当前没有草稿 → 直接升位，不凭空造出一份副本", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: "task-1", prompt: "唯一还剩的那份", savedAt: 10 }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{
				kind: "promote_superseded_task_edit_draft_copy_to_current_draft",
				taskId: "task-1",
				supersededDraftSavedAt: 10,
			},
			7_777,
		);

		expect(next.draftsByTaskId["task-1"]?.prompt).toBe("唯一还剩的那份");
		expect(next.supersededDraftCopies).toEqual([]);
	});

	// 去重键是 (taskId, savedAt)，于是两个 origin 在同一毫秒各存过一次时，被顶下来的当前草稿会与刚被
	// 提升走的那份撞上同一个键。「先把被提升的那份摘掉、再判断当前草稿要不要留存」的次序就是为这一格
	// 设的——判在前就会把当前草稿当成「早就存过了」直接扔掉。
	it("提升时两份 savedAt 相同 → 被顶下来的当前草稿仍必须留存", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: { "task-1": createDraft({ taskId: "task-1", prompt: "本机这份", savedAt: 10 }) },
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: "task-1", prompt: "同一毫秒的另一份", savedAt: 10 }),
					supersededAt: 1,
					supersededBySavedAt: 10,
				},
			],
		};

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{
				kind: "promote_superseded_task_edit_draft_copy_to_current_draft",
				taskId: "task-1",
				supersededDraftSavedAt: 10,
			},
			7_777,
		);

		expect(next.draftsByTaskId["task-1"]?.prompt).toBe("同一毫秒的另一份");
		expect(next.supersededDraftCopies).toEqual([
			{
				draft: expect.objectContaining({ prompt: "本机这份" }),
				supersededAt: 7_777,
				supersededBySavedAt: 10,
			},
		]);
	});

	it("提升幂等：那一份已被提升 / 已被丢弃 / 从来不存在时原样返回，不写盘也不凭空造草稿", () => {
		const seeded: WorkspaceTaskEditDraftsSnapshot = {
			draftsByTaskId: { "task-1": createDraft({ taskId: "task-1", prompt: "当前", savedAt: 30 }) },
			supersededDraftCopies: [],
		};

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{
				kind: "promote_superseded_task_edit_draft_copy_to_current_draft",
				taskId: "task-1",
				supersededDraftSavedAt: 10,
			},
			7_777,
		);

		expect(next).toBe(seeded);
	});
});

describe("task-edit-draft-store — 从浏览器 localStorage 合并迁移", () => {
	it("服务端没有这条时整份采纳", () => {
		const draft = createDraft({ taskId: "task-1", prompt: "浏览器里那份", savedAt: 5 });
		const next = applyWorkspaceTaskEditDraftMutation(
			emptySnapshot(),
			{ kind: "merge_task_edit_drafts_migrated_from_browser_local_storage", drafts: [draft] },
			9_999,
		);

		expect(next.draftsByTaskId["task-1"]).toEqual(draft);
		expect(next.supersededDraftCopies).toEqual([]);
	});

	// 草稿是无法重建的原创内容，凭一个时间戳就静默销毁另一半不可接受。
	it("savedAt 新的胜出，落败那份另存为带来源标注的副本而不是被丢掉", () => {
		const olderDraft = createDraft({ taskId: "task-1", prompt: "旧的", savedAt: 100 });
		const newerDraft = createDraft({ taskId: "task-1", prompt: "新的", savedAt: 200 });
		const seeded = applyWorkspaceTaskEditDraftMutation(
			emptySnapshot(),
			{ kind: "save_task_edit_draft", draft: olderDraft },
			0,
		);

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{ kind: "merge_task_edit_drafts_migrated_from_browser_local_storage", drafts: [newerDraft] },
			777,
		);

		expect(next.draftsByTaskId["task-1"]).toEqual(newerDraft);
		expect(next.supersededDraftCopies).toEqual([{ draft: olderDraft, supersededAt: 777, supersededBySavedAt: 200 }]);
	});

	it("来的那份更旧时服务端那份留任，落败的仍是来的那份", () => {
		const newerDraft = createDraft({ taskId: "task-1", prompt: "服务端更新", savedAt: 200 });
		const olderDraft = createDraft({ taskId: "task-1", prompt: "浏览器更旧", savedAt: 100 });
		const seeded = applyWorkspaceTaskEditDraftMutation(
			emptySnapshot(),
			{ kind: "save_task_edit_draft", draft: newerDraft },
			0,
		);

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{ kind: "merge_task_edit_drafts_migrated_from_browser_local_storage", drafts: [olderDraft] },
			777,
		);

		expect(next.draftsByTaskId["task-1"]).toEqual(newerDraft);
		expect(next.supersededDraftCopies[0]?.draft).toEqual(olderDraft);
	});

	// 否则每打开一个新 origin 都会凭空多出一份一模一样的「落败草稿」。
	it("savedAt 相等视为同一次编辑的副本，不产生落败副本", () => {
		const draft = createDraft({ taskId: "task-1", savedAt: 100 });
		const seeded = applyWorkspaceTaskEditDraftMutation(emptySnapshot(), { kind: "save_task_edit_draft", draft }, 0);

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{ kind: "merge_task_edit_drafts_migrated_from_browser_local_storage", drafts: [draft] },
			777,
		);

		expect(next).toBe(seeded);
	});

	// 浏览器那边刻意不删本地镜像，于是每次页面加载都会把同一份旧镜像重新送上来。
	it("同一份镜像反复迁移时，落败副本只留一份、不随加载次数堆积", () => {
		const olderMirrorDraft = createDraft({ taskId: "task-1", prompt: "浏览器里那份", savedAt: 100 });
		const newerServerDraft = createDraft({ taskId: "task-1", prompt: "服务端更新", savedAt: 200 });
		const migration: WorkspaceTaskEditDraftMutation = {
			kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
			drafts: [olderMirrorDraft],
		};
		const seeded = applyWorkspaceTaskEditDraftMutation(
			emptySnapshot(),
			{ kind: "save_task_edit_draft", draft: newerServerDraft },
			0,
		);

		const afterFirstMigration = applyWorkspaceTaskEditDraftMutation(seeded, migration, 111);
		const afterSecondMigration = applyWorkspaceTaskEditDraftMutation(afterFirstMigration, migration, 222);

		expect(afterFirstMigration.supersededDraftCopies).toEqual([
			{ draft: olderMirrorDraft, supersededAt: 111, supersededBySavedAt: 200 },
		]);
		// 快照一个字节都没变——原样返回可以让上层跳过写盘。
		expect(afterSecondMigration).toBe(afterFirstMigration);
	});

	// 同一个 taskId 下不同 savedAt 是不同的编辑，去重不能把它们也一起吞掉。
	it("落败副本去重只认「同一次编辑」，另一份更旧的草稿照样留存", () => {
		const oldestDraft = createDraft({ taskId: "task-1", prompt: "最旧那份", savedAt: 50 });
		const olderDraft = createDraft({ taskId: "task-1", prompt: "稍旧那份", savedAt: 100 });
		const seeded = applyWorkspaceTaskEditDraftMutation(
			emptySnapshot(),
			{ kind: "save_task_edit_draft", draft: createDraft({ taskId: "task-1", savedAt: 200 }) },
			0,
		);

		const next = applyWorkspaceTaskEditDraftMutation(
			seeded,
			{ kind: "merge_task_edit_drafts_migrated_from_browser_local_storage", drafts: [olderDraft, oldestDraft] },
			777,
		);

		expect(next.supersededDraftCopies.map((copy) => copy.draft.savedAt)).toEqual([100, 50]);
	});
});

describe("task-edit-draft-store — 落盘", () => {
	let temporaryHome = "";

	beforeEach(async () => {
		temporaryHome = await mkdtemp(join(tmpdir(), "kanban-task-edit-drafts-"));
		testRuntimeHome.path = temporaryHome;
	});

	afterEach(async () => {
		await rm(temporaryHome, { recursive: true, force: true });
	});

	it("文件不存在时读出空集", async () => {
		expect(await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID)).toEqual(
			EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT,
		);
	});

	it("写入后可读回", async () => {
		const draft = createDraft({ taskId: "task-1", prompt: "存下来的", savedAt: 42 });
		await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, { kind: "save_task_edit_draft", draft });

		expect((await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID)).draftsByTaskId["task-1"]).toEqual(draft);
	});

	it("坏掉的单条草稿被丢弃，其余条目照常读出", async () => {
		const goodDraft = createDraft({ taskId: "task-good", prompt: "好的" });
		// 先走一次正常写入，让 workspace 目录被建出来；随后才能直接往那份文件里塞手写内容。
		await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, { kind: "save_task_edit_draft", draft: goodDraft });
		await writeFile(
			getWorkspaceTaskEditDraftsPath(WORKSPACE_ID),
			JSON.stringify({
				draftsByTaskId: { "task-good": goodDraft, "task-bad": { taskId: 42 } },
				supersededDraftCopies: [],
			}),
			"utf8",
		);

		const snapshot = await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID);

		expect(Object.keys(snapshot.draftsByTaskId)).toEqual(["task-good"]);
	});

	// 拿降级出来的空快照去原子覆盖损坏文件，等于把一个还能人工修复的状态变成不可逆的草稿丢失。
	it("覆盖读不出来的文件之前先把原始字节搬到旁路留存", async () => {
		const draftsPath = getWorkspaceTaskEditDraftsPath(WORKSPACE_ID);
		await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
			kind: "save_task_edit_draft",
			draft: createDraft({ taskId: "seed" }),
		});
		const corruptedBytes = '{"draftsByTaskId": 这不是 JSON';
		await writeFile(draftsPath, corruptedBytes, "utf8");

		await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
			kind: "save_task_edit_draft",
			draft: createDraft({ taskId: "task-after-corruption" }),
		});

		const filesInWorkspace = await readdir(join(temporaryHome, "workspaces", WORKSPACE_ID));
		const quarantinedFileName = filesInWorkspace.find((name) =>
			name.includes("unreadable-quarantined-before-overwrite"),
		);
		expect(quarantinedFileName).toBeDefined();
		if (!quarantinedFileName) {
			throw new Error("Expected a quarantined copy of the unreadable drafts file.");
		}
		expect(await readFile(join(temporaryHome, "workspaces", WORKSPACE_ID, quarantinedFileName), "utf8")).toBe(
			corruptedBytes,
		);
		expect((await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID)).draftsByTaskId).toHaveProperty(
			"task-after-corruption",
		);
	});

	// 副本数组与草稿文件不能随页面加载次数线性膨胀——那些副本目前在界面上还看不到，用户发现不了也清不掉。
	it("同一份镜像连续迁移多次，落盘的落败副本不重复增长", async () => {
		const olderMirrorDraft = createDraft({ taskId: "task-1", prompt: "浏览器里那份", savedAt: 100 });
		await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
			kind: "save_task_edit_draft",
			draft: createDraft({ taskId: "task-1", prompt: "服务端更新", savedAt: 200 }),
		});

		for (let migrationAttempt = 0; migrationAttempt < 3; migrationAttempt += 1) {
			await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
				kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
				drafts: [olderMirrorDraft],
			});
		}

		const snapshot = await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID);
		expect(snapshot.supersededDraftCopies.map((copy) => copy.draft)).toEqual([olderMirrorDraft]);
	});

	it("并发写在锁内合并，互不覆盖", async () => {
		await Promise.all([
			mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
				kind: "save_task_edit_draft",
				draft: createDraft({ taskId: "task-1" }),
			}),
			mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
				kind: "save_task_edit_draft",
				draft: createDraft({ taskId: "task-2" }),
			}),
		]);

		expect(Object.keys((await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID)).draftsByTaskId).sort()).toEqual([
			"task-1",
			"task-2",
		]);
	});
});
