import pLimit from "p-limit";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";

interface ProjectAssignmentTitleExample {
	title: string;
	updatedAt: number;
	columnId: string;
}
export interface ProjectAssignmentContextProject {
	workspaceId: string;
	name: string;
	repositoryPath: string;
	titleExamples: readonly ProjectAssignmentTitleExample[];
}
export const PROJECT_ASSIGNMENT_TITLE_EXAMPLES_TOTAL_CHARACTER_BUDGET = 12_000;

/** 完整项目目录永不裁剪，只减少标题示例；不接受任务正文、会话或通知材料。 */
export function buildProjectAssignmentLightweightContext(
	projects: readonly ProjectAssignmentContextProject[],
	queryText: string,
) {
	const words = [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(queryText.slice(0, 20_000))]
		.filter((segment) => segment.isWordLike && segment.segment.length > 1)
		.map((segment) => segment.segment.toLowerCase());
	const queryWords = [...new Set(words)];
	const result = [...projects]
		.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
		.map((project) => ({
			workspaceId: project.workspaceId,
			name: project.name,
			repositoryPath: project.repositoryPath,
			titleExamples: [] as string[],
		}));
	const selectedTitles = new Map(
		projects.map((project) => [
			project.workspaceId,
			project.titleExamples
				.filter((example) => example.columnId !== "trash" && example.title.trim())
				.map((example) => ({
					...example,
					score: queryWords.filter((word) => example.title.toLowerCase().includes(word)).length,
				}))
				.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
				.slice(0, 3)
				.map((example) => [...example.title].slice(0, 120).join("")),
		]),
	);
	let remainingCharacters = PROJECT_ASSIGNMENT_TITLE_EXAMPLES_TOTAL_CHARACTER_BUDGET;
	// 轮流分配示例，避免前几个大项目吃完整个预算。
	for (let index = 0; index < 3; index++)
		for (const project of result) {
			const title = selectedTitles.get(project.workspaceId)?.[index];
			if (!title) continue;
			const characterCount = JSON.stringify(title).length + 1;
			if (characterCount > remainingCharacters) continue;
			project.titleExamples.push(title);
			remainingCharacters -= characterCount;
		}
	return result;
}

/** 只读注册目录及看板标题，不触及重型 recap、通知归档或会话历史。 */
export async function collectProjectAssignmentLightweightContext(queryText: string) {
	const readBoard = pLimit(4);
	const projects = await listWorkspaceIndexEntries();
	const contextCompleteness: string[] = [];
	const material = await Promise.all(
		projects.map((project) =>
			readBoard(async () => {
				const titleExamples: ProjectAssignmentTitleExample[] = [];
				try {
					const board = await loadWorkspaceBoardById(project.workspaceId);
					for (const column of board.columns)
						if (column.id !== "trash")
							for (const card of column.cards)
								titleExamples.push({ title: card.title ?? "", updatedAt: card.updatedAt, columnId: column.id });
				} catch {
					contextCompleteness.push(`${project.workspaceId}:task_titles_unavailable`);
				}
				return {
					workspaceId: project.workspaceId,
					name: deriveProjectDisplayNameFromRepoPath(project.repoPath),
					repositoryPath: project.repoPath,
					titleExamples,
				};
			}),
		),
	);
	return { projects: buildProjectAssignmentLightweightContext(material, queryText), contextCompleteness };
}
