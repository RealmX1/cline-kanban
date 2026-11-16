import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProjectInputPath } from "../projects/project-path";
import { runGit } from "../workspace/git-utils";
import { listWorkspaceIndexEntries, loadWorkspaceContext } from "./workspace-state";

export async function resolveGitCommonDirectory(repositoryPath: string): Promise<string> {
	const result = await runGit(repositoryPath, ["rev-parse", "--git-common-dir"]);
	if (!result.ok) throw new Error(result.error ?? `无法读取 Git 仓库：${repositoryPath}`);
	return realpath(resolve(repositoryPath, result.stdout));
}

/** 任务命令只选择已有项目；会话绑定优先于 worktree 的目录名。 */
export async function resolveRegisteredWorkspaceInvocationContext(
	projectPath: string | undefined,
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
) {
	const explicitProjectPath = projectPath?.trim();
	if (explicitProjectPath)
		return loadWorkspaceContext(resolveProjectInputPath(explicitProjectPath, cwd), { autoCreateIfMissing: false });
	const boundProjectPath = environment.KANBAN_PROJECT_PATH?.trim();
	if (boundProjectPath) {
		const context = await loadWorkspaceContext(boundProjectPath, { autoCreateIfMissing: false });
		if ((await resolveGitCommonDirectory(cwd)) !== (await resolveGitCommonDirectory(context.repoPath)))
			throw new Error("当前目录与会话绑定的项目不属于同一 Git 仓库，请显式提供 --project-path。");
		return context;
	}
	const commonDirectory = await resolveGitCommonDirectory(cwd);
	const candidates = [];
	for (const entry of await listWorkspaceIndexEntries()) {
		try {
			if ((await resolveGitCommonDirectory(entry.repoPath)) === commonDirectory) candidates.push(entry);
		} catch {
			// 不可访问的其他仓库不影响当前仓库的只读解析。
		}
	}
	const candidate = candidates[0];
	if (candidates.length !== 1 || !candidate)
		throw new Error(
			"当前仓库没有唯一的已注册项目，请显式提供已注册项目的 --project-path；新增项目请使用 project add。",
		);
	return loadWorkspaceContext(candidate.repoPath, { autoCreateIfMissing: false });
}
