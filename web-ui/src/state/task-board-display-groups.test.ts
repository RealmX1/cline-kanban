import type { DropResult } from "@hello-pangea/dnd";
import { describe, expect, it } from "vitest";
import { buildTaskCardBusinessProps } from "@/components/task-card-business-props";
import { normalizeBoardData, resolveTaskCardDropFromDragResultByTaskId } from "@/state/board-state";
import { projectTaskBoardDisplayGroups } from "@/state/task-board-display-groups";
import { collectTasksPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const stages: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
const card = (id: string, isShelved = false, lastChangedAt = 1): BoardCard => ({
	id,
	title: id,
	prompt: id,
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
	...(isShelved ? { taskShelvingState: { isShelved, lastChangedAt }, pinnedToTaskPinboardAt: 1 } : {}),
});
const board = (): BoardData => ({
	columns: stages.map((id, index) => ({ id, title: id, cards: [card(id, true, index + 1), card(`active-${id}`)] })),
});
function drop(taskId: string, source: string, destination: string, index = 0): DropResult {
	return {
		draggableId: taskId,
		type: "CARD",
		source: { droppableId: source, index: 0 },
		destination: { droppableId: destination, index },
		reason: "DROP",
		mode: "FLUID",
		combine: null,
	};
}

describe("真实 Stage 与 Shelved 展示分组", () => {
	it("五个 Stage 的搁置卡只在最后一组出现，保留完整持久看板和置顶意图", () => {
		const original = board();
		const groups = projectTaskBoardDisplayGroups(original.columns);
		expect(groups.map((group) => group.id)).toEqual([...stages, "shelved"]);
		expect(groups.at(-1)?.cards.map((task) => task.id)).toEqual([...stages].reverse());
		expect(groups.slice(0, 5).flatMap((group) => group.cards.map((task) => task.id))).toEqual(
			stages.map((stage) => `active-${stage}`),
		);
		expect(original.columns.every((column) => column.cards.length === 2)).toBe(true);
		expect(collectTasksPinnedToTaskPinboard(original)).toEqual([]);
		expect(normalizeBoardData(original)?.columns[0]?.cards[0]?.taskShelvingState).toEqual({
			isShelved: true,
			lastChangedAt: 1,
		});
	});
	it.each(stages)("搁置 %s 卡拖回原 Stage 仅取消搁置", (stage) => {
		expect(resolveTaskCardDropFromDragResultByTaskId(board(), drop(stage, "shelved", stage))).toEqual({
			taskCardDropKind: "task_card_shelving_state_changed",
			taskId: stage,
			isShelved: false,
		});
	});
	it("拖入 Shelved、组内不排序，搁置 Backlog 可拖到 In Progress 启动", () => {
		expect(
			resolveTaskCardDropFromDragResultByTaskId(board(), drop("active-review", "review", "shelved")),
		).toMatchObject({ taskCardDropKind: "task_card_shelving_state_changed", isShelved: true });
		expect(resolveTaskCardDropFromDragResultByTaskId(board(), drop("review", "shelved", "shelved", 2))).toEqual({
			taskCardDropKind: "no_effective_task_card_drop",
		});
		expect(
			resolveTaskCardDropFromDragResultByTaskId(board(), drop("backlog", "shelved", "in_progress")),
		).toMatchObject({
			taskCardDropKind: "task_card_moved_between_board_columns",
			fromColumnId: "backlog",
			toColumnId: "in_progress",
		});
		expect(resolveTaskCardDropFromDragResultByTaskId(board(), drop("review", "shelved", "validation"))).toEqual({
			taskCardDropKind: "no_effective_task_card_drop",
		});
	});
	it("显示索引绕过隐藏卡，按任务 ID 和可见目标锚点定位", () => {
		const original = board();
		original.columns[1]?.cards.push(card("second-active"));
		expect(
			resolveTaskCardDropFromDragResultByTaskId(original, drop("active-review", "review", "validation")),
		).toMatchObject({ taskId: "active-review", destinationIndex: 1 });
		expect(
			resolveTaskCardDropFromDragResultByTaskId(original, drop("second-active", "in_progress", "in_progress")),
		).toMatchObject({ taskId: "second-active", destinationIndex: 1 });
	});
	it("Shelved 卡片动作按原 Stage 判断，仅保留 Backlog 的单独启动", () => {
		const action = () => {};
		for (const stage of stages) {
			const props = buildTaskCardBusinessProps({
				card: card(stage, true),
				columnId: stage,
				handlers: {
					onStartTask: action,
					onMoveToReviewTask: action,
					onMoveToValidationTask: action,
					onRestoreFromTrashTask: action,
					onMoveToTrashTask: action,
				},
			});
			expect(props.onStart).toBe(stage === "backlog" ? action : undefined);
			expect(props.onMoveToReview).toBeUndefined();
			expect(props.onMoveToValidation).toBeUndefined();
			expect(props.onRestoreFromTrash).toBeUndefined();
			expect(props.onMoveToTrash).toBeUndefined();
		}
	});
});
