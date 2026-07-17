import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeGitWorkspaceState } from "../../../src/workspace/git-sync";

let repo: string;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();
}

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "probe-git-"));
	git(repo, ["init", "-q", "-b", "main"]);
	await writeFile(join(repo, "a.txt"), "hello\n");
	git(repo, ["add", "a.txt"]);
	git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("probeGitWorkspaceState headCommit via `# branch.oid`", () => {
	it("headCommit 从 status 的 branch.oid 解析，等于 rev-parse HEAD（不再单独 spawn rev-parse）", async () => {
		const expectedHead = git(repo, ["rev-parse", "HEAD"]);
		const probe = await probeGitWorkspaceState(repo, { knownRepoRoot: repo });
		expect(probe.headCommit).toBe(expectedHead);
		expect(probe.currentBranch).toBe("main");
		expect(probe.repoRoot).toBe(repo);
	});

	it("knownRepoRoot 与自动解析 toplevel 得到一致的 headCommit / branch", async () => {
		const withKnownRoot = await probeGitWorkspaceState(repo, { knownRepoRoot: repo });
		const withResolvedRoot = await probeGitWorkspaceState(repo);
		expect(withKnownRoot.headCommit).toBe(withResolvedRoot.headCommit);
		expect(withKnownRoot.currentBranch).toBe(withResolvedRoot.currentBranch);
	});

	it("工作树有未跟踪 + 修改文件时 changedFiles 统计不受 headCommit 改动影响", async () => {
		await writeFile(join(repo, "a.txt"), "hello world\n"); // 修改已跟踪
		await writeFile(join(repo, "b.txt"), "new\n"); // 未跟踪
		const probe = await probeGitWorkspaceState(repo, { knownRepoRoot: repo });
		expect(probe.headCommit).toBe(git(repo, ["rev-parse", "HEAD"]));
		expect(probe.changedFiles).toBe(2);
	});
});
