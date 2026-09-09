import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimeBoardData } from "../core/api-contract";

export { INDEPENDENT_TASKS_WORKSPACE_ID } from "../core/api-contract";

export function getIndependentTasksWorkspacePath(): string {
	return join(homedir(), ".cline", "kanban", "independent-task-workspaces");
}

export function isIndependentTasksWorkspacePath(path: string): boolean {
	return resolve(path) === getIndependentTasksWorkspacePath();
}

export function isInsideIndependentTaskWorkspaces(path: string): boolean {
	const pathWithinRoot = relative(getIndependentTasksWorkspacePath(), resolve(path));
	return pathWithinRoot === "" || (!pathWithinRoot.startsWith("..") && !isAbsolute(pathWithinRoot));
}

export function getIndependentTaskDirectoryPath(taskId: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
		throw new Error("Invalid independent task ID.");
	}
	return join(getIndependentTasksWorkspacePath(), taskId);
}

async function verifyIndependentTasksRootDirectory(): Promise<string> {
	const rootDirectoryPath = getIndependentTasksWorkspacePath();
	const rootStat = await lstat(rootDirectoryPath);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
		throw new Error("Independent task workspace root is not an owned directory.");
	const [actualRoot, actualParent] = await Promise.all([
		realpath(rootDirectoryPath),
		realpath(dirname(rootDirectoryPath)),
	]);
	if (dirname(actualRoot) !== actualParent)
		throw new Error("Independent task workspace root is not an owned directory.");
	return actualRoot;
}

export async function verifyIndependentTaskDirectory(taskId: string): Promise<string> {
	const directoryPath = getIndependentTaskDirectoryPath(taskId);
	const rootPath = await verifyIndependentTasksRootDirectory();
	const directoryStat = await lstat(directoryPath);
	if (
		!directoryStat.isDirectory() ||
		directoryStat.isSymbolicLink() ||
		dirname(await realpath(directoryPath)) !== rootPath
	) {
		throw new Error("Independent task workspace is not an owned directory.");
	}
	return directoryPath;
}

export async function createIndependentTaskDirectoriesForNewCards(
	previousBoard: RuntimeBoardData,
	nextBoard: RuntimeBoardData,
): Promise<void> {
	const existingTaskIds = new Set(previousBoard.columns.flatMap((column) => column.cards.map((card) => card.id)));
	const nextTaskIds = new Set(nextBoard.columns.flatMap((column) => column.cards.map((card) => card.id)));
	if ([...existingTaskIds].some((taskId) => !nextTaskIds.has(taskId))) {
		throw new Error("独立任务必须通过永久删除操作清理，不能通过整份看板保存移除。");
	}
	for (const column of nextBoard.columns) {
		for (const card of column.cards) {
			// 所有写入入口在持有看板锁时统一归一，浏览器不能把普通目录切成仓库工作流。
			card.baseRef = "";
			card.worktreeMode = "independent_directory";
			card.autoReviewEnabled = false;
			if (existingTaskIds.has(card.id)) continue;
			await mkdir(getIndependentTasksWorkspacePath(), { recursive: true });
			await verifyIndependentTasksRootDirectory();
			await mkdir(getIndependentTaskDirectoryPath(card.id), { recursive: true });
			await verifyIndependentTaskDirectory(card.id);
		}
	}
}

export async function deleteIndependentTaskDirectory(taskId: string): Promise<boolean> {
	try {
		const directoryPath = await verifyIndependentTaskDirectory(taskId);
		await rm(directoryPath, { recursive: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
