// 远端 workspace revision 前进时，本地 board 该怎么办（cf427）。
//
// 过去的规则是「revision 一变就整板采纳远端」。revision 却不只因 board 变化而前进（原生会话身份落盘、关机时
// 保存 sessions 都会推它），而浏览器的改动要等 120ms 防抖才整板保存——于是刚建、尚未落盘的卡片会被一次
// 与它毫不相干的 revision 前进整张抹掉，照常启动的 agent 成了孤儿会话。这里按三方（runtime 最近确认的 board
// = 基线、本地 board、远端 board）逐卡合并：
//
// - 本地新建的卡（基线里没有）：以本地版本、本地位置为准并入。新卡 id 由 runtime 全局分配、全局唯一，「基线里
//   没有的卡」只可能是本客户端自己建的，多客户端下这个判定也安全。
// - 已有的卡按两个面分别合并：所在列、字段值（不比 updatedAt——每次改动都会推它，比它会把「只有本地动了列、
//   只有远端动了字段」误判成双方都改了同一张卡）。只有本地改了的面取本地，只有远端改了的面取远端；双方把
//   同一个面改成不同的值时以远端为准，记为「本地改动被丢弃」，由调用方提示用户。
// - 本地删了的卡：远端没动过它就照删；远端改过它就以远端为准（记为丢弃）。远端删了而本地改过的卡：远端为准。
// 列内顺序不参与合并（以远端为准）。

import isDeepEqual from "fast-deep-equal";

import type { BoardCard, BoardColumnId, BoardData } from "@/types";

export type LocalBoardReconciliationAfterRemoteWorkspaceRevisionAdvance =
	| { reconciliationKind: "local_board_already_equals_remote_board" }
	| { reconciliationKind: "adopt_remote_board_because_local_board_has_no_unsaved_changes" }
	| { reconciliationKind: "keep_local_board_because_remote_board_changes_are_already_in_local_board" }
	| {
			reconciliationKind: "adopt_remote_board_merged_with_local_unsaved_changes";
			reconciledBoard: BoardData;
			// 合并结果里有远端（runtime）还没有的本地改动：水合之后必须照常保存。
			reconciledBoardContainsLocalChangesNotYetPersistedByRuntime: boolean;
			conflictingLocalUnsavedChangesWereDiscarded: boolean;
	  };

interface TaskCardPlacementOnBoard {
	card: BoardCard;
	columnId: BoardColumnId;
	indexWithinColumn: number;
}

function indexTaskCardPlacementsOnBoard(board: BoardData): Map<string, TaskCardPlacementOnBoard> {
	const placements = new Map<string, TaskCardPlacementOnBoard>();
	for (const column of board.columns) {
		for (const [indexWithinColumn, card] of column.cards.entries()) {
			placements.set(card.id, { card, columnId: column.id, indexWithinColumn });
		}
	}
	return placements;
}

function haveSameTaskCardFieldValuesIgnoringUpdatedAt(left: BoardCard, right: BoardCard): boolean {
	const { updatedAt: _leftUpdatedAt, ...leftFieldValues } = left;
	const { updatedAt: _rightUpdatedAt, ...rightFieldValues } = right;
	return isDeepEqual(leftFieldValues, rightFieldValues);
}

// 以远端 board 为底、可按卡移除 / 放置的工作副本。
function createMutableBoardCopy(board: BoardData) {
	const cardsByColumnId = new Map(board.columns.map((column) => [column.id, [...column.cards]]));
	const removeTaskCard = (taskId: string): void => {
		for (const cards of cardsByColumnId.values()) {
			const index = cards.findIndex((card) => card.id === taskId);
			if (index >= 0) {
				cards.splice(index, 1);
				return;
			}
		}
	};
	const placeTaskCard = (placement: TaskCardPlacementOnBoard): void => {
		const targetCards = cardsByColumnId.get(placement.columnId) ?? cardsByColumnId.get("backlog");
		targetCards?.splice(Math.min(placement.indexWithinColumn, targetCards.length), 0, placement.card);
	};
	const replaceTaskCardInPlace = (card: BoardCard): void => {
		for (const cards of cardsByColumnId.values()) {
			const index = cards.findIndex((candidate) => candidate.id === card.id);
			if (index >= 0) {
				cards[index] = card;
				return;
			}
		}
	};
	const toBoard = (): BoardData => ({
		...board,
		columns: board.columns.map((column) => ({ ...column, cards: cardsByColumnId.get(column.id) ?? column.cards })),
	});
	return { removeTaskCard, placeTaskCard, replaceTaskCardInPlace, toBoard };
}

