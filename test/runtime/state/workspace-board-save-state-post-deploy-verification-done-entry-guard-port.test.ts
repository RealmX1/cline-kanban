import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import {
	registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard,
	revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure,
} from "../../../src/state/workspace-board-save-state-post-deploy-verification-done-entry-guard-port";

// 整板保存（浏览器 saveState / 旧 bundle）的门禁兜底：受门禁、未授权的卡不能被带进 Done，改回持久化时的列；
// 不能整板拒绝（之后每次整板保存都会带着这张卡，整板拒绝会让全部后续保存失败）。

function createCard(taskId: string): RuntimeBoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: taskId,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	} as RuntimeBoardCard;
}

function createBoard(cardIdsByColumnId: Partial<Record<RuntimeBoardColumnId, string[]>>): RuntimeBoardData {
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: columnIds.map((columnId) => ({
			id: columnId,
			title: columnId,
			cards: (cardIdsByColumnId[columnId] ?? []).map(createCard),
		})),
	} as RuntimeBoardData;
}

function readColumnCardIds(board: RuntimeBoardData, columnId: RuntimeBoardColumnId): string[] {
	return board.columns.find((column) => column.id === columnId)?.cards.map((card) => card.id) ?? [];
}

afterEach(() => {
	registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard(null);
});

describe("revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure", () => {
	it("未注册门禁（CLI / 单测进程）时原样放行", async () => {
		const incomingBoard = createBoard({ trash: ["gated"] });
		const result = await revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure({
			workspaceId: "ws-1",
			persistedBoard: createBoard({ validation: ["gated"] }),
			incomingBoard,
			nowIso: "2026-10-11T00:00:00.000Z",
		});
		expect(result).toEqual({ board: incomingBoard, revertedTaskIds: [] });
	});

	it("只问「这次新进 Done」的卡；被挡的改回原列，其余照常", async () => {
		const guard = vi.fn(async () => new Set(["gated"]));
		registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard(guard);

		const result = await revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure({
			workspaceId: "ws-1",
			persistedBoard: createBoard({ validation: ["gated"], review: ["free"], trash: ["already-done"] }),
			incomingBoard: createBoard({ trash: ["gated", "free", "already-done"] }),
			nowIso: "2026-10-11T00:00:00.000Z",
		});

		expect(guard).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskIdsNewlyEnteringDone: ["gated", "free"],
			nowIso: "2026-10-11T00:00:00.000Z",
		});
		expect(result.revertedTaskIds).toEqual(["gated"]);
		expect(readColumnCardIds(result.board, "validation")).toEqual(["gated"]);
		expect(readColumnCardIds(result.board, "trash")).toEqual(["free", "already-done"]);
	});
});
