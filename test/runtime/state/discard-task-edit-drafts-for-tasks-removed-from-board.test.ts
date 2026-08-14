import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardData,
	RuntimeTaskEditDraft,
	WorkspaceTaskEditDraftMutation,
} from "../../../src/core/api-contract";
import {
	addTaskToColumn,
	deleteTasksFromBoard,
	trashTaskAndGetReadyLinkedTaskIds,
} from "../../../src/core/task-board-mutations";

// 草稿落在 ~/.cline/kanban/workspaces/<id> 之下，路径由 workspace-state 解析。重定向到临时目录，
// 而不是去动 homedir()——后者会让本套件在用户真实的草稿上跑。
const testRuntimeHome = { path: "" };
// 服务端 board 的替身：迁移过滤要按「任务还在不在 board 上」判定，用例逐条摆好这份 board。
// null = 这次读盘失败（过滤必须整条放行，不能把「读不到」当成「一张卡都不剩」）。
const testWorkspaceBoard: { value: RuntimeBoardData | null } = { value: null };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	loadWorkspaceBoardById: async () => {
		if (testWorkspaceBoard.value === null) {
			throw new Error("board 这次读不出来");
		}
		return testWorkspaceBoard.value;
	},
}));

const {
	collectTaskIdsRemovedFromBoard,
	discardTaskEditDraftsForTasksRemovedFromBoard,
	withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped,
} = await import("../../../src/state/discard-task-edit-drafts-for-tasks-removed-from-board");
const { mutateWorkspaceTaskEditDrafts, readWorkspaceTaskEditDraftsSnapshot } = await import(
	"../../../src/state/task-edit-draft-store"
);

const WORKSPACE_ID = "workspace-alpha";

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createBoardWithTasks(prompts: string[]): { board: RuntimeBoardData; taskIds: string[] } {
	let board = createEmptyBoard();
	const taskIds: string[] = [];
	prompts.forEach((prompt, index) => {
		// 固定 id：断言要按 taskId 比对草稿归属，随机 id 会让失败信息读不出是哪一张卡。
		const added = addTaskToColumn(board, "backlog", { prompt, baseRef: "main" }, () => `task${index}0000`);
		board = added.board;
		taskIds.push(added.task.id);
	});
	return { board, taskIds };
}

function createDraft(taskId: string, savedAt: number): RuntimeTaskEditDraft {
	return {
		taskId,
		prompt: `${taskId} 的草稿（savedAt=${savedAt}）`,
		images: [],
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		branchRef: "main",
		savedAt,
	};
}

async function seedDraftWithSupersededCopy(taskId: string): Promise<void> {
	await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
		kind: "save_task_edit_draft",
		draft: {
			taskId,
			prompt: `${taskId} 的草稿`,
			images: [],
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			branchRef: "main",
			savedAt: 30,
		},
	});
	// 顺带造一份落败副本：任务删除时它也必须一起走，否则留下的是永远无法认领的孤儿。
	await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, {
		kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
		drafts: [
			{
				taskId,
				prompt: `${taskId} 的另一个 origin 那份`,
				images: [],
				startInPlanMode: false,
				autoReviewEnabled: false,
				autoReviewMode: "commit",
				branchRef: "main",
				savedAt: 10,
			},
		],
	});
}

describe("任务从看板上消失时清掉它的编辑草稿", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-draft-cleanup-"));
		testWorkspaceBoard.value = null;
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("永久删除的任务算被移除", () => {
		const { board, taskIds } = createBoardWithTasks(["甲", "乙"]);
		const deleted = deleteTasksFromBoard(board, [taskIds[0] ?? ""]);

		expect(collectTaskIdsRemovedFromBoard(board, deleted.board)).toEqual([taskIds[0]]);
	});

	// 红线：`kanban task trash`（`done` 的别名）只是把卡片移到 trash 列，任务还能恢复。
	// 此时清草稿本身就是丢内容——判据必须是「还在不在 board 上」，而不是「在哪一列」。
	it("移进 trash 列**不算**被移除：任务还在，草稿还能被认领", () => {
		const { board, taskIds } = createBoardWithTasks(["甲"]);
		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, taskIds[0] ?? "");

		expect(collectTaskIdsRemovedFromBoard(board, trashed.board)).toEqual([]);
	});

	it("差集清理只带走被删掉那个任务的草稿与落败副本，别的任务一个不动", async () => {
		const { board, taskIds } = createBoardWithTasks(["甲", "乙"]);
		const deletedTaskId = taskIds[0] ?? "";
		const survivingTaskId = taskIds[1] ?? "";
		await seedDraftWithSupersededCopy(deletedTaskId);
		await seedDraftWithSupersededCopy(survivingTaskId);
		const deleted = deleteTasksFromBoard(board, [deletedTaskId]);

		await discardTaskEditDraftsForTasksRemovedFromBoard(WORKSPACE_ID, board, deleted.board);

		const snapshot = await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID);
		expect(Object.keys(snapshot.draftsByTaskId)).toEqual([survivingTaskId]);
		expect(snapshot.supersededDraftCopies.map((copy) => copy.draft.taskId)).toEqual([survivingTaskId]);
	});

	it("board 没有任何任务消失时不写盘（草稿原样保留）", async () => {
		const { board, taskIds } = createBoardWithTasks(["甲"]);
		await seedDraftWithSupersededCopy(taskIds[0] ?? "");

		await discardTaskEditDraftsForTasksRemovedFromBoard(WORKSPACE_ID, board, board);

		const snapshot = await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID);
		expect(Object.keys(snapshot.draftsByTaskId)).toEqual([taskIds[0]]);
	});
});

