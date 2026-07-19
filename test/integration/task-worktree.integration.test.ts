import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture";
import {
	createProtectedFilesystemMutationTestFixture,
	type ProtectedFilesystemMutationTestFixture,
} from "../dangerous-capability-test-infrastructure/protected-filesystem-mutation-test-fixture";

function expectMirroredPathBehavior(path: string): void {
	const exists = existsSync(path);
	if (process.platform === "win32") {
		if (exists) {
			expect(lstatSync(path).isSymbolicLink()).toBe(true);
		}
		return;
	}
	expect(exists).toBe(true);
	expect(lstatSync(path).isSymbolicLink()).toBe(true);
}

async function withProtectedTaskWorktreeTestHome<T>(
	run: (context: {
		gitFixture: IsolatedGitTestWorkspaceFixture;
		filesystemFixture: ProtectedFilesystemMutationTestFixture;
		isolatedHomeDirectoryPath: string;
		createRepository: (repositoryDirectoryName: string) => IsolatedGitTestRepository;
	}) => Promise<T>,
): Promise<T> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const filesystemFixture = createProtectedFilesystemMutationTestFixture({
		parentDirectoryPath: gitFixture.fixtureRootDirectoryPath,
	});
	const tempHome = filesystemFixture.createOwnedMutationDirectory({ ownedDirectoryName: "task-worktree-home" });
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run({
			gitFixture,
			filesystemFixture,
			isolatedHomeDirectoryPath: tempHome,
			createRepository: (repositoryDirectoryName) =>
				gitFixture.createNonBareRepository({ repositoryDirectoryName, initialBranchName: "main" }),
		});
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
		filesystemFixture.assertProtectedCanariesIntact();
		filesystemFixture.cleanup();
		gitFixture.cleanup();
	}
}

