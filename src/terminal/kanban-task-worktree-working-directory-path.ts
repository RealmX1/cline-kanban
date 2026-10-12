import { getTaskWorktreesHomePath } from "../state/workspace-state";

// 这个工作目录是否落在 kanban 自己创建的 task worktree 之下（`~/.cline/worktrees/<task>/<repo>`）。
//
// 用途：决定能不能**替用户**信任这个工作区（Claude 自动按下 trust、Cursor 传 `--trust`）。worktree 是 kanban
// 从用户自己的仓库检出来的，信任它与信任源仓库等价；inplace 任务 / 主仓库 / home agent 的 cwd 则是用户的任意
// 目录，一律不替用户做主，交给 agent 自己的信任对话框。
export function isKanbanTaskWorktreeWorkingDirectoryPath(workingDirectoryPath: string): boolean {
	const worktreesRoot = `${getTaskWorktreesHomePath().replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	const normalizedPath = `${workingDirectoryPath.replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	if (process.platform === "win32") {
		return normalizedPath.toLowerCase().startsWith(worktreesRoot.toLowerCase());
	}
	return normalizedPath.startsWith(worktreesRoot);
}
