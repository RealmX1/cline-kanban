import { describe, expect, it } from "vitest";
import { runtimeBoardDataSchema } from "../../../src/core/api-contract";
import { preserveRuntimeOwnedTaskClosureState } from "../../../src/core/task-closure-protected-board-state";

describe("旧整板保存的结案保护", () => {
	it("不能移入已结案、重开、删卡或覆盖服务端操作进度", () => {
		const card = {
			id: "task",
			title: "任务",
			prompt: "需求",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
			taskClosureOperationProgress: {
				closureRequestId: "11111111-1111-4111-8111-111111111111",
				phase: "preserving",
				attemptCount: 1,
				lastError: null,
				recoveryCondition: null,
				nextRetryAtEpochMs: null,
			},
		};
		const original = runtimeBoardDataSchema.parse({
			columns: [
				{ id: "review", title: "Review", cards: [card] },
				{ id: "trash", title: "Done", cards: [] },
			],
		});
		const malicious = runtimeBoardDataSchema.parse({
			columns: [
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [{ ...card, taskClosureOperationProgress: undefined }] },
			],
		});
		const guarded = preserveRuntimeOwnedTaskClosureState(original, malicious);
		expect(guarded.columns[0]?.cards[0]?.taskClosureOperationProgress?.phase).toBe("preserving");
		expect(guarded.columns[1]?.cards).toEqual([]);
		expect(guarded.columns[1]?.title).toBe("已结案");
		const reopened = preserveRuntimeOwnedTaskClosureState(malicious, original);
		expect(reopened.columns[1]?.cards[0]?.id).toBe("task");
		expect(reopened.columns[0]?.cards).toEqual([]);
	});
});
