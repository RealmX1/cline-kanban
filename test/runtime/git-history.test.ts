import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	getCommitChangedFileMetadata,
	getCommitDiff,
	getCommitFileDiffPatch,
	getGitLog,
	getGitRefs,
} from "../../src/workspace/git-history";
import { discardGitChanges, getGitSyncSummary } from "../../src/workspace/git-sync";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

function commitAllRepositoryFiles(repository: IsolatedGitTestRepository, message: string): string {
	repository.runGit(["add", "."]);
	repository.runGit(["commit", "--quiet", "-m", message]);
	return repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
}

describe.sequential("git history runtime", () => {
	it("returns commit changed file metadata without patches", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-metadata" });
		const repoPath = repository.repositoryPath;
		try {
			writeFileSync(join(repoPath, "first.txt"), "hello\n", "utf8");
			writeFileSync(join(repoPath, "second.txt"), "world\nagain\n", "utf8");
			const commitHash = commitAllRepositoryFiles(repository, "add files");

			const response = await getCommitChangedFileMetadata({
				cwd: repoPath,
				commitHash,
			});

			expect(response.ok).toBe(true);
			expect(response.files).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: "first.txt",
						status: "added",
						additions: 1,
						deletions: 0,
					}),
					expect.objectContaining({
						path: "second.txt",
						status: "added",
						additions: 2,
						deletions: 0,
					}),
				]),
			);
			expect(response.files[0]).not.toHaveProperty("patch");
		} finally {
			gitFixture.cleanup();
		}
	});

	it("reports an error when commit changed file metadata cannot be read", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-invalid-metadata" });
		const repoPath = repository.repositoryPath;
		try {
			writeFileSync(join(repoPath, "first.txt"), "hello\n", "utf8");
			commitAllRepositoryFiles(repository, "init");

			const response = await getCommitChangedFileMetadata({
				cwd: repoPath,
				commitHash: "not-a-real-commit",
			});

			expect(response.ok).toBe(false);
			expect(response.files).toEqual([]);
			expect(response.error).toBeTruthy();
		} finally {
			gitFixture.cleanup();
		}
	});

	it("returns only the requested file patch for a commit", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-file-patch" });
		const repoPath = repository.repositoryPath;
		try {
			writeFileSync(join(repoPath, "first.txt"), "old first\n", "utf8");
			writeFileSync(join(repoPath, "second.txt"), "old second\n", "utf8");
			commitAllRepositoryFiles(repository, "init");

			writeFileSync(join(repoPath, "first.txt"), "new first\n", "utf8");
			writeFileSync(join(repoPath, "second.txt"), "new second\n", "utf8");
			const commitHash = commitAllRepositoryFiles(repository, "edit files");

			const response = await getCommitFileDiffPatch({
				cwd: repoPath,
				commitHash,
				path: "first.txt",
			});

			expect(response.ok).toBe(true);
			expect(response.patch).toContain("diff --git a/first.txt b/first.txt");
			expect(response.patch).toContain("+new first");
			expect(response.patch).not.toContain("second.txt");
			expect(response.patch).not.toContain("+new second");
		} finally {
			gitFixture.cleanup();
		}
	});

	it("returns correct metadata for root commit diffs", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-root-commit" });
		const repoPath = repository.repositoryPath;
		try {
			writeFileSync(join(repoPath, "first.txt"), "hello\nworld\n", "utf8");
			const rootCommit = commitAllRepositoryFiles(repository, "first commit");

			const response = await getCommitDiff({
				cwd: repoPath,
				commitHash: rootCommit,
			});

			expect(response.ok).toBe(true);
			expect(response.files).toHaveLength(1);
			expect(response.files[0]).toMatchObject({
				path: "first.txt",
				status: "added",
				additions: 2,
				deletions: 0,
			});
			expect(response.files[0]?.patch).toContain("+++ b/first.txt");
		} finally {
			gitFixture.cleanup();
		}
	});

	it("returns rename metadata for rename-only commits", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-rename" });
		const repoPath = repository.repositoryPath;
		try {
			writeFileSync(join(repoPath, "old.txt"), "hello\n", "utf8");
			commitAllRepositoryFiles(repository, "init");

			repository.runGit(["mv", "old.txt", "new.txt"]);
			const renameCommit = commitAllRepositoryFiles(repository, "rename file");

			const response = await getCommitDiff({
				cwd: repoPath,
				commitHash: renameCommit,
			});

			expect(response.ok).toBe(true);
			expect(response.files).toHaveLength(1);
			expect(response.files[0]).toMatchObject({
				path: "new.txt",
				previousPath: "old.txt",
				status: "renamed",
				additions: 0,
				deletions: 0,
			});
			expect(response.files[0]?.patch).toContain("rename from old.txt");
			expect(response.files[0]?.patch).toContain("rename to new.txt");
		} finally {
			gitFixture.cleanup();
		}
	});

	it("discards tracked, staged, and untracked working copy changes", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-discard" });
		const repoPath = repository.repositoryPath;
		try {
			writeFileSync(join(repoPath, "tracked.txt"), "original\n", "utf8");
			commitAllRepositoryFiles(repository, "init");

			writeFileSync(join(repoPath, "tracked.txt"), "changed\n", "utf8");
			repository.runGit(["add", "tracked.txt"]);
			mkdirSync(join(repoPath, "scratch"), { recursive: true });
			writeFileSync(join(repoPath, "scratch", "note.txt"), "temp\n", "utf8");

			const response = await discardGitChanges({ cwd: repoPath });

			expect(response.ok).toBe(true);
			expect(response.summary.changedFiles).toBe(0);
			expect(readFileSync(join(repoPath, "tracked.txt"), "utf8").replace(/\r\n/gu, "\n")).toBe("original\n");
			expect(existsSync(join(repoPath, "scratch", "note.txt"))).toBe(false);
		} finally {
			gitFixture.cleanup();
		}
	});

	it("returns correct UTF-8 paths for non-ASCII filenames", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "history-nonascii" });
		const repoPath = repository.repositoryPath;
		try {
			const dirName = "提出書類";
			const fileName = "設計書.md";
			const relativePath = `${dirName}/${fileName}`;
			mkdirSync(join(repoPath, dirName), { recursive: true });
			writeFileSync(join(repoPath, dirName, fileName), "# 設計書\n", "utf8");
			const commitHash = commitAllRepositoryFiles(repository, "add non-ASCII path");

			const response = await getCommitDiff({
				cwd: repoPath,
				commitHash,
			});

			expect(response.ok).toBe(true);
			expect(response.files).toHaveLength(1);
			expect(response.files[0]).toMatchObject({
				path: relativePath,
				status: "added",
			});
			expect(response.files[0]?.patch).toContain(`+++ b/${relativePath}`);
		} finally {
			gitFixture.cleanup();
		}
	});

	it("reads ahead and behind counts from tracked branches", { timeout: 15_000 }, async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		try {
			const remoteRepository = gitFixture.createBareRepository({ repositoryDirectoryName: "history-remote.git" });
			const localRepository = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "history-local",
				initialBranchName: "main",
			});
			const peerRepository = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "history-peer",
				initialBranchName: "main",
			});
			const remotePath = remoteRepository.repositoryPath;
			const localPath = localRepository.repositoryPath;
			const peerPath = peerRepository.repositoryPath;
			writeFileSync(join(localPath, "file.txt"), "base\n", "utf8");
			commitAllRepositoryFiles(localRepository, "init");
			localRepository.runGit(["remote", "add", "origin", remotePath]);
			const currentBranch = localRepository.runGit(["symbolic-ref", "--short", "HEAD"]).stdout.trim();
			localRepository.runGit(["push", "-u", "origin", currentBranch]);

			peerRepository.runGit(["remote", "add", "origin", remotePath]);
			peerRepository.runGit(["fetch", "origin"]);
			peerRepository.runGit(["checkout", "-B", currentBranch, `origin/${currentBranch}`]);
			writeFileSync(join(peerPath, "peer.txt"), "remote\n", "utf8");
			commitAllRepositoryFiles(peerRepository, "remote commit");
			peerRepository.runGit(["push", "origin", currentBranch]);

			writeFileSync(join(localPath, "local.txt"), "local\n", "utf8");
			commitAllRepositoryFiles(localRepository, "local commit");
			localRepository.runGit(["fetch", "origin"]);

			const refsResponse = await getGitRefs(localPath);
			expect(refsResponse.ok).toBe(true);
			const headBranch = refsResponse.refs.find((ref) => ref.isHead);
			expect(headBranch).toMatchObject({
				name: currentBranch,
				type: "branch",
				upstreamName: `origin/${currentBranch}`,
				ahead: 1,
				behind: 1,
			});

			expect(refsResponse.refs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: `origin/${currentBranch}`,
						type: "remote",
					}),
				]),
			);

			const summary = await getGitSyncSummary(localPath);
			expect(summary.aheadCount).toBe(1);
			expect(summary.behindCount).toBe(1);

			const logResponse = await getGitLog({
				cwd: localPath,
				refs: [currentBranch, `origin/${currentBranch}`],
			});
			expect(logResponse.ok).toBe(true);
			expect(logResponse.commits).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						message: "local commit",
						relation: "selected",
					}),
					expect.objectContaining({
						message: "remote commit",
						relation: "upstream",
					}),
				]),
			);
		} finally {
			gitFixture.cleanup();
		}
	});
});
