// 任务从看板上消失时清掉它的编辑草稿与全部落败副本。
//
// ## 为什么需要这个模块
//
// 草稿的落点是每个 workspace 一份独立文件（**不进** board.json，理由见 task-edit-draft-store.ts），
// 代价就是「卡片删除时不再自动带走这些数据」——生命周期得自己写。在此之前它只写在了一处：
// `web-ui/src/hooks/use-board-interactions.ts` 的删除 handler。于是 `kanban task delete` 删掉的任务
// 会留下永远无法认领的孤儿草稿：任务本体没了，界面上再也没有可以打开它的地方。
//
// ## 为什么不放进 workspace-state.ts
//
// 那里是最自然的位置（`saveWorkspaceState` / `mutateWorkspaceState` 在同一把锁内同时握着「写之前的
// board」和「写之后的 board」），但 task-edit-draft-store 需要 workspace-state 的 `getWorkspaceDirectoryPath`
// 来解析落盘路径——反向 import 会形成模块环。这个模块坐在两者之上，由调用方在写盘之后调用。
//
// ## 「删除」与「移进 trash 列」是两件事
//
// `kanban task trash`（`done` 的别名）只是把卡片移到 trash 列，任务还能恢复，此时清草稿本身就是丢内容。
// 所以判据一律是「taskId 还在不在 board 上」，而不是「它在哪一列」——移列的任务在两份 board 里都在，
// 差集天然不会碰它。

import type { RuntimeBoardData, WorkspaceTaskEditDraftMutation } from "../core/api-contract";
import { mutateWorkspaceTaskEditDrafts } from "./task-edit-draft-store";
import { loadWorkspaceBoardById } from "./workspace-state";

function collectTaskIdsOnBoard(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

/** 在 `boardBeforeWrite` 上、却已经不在 `boardAfterWrite` 上的任务 id。 */
export function collectTaskIdsRemovedFromBoard(
	boardBeforeWrite: RuntimeBoardData,
	boardAfterWrite: RuntimeBoardData,
): string[] {
	const taskIdsAfterWrite = collectTaskIdsOnBoard(boardAfterWrite);
	return [...collectTaskIdsOnBoard(boardBeforeWrite)].filter((taskId) => !taskIdsAfterWrite.has(taskId));
}

/**
 * 清掉这些任务的草稿与落败副本。
 *
 * 失败只记不抛：调用方是「任务已经删成了」之后的收尾，为一次清理失败把整条删除报成失败，会让用户以为
 * 任务还在。残留的后果也只是一条看不见的孤儿草稿，不丢任何用户内容。
 */
export async function discardTaskEditDraftsForDeletedTasks(
	workspaceId: string,
	deletedTaskIds: readonly string[],
): Promise<void> {
	for (const taskId of deletedTaskIds) {
		try {
			await mutateWorkspaceTaskEditDrafts(workspaceId, {
				kind: "discard_all_task_edit_drafts_for_deleted_task",
				taskId,
			});
		} catch {
			// 见上：这是收尾，不是删除本身的一部分。
		}
	}
}

/** 差集版：给「删除不是一次显式操作、而是整份 board 里少了一张卡」的写入路径用（浏览器的整份 PUT）。 */
export async function discardTaskEditDraftsForTasksRemovedFromBoard(
	workspaceId: string,
	boardBeforeWrite: RuntimeBoardData,
	boardAfterWrite: RuntimeBoardData,
): Promise<void> {
	const removedTaskIds = collectTaskIdsRemovedFromBoard(boardBeforeWrite, boardAfterWrite);
	if (removedTaskIds.length === 0) {
		return;
	}
	await discardTaskEditDraftsForDeletedTasks(workspaceId, removedTaskIds);
}

/**
 * 迁移意图的入口过滤：浏览器镜像里那些**任务已经不在看板上**的草稿不许迁上来。
 *
 * 没有这一道，上面两条清理对浏览器写入等于白做。浏览器的 localStorage 镜像是迁移的**种子**且刻意不删
 * （见 web-ui/src/runtime/task-edit-draft-store.ts 的「迁移不删本地镜像」），于是每次页面加载都会把整份
 * 镜像重新作为 merge_task_edit_drafts_migrated_from_browser_local_storage 送上服务端。任务被删掉之后镜像
 * 里那条仍在，刚被清掉的草稿会在下一次加载时原样迁回服务端，成为永远无法认领的孤儿。
 *
 * 过滤放在服务端而不是让浏览器自己先比一遍：镜像是 per-origin 的，别的 origin／别的浏览器照样会重发同
 * 一份；而 CLI 删除本来就不经过任何浏览器。
 *
 * 两条保守红线，宁可漏过一条孤儿草稿也不能丢用户内容：
 *
 * 1. 读不到 board 就整条放行——把「读不到」当成「一张卡都不剩」会把整份迁移载荷丢光。
 * 2. **board 上一张卡都没有时同样整条放行**。`loadWorkspaceBoardById` 把「board.json 不存在／读坏了」
 *    降级成空 board，与「用户真把所有任务都删了」在这里分辨不出来；而误判的代价是不可逆的：迁移被丢空
 *    后服务端快照没有这条草稿，浏览器据此判定「已交接且服务端没有」，下一次去抖自动保存就会发出
 *    clear_task_edit_draft 把镜像里那份无法重建的原创内容一并删掉。
 */
export async function withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(
	workspaceId: string,
	mutation: WorkspaceTaskEditDraftMutation,
): Promise<WorkspaceTaskEditDraftMutation> {
	if (mutation.kind !== "merge_task_edit_drafts_migrated_from_browser_local_storage") {
		return mutation;
	}
	let taskIdsOnBoard: Set<string>;
	try {
		taskIdsOnBoard = collectTaskIdsOnBoard(await loadWorkspaceBoardById(workspaceId));
	} catch {
		return mutation;
	}
	if (taskIdsOnBoard.size === 0) {
		return mutation;
	}
	const draftsForTasksStillOnBoard = mutation.drafts.filter((draft) => taskIdsOnBoard.has(draft.taskId));
	// 一条都没被拦下时原样返回同一个对象引用：这是绝大多数情况，不必每次页面加载都造一份新载荷。
	return draftsForTasksStillOnBoard.length === mutation.drafts.length
		? mutation
		: { ...mutation, drafts: draftsForTasksStillOnBoard };
}
