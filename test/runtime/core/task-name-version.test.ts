import { describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { updateTask } from "../../../src/core/task-board-mutations";
import { preserveTaskNameVersionsAgainstIncomingBoardSnapshot } from "../../../src/core/task-name-version";

const board = (): RuntimeBoardData => ({
	columns: [
		{
			id: "backlog",
			title: "待办",
			cards: [
				{
					id: "abcde",
					startInPlanMode: false,
					title: "原名称",
					prompt: "正文",
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
					taskNameVersion: 2,
				},
			],
		},
	],
});
describe("任务名称版本保护", () => {
	it("改名后再改回原名仍递增版本，旧页面整板保存不能倒退", () => {
		const original = board();
		const renamed = updateTask(original, "abcde", { prompt: "正文", baseRef: "main", title: "人工名称" }).board;
		const restored = updateTask(renamed, "abcde", { prompt: "正文", baseRef: "main", title: "原名称" }).board;
		expect(restored.columns[0]?.cards[0]?.taskNameVersion).toBe(4);
		const merged = preserveTaskNameVersionsAgainstIncomingBoardSnapshot(restored, original);
		expect(merged.columns[0]?.cards[0]?.taskNameVersion).toBe(4);
	});
	it("旧页面实际改名推进版本，同 ID 新 incarnation 不借用旧版本", () => {
		const original = board();
		const incoming = board();
		const card = incoming.columns[0]?.cards[0];
		if (!card) throw new Error("缺少测试卡片");
		card.title = "新名称";
		card.taskNameVersion = undefined;
		expect(
			preserveTaskNameVersionsAgainstIncomingBoardSnapshot(original, incoming).columns[0]?.cards[0]?.taskNameVersion,
		).toBe(3);
		card.createdAt = 2;
		expect(
			preserveTaskNameVersionsAgainstIncomingBoardSnapshot(original, incoming).columns[0]?.cards[0]?.taskNameVersion,
		).toBeUndefined();
	});
});
