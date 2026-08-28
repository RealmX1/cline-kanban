import type { RuntimeAllProjectsTaskSearchIndexResponse, RuntimeBoardData } from "../core/api-contract";

/** 每个注册项目的原始输入：projectId + 展示名 + 已加载的 board（加载失败为 null，将被跳过）。 */
export interface AllProjectsTaskSearchIndexProjectInput {
	projectId: string;
	projectName: string;
	board: RuntimeBoardData | null;
}

/**
 * 把「各项目的 board」投影为跨项目任务搜索索引响应（镜像 in-progress-task-detail-projection 的纯函数模式）。
 *
 * - board 为 null（读盘失败）的项目整体跳过；
 * - 遍历全部列（含 trash/Done），逐卡输出匹配字段（taskId / title / prompt / columnId）加结果行排序与展示
 *   所需的卡片级持久事实（createdAt / updatedAt / agentId / mostRecentlyLaunchedAgentSessionAgentId）；
 *   title 缺省归一为空串，两个 agent 字段的 undefined 归一为 null（契约是 nullable 而非 optional）。
 *
 * 纯函数：无 I/O、无闭包状态，可独立单测。
 */
export function projectAllProjectsTaskSearchIndex(
	projects: ReadonlyArray<AllProjectsTaskSearchIndexProjectInput>,
): RuntimeAllProjectsTaskSearchIndexResponse {
	const projectEntries: RuntimeAllProjectsTaskSearchIndexResponse["projects"] = [];
	for (const project of projects) {
		if (!project.board) {
			continue;
		}
		const tasks: RuntimeAllProjectsTaskSearchIndexResponse["projects"][number]["tasks"] = [];
		for (const column of project.board.columns) {
			for (const card of column.cards) {
				tasks.push({
					taskId: card.id,
					title: card.title ?? "",
					prompt: card.prompt,
					columnId: column.id,
					createdAt: card.createdAt,
					updatedAt: card.updatedAt,
					agentId: card.agentId ?? null,
					mostRecentlyLaunchedAgentSessionAgentId: card.mostRecentlyLaunchedAgentSessionAgentId ?? null,
				});
			}
		}
		projectEntries.push({
			projectId: project.projectId,
			projectName: project.projectName,
			tasks,
		});
	}
	return { projects: projectEntries };
}
