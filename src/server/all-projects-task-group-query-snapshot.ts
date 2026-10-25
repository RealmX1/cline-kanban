import pLimit from "p-limit";
import type {
	RuntimeAllProjectsTaskGroupQuerySnapshot,
	RuntimeCrossProjectTaskSwitcherEntry,
} from "../core/api-contract";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";

// 跨请求共享读取预算，避免多个监控进程同时放大项目数带来的 I/O。
const taskGroupSnapshotProjectReadLimiter = pLimit(8);

export async function collectAllProjectsTaskGroupQuerySnapshot(input: {
	recentDays: 7 | 30;
	nowMs: number;
	projects: readonly { workspaceId: string; repoPath: string }[];
	loadEntries: (
		workspaceId: string,
		nowMs: number,
		activityHorizonMs: number,
	) => Promise<RuntimeCrossProjectTaskSwitcherEntry[]>;
}): Promise<RuntimeAllProjectsTaskGroupQuerySnapshot> {
	const projects = await Promise.all(
		input.projects.map((project) =>
			taskGroupSnapshotProjectReadLimiter(async () => {
				const identity = {
					workspaceId: project.workspaceId,
					projectName: deriveProjectDisplayNameFromRepoPath(project.repoPath),
					projectPath: project.repoPath,
				};
				try {
					return {
						...identity,
						taskEntriesReadStatus: "complete" as const,
						crossProjectTaskSwitcherEntries: await input.loadEntries(
							project.workspaceId,
							input.nowMs,
							input.recentDays * 24 * 60 * 60_000,
						),
					};
				} catch (error) {
					return {
						...identity,
						taskEntriesReadStatus: "unavailable" as const,
						unavailableReason: error instanceof Error ? error.message || error.name : String(error),
						crossProjectTaskSwitcherEntries: [],
					};
				}
			}),
		),
	);
	return { observedAtMs: input.nowMs, recentDays: input.recentDays, projects };
}
