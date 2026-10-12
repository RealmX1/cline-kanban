import { describe, expect, it } from "vitest";

import { runtimeBoardDataSchema } from "../../../src/core/api-contract";

// dd2db 1a：任务连线（board.dependencies）/ 完成后自动启动机制已整体退役、不做向后兼容。
// 旧盘 board.json 仍可能带 `dependencies` 键：schema 非 strict，读入时静默剥离、不得抛错。
describe("runtimeBoardDataSchema 对已退役 dependencies 键的处理", () => {
	it("带 dependencies 键的旧 board 能正常解析，且解析结果里不再出现该键", () => {
		const legacyBoardFileContents = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "wait1",
							title: "waits for rev01",
							prompt: "waits for rev01",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1_000,
							updatedAt: 1_000,
						},
					],
				},
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [{ id: "dep01", fromTaskId: "wait1", toTaskId: "rev01", createdAt: 2_000 }],
		};

		const parsed = runtimeBoardDataSchema.safeParse(legacyBoardFileContents);

		expect(parsed.success).toBe(true);
		expect(parsed.data).not.toHaveProperty("dependencies");
		expect(parsed.data?.columns[0]?.cards.map((card) => card.id)).toEqual(["wait1"]);
	});
});
