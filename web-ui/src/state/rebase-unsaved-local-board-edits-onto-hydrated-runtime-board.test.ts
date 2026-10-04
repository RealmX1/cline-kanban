import { describe, expect, it } from "vitest";

import { rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard } from "@/state/rebase-unsaved-local-board-edits-onto-hydrated-runtime-board";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// 回灌时的三方合并：默认服务端赢，只带回未落盘的本地新建卡与列内重排。

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function board(cardsByColumn: Partial<Record<BoardColumnId, BoardCard[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return { columns: columnIds.map((id) => ({ id, title: id, cards: cardsByColumn[id] ?? [] })) };
}

function columnTaskIds(target: BoardData, columnId: BoardColumnId): string[] {
	return target.columns.find((column) => column.id === columnId)?.cards.map((entry) => entry.id) ?? [];
}

describe("rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard", () => {
	it("本地没有未保存编辑（或没有共同祖先）时原样返回服务端那份", () => {
		const ancestor = board({ review: [card("a")] });
		const hydrated = board({ trash: [card("a")] });
		expect(
			rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
				boardLastConfirmedPersistedByRuntime: ancestor,
				localBoard: ancestor,
				hydratedRuntimeBoard: hydrated,
			}),
		).toBe(hydrated);
		expect(
			rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
				boardLastConfirmedPersistedByRuntime: null,
				localBoard: board({ backlog: [card("new")] }),
				hydratedRuntimeBoard: hydrated,
			}),
		).toBe(hydrated);
	});

	it("未落盘的本地新建卡被带回；服务端的移列以服务端为准", () => {
		const ancestor = board({ backlog: [card("b")], review: [card("a")] });
		const local = board({ backlog: [card("new"), card("b")], review: [card("a")] });
		const hydrated = board({ backlog: [card("b")], trash: [card("a")] });
		const rebased = rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
			boardLastConfirmedPersistedByRuntime: ancestor,
			localBoard: local,
			hydratedRuntimeBoard: hydrated,
		});
		expect(columnTaskIds(rebased, "backlog")).toEqual(["new", "b"]);
		expect(columnTaskIds(rebased, "trash")).toEqual(["a"]);
		expect(columnTaskIds(rebased, "review")).toEqual([]);
	});

	it("服务端删掉的卡不会被当成本地新建卡复活", () => {
		const ancestor = board({ review: [card("a")] });
		const local = board({ review: [card("a")], backlog: [card("new")] });
		const hydrated = board({});
		const rebased = rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
			boardLastConfirmedPersistedByRuntime: ancestor,
			localBoard: local,
			hydratedRuntimeBoard: hydrated,
		});
		expect(columnTaskIds(rebased, "review")).toEqual([]);
		expect(columnTaskIds(rebased, "backlog")).toEqual(["new"]);
	});

	it("列内重排：服务端该列成员不变时沿用本地顺序，成员变了就以服务端为准", () => {
		const ancestor = board({ backlog: [card("a"), card("b"), card("c")] });
		const local = board({ backlog: [card("c"), card("a"), card("b")] });
		const unchangedMembers = board({ backlog: [card("a"), card("b", { title: "server" }), card("c")] });
		const rebased = rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
			boardLastConfirmedPersistedByRuntime: ancestor,
			localBoard: local,
			hydratedRuntimeBoard: unchangedMembers,
		});
		expect(columnTaskIds(rebased, "backlog")).toEqual(["c", "a", "b"]);
		// 字段仍取服务端那份。
		expect(rebased.columns[0]?.cards[2]?.title).toBe("server");
		const membersChanged = board({ backlog: [card("a"), card("b")], in_progress: [card("c")] });
		expect(
			columnTaskIds(
				rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
					boardLastConfirmedPersistedByRuntime: ancestor,
					localBoard: local,
					hydratedRuntimeBoard: membersChanged,
				}),
				"backlog",
			),
		).toEqual(["a", "b"]);
	});

	it("列内重排：服务端也重排过该列时保留服务端顺序，不让随后的整板保存覆盖已落盘的顺序", () => {
		const ancestor = board({ in_progress: [card("a"), card("b"), card("c")] });
		const local = board({ in_progress: [card("c"), card("a"), card("b")] });
		const hydratedReorderedByRuntime = board({ in_progress: [card("b"), card("a"), card("c")] });
		const rebased = rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
			boardLastConfirmedPersistedByRuntime: ancestor,
			localBoard: local,
			hydratedRuntimeBoard: hydratedReorderedByRuntime,
		});
		expect(columnTaskIds(rebased, "in_progress")).toEqual(["b", "a", "c"]);
		// 没有可带回的编辑：原样返回服务端那份的引用，调用方据此判断无需再保存。
		expect(rebased).toBe(hydratedReorderedByRuntime);
	});

	it("列内重排：服务端只动了别的列时，这一列仍沿用本地顺序", () => {
		const ancestor = board({ in_progress: [card("a"), card("b"), card("c")] });
		const local = board({ in_progress: [card("c"), card("a"), card("b")] });
		const hydratedWithOtherColumnChanged = board({
			in_progress: [card("a"), card("b"), card("c")],
			review: [card("z")],
		});
		const rebased = rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard({
			boardLastConfirmedPersistedByRuntime: ancestor,
			localBoard: local,
			hydratedRuntimeBoard: hydratedWithOtherColumnChanged,
		});
		expect(columnTaskIds(rebased, "in_progress")).toEqual(["c", "a", "b"]);
		expect(columnTaskIds(rebased, "review")).toEqual(["z"]);
	});
});
