import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeGitWorkspaceState } from "../../../src/workspace/git-sync";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
} from "../../dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture";

function createRepositoryForGitWorkspaceProbeTest(): IsolatedGitTestRepository {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const repository = fixture.createNonBareRepository({
		repositoryDirectoryName: "workspace-probe-repository",
		initialBranchName: "main",
	});
	writeFileSync(join(repository.repositoryPath, "a.txt"), "hello\n");
	repository.runGit(["add", "a.txt"]);
	repository.runGit(["commit", "--quiet", "-m", "initial commit"]);
	return repository;
}

describe("probeGitWorkspaceState headCommit via `# branch.oid`", () => {
	it("headCommit 从 status 的 branch.oid 解析，等于 rev-parse HEAD（不再单独 spawn rev-parse）", async () => {
		const repository = createRepositoryForGitWorkspaceProbeTest();
		const expectedHead = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		const probe = await probeGitWorkspaceState(repository.repositoryPath, {
			knownRepoRoot: repository.repositoryPath,
		});
		expect(probe.headCommit).toBe(expectedHead);
		expect(probe.currentBranch).toBe("main");
		expect(probe.repoRoot).toBe(repository.repositoryPath);
	});

	it("knownRepoRoot 与自动解析 toplevel 得到一致的 headCommit / branch", async () => {
		const repository = createRepositoryForGitWorkspaceProbeTest();
		const withKnownRoot = await probeGitWorkspaceState(repository.repositoryPath, {
			knownRepoRoot: repository.repositoryPath,
		});
		const withResolvedRoot = await probeGitWorkspaceState(repository.repositoryPath);
		expect(withKnownRoot.headCommit).toBe(withResolvedRoot.headCommit);
		expect(withKnownRoot.currentBranch).toBe(withResolvedRoot.currentBranch);
	});

	it("工作树有未跟踪 + 修改文件时 changedFiles 统计不受 headCommit 改动影响", async () => {
		const repository = createRepositoryForGitWorkspaceProbeTest();
		writeFileSync(join(repository.repositoryPath, "a.txt"), "hello world\n"); // 修改已跟踪
		writeFileSync(join(repository.repositoryPath, "b.txt"), "new\n"); // 未跟踪
		const probe = await probeGitWorkspaceState(repository.repositoryPath, {
			knownRepoRoot: repository.repositoryPath,
		});
		expect(probe.headCommit).toBe(repository.runGit(["rev-parse", "HEAD"]).stdout.trim());
		expect(probe.changedFiles).toBe(2);
	});
});
