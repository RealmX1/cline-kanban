// per-workspace JSON store 的集成测试共享 fixture：把 HOME / USERPROFILE 指向一个临时目录，
// 于是 getRuntimeHomePath() 派生出的 ~/.cline/kanban/workspaces/** 全部落在隔离沙盒里，
// 测试不会读写用户真实的 Kanban 状态。
//
// 抽出来的原因：notification-log-store / agent-session-reclamation-deadline-store /
// agent-raised-pending-user-decision-store 三份集成测试需要逐字相同的这段样板。

import { loadWorkspaceContext, loadWorkspaceState } from "../../src/state/workspace-state";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

export interface RegisteredIsolatedWorkspace {
	workspaceId: string;
	path: string;
}

export type RegisterIsolatedWorkspace = (repositoryDirectoryName: string) => Promise<RegisteredIsolatedWorkspace>;

async function registerWorkspace(
	gitFixture: IsolatedGitTestWorkspaceFixture,
	repositoryDirectoryName: string,
): Promise<RegisteredIsolatedWorkspace> {
	const workspacePath = gitFixture.createNonBareRepository({ repositoryDirectoryName }).repositoryPath;
	await loadWorkspaceState(workspacePath);
	const context = await loadWorkspaceContext(workspacePath);
	return { workspaceId: context.workspaceId, path: workspacePath };
}

export async function withIsolatedWorkspaceHome<T>(
	run: (registerIsolatedWorkspace: RegisterIsolatedWorkspace) => Promise<T>,
): Promise<T> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const tempHome = gitFixture.isolatedHomeDirectoryPath;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run((repositoryDirectoryName) => registerWorkspace(gitFixture, repositoryDirectoryName));
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		gitFixture.cleanup();
	}
}
