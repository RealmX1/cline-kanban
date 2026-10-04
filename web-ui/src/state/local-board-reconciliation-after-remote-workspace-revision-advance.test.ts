import { describe, expect, it } from "vitest";

import {
	type LocalBoardReconciliationAfterRemoteWorkspaceRevisionAdvance,
	reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance,
} from "@/state/local-board-reconciliation-after-remote-workspace-revision-advance";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

function createCard(taskId: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: taskId,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(cardsByColumnId: Partial<Record<BoardColumnId, BoardCard[]>>): BoardData {
	return {
		columns: (["backlog", "in_progress", "review", "trash"] as const).map((columnId) => ({
			id: columnId,
			title: columnId,
			cards: cardsByColumnId[columnId] ?? [],
		})),
	};
}

function describeColumns(board: BoardData): Array<[string, string[]]> {
	return board.columns.map((column) => [column.id, column.cards.map((card) => card.id)]);
}

function expectMerged(
	reconciliation: LocalBoardReconciliationAfterRemoteWorkspaceRevisionAdvance,
): Extract<
	LocalBoardReconciliationAfterRemoteWorkspaceRevisionAdvance,
	{ reconciliationKind: "adopt_remote_board_merged_with_local_unsaved_changes" }
> {
	if (reconciliation.reconciliationKind !== "adopt_remote_board_merged_with_local_unsaved_changes") {
		throw new Error(`expected a merge, got ${reconciliation.reconciliationKind}`);
	}
	return reconciliation;
}

describe("reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance", () => {
	const baseBoard = createBoard({ backlog: [createCard("old01")], review: [createCard("rev01")] });

	it("本地与远端一致时不需要任何动作", () => {
		const localBoard = createBoard({
			backlog: [createCard("new01"), createCard("old01")],
			review: [createCard("rev01")],
		});
		expect(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard,
				remoteBoard: structuredClone(localBoard),
			}).reconciliationKind,
		).toBe("local_board_already_equals_remote_board");
	});

	it("没有基线、或本地相对基线没有改动时采纳远端", () => {
		const remoteBoard = createBoard({ trash: [createCard("rev01")] });
		for (const boardLastAcknowledgedByRuntime of [null, baseBoard]) {
			expect(
				reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
					boardLastAcknowledgedByRuntime,
					localBoard: structuredClone(baseBoard),
					remoteBoard,
				}).reconciliationKind,
			).toBe("adopt_remote_board_because_local_board_has_no_unsaved_changes");
		}
	});

	it("建卡落盘确认带回的远端只多了这张卡（初版在 backlog），本地已把它移进 in_progress：保留本地", () => {
		expect(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					backlog: [createCard("old01")],
					in_progress: [createCard("new01")],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({
					backlog: [createCard("new01"), createCard("old01")],
					review: [createCard("rev01")],
				}),
			}).reconciliationKind,
		).toBe("keep_local_board_because_remote_board_changes_are_already_in_local_board");
	});

	// 实测假阳性（隔离实例 e2e）：建卡并启动时，本地刚把卡移进 in_progress（updatedAt 随之变化）还没保存，
	// runtime 的 startTaskSession 已把卡移进 in_progress 并写上运行时字段。两边改的是同一张卡的不同面，不是冲突。
	it("本地只改了列、远端改了字段并且也移到了同一列：合并为远端版本，不算丢弃", () => {
		const localBoard = createBoard({
			in_progress: [createCard("old01", { updatedAt: 5 })],
			review: [createCard("rev01")],
		});
		const remoteBoard = createBoard({
			in_progress: [createCard("old01", { updatedAt: 6, mostRecentlyLaunchedAgentSessionAgentId: "codex" })],
			review: [createCard("rev01")],
		});
		const merged = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard,
				remoteBoard,
			}),
		);
		expect(merged.reconciledBoard).toEqual(remoteBoard);
		expect(merged.reconciledBoardContainsLocalChangesNotYetPersistedByRuntime).toBe(false);
		expect(merged.conflictingLocalUnsavedChangesWereDiscarded).toBe(false);
	});

	it("本地只移了列、远端没动这张卡：合并结果采用本地的列，updatedAt 不回退到远端旧值", () => {
		const merged = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					in_progress: [createCard("old01", { updatedAt: 7 })],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({ backlog: [createCard("old01")], trash: [createCard("rev01")] }),
			}),
		);
		expect(describeColumns(merged.reconciledBoard)).toEqual([
			["backlog", []],
			["in_progress", ["old01"]],
			["review", []],
			["trash", ["rev01"]],
		]);
		expect(merged.reconciledBoard.columns[1]?.cards[0]?.updatedAt).toBe(7);
		expect(merged.reconciledBoardContainsLocalChangesNotYetPersistedByRuntime).toBe(true);
		expect(merged.conflictingLocalUnsavedChangesWereDiscarded).toBe(false);
	});

	it("本地改了字段、远端只移了列：合并结果的 updatedAt 取两边较大者", () => {
		const remoteUpdatedAtIsNewer = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					backlog: [createCard("old01", { title: "renamed locally", updatedAt: 4 })],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({
					in_progress: [createCard("old01", { updatedAt: 9 })],
					review: [createCard("rev01")],
				}),
			}),
		);
		const mergedCardWithNewerRemoteUpdatedAt = remoteUpdatedAtIsNewer.reconciledBoard.columns[1]?.cards[0];
		expect(mergedCardWithNewerRemoteUpdatedAt?.title).toBe("renamed locally");
		expect(mergedCardWithNewerRemoteUpdatedAt?.updatedAt).toBe(9);
		expect(remoteUpdatedAtIsNewer.conflictingLocalUnsavedChangesWereDiscarded).toBe(false);

		const localUpdatedAtIsNewer = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					backlog: [createCard("old01", { title: "renamed locally", updatedAt: 12 })],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({
					in_progress: [createCard("old01", { updatedAt: 9 })],
					review: [createCard("rev01")],
				}),
			}),
		);
		const mergedCardWithNewerLocalUpdatedAt = localUpdatedAtIsNewer.reconciledBoard.columns[1]?.cards[0];
		expect(mergedCardWithNewerLocalUpdatedAt?.title).toBe("renamed locally");
		expect(mergedCardWithNewerLocalUpdatedAt?.updatedAt).toBe(12);
	});

	it("本地改了一张卡的字段、远端动了另一张卡：两边都保留，并标记需要保存", () => {
		const merged = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					backlog: [createCard("old01", { title: "renamed locally" })],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({ backlog: [createCard("old01")], trash: [createCard("rev01")] }),
			}),
		);
		expect(describeColumns(merged.reconciledBoard)).toEqual([
			["backlog", ["old01"]],
			["in_progress", []],
			["review", []],
			["trash", ["rev01"]],
		]);
		expect(merged.reconciledBoard.columns[0]?.cards[0]?.title).toBe("renamed locally");
		expect(merged.reconciledBoardContainsLocalChangesNotYetPersistedByRuntime).toBe(true);
		expect(merged.conflictingLocalUnsavedChangesWereDiscarded).toBe(false);
	});

	it("远端另有变化时，本地新卡以本地版本、本地位置并回（即便远端已有它的初版）", () => {
		const merged = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					backlog: [createCard("old01"), createCard("new02")],
					in_progress: [createCard("new01")],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({
					backlog: [createCard("new01"), createCard("old01")],
					trash: [createCard("rev01")],
				}),
			}),
		);
		expect(describeColumns(merged.reconciledBoard)).toEqual([
			["backlog", ["old01", "new02"]],
			["in_progress", ["new01"]],
			["review", []],
			["trash", ["rev01"]],
		]);
		expect(merged.reconciledBoardContainsLocalChangesNotYetPersistedByRuntime).toBe(true);
		expect(merged.conflictingLocalUnsavedChangesWereDiscarded).toBe(false);
	});

	it("双方把同一张卡的同一个面改成不同的值：远端为准，并报告本地改动被丢弃", () => {
		const remoteBoard = createBoard({
			backlog: [createCard("old01", { title: "renamed on another device" })],
			review: [createCard("rev01")],
		});
		const reconciliation = reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
			boardLastAcknowledgedByRuntime: baseBoard,
			localBoard: createBoard({
				backlog: [createCard("old01", { title: "renamed locally" })],
				review: [createCard("rev01")],
			}),
			remoteBoard,
		});
		const merged = expectMerged(reconciliation);
		expect(merged.reconciledBoard).toEqual(remoteBoard);
		expect(merged.conflictingLocalUnsavedChangesWereDiscarded).toBe(true);
	});

	it("远端删掉了本地改过的卡：以远端为准并报告丢弃；本地删掉、远端没动过的卡照删", () => {
		const remoteDeletedLocallyEdited = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({
					backlog: [createCard("old01", { title: "renamed locally" })],
					review: [createCard("rev01")],
				}),
				remoteBoard: createBoard({ review: [createCard("rev01")] }),
			}),
		);
		expect(describeColumns(remoteDeletedLocallyEdited.reconciledBoard)[0]).toEqual(["backlog", []]);
		expect(remoteDeletedLocallyEdited.conflictingLocalUnsavedChangesWereDiscarded).toBe(true);

		const locallyDeletedRemoteUntouched = expectMerged(
			reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
				boardLastAcknowledgedByRuntime: baseBoard,
				localBoard: createBoard({ review: [createCard("rev01")] }),
				remoteBoard: createBoard({
					backlog: [createCard("old01"), createCard("oth01")],
					review: [createCard("rev01")],
				}),
			}),
		);
		expect(describeColumns(locallyDeletedRemoteUntouched.reconciledBoard)[0]).toEqual(["backlog", ["oth01"]]);
		expect(locallyDeletedRemoteUntouched.conflictingLocalUnsavedChangesWereDiscarded).toBe(false);
	});
});
