import { expect, it } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { preserveBacklogTaskStartReadinessAgainstClientBoardSnapshot } from "../../../src/core/backlog-task-start-readiness-protected-board-state";

it("旧客户端不能绕过复核移出 Backlog 或清除服务端复核记录", () => {
	const card = {
		id: "card1",
		title: "任务",
		prompt: "原始需求",
		startInPlanMode: true,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		backlogTaskStartReadinessConditionsText: "依赖合入后",
		backlogTaskStartReadinessReview: {
			operationId: "11111111-1111-4111-8111-111111111111",
			phase: "reviewing" as const,
			summary: "启动前复核",
			updatedAtEpochMs: 2,
		},
	};
	const prior: RuntimeBoardData = {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [card] },
			{ id: "in_progress", title: "进行中", cards: [] },
		],
	};
	const incoming: RuntimeBoardData = {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "进行中", cards: [{ ...card, backlogTaskStartReadinessReview: undefined }] },
		],
	};
	const preserved = preserveBacklogTaskStartReadinessAgainstClientBoardSnapshot(prior, incoming);
	expect(preserved.columns[0]?.cards[0]?.backlogTaskStartReadinessReview?.phase).toBe("reviewing");
	expect(preserved.columns[1]?.cards).toEqual([]);
});