// 浏览器的 localStorage 镜像刻意不删，每次页面加载都会把整份镜像重新作为迁移载荷送上来。不在入口拦掉，
// 上面那条差集清理刚清掉的草稿下一次加载就被原样迁回服务端，成为永远无法认领的孤儿。
describe("迁移载荷入口过滤：任务已经不在看板上的草稿不许迁回来", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-draft-migration-filter-"));
		testWorkspaceBoard.value = null;
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("清掉的草稿不会被下一次页面加载的迁移迁回来", async () => {
		const { board, taskIds } = createBoardWithTasks(["甲", "乙"]);
		const deletedTaskId = taskIds[0] ?? "";
		const survivingTaskId = taskIds[1] ?? "";
		await seedDraftWithSupersededCopy(deletedTaskId);
		const deleted = deleteTasksFromBoard(board, [deletedTaskId]);
		await discardTaskEditDraftsForTasksRemovedFromBoard(WORKSPACE_ID, board, deleted.board);
		testWorkspaceBoard.value = deleted.board;

		// 下一次页面加载：镜像里那两条原样重发。
		const filtered = await withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(WORKSPACE_ID, {
			kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
			drafts: [createDraft(deletedTaskId, 90), createDraft(survivingTaskId, 90)],
		});
		await mutateWorkspaceTaskEditDrafts(WORKSPACE_ID, filtered);

		const snapshot = await readWorkspaceTaskEditDraftsSnapshot(WORKSPACE_ID);
		expect(Object.keys(snapshot.draftsByTaskId)).toEqual([survivingTaskId]);
		expect(snapshot.supersededDraftCopies).toEqual([]);
	});

	it("任务还在看板上时整条载荷原样放行", async () => {
		const { board, taskIds } = createBoardWithTasks(["甲"]);
		testWorkspaceBoard.value = board;
		const mutation: WorkspaceTaskEditDraftMutation = {
			kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
			drafts: [createDraft(taskIds[0] ?? "", 90)],
		};

		expect(await withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(WORKSPACE_ID, mutation)).toBe(mutation);
	});

	// 红线：误判的代价不可逆——迁移被丢空后浏览器会判定「已交接且服务端没有」，去抖自动保存随即发出
	// clear_task_edit_draft 把镜像里那份无法重建的原创内容一并删掉。
	it("board 读不出来时整条放行，绝不当成「一张卡都不剩」", async () => {
		testWorkspaceBoard.value = null;
		const mutation: WorkspaceTaskEditDraftMutation = {
			kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
			drafts: [createDraft("task00000", 90)],
		};

		expect(await withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(WORKSPACE_ID, mutation)).toBe(mutation);
	});

	it("board 上一张卡都没有时整条放行（与 board.json 读坏后的降级空 board 分辨不出来）", async () => {
		testWorkspaceBoard.value = createEmptyBoard();
		const mutation: WorkspaceTaskEditDraftMutation = {
			kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
			drafts: [createDraft("task00000", 90)],
		};

		expect(await withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(WORKSPACE_ID, mutation)).toBe(mutation);
	});

	it("非迁移意图一律不读 board、原样放行", async () => {
		testWorkspaceBoard.value = null;
		const mutation: WorkspaceTaskEditDraftMutation = {
			kind: "save_task_edit_draft",
			draft: createDraft("task00000", 90),
		};

		expect(await withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(WORKSPACE_ID, mutation)).toBe(mutation);
	});
});
