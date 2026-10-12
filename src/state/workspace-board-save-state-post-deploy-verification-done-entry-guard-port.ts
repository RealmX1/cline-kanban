import type { RuntimeBoardData } from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";

// 整板保存（浏览器 saveState，含没刷新的旧 bundle）的 Post-Deploy Verification 门禁兜底。正常入口（看板按钮、拖拽、
// Focus View、PDV 面板、CLI）都经 taskCardAction.moveTaskCardIntoDone… 的门禁；只有整板保存能绕开它，这里把漏网的挡回去。
//
// 注册制而不是直接 import：门禁要读 src/deployment 的 PDV 状态，而 src/deployment 反过来依赖本目录（runtime home 路径等）；
// runtime 启动时注册实现，未注册的进程（单测、CLI）不设门禁。
//
// 只能「把卡改回原列」而不能整板拒绝：浏览器之后的每次整板保存都会带着这张 Done 卡，整板拒绝会让全部后续保存失败。

export type WorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard = (input: {
	workspaceId: string;
	taskIdsNewlyEnteringDone: readonly string[];
	nowIso: string;
}) => Promise<Set<string>>;

let registeredWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard: WorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard | null =
	null;

export function registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard(
	guard: WorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard | null,
): void {
	registeredWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard = guard;
}

/**
 * 在 board 锁内调用：找出这次保存里新进 Done（trash）的卡，受门禁且没有在途授权的改回持久化时的列。
 * 返回修正后的 board 与被挡回的 taskId（调用方据此告警）。未注册门禁时原样返回。
 */
export async function revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure(input: {
	workspaceId: string;
	persistedBoard: RuntimeBoardData;
	incomingBoard: RuntimeBoardData;
	nowIso: string;
}): Promise<{ board: RuntimeBoardData; revertedTaskIds: string[] }> {
	const guard = registeredWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard;
	if (!guard) {
		return { board: input.incomingBoard, revertedTaskIds: [] };
	}
	const incomingDoneTaskIds = input.incomingBoard.columns.find((column) => column.id === "trash")?.cards ?? [];
	const taskIdsNewlyEnteringDone = incomingDoneTaskIds
		.map((card) => card.id)
		.filter((taskId) => {
			const persistedColumnId = getTaskColumnId(input.persistedBoard, taskId);
			return persistedColumnId !== null && persistedColumnId !== "trash";
		});
	if (taskIdsNewlyEnteringDone.length === 0) {
		return { board: input.incomingBoard, revertedTaskIds: [] };
	}
	const blockedTaskIds = await guard({
		workspaceId: input.workspaceId,
		taskIdsNewlyEnteringDone,
		nowIso: input.nowIso,
	});
	let board = input.incomingBoard;
	const revertedTaskIds: string[] = [];
	for (const taskId of blockedTaskIds) {
		const persistedColumnId = getTaskColumnId(input.persistedBoard, taskId);
		if (!persistedColumnId || persistedColumnId === "trash") {
			continue;
		}
		const moved = moveTaskToColumn(board, taskId, persistedColumnId);
		if (moved.moved) {
			board = moved.board;
			revertedTaskIds.push(taskId);
		}
	}
	return { board, revertedTaskIds };
}

export function logWorkspaceStatePostDeployVerificationDoneEntryGuardRevertedCards(input: {
	workspaceId: string;
	revertedTaskIds: string[];
}): void {
	try {
		process.stderr.write(
			`[warn] [post-deploy-verification-done-entry-guard] whole-board save tried to move gated cards into Done without a Post-Deploy Verification closure; moved them back workspaceId=${input.workspaceId} taskIds=${input.revertedTaskIds.join(",")}\n`,
		);
	} catch {
		// Best-effort diagnostic logging only.
	}
}
