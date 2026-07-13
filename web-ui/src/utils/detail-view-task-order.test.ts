import { describe, expect, it } from "vitest";

import {
	getNextDetailTaskIdAfterTrashMove,
	getNextReviewTaskIdAfterReviewTaskMovesToValidation,
	isDetailViewColumnId,
} from "@/utils/detail-view-task-order";

function createTask(taskId: string) {
	return {
		id: taskId,
		title: taskId,
		prompt: "",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("isDetailViewColumnId", () => {
	it("returns true only for in-progress and review columns", () => {
		expect(isDetailViewColumnId("in_progress")).toBe(true);
		expect(isDetailViewColumnId("review")).toBe(true);
		expect(isDetailViewColumnId("backlog")).toBe(false);
		expect(isDetailViewColumnId("trash")).toBe(false);
	});
});

describe("getNextDetailTaskIdAfterTrashMove", () => {
	it("prefers the next detail task when available", () => {
		const nextTaskId = getNextDetailTaskIdAfterTrashMove(
			{
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "b1",
								title: "b1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{
						id: "in_progress",
						title: "In Progress",
						cards: [
							{
								id: "i1",
								title: "i1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
							{
								id: "i2",
								title: "i2",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: "r1",
								title: "r1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"i1",
		);

		expect(nextTaskId).toBe("i2");
	});

	it("falls back to previous detail task when removing the last detail task", () => {
		const nextTaskId = getNextDetailTaskIdAfterTrashMove(
			{
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{
						id: "in_progress",
						title: "In Progress",
						cards: [
							{
								id: "i1",
								title: "i1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: "r1",
								title: "r1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"r1",
		);

		expect(nextTaskId).toBe("i1");
	});

	it("returns first detail task when target task is not in detail columns", () => {
		const nextTaskId = getNextDetailTaskIdAfterTrashMove(
			{
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "b1",
								title: "b1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{
						id: "in_progress",
						title: "In Progress",
						cards: [
							{
								id: "i1",
								title: "i1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: "r1",
								title: "r1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"b1",
		);

		expect(nextTaskId).toBe("i1");
	});

	it("returns null when there are no detail tasks", () => {
		const nextTaskId = getNextDetailTaskIdAfterTrashMove(
			{
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "b1",
								title: "b1",
								prompt: "",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"b1",
		);

		expect(nextTaskId).toBeNull();
	});
});

describe("getNextReviewTaskIdAfterReviewTaskMovesToValidation", () => {
	it("prefers the following review task", () => {
		const nextTaskId = getNextReviewTaskIdAfterReviewTaskMovesToValidation(
			{
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [createTask("r1"), createTask("r2"), createTask("r3")] },
					{ id: "validation", title: "Validation", cards: [] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"r2",
		);

		expect(nextTaskId).toBe("r3");
	});

	it("falls back to the previous review task when moving the last review task", () => {
		const nextTaskId = getNextReviewTaskIdAfterReviewTaskMovesToValidation(
			{
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [createTask("r1"), createTask("r2")] },
					{ id: "validation", title: "Validation", cards: [] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"r2",
		);

		expect(nextTaskId).toBe("r1");
	});

	it("returns null when the moved task is the only review task", () => {
		const nextTaskId = getNextReviewTaskIdAfterReviewTaskMovesToValidation(
			{
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [createTask("r1")] },
					{ id: "validation", title: "Validation", cards: [] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"r1",
		);

		expect(nextTaskId).toBeNull();
	});

	it("returns null when the task is not in review", () => {
		const nextTaskId = getNextReviewTaskIdAfterReviewTaskMovesToValidation(
			{
				columns: [
					{ id: "backlog", title: "Backlog", cards: [createTask("b1")] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [createTask("r1")] },
					{ id: "validation", title: "Validation", cards: [] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [],
			},
			"b1",
		);

		expect(nextTaskId).toBeNull();
	});
});
