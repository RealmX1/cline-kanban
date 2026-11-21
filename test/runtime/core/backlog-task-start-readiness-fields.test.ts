import { describe, expect, it } from "vitest";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import { addTaskToColumn, updateTask } from "../../../src/core/task-board-mutations";
import { buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch } from "../../../src/core/task-card-field-patch-resolution";

describe("Backlog 开启条件的创建与三态更新", () => {
	it("保留开启条件，并支持省略保留、空值清除", () => {
		const board = { columns: [{ id: "backlog" as const, title: "Backlog", cards: [] }] };
		const created = addTaskToColumn(
			board,
			"backlog",
			{
				prompt: "实现剩余工作",
				baseRef: "main",
				backlogTaskStartReadinessConditionsText: "  依赖合入后  ",
			},
			() => "aaaaabbbbbccccc",
		);
		expect(runtimeBoardCardSchema.parse(created.task).backlogTaskStartReadinessConditionsText).toBe("依赖合入后");
		const preserved = updateTask(
			created.board,
			created.task.id,
			buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(created.task, { title: "新名称" }),
		);
		expect(preserved.task?.backlogTaskStartReadinessConditionsText).toBe("依赖合入后");
		const cleared = updateTask(
			created.board,
			created.task.id,
			buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(created.task, {
				backlogTaskStartReadinessConditionsText: null,
			}),
		);
		expect(cleared.task?.backlogTaskStartReadinessConditionsText).toBeUndefined();
	});
});