export function reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance(input: {
	// runtime 最近一次确认持久化的 board（水合 / 保存成功 / 建卡落盘确认）。null = 尚无基线，只能采纳远端。
	boardLastAcknowledgedByRuntime: BoardData | null;
	localBoard: BoardData;
	remoteBoard: BoardData;
}): LocalBoardReconciliationAfterRemoteWorkspaceRevisionAdvance {
	const { boardLastAcknowledgedByRuntime: baseBoard, localBoard, remoteBoard } = input;
	if (localBoard === remoteBoard || isDeepEqual(localBoard, remoteBoard)) {
		return { reconciliationKind: "local_board_already_equals_remote_board" };
	}
	if (baseBoard === null || localBoard === baseBoard || isDeepEqual(localBoard, baseBoard)) {
		return { reconciliationKind: "adopt_remote_board_because_local_board_has_no_unsaved_changes" };
	}
	const basePlacements = indexTaskCardPlacementsOnBoard(baseBoard);
	const localPlacements = indexTaskCardPlacementsOnBoard(localBoard);
	const remotePlacements = indexTaskCardPlacementsOnBoard(remoteBoard);
	const mergedBoard = createMutableBoardCopy(remoteBoard);
	let conflictingLocalUnsavedChangesWereDiscarded = false;

	for (const [taskId, basePlacement] of basePlacements) {
		const localPlacement = localPlacements.get(taskId);
		const remotePlacement = remotePlacements.get(taskId);
		if (!localPlacement) {
			// 本地删了。远端原样未动 → 照删；远端改过 → 远端为准。
			if (remotePlacement) {
				const remoteLeftItUntouched =
					remotePlacement.columnId === basePlacement.columnId &&
					haveSameTaskCardFieldValuesIgnoringUpdatedAt(remotePlacement.card, basePlacement.card);
				if (remoteLeftItUntouched) {
					mergedBoard.removeTaskCard(taskId);
				} else {
					conflictingLocalUnsavedChangesWereDiscarded = true;
				}
			}
			continue;
		}
		const localChangedFieldValues = !haveSameTaskCardFieldValuesIgnoringUpdatedAt(
			localPlacement.card,
			basePlacement.card,
		);
		const localChangedColumn = localPlacement.columnId !== basePlacement.columnId;
		if (!localChangedFieldValues && !localChangedColumn) {
			continue;
		}
		if (!remotePlacement) {
			conflictingLocalUnsavedChangesWereDiscarded = true;
			continue;
		}
		let mergedCard = remotePlacement.card;
		// 合并结果是否吸收了本地独有的某个面（列或字段）。双方改成同一个值不算——那时结果就是远端版本。
		let mergedCardAbsorbedLocalOnlyChange = false;
		if (localChangedFieldValues) {
			if (haveSameTaskCardFieldValuesIgnoringUpdatedAt(remotePlacement.card, basePlacement.card)) {
				mergedCard = localPlacement.card;
				mergedCardAbsorbedLocalOnlyChange = true;
			} else if (!haveSameTaskCardFieldValuesIgnoringUpdatedAt(remotePlacement.card, localPlacement.card)) {
				conflictingLocalUnsavedChangesWereDiscarded = true;
			}
		}
		let mergedColumnId = remotePlacement.columnId;
		if (localChangedColumn) {
			if (remotePlacement.columnId === basePlacement.columnId) {
				mergedColumnId = localPlacement.columnId;
				mergedCardAbsorbedLocalOnlyChange = true;
			} else if (remotePlacement.columnId !== localPlacement.columnId) {
				conflictingLocalUnsavedChangesWereDiscarded = true;
			}
		}
		// 冲突判定有意不比 updatedAt，但合并结果的 updatedAt 不能回退：吸收了本地改动时，本地推进过的时间戳
		// 要保住（它参与「最近移入 / 最近修改」排序与 Focus View 最新卡选择，下次保存还会把回退值持久化），
		// 远端推进过的也要保住——取两者较大者。
		if (mergedCardAbsorbedLocalOnlyChange) {
			const mergedUpdatedAt = Math.max(localPlacement.card.updatedAt, remotePlacement.card.updatedAt);
			if (mergedCard.updatedAt !== mergedUpdatedAt) {
				mergedCard = { ...mergedCard, updatedAt: mergedUpdatedAt };
			}
		}
		if (mergedColumnId !== remotePlacement.columnId) {
			mergedBoard.removeTaskCard(taskId);
			mergedBoard.placeTaskCard({
				card: mergedCard,
				columnId: mergedColumnId,
				indexWithinColumn: localPlacement.indexWithinColumn,
			});
		} else if (mergedCard !== remotePlacement.card) {
			mergedBoard.replaceTaskCardInPlace(mergedCard);
		}
	}

	// 本地新建的卡：远端若已有（建卡落盘确认、或自己保存的回声）先拿掉，再按本地列自上而下插回本地版本。
	const locallyCreatedTaskCardPlacements = [...localPlacements.values()].filter(
		(placement) => !basePlacements.has(placement.card.id),
	);
	for (const placement of locallyCreatedTaskCardPlacements) {
		mergedBoard.removeTaskCard(placement.card.id);
	}
	for (const placement of locallyCreatedTaskCardPlacements) {
		mergedBoard.placeTaskCard(placement);
	}

	const reconciledBoard = mergedBoard.toBoard();
	if (isDeepEqual(reconciledBoard, localBoard)) {
		return { reconciliationKind: "keep_local_board_because_remote_board_changes_are_already_in_local_board" };
	}
	return {
		reconciliationKind: "adopt_remote_board_merged_with_local_unsaved_changes",
		reconciledBoard,
		reconciledBoardContainsLocalChangesNotYetPersistedByRuntime: !isDeepEqual(reconciledBoard, remoteBoard),
		conflictingLocalUnsavedChangesWereDiscarded,
	};
}
