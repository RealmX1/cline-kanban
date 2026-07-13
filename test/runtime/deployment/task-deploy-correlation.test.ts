import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { correlateTasksWithDeployDelta } from "../../../src/deployment/task-deploy-correlation";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function initRepository(path: string): void {
	runGit(path, ["init", "-q"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
}

function commitFile(cwd: string, file: string, contents: string, message: string): string {
	writeFileSync(join(cwd, file), contents, "utf8");
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

interface CherryPickFixture {
	sourceCheckoutPath: string;
	taskWorktreePath: string;
	baseBranch: string;
	baseCommit: string;
	taskCommit: string;
	deployedCommit: string;
}

// 构造「task worktree 里提交一条 → cherry-pick 到 main（hash 变、patch 同）」的真实 git 场景。
// main 仓库当 sourceCheckout（deploy delta 在此算）；task 用共享 ref 的 linked worktree，
// 以 worktreeMode:"inplace" 直接把该 worktree 目录当作任务 cwd，绕开 ~/.cline 的 worktree 路径解析。
function buildCherryPickFixture(sandboxRoot: string): CherryPickFixture {
	const sourceCheckoutPath = join(sandboxRoot, "source-checkout");
	// taskWorktreePath 由后续 `git worktree add` 创建，此处不能预建（worktree add 要求路径不存在或为空）。
	const taskWorktreePath = join(sandboxRoot, "task-worktree");

	mkdirSync(sourceCheckoutPath, { recursive: true });
	initRepository(sourceCheckoutPath);
	const baseCommit = commitFile(sourceCheckoutPath, "app.txt", "line-1\n", "base");
	const baseBranch = runGit(sourceCheckoutPath, ["symbolic-ref", "--short", "HEAD"]);

	// task 分支从 base 分叉，提交自己的 feature commit。
	runGit(sourceCheckoutPath, ["worktree", "add", "-q", "-b", "task/verify", taskWorktreePath, baseCommit]);
	const taskCommit = commitFile(taskWorktreePath, "app.txt", "line-1\nfeature\n", "feature");

	// main 先推进一条无关提交，让后续 cherry-pick 落在不同 parent 上——
	// 否则同 parent+tree+作者+同秒时间会算出与 taskCommit 完全相同的 hash，退化成 exact_hash，测不到 patch-id 路径。
	commitFile(sourceCheckoutPath, "other.txt", "unrelated\n", "unrelated main change");

	// 把 feature commit cherry-pick 到 main：patch（对 app.txt 的同一 diff）相同、hash 不同。
	runGit(sourceCheckoutPath, ["cherry-pick", taskCommit]);
	const deployedCommit = runGit(sourceCheckoutPath, ["rev-parse", "HEAD"]);

	return { sourceCheckoutPath, taskWorktreePath, baseBranch, baseCommit, taskCommit, deployedCommit };
}

describe.sequential("correlateTasksWithDeployDelta", () => {
	let sandbox: ReturnType<typeof createTempDir>;

	beforeEach(() => {
		sandbox = createTempDir("kanban-deploy-correlation-");
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	it("matches a cherry-picked task commit via patch-id equivalence despite the hash changing", async () => {
		const fixture = buildCherryPickFixture(sandbox.path);
		// 前置断言：cherry-pick 确实换了 hash（否则退化成 exact_hash 匹配，测不到 patch-id 路径）。
		expect(fixture.deployedCommit).not.toBe(fixture.taskCommit);

		const candidates = await correlateTasksWithDeployDelta({
			sourceCheckoutPath: fixture.sourceCheckoutPath,
			oldSha: fixture.baseCommit,
			newSha: fixture.deployedCommit,
			tasks: [
				{
					taskId: "task-1",
					columnId: "validation",
					cwd: fixture.taskWorktreePath,
					baseRef: fixture.baseBranch,
					worktreeMode: "inplace",
				},
			],
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toEqual({
			taskId: "task-1",
			columnId: "validation",
			matchedCommits: [fixture.deployedCommit],
			matchConfidence: "patch_id_equivalent",
		});
	});

	it("returns no candidates when redeploying the same commit (empty delta range)", async () => {
		const fixture = buildCherryPickFixture(sandbox.path);

		const candidates = await correlateTasksWithDeployDelta({
			sourceCheckoutPath: fixture.sourceCheckoutPath,
			// 同 commit 重部署：oldSha === newSha → `git log X..X` 为空 → 0 关联。
			oldSha: fixture.deployedCommit,
			newSha: fixture.deployedCommit,
			tasks: [
				{
					taskId: "task-1",
					columnId: "validation",
					cwd: fixture.taskWorktreePath,
					baseRef: fixture.baseBranch,
					worktreeMode: "inplace",
				},
			],
		});

		expect(candidates).toEqual([]);
	});
});
