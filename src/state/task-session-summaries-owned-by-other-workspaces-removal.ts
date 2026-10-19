import { isAbsolute, join, relative, sep } from "node:path";

import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isHomeAgentSessionId, isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import { getWorkspaceFolderLabelForWorktreePath } from "../workspace/task-worktree-path";

// 一个 workspace 的 sessions.json 只该装它自己的会话（cf427）。
//
// 浏览器原地切项目时，App 级 sessions 曾不清空、新项目水合时又是合并，整板保存再把整份 sessions 发给 runtime，
// runtime 不校验归属照单全收——于是每个项目的 sessions.json 都混进了别的项目的会话（实测 27 个项目共 8428 条
// 外来任务会话、637 条外来侧边栏会话；外来条目在其属主那里都有副本）。它们让 sessions.json 膨胀到数 MB、随每次
// 整板广播发给所有客户端，重启水合时还会被装进错误项目的会话管理器。
//
// 只剔除**能确定**属于别的项目的条目，其余（含 null 路径、inplace 任务的仓库路径、判断不了的路径）一律保留：
//   - 侧边栏 agent 会话：会话 id 里编码了 workspaceId，与本项目不符；
//   - 任务会话：workspacePath 位于 task worktree 根下（`<根>/<taskId>/<仓库目录名>/…`），而仓库目录名不是本项目的。

export interface TaskSessionSummariesOwnedByOtherWorkspacesRemoval {
	sessionsWithoutSummariesOwnedByOtherWorkspaces: Record<string, RuntimeTaskSessionSummary>;
	removedTaskSessionIdsOwnedByOtherWorkspaces: string[];
}

// 判定「会话工作目录是否在 task worktree 根下」用到的 path 操作。默认是当前平台的 node:path；
// 测试注入 path.win32 来覆盖 Windows 跨盘符语义（posix 上 relative() 永远不会返回绝对路径）。
export type SessionWorkingDirectoryOwnershipPathOperations = {
	isAbsolute: typeof isAbsolute;
	join: typeof join;
	relative: typeof relative;
	sep: string;
};

const CURRENT_PLATFORM_SESSION_WORKING_DIRECTORY_OWNERSHIP_PATH_OPERATIONS: SessionWorkingDirectoryOwnershipPathOperations =
	{ isAbsolute, join, relative, sep };

function isTaskSessionSummaryCertainlyOwnedByOtherWorkspace(input: {
	taskSessionId: string;
	summary: RuntimeTaskSessionSummary;
	workspaceId: string;
	workspaceFolderLabel: string;
	taskWorktreesHomePath: string;
	sessionWorkingDirectoryOwnershipPathOperations: SessionWorkingDirectoryOwnershipPathOperations;
}): boolean {
	if (isHomeAgentSessionId(input.taskSessionId)) {
		return !isHomeAgentSessionIdForWorkspace(input.taskSessionId, input.workspaceId);
	}
	const sessionWorkingDirectoryPath = input.summary.workspacePath;
	if (!sessionWorkingDirectoryPath) {
		return false;
	}
	const pathOperations = input.sessionWorkingDirectoryOwnershipPathOperations;
	const pathRelativeToTaskWorktreesHome = pathOperations.relative(
		input.taskWorktreesHomePath,
		sessionWorkingDirectoryPath,
	);
	// 不在 task worktree 根下的形态一律保留：上溯（`..` 开头）、就是根本身（空串）、以及 relative() 直接返回
	// 绝对路径——Windows 上目标与根跨盘符时（如 `D:\repos\proj`）就是这样。最后一种若继续按 sep 切分取第二段，
	// 会把另一盘符上的 inplace 任务（workspacePath = 仓库本身）误判为外来会话而从 sessions.json 删除。
	if (
		pathRelativeToTaskWorktreesHome === "" ||
		pathRelativeToTaskWorktreesHome.startsWith("..") ||
		pathOperations.isAbsolute(pathRelativeToTaskWorktreesHome)
	) {
		return false;
	}
	const [, worktreeRepositoryFolderLabel] = pathRelativeToTaskWorktreesHome.split(pathOperations.sep);
	return worktreeRepositoryFolderLabel !== undefined && worktreeRepositoryFolderLabel !== input.workspaceFolderLabel;
}

export function removeTaskSessionSummariesOwnedByOtherWorkspaces(input: {
	workspaceId: string;
	workspaceRepositoryPath: string;
	taskWorktreesHomePath: string;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	sessionWorkingDirectoryOwnershipPathOperations?: SessionWorkingDirectoryOwnershipPathOperations;
}): TaskSessionSummariesOwnedByOtherWorkspacesRemoval {
	const sessionWorkingDirectoryOwnershipPathOperations =
		input.sessionWorkingDirectoryOwnershipPathOperations ??
		CURRENT_PLATFORM_SESSION_WORKING_DIRECTORY_OWNERSHIP_PATH_OPERATIONS;
	const workspaceFolderLabel = getWorkspaceFolderLabelForWorktreePath(input.workspaceRepositoryPath);
	const taskWorktreesHomePath = sessionWorkingDirectoryOwnershipPathOperations.join(input.taskWorktreesHomePath);
	let sessionsWithoutSummariesOwnedByOtherWorkspaces = input.sessions;
	const removedTaskSessionIdsOwnedByOtherWorkspaces: string[] = [];
	for (const [taskSessionId, summary] of Object.entries(input.sessions)) {
		if (
			!isTaskSessionSummaryCertainlyOwnedByOtherWorkspace({
				taskSessionId,
				summary,
				workspaceId: input.workspaceId,
				workspaceFolderLabel,
				taskWorktreesHomePath,
				sessionWorkingDirectoryOwnershipPathOperations,
			})
		) {
			continue;
		}
		if (sessionsWithoutSummariesOwnedByOtherWorkspaces === input.sessions) {
			sessionsWithoutSummariesOwnedByOtherWorkspaces = { ...input.sessions };
		}
		delete sessionsWithoutSummariesOwnedByOtherWorkspaces[taskSessionId];
		removedTaskSessionIdsOwnedByOtherWorkspaces.push(taskSessionId);
	}
	return { sessionsWithoutSummariesOwnedByOtherWorkspaces, removedTaskSessionIdsOwnedByOtherWorkspaces };
}

// 写盘路径剔除时留一行诊断（读路径静默：没被保存过的项目每次读都会剔一遍，记日志只会刷屏）。
export function logTaskSessionSummariesOwnedByOtherWorkspacesRemovedBeforeWrite(input: {
	workspaceId: string;
	removedTaskSessionIdsOwnedByOtherWorkspaces: string[];
}): void {
	if (input.removedTaskSessionIdsOwnedByOtherWorkspaces.length === 0) {
		return;
	}
	const sampledTaskSessionIds = input.removedTaskSessionIdsOwnedByOtherWorkspaces.slice(0, 10).join(",");
	try {
		process.stderr.write(
			`[warn] [workspace-session-ownership] removed-sessions-owned-by-other-workspaces workspaceId=${input.workspaceId} count=${input.removedTaskSessionIdsOwnedByOtherWorkspaces.length} sample=${sampledTaskSessionIds}\n`,
		);
	} catch {
		// Best-effort diagnostic logging only.
	}
}
