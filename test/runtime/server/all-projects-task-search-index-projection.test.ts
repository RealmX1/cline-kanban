import { describe, expect, it } from "vitest";

import {
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	runtimeAllProjectsTaskSearchIndexResponseSchema,
} from "../../../src/core/api-contract";
import { projectAllProjectsTaskSearchIndex } from "../../../src/server/all-projects-task-search-index-projection";

// 跨项目任务搜索索引的纯投影。不变量：board=null 的项目整体跳过；遍历全部列（含 trash/Done）逐卡输出
// { taskId, title, prompt, columnId }；title 缺省归一空串。纯函数测试，不启动 SDK host。

function makeCard(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		title: overrides.id,
		prompt: "p",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeBoard(columnToCards: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const allColumns: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: allColumns.map((id) => ({ id, title: id, cards: columnToCards[id] ?? [] })),
		dependencies: [],
	};
}

describe("projectAllProjectsTaskSearchIndex", () => {
	it("flattens tasks across projects, preserving project identity and column ownership", () => {
		const response = projectAllProjectsTaskSearchIndex([
			{
				projectId: "p1",
				projectName: "One",
				board: makeBoard({
					backlog: [makeCard({ id: "a", title: "Alpha", prompt: "first" })],
					review: [makeCard({ id: "b", title: "Beta", prompt: "second" })],
				}),
			},
			{
				projectId: "p2",
				projectName: "Two",
				board: makeBoard({ backlog: [makeCard({ id: "c", title: "Gamma", prompt: "third" })] }),
			},
		]);

		expect(response.projects).toHaveLength(2);
		expect(response.projects[0]).toEqual({
			projectId: "p1",
			projectName: "One",
			tasks: [
				{ taskId: "a", title: "Alpha", prompt: "first", columnId: "backlog" },
				{ taskId: "b", title: "Beta", prompt: "second", columnId: "review" },
			],
		});
		expect(response.projects[1]?.tasks.map((task) => task.taskId)).toEqual(["c"]);
	});

	it("skips projects whose board failed to load (null)", () => {
		const response = projectAllProjectsTaskSearchIndex([
			{ projectId: "ok", projectName: "OK", board: makeBoard({ backlog: [makeCard({ id: "a" })] }) },
			{ projectId: "broken", projectName: "Broken", board: null },
		]);

		expect(response.projects.map((project) => project.projectId)).toEqual(["ok"]);
	});

	it("includes tasks from the trash (Done) column", () => {
		const response = projectAllProjectsTaskSearchIndex([
			{
				projectId: "p",
				projectName: "P",
				board: makeBoard({ trash: [makeCard({ id: "d", title: "Done task", prompt: "archived" })] }),
			},
		]);

		expect(response.projects[0]?.tasks).toEqual([
			{ taskId: "d", title: "Done task", prompt: "archived", columnId: "trash" },
		]);
	});

	it("defaults a missing title to an empty string", () => {
		const response = projectAllProjectsTaskSearchIndex([
			{
				projectId: "p",
				projectName: "P",
				board: makeBoard({ backlog: [makeCard({ id: "a", title: undefined, prompt: "body" })] }),
			},
		]);

		expect(response.projects[0]?.tasks[0]?.title).toBe("");
	});
});

describe("runtimeAllProjectsTaskSearchIndexResponseSchema", () => {
	it("accepts a valid response and normalizes the legacy 'done' column id to 'trash'", () => {
		const parsed = runtimeAllProjectsTaskSearchIndexResponseSchema.parse({
			projects: [
				{
					projectId: "p",
					projectName: "P",
					tasks: [{ taskId: "a", title: "Alpha", prompt: "body", columnId: "done" }],
				},
			],
		});

		expect(parsed.projects[0]?.tasks[0]?.columnId).toBe("trash");
	});
});
