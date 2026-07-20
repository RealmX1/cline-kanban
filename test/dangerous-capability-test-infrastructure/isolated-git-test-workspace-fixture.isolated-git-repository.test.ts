import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "./isolated-git-test-workspace-fixture";

interface GitRepositoryMutationCanarySnapshot {
	config: Buffer;
	head: Buffer;
	index: Buffer;
	statusPorcelainVersion2: string;
}

function captureGitRepositoryMutationCanarySnapshot(
	repository: ReturnType<ReturnType<typeof createIsolatedGitTestWorkspaceFixture>["createNonBareRepository"]>,
): GitRepositoryMutationCanarySnapshot {
	return {
		config: readFileSync(join(repository.repositoryPath, ".git", "config")),
		head: readFileSync(join(repository.repositoryPath, ".git", "HEAD")),
		index: readFileSync(join(repository.repositoryPath, ".git", "index")),
		statusPorcelainVersion2: repository.runGit(["status", "--porcelain=v2", "-z"]).stdout,
	};
}

describe("isolated Git test workspace fixture", () => {
	it("ignores inherited Git repository redirection and leaves the sacrificial canary repository unchanged", () => {
		const sacrificialCanaryFixture = createIsolatedGitTestWorkspaceFixture();
		const sacrificialCanaryRepository = sacrificialCanaryFixture.createNonBareRepository({
			repositoryDirectoryName: "sacrificial-canary-repository",
			initialBranchName: "main",
		});
		writeFileSync(join(sacrificialCanaryRepository.repositoryPath, "canary.txt"), "canary\n");
		sacrificialCanaryRepository.runGit(["add", "canary.txt"]);
		sacrificialCanaryRepository.runGit(["commit", "-m", "canary baseline"]);
		const before = captureGitRepositoryMutationCanarySnapshot(sacrificialCanaryRepository);

		const sacrificialCanaryGitDirectoryPath = join(sacrificialCanaryRepository.repositoryPath, ".git");
		vi.stubEnv("GIT_DIR", sacrificialCanaryGitDirectoryPath);
		vi.stubEnv("GIT_WORK_TREE", sacrificialCanaryRepository.repositoryPath);
		vi.stubEnv("GIT_COMMON_DIR", sacrificialCanaryGitDirectoryPath);
		vi.stubEnv("GIT_INDEX_FILE", join(sacrificialCanaryGitDirectoryPath, "index"));
		vi.stubEnv("GIT_OBJECT_DIRECTORY", join(sacrificialCanaryGitDirectoryPath, "objects"));
		vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", join(sacrificialCanaryGitDirectoryPath, "objects"));
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});

		const subjectFixture = createIsolatedGitTestWorkspaceFixture();
		const subjectRepository = subjectFixture.createNonBareRepository({
			repositoryDirectoryName: "subject-repository",
			initialBranchName: "main",
		});
		writeFileSync(join(subjectRepository.repositoryPath, "subject.txt"), "subject\n");
		subjectRepository.runGit(["add", "subject.txt"]);
		subjectRepository.runGit(["commit", "-m", "subject commit"]);

		expect(subjectRepository.runGit(["rev-parse", "--is-inside-work-tree"]).stdout.trim()).toBe("true");
		expect(captureGitRepositoryMutationCanarySnapshot(sacrificialCanaryRepository)).toEqual(before);
	});

	it("ignores inherited global Git configuration, hooks, signing, and credential helpers", () => {
		const maliciousConfigurationFixture = createIsolatedGitTestWorkspaceFixture();
		const maliciousHooksDirectoryPath = join(
			maliciousConfigurationFixture.fixtureRootDirectoryPath,
			"malicious-global-hooks",
		);
		mkdirSync(maliciousHooksDirectoryPath);
		const maliciousHookExecutionSentinelPath = join(
			maliciousConfigurationFixture.fixtureRootDirectoryPath,
			"malicious-hook-executed",
		);
		writeFileSync(
			join(maliciousHooksDirectoryPath, "pre-commit"),
			`#!/bin/sh\nprintf executed > ${JSON.stringify(maliciousHookExecutionSentinelPath)}\n`,
			{ mode: 0o755 },
		);
		const maliciousGlobalGitConfigurationPath = join(
			maliciousConfigurationFixture.fixtureRootDirectoryPath,
			"malicious-global-git-config",
		);
		writeFileSync(
			maliciousGlobalGitConfigurationPath,
			[
				"[core]",
				`\thooksPath = ${maliciousHooksDirectoryPath}`,
				"[commit]",
				"\tgpgSign = true",
				"[credential]",
				`\thelper = !printf credential-helper-executed > ${maliciousHookExecutionSentinelPath}`,
				"",
			].join("\n"),
		);
		vi.stubEnv("HOME", maliciousConfigurationFixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", maliciousConfigurationFixture.isolatedHomeDirectoryPath);
		vi.stubEnv("GIT_CONFIG_GLOBAL", maliciousGlobalGitConfigurationPath);
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});

		const subjectFixture = createIsolatedGitTestWorkspaceFixture();
		const subjectRepository = subjectFixture.createNonBareRepository({
			repositoryDirectoryName: "global-configuration-isolation-subject",
		});
		writeFileSync(join(subjectRepository.repositoryPath, "subject.txt"), "subject\n");
		subjectRepository.runGit(["add", "subject.txt"]);
		subjectRepository.runGit(["commit", "-m", "commit must not use inherited global configuration"]);

		expect(existsSync(maliciousHookExecutionSentinelPath)).toBe(false);
		expect(
			subjectRepository.runGit(["config", "--global", "--get", "commit.gpgSign"], {
				expectedExitCodes: [0, 1],
			}).stdout,
		).toBe("");
	});

	it("supports non-bare, bare, linked-worktree, Unicode-path, and expected-failure scenarios", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "Unicode-仓库-🧪",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "初始文件.txt"), "content\n");
		repository.runGit(["add", "初始文件.txt"]);
		repository.runGit(["commit", "-m", "initial Unicode commit"]);
		const linkedWorktree = repository.createLinkedWorktree({
			worktreeDirectoryName: "Unicode-工作树-🧪",
			branchName: "test/linked-worktree",
		});
		const bareRepository = fixture.createBareRepository({ repositoryDirectoryName: "bare-remote.git" });

		expect(existsSync(linkedWorktree.worktreePath)).toBe(true);
		expect(bareRepository.runGit(["rev-parse", "--is-bare-repository"]).stdout.trim()).toBe("true");
		expect(repository.runGit(["rev-parse", "refs/heads/does-not-exist"], { expectedExitCodes: [128] }).exitCode).toBe(
			128,
		);
		repository.runGit(["remote", "add", "origin", bareRepository.repositoryPath]);
		expect(repository.runGit(["remote", "get-url", "origin"]).stdout.trim()).toBe(bareRepository.repositoryPath);
	});

	it("拒绝指向 fixture root 外或网络位置的 remote", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "remote-containment-repository" });

		expect(() => repository.runGit(["remote", "add", "outside", process.cwd()])).toThrow(
			/escaped isolated Git fixture root/,
		);
		expect(() => repository.runGit(["remote", "add", "network", "https://example.invalid/repo.git"])).toThrow(
			/must be fixture-local/,
		);
		expect(() => repository.runGit(["push", process.cwd(), "main"])).toThrow(
			/may only target a configured fixture-local remote name/,
		);
		expect(repository.runGit(["remote"]).stdout).toBe("");
	});

	it("rejects working directories, linked-worktree targets, and symlinks that escape the fixture root", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "contained-repository" });
		const escapingSymlinkPath = join(fixture.fixtureRootDirectoryPath, "escaping-working-directory-symlink");
		symlinkSync(process.cwd(), escapingSymlinkPath, "dir");

		expect(() => repository.runGit(["status"], { workingDirectoryPath: process.cwd() })).toThrow(
			/escaped isolated Git fixture root/,
		);
		expect(() => repository.runGit(["status"], { workingDirectoryPath: escapingSymlinkPath })).toThrow(
			/escaped isolated Git fixture root/,
		);
		expect(() =>
			repository.createLinkedWorktree({
				worktreeDirectoryName: "../escaped-linked-worktree",
				branchName: "test/escaped-linked-worktree",
			}),
		).toThrow(/one non-empty directory name/);
	});

	it("provides a sanitized child-process environment without allowing isolation-directory overrides", () => {
		vi.stubEnv("GIT_DIR", "/developer-repository-that-must-not-be-inherited/.git");
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		const fixture = createIsolatedGitTestWorkspaceFixture();

		const childProcessEnvironment = fixture.createIsolatedChildProcessEnvironment({
			KANBAN_RUNTIME_PORT: "43210",
		});

		expect(childProcessEnvironment.GIT_DIR).toBeUndefined();
		expect(childProcessEnvironment.HOME).toBe(fixture.isolatedHomeDirectoryPath);
		expect(childProcessEnvironment.USERPROFILE).toBe(fixture.isolatedHomeDirectoryPath);
		expect(childProcessEnvironment.KANBAN_RUNTIME_PORT).toBe("43210");
		expect(() => fixture.createIsolatedChildProcessEnvironment({ HOME: "/unsafe-home-override" })).toThrow(
			/isolation-owned environment variable HOME/,
		);
		expect(() => fixture.createIsolatedChildProcessEnvironment({ GIT_WORK_TREE: "/unsafe-worktree" })).toThrow(
			/isolation-owned environment variable GIT_WORK_TREE/,
		);
	});

	it("initializes repositories only at explicitly owned fixture paths and supports isolated commit dates", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const ownedRepositoryPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "owned-integration-project");
		mkdirSync(ownedRepositoryPath);
		const repository = fixture.createNonBareRepositoryAtOwnedPath({
			repositoryPath: ownedRepositoryPath,
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "dated.txt"), "dated\n");
		repository.runGit(["add", "dated.txt"]);
		repository.runGit(["commit", "-m", "dated commit"], {
			environmentVariableOverrides: {
				GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
				GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
			},
		});

		expect(repository.runGit(["show", "-s", "--format=%at/%ct", "HEAD"]).stdout.trim()).toBe("1767323045/1767323045");
		expect(() => fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: process.cwd() })).toThrow(
			/escaped isolated Git fixture root/,
		);
		expect(() =>
			repository.runGit(["status"], { environmentVariableOverrides: { GIT_DIR: "/unsafe-git-directory" } }),
		).toThrow(/Git command environment variable GIT_DIR/);
	});

	it("cleanup root identity 被篡改时停止删除并保留现场", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const originalFixtureRootDirectoryPath = fixture.fixtureRootDirectoryPath;
		const movedOriginalFixtureRootDirectoryPath = `${originalFixtureRootDirectoryPath}-moved-original`;
		renameSync(originalFixtureRootDirectoryPath, movedOriginalFixtureRootDirectoryPath);
		mkdirSync(originalFixtureRootDirectoryPath);

		expect(() => fixture.cleanup()).toThrow(/fixture root identity changed/);
		expect(existsSync(movedOriginalFixtureRootDirectoryPath)).toBe(true);

		rmSync(originalFixtureRootDirectoryPath, { recursive: true });
		renameSync(movedOriginalFixtureRootDirectoryPath, originalFixtureRootDirectoryPath);
		fixture.cleanup();
	});
});
