import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { removeTaskSessionSummariesOwnedByOtherWorkspaces } from "../../../src/state/task-session-summaries-owned-by-other-workspaces-removal";

const TASK_WORKTREES_HOME_PATH = "/home/user/.cline/worktrees";

function createSummary(taskId: string, workspacePath: string | null): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("removeTaskSessionSummariesOwnedByOtherWorkspaces", () => {
	it("只剔除确定属于别的项目的条目：别的仓库目录名下的 worktree、别的 workspace 的侧边栏会话", () => {
		const sessions = {
			"own-worktree-task": createSummary(
				"own-worktree-task",
				join(TASK_WORKTREES_HOME_PATH, "own01", "cline-kanban"),
			),
			"own-worktree-subdirectory": createSummary(
				"own-worktree-subdirectory",
				join(TASK_WORKTREES_HOME_PATH, "own02", "cline-kanban", "web-ui"),
			),
			"inplace-task-in-repository": createSummary("inplace-task-in-repository", "/repos/cline-kanban"),
			"never-started-placeholder": createSummary("never-started-placeholder", null),
			"path-outside-task-worktrees-home": createSummary("path-outside-task-worktrees-home", "/somewhere/else"),
			[createHomeAgentSessionId("cline-kanban", "claude")]: createSummary("home-own", "/repos/cline-kanban"),
			"7fa4d": createSummary("7fa4d", join(TASK_WORKTREES_HOME_PATH, "7fa4d", "my-ai-setup")),
			[createHomeAgentSessionId("my-ai-setup", "codex")]: createSummary("home-foreign", "/repos/my-ai-setup"),
		};
		const removal = removeTaskSessionSummariesOwnedByOtherWorkspaces({
			workspaceId: "cline-kanban",
			workspaceRepositoryPath: "/repos/cline-kanban",
			taskWorktreesHomePath: TASK_WORKTREES_HOME_PATH,
			sessions,
		});
		expect(removal.removedTaskSessionIdsOwnedByOtherWorkspaces).toEqual([
			"7fa4d",
			createHomeAgentSessionId("my-ai-setup", "codex"),
		]);
		expect(Object.keys(removal.sessionsWithoutSummariesOwnedByOtherWorkspaces)).toEqual([
			"own-worktree-task",
			"own-worktree-subdirectory",
			"inplace-task-in-repository",
			"never-started-placeholder",
			"path-outside-task-worktrees-home",
			createHomeAgentSessionId("cline-kanban", "claude"),
		]);
		// 不改入参。
		expect(Object.keys(sessions)).toHaveLength(8);
	});

	it("没有可剔除的条目时原样返回同一个对象", () => {
		const sessions = {
			own: createSummary("own", join(TASK_WORKTREES_HOME_PATH, "own01", "cline-kanban")),
		};
		const removal = removeTaskSessionSummariesOwnedByOtherWorkspaces({
			workspaceId: "cline-kanban",
			workspaceRepositoryPath: "/repos/cline-kanban/",
			taskWorktreesHomePath: TASK_WORKTREES_HOME_PATH,
			sessions,
		});
		expect(removal.sessionsWithoutSummariesOwnedByOtherWorkspaces).toBe(sessions);
		expect(removal.removedTaskSessionIdsOwnedByOtherWorkspaces).toEqual([]);
	});
});
