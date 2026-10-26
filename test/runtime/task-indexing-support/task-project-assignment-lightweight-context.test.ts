import { describe, expect, it } from "vitest";
import {
	buildProjectAssignmentLightweightContext,
	PROJECT_ASSIGNMENT_TITLE_EXAMPLES_TOTAL_CHARACTER_BUDGET,
} from "../../../src/task-indexing-support/task-project-assignment-lightweight-context";

describe("项目归属轻量 Context", () => {
	it("相关标题优先，无匹配时按最近时间补足，排除 Trash", () => {
		const result = buildProjectAssignmentLightweightContext(
			[
				{
					workspaceId: "project",
					name: "项目",
					repositoryPath: "/repo",
					titleExamples: [
						{ title: "无关任务", updatedAt: 9, columnId: "backlog" },
						{ title: "修复 OAuth 登录", updatedAt: 1, columnId: "review" },
						{ title: "OAuth Trash", updatedAt: 10, columnId: "trash" },
						{ title: "最近任务", updatedAt: 8, columnId: "backlog" },
						{ title: "较早任务", updatedAt: 7, columnId: "backlog" },
					],
				},
			],
			"OAuth 登录回调故障",
		);
		expect(result[0]?.titleExamples).toEqual(["修复 OAuth 登录", "无关任务", "最近任务"]);
	});
	it("完整项目目录保留，标题单条及总预算受控，背景材料相较重 recap 减少至少 90%", () => {
		const projects = Array.from({ length: 100 }, (_, i) => ({
			workspaceId: `project-${i}`,
			name: `项目${i}`,
			repositoryPath: `/repositories/project-${i}`,
			titleExamples: Array.from({ length: 20 }, (_, j) => ({
				title: `标题 ${j} ${"中".repeat(200)}`,
				updatedAt: j,
				columnId: "backlog",
			})),
		}));
		const result = buildProjectAssignmentLightweightContext(projects, "无匹配");
		expect(result).toHaveLength(projects.length);
		expect(
			result.every(
				(project) =>
					project.titleExamples.length <= 3 && project.titleExamples.every((title) => [...title].length <= 120),
			),
		).toBe(true);
		expect(
			result
				.flatMap((project) => project.titleExamples)
				.reduce((count, title) => count + JSON.stringify(title).length + 1, 0),
		).toBeLessThanOrEqual(PROJECT_ASSIGNMENT_TITLE_EXAMPLES_TOTAL_CHARACTER_BUDGET);
		const formerBackground = projects.map((project) => ({
			...project,
			recaps: project.titleExamples.map(() => "正文、通知、会话摘要".repeat(1000)),
		}));
		expect(JSON.stringify(result).length / JSON.stringify(formerBackground).length).toBeLessThanOrEqual(0.1);
	});
	it("没有任务的项目也保留；无注册项目返回空列表", () => {
		expect(
			buildProjectAssignmentLightweightContext(
				[{ workspaceId: "empty", name: "空项目", repositoryPath: "/empty", titleExamples: [] }],
				"完整任务",
			),
		).toEqual([{ workspaceId: "empty", name: "空项目", repositoryPath: "/empty", titleExamples: [] }]);
		expect(buildProjectAssignmentLightweightContext([], "任务")).toEqual([]);
	});
});