describe.sequential("task-worktree integration", () => {
	it("returns a friendly error when the repository has no initial commit", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository }) => {
			const repository = createRepository("unborn-repository");
			const repoPath = repository.repositoryPath;

			const currentBranch = repository.runGit(["symbolic-ref", "--short", "HEAD"]).stdout.trim();
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-no-initial-commit",
				baseRef: currentBranch,
			});

			expect(ensured.ok).toBe(false);
			expect(ensured.error).toContain("does not have an initial commit yet");
			expect(ensured.error).toContain(`base ref "${currentBranch}"`);
		});
	});

	it("keeps symlinked ignored paths ignored in task worktrees", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository }) => {
			const repository = createRepository("ignored-paths-repository");
			const repoPath = repository.repositoryPath;

			writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
			mkdirSync(join(repoPath, ".husky", "_"), { recursive: true });
			writeFileSync(join(repoPath, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
			writeFileSync(join(repoPath, ".husky", "_", ".gitignore"), "*\n", "utf8");
			writeFileSync(join(repoPath, ".husky", "_", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");

			repository.runGit(["add", "README.md", ".husky/pre-commit"]);
			repository.runGit(["commit", "-m", "init"]);

			const ignoredPaths = repository
				.runGit(["ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "--directory"])
				.stdout.trim();
			expect(ignoredPaths).toContain(".husky/_/");

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-1",
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) {
				throw new Error("Task worktree was not created");
			}

			const huskyIgnoredPath = join(ensured.path, ".husky", "_");
			expectMirroredPathBehavior(huskyIgnoredPath);
			expect(
				repository
					.runGit(["status", "--porcelain", "--", ".husky/_"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			if (existsSync(huskyIgnoredPath)) {
				expect(
					repository.runGit(["check-ignore", "-v", ".husky/_"], {
						workingDirectoryPath: ensured.path,
					}).stdout,
				).toContain("info/exclude");
			}

			const ensuredAgain = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-1",
				baseRef: "HEAD",
			});
			expect(ensuredAgain.ok).toBe(true);
			expect(
				repository
					.runGit(["status", "--porcelain", "--", ".husky/_"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			expectMirroredPathBehavior(huskyIgnoredPath);
		});
	});

	it("keeps symlinked directory-only ignored paths ignored in task worktrees", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository }) => {
			const repository = createRepository("directory-only-ignored-paths-repository");
			const repoPath = repository.repositoryPath;

			writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
			writeFileSync(join(repoPath, ".gitignore"), "/.next/\n/node_modules/\n", "utf8");
			mkdirSync(join(repoPath, ".next"), { recursive: true });
			mkdirSync(join(repoPath, "node_modules"), { recursive: true });
			writeFileSync(join(repoPath, ".next", "BUILD_ID"), "build\n", "utf8");
			writeFileSync(join(repoPath, "node_modules", "package.json"), '{\n  "name": "fixture"\n}\n', "utf8");

			repository.runGit(["add", "README.md", ".gitignore"]);
			repository.runGit(["commit", "-m", "init"]);

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-2",
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) {
				throw new Error("Task worktree was not created");
			}

			const nextPath = join(ensured.path, ".next");
			const nodeModulesPath = join(ensured.path, "node_modules");
			expectMirroredPathBehavior(nextPath);
			expectMirroredPathBehavior(nodeModulesPath);
			expect(
				repository
					.runGit(["status", "--porcelain", "--", ".next"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			expect(
				repository
					.runGit(["status", "--porcelain", "--", "node_modules"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			if (existsSync(nextPath)) {
				expect(
					repository.runGit(["check-ignore", "-v", ".next"], {
						workingDirectoryPath: ensured.path,
					}).stdout,
				).toContain("info/exclude");
			}
			if (existsSync(nodeModulesPath)) {
				expect(
					repository.runGit(["check-ignore", "-v", "node_modules"], {
						workingDirectoryPath: ensured.path,
					}).stdout,
				).toContain("info/exclude");
			}
		});
	});

	it("skips symlinking root node_modules for root Next apps without a next config file", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository }) => {
			const repository = createRepository("root-next-turbopack-repository");
			const repoPath = repository.repositoryPath;

			writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
			writeFileSync(
				join(repoPath, "package.json"),
				'{\n  "dependencies": {\n    "next": "15.0.0"\n  },\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n',
				"utf8",
			);
			writeFileSync(join(repoPath, ".gitignore"), "/.next/\n/node_modules/\n", "utf8");
			mkdirSync(join(repoPath, ".next"), { recursive: true });
			mkdirSync(join(repoPath, "node_modules"), { recursive: true });
			writeFileSync(join(repoPath, ".next", "BUILD_ID"), "build\n", "utf8");
			writeFileSync(join(repoPath, "node_modules", "package.json"), '{\n  "name": "fixture"\n}\n', "utf8");

			repository.runGit(["add", "README.md", "package.json", ".gitignore"]);
			repository.runGit(["commit", "-m", "init"]);

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-root-turbopack",
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) {
				throw new Error("Task worktree was not created");
			}

			const nextPath = join(ensured.path, ".next");
			const nodeModulesPath = join(ensured.path, "node_modules");
			expectMirroredPathBehavior(nextPath);
			expect(existsSync(nodeModulesPath)).toBe(false);
			expect(
				repository
					.runGit(["status", "--porcelain", "--", ".next"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			expect(
				repository
					.runGit(["status", "--porcelain", "--", "node_modules"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
		});
	});

	it("skips only nested Turbopack app node_modules while keeping root node_modules symlinked", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository }) => {
			const repository = createRepository("nested-turbopack-repository");
			const repoPath = repository.repositoryPath;
			const appPath = join(repoPath, "apps", "web");
			mkdirSync(appPath, { recursive: true });

			writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
			writeFileSync(join(repoPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
			writeFileSync(
				join(appPath, "package.json"),
				'{\n  "dependencies": {\n    "next": "15.0.0"\n  },\n  "scripts": {\n    "dev": "next dev --turbopack"\n  }\n}\n',
				"utf8",
			);
			writeFileSync(join(repoPath, ".gitignore"), "/node_modules/\n/apps/web/node_modules/\n", "utf8");
			mkdirSync(join(repoPath, "node_modules"), { recursive: true });
			mkdirSync(join(appPath, "node_modules"), { recursive: true });
			writeFileSync(join(repoPath, "node_modules", "package.json"), '{\n  "name": "root-fixture"\n}\n', "utf8");
			writeFileSync(join(appPath, "node_modules", "package.json"), '{\n  "name": "app-fixture"\n}\n', "utf8");

			repository.runGit(["add", "README.md", "package.json", "apps/web/package.json", ".gitignore"]);
			repository.runGit(["commit", "-m", "init"]);

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-nested-turbopack",
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) {
				throw new Error("Task worktree was not created");
			}

			const rootNodeModulesPath = join(ensured.path, "node_modules");
			const appNodeModulesPath = join(ensured.path, "apps", "web", "node_modules");
			expectMirroredPathBehavior(rootNodeModulesPath);
			expect(existsSync(appNodeModulesPath)).toBe(false);
			expect(
				repository
					.runGit(["status", "--porcelain", "--", "node_modules"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			expect(
				repository
					.runGit(["status", "--porcelain", "--", "apps/web/node_modules"], {
						workingDirectoryPath: ensured.path,
					})
					.stdout.trim(),
			).toBe("");
			if (existsSync(rootNodeModulesPath)) {
				expect(
					repository.runGit(["check-ignore", "-v", "node_modules"], {
						workingDirectoryPath: ensured.path,
					}).stdout,
				).toContain("info/exclude");
			}
		});
	});

	it("restores a trashed task patch onto the saved commit", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository, isolatedHomeDirectoryPath }) => {
			const repository = createRepository("trashed-task-restore-repository");
			const repoPath = repository.repositoryPath;

			writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
			writeFileSync(join(repoPath, "tracked.txt"), "base\n", "utf8");
			repository.runGit(["add", "README.md", "tracked.txt"]);
			repository.runGit(["commit", "-m", "init"]);

			const taskId = `task-restore-${Date.now()}`;
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId,
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) {
				throw new Error("Task worktree was not created");
			}

			const createdCommit = repository
				.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: ensured.path })
				.stdout.trim();
			writeFileSync(join(ensured.path, "tracked.txt"), "base\nlocal change\n", "utf8");
			writeFileSync(join(ensured.path, "notes.txt"), "untracked\n", "utf8");

			const deleted = await deleteTaskWorktree({
				repoPath,
				taskId,
			});
			expect(deleted.ok).toBe(true);
			expect(deleted.removed).toBe(true);

			const patchPath = join(
				isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"trashed-task-patches",
				`${taskId}.${createdCommit}.patch`,
			);
			expect(existsSync(patchPath)).toBe(true);
			expect(readFileSync(patchPath, "utf8")).toContain("tracked.txt");
			expect(readFileSync(patchPath, "utf8")).toContain("notes.txt");

			writeFileSync(join(repoPath, "README.md"), "hello again\n", "utf8");
			repository.runGit(["add", "README.md"]);
			repository.runGit(["commit", "-m", "advance"]);
			const advancedCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
			expect(advancedCommit).not.toBe(createdCommit);

			const restored = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId,
				baseRef: "HEAD",
			});
			expect(restored.ok).toBe(true);
			if (!restored.ok || !restored.path) {
				throw new Error("Task worktree was not restored");
			}

			expect(restored.baseCommit).toBe(createdCommit);
			expect(repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: restored.path }).stdout.trim()).toBe(
				createdCommit,
			);
			expect(readFileSync(join(restored.path, "tracked.txt"), "utf8")).toBe("base\nlocal change\n");
			expect(readFileSync(join(restored.path, "notes.txt"), "utf8")).toBe("untracked\n");
			expect(existsSync(patchPath)).toBe(false);
		});
	});

	it("resumes a trashed task even when the saved patch is invalid", async () => {
		await withProtectedTaskWorktreeTestHome(async ({ createRepository, isolatedHomeDirectoryPath }) => {
			const repository = createRepository("invalid-trashed-task-patch-repository");
			const repoPath = repository.repositoryPath;

			writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
			repository.runGit(["add", "README.md"]);
			repository.runGit(["commit", "-m", "init"]);

			const taskId = `task-invalid-patch-${Date.now()}`;
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId,
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) {
				throw new Error("Task worktree was not created");
			}

			const createdCommit = repository
				.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: ensured.path })
				.stdout.trim();
			const deleted = await deleteTaskWorktree({
				repoPath,
				taskId,
			});
			expect(deleted.ok).toBe(true);

			const patchesDir = join(isolatedHomeDirectoryPath, ".cline", "kanban", "trashed-task-patches");
			mkdirSync(patchesDir, { recursive: true });
			const patchPath = join(patchesDir, `${taskId}.${createdCommit}.patch`);
			writeFileSync(
				patchPath,
				[
					"diff --git a/README.md b/README.md",
					"new file mode 100644",
					"index 0000000..1111111",
					"--- /dev/null",
					"+++ b/README.md",
					"@@ -0,0 +1 @@",
					"+hello",
					"GIT binary patch",
					"this-is-not-valid-binary-patch-data",
					"",
				].join("\n"),
				"utf8",
			);

			const restored = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId,
				baseRef: "HEAD",
			});
			expect(restored.ok).toBe(true);
			if (!restored.ok || !restored.path) {
				throw new Error("Task worktree was not restored");
			}

			expect(restored.warning).toContain("Saved task changes could not be reapplied automatically.");
			expect(repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: restored.path }).stdout.trim()).toBe(
				createdCommit,
			);
		});
	});
});
