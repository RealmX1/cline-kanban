import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeWorktreeGitChangeToken,
	resetResolvedGitDirCacheForTest,
} from "../../../src/workspace/git-change-token";

let root: string;

beforeEach(async () => {
	resetResolvedGitDirCacheForTest();
	root = await mkdtemp(join(tmpdir(), "git-change-token-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function setMtime(path: string, seconds: number): Promise<void> {
	await utimes(path, seconds, seconds);
}

async function createRegularRepo(dir: string): Promise<void> {
	const gitDir = join(dir, ".git");
	await mkdir(join(gitDir, "logs"), { recursive: true });
	await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(gitDir, "index"), "index-v1");
	await writeFile(join(gitDir, "logs", "HEAD"), "reflog-line-1\n");
}

describe("computeWorktreeGitChangeToken", () => {
	it("同一状态两次调用得到相同 token（幂等）", async () => {
		await createRegularRepo(root);
		const first = await computeWorktreeGitChangeToken(root);
		const second = await computeWorktreeGitChangeToken(root);
		expect(first).toBe(second);
		expect(first).not.toBe("no-gitdir");
	});

	it("HEAD 的 mtime 变化 → token 变化（提交 / checkout）", async () => {
		await createRegularRepo(root);
		await setMtime(join(root, ".git", "HEAD"), 1_000_000);
		const before = await computeWorktreeGitChangeToken(root);
		await setMtime(join(root, ".git", "HEAD"), 2_000_000);
		const after = await computeWorktreeGitChangeToken(root);
		expect(after).not.toBe(before);
	});

	it("index 的 mtime 变化 → token 变化（暂存）", async () => {
		await createRegularRepo(root);
		await setMtime(join(root, ".git", "index"), 1_000_000);
		const before = await computeWorktreeGitChangeToken(root);
		await setMtime(join(root, ".git", "index"), 2_000_000);
		const after = await computeWorktreeGitChangeToken(root);
		expect(after).not.toBe(before);
	});

	it("logs/HEAD 的 mtime 变化 → token 变化（HEAD 移动 reflog 追加）", async () => {
		await createRegularRepo(root);
		await setMtime(join(root, ".git", "logs", "HEAD"), 1_000_000);
		const before = await computeWorktreeGitChangeToken(root);
		await setMtime(join(root, ".git", "logs", "HEAD"), 2_000_000);
		const after = await computeWorktreeGitChangeToken(root);
		expect(after).not.toBe(before);
	});

	it("工作树根新增文件 → token 变化", async () => {
		await createRegularRepo(root);
		const before = await computeWorktreeGitChangeToken(root);
		await writeFile(join(root, "new-file.txt"), "hello");
		const after = await computeWorktreeGitChangeToken(root);
		expect(after).not.toBe(before);
	});

	it("linked worktree（.git 为文件指向真实 gitdir）→ 解析并反映 linked HEAD", async () => {
		// 模拟 linked worktree 布局：worktree 根的 .git 是文件，指向 commonDir/worktrees/<name>
		const commonGitDir = join(root, "main-repo", ".git");
		const linkedGitDir = join(commonGitDir, "worktrees", "task-abc");
		await mkdir(join(linkedGitDir, "logs"), { recursive: true });
		await writeFile(join(linkedGitDir, "HEAD"), "ref: refs/heads/task\n");
		await writeFile(join(linkedGitDir, "index"), "linked-index");
		await writeFile(join(linkedGitDir, "logs", "HEAD"), "linked-reflog\n");

		const worktreeRoot = join(root, "worktree");
		await mkdir(worktreeRoot, { recursive: true });
		await writeFile(join(worktreeRoot, ".git"), `gitdir: ${linkedGitDir}\n`);

		await setMtime(join(linkedGitDir, "HEAD"), 1_000_000);
		const before = await computeWorktreeGitChangeToken(worktreeRoot);
		expect(before).not.toBe("no-gitdir");
		// 改动 linked gitdir 的 HEAD → token 变化（证明确实解析到了 linked gitdir，而非 worktree 根的 .git 文件）
		await setMtime(join(linkedGitDir, "HEAD"), 2_000_000);
		const after = await computeWorktreeGitChangeToken(worktreeRoot);
		expect(after).not.toBe(before);
	});

	it("非 git 目录 → 恒定 sentinel 'no-gitdir'", async () => {
		const nonGit = join(root, "plain");
		await mkdir(nonGit, { recursive: true });
		const first = await computeWorktreeGitChangeToken(nonGit);
		const second = await computeWorktreeGitChangeToken(nonGit);
		expect(first).toBe("no-gitdir");
		expect(second).toBe("no-gitdir");
	});
});
