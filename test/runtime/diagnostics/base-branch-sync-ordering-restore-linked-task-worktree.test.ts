import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeIndependentWorkingState } from "../../../scripts/base-branch-sync-ordering-experiment/frozen-source-snapshot";
import { createOwnedExperimentRoot } from "../../../scripts/base-branch-sync-ordering-experiment/persistent-experiment-storage";
import { restoreLinkedTaskWorktreeFromFrozenSnapshot } from "../../../scripts/base-branch-sync-ordering-experiment/restore-linked-task-worktree-from-frozen-snapshot";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	captureSourceGitWorkingState,
} from "../../../src/independent-task-creation/git-working-state-snapshot";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("从冻结档案恢复可供原主 Agent 正常操作的 linked task worktree", () => {
	it.each(["original-child.txt", "nested-directory/original-child.txt"])(
		"保留目录替换为文件后的删除路径 %s，允许重入且不覆盖后续编辑",
		async (deletedRelativePath) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const source = fixture.createNonBareRepository({ repositoryDirectoryName: "directory-replacement-source" });
			const originalChild = join(source.repositoryPath, "replaced-directory", deletedRelativePath);
			mkdirSync(dirname(originalChild), { recursive: true });
			writeFileSync(originalChild, "原子文件\n");
			source.commitAllRepositoryFilesAtDate({
				message: "目录基线",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "directory-replacement-restoration");
			await createOwnedExperimentRoot(root, join(source.repositoryPath, ".git"));
			const baseArchive = join(root, "frozen-base");
			await captureSourceGitWorkingState(source.repositoryPath, baseArchive);
			const originalTask = source.createLinkedWorktree({
				worktreeDirectoryName: "directory-replacement-task",
				branchName: "directory-replacement-task",
			});
			rmSync(join(originalTask.worktreePath, "replaced-directory"), { recursive: true });
			writeFileSync(join(originalTask.worktreePath, "replaced-directory"), "替换后的普通文件\n");
			const archive = join(root, "frozen-task");
			const snapshot = await captureSourceGitWorkingState(originalTask.worktreePath, archive);
			expect(snapshot.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "replaced-directory", kind: "file" }),
					expect.objectContaining({ path: `replaced-directory/${deletedRelativePath}`, kind: "absent" }),
				]),
			);
			mkdirSync(join(root, "private-base"));
			const base = fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: join(root, "private-base") });
			await materializeIndependentWorkingState(root, baseArchive, base.repositoryPath);
			const worktree = join(root, "task-worktrees", "directory-replacement-task");
			try {
				const gitDirectory = await restoreLinkedTaskWorktreeFromFrozenSnapshot(
					root,
					base.repositoryPath,
					archive,
					worktree,
					snapshot,
				);
				expect(readFileSync(join(gitDirectory, "index"))).toEqual(readFileSync(join(archive, "source-git-index")));
				expect(readFileSync(join(worktree, "replaced-directory"), "utf8")).toBe("替换后的普通文件\n");
				expect(existsSync(join(worktree, "replaced-directory", deletedRelativePath))).toBe(false);
				expect(
					base.runGit(["--no-optional-locks", "status", "--porcelain=v1"], { workingDirectoryPath: worktree })
						.stdout,
				).toBe(
					source.runGit(["--no-optional-locks", "status", "--porcelain=v1"], {
						workingDirectoryPath: originalTask.worktreePath,
					}).stdout,
				);
				expect(
					await restoreLinkedTaskWorktreeFromFrozenSnapshot(
						root,
						base.repositoryPath,
						archive,
						worktree,
						snapshot,
					),
				).toBe(gitDirectory);
				writeFileSync(join(worktree, "replaced-directory"), "后续编辑\n");
				await expect(
					restoreLinkedTaskWorktreeFromFrozenSnapshot(root, base.repositoryPath, archive, worktree, snapshot),
				).rejects.toThrow("漂移");
				expect(readFileSync(join(worktree, "replaced-directory"), "utf8")).toBe("后续编辑\n");
			} finally {
				await assertSourceGitWorkingStateMatchesSnapshot(originalTask.worktreePath, archive);
				await assertSourceGitWorkingStateMatchesSnapshot(source.repositoryPath, baseArchive);
			}
		},
	);

	it("保留 HEAD、split index、完整 WIP 与 base 背景，拒绝越界和覆盖后续工作", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const source = fixture.createNonBareRepository({ repositoryDirectoryName: "original-source" });
		writeFileSync(join(source.repositoryPath, "staged.txt"), "原始\n");
		writeFileSync(join(source.repositoryPath, "deleted.txt"), "原来存在\n");
		writeFileSync(join(source.repositoryPath, "executable.sh"), "echo 原始\n");
		writeFileSync(join(source.repositoryPath, ".gitignore"), "ignored-artifact.txt\n");
		source.commitAllRepositoryFilesAtDate({ message: "基线", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
		writeFileSync(join(source.repositoryPath, "base-background.txt"), "base 背景 WIP\n");
		const root = join(fixture.ownedIntegrationProjectsDirectoryPath, "restored-runtime-workspace");
		await createOwnedExperimentRoot(root, join(source.repositoryPath, ".git"));
		const baseArchive = join(root, "frozen-base");
		await captureSourceGitWorkingState(source.repositoryPath, baseArchive);
		const originalTask = source.createLinkedWorktree({ worktreeDirectoryName: "original-task", branchName: "task" });
		writeFileSync(join(originalTask.worktreePath, "staged.txt"), "暂存\n");
		source.runGit(["add", "staged.txt"], { workingDirectoryPath: originalTask.worktreePath });
		writeFileSync(join(originalTask.worktreePath, "staged.txt"), "未暂存\n");
		rmSync(join(originalTask.worktreePath, "deleted.txt"));
		chmodSync(join(originalTask.worktreePath, "executable.sh"), 0o755);
		writeFileSync(join(originalTask.worktreePath, "untracked.bin"), Buffer.from([0, 13, 255]));
		writeFileSync(join(originalTask.worktreePath, "ignored-artifact.txt"), "保留 ignored 成果\n");
		symlinkSync("staged.txt", join(originalTask.worktreePath, "relative-link"));
		source.runGit(["update-index", "--split-index"], { workingDirectoryPath: originalTask.worktreePath });
		const archive = join(root, "frozen-task");
		const snapshot = await captureSourceGitWorkingState(originalTask.worktreePath, archive, ["ignored-artifact.txt"]);
		mkdirSync(join(root, "private-base"), { recursive: true });
		const base = fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: join(root, "private-base") });
		await materializeIndependentWorkingState(root, baseArchive, base.repositoryPath);
		const worktree = join(root, "task-worktrees", "original-task");
		const gitDirectory = await restoreLinkedTaskWorktreeFromFrozenSnapshot(
			root,
			base.repositoryPath,
			archive,
			worktree,
			snapshot,
		);
		expect(
			base
				.runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { workingDirectoryPath: worktree })
				.stdout.trim(),
		).toBe(join(base.repositoryPath, ".git"));
		expect(base.runGit(["rev-parse", "--abbrev-ref", "HEAD"], { workingDirectoryPath: worktree }).stdout.trim()).toBe(
			"HEAD",
		);
		expect(readFileSync(join(gitDirectory, "index"))).toEqual(readFileSync(join(archive, "source-git-index")));
		expect(base.runGit(["show", ":staged.txt"], { workingDirectoryPath: worktree }).stdout).toBe("暂存\n");
		expect(readFileSync(join(worktree, "staged.txt"), "utf8")).toBe("未暂存\n");
		expect(existsSync(join(worktree, "deleted.txt"))).toBe(false);
		expect(readlinkSync(join(worktree, "relative-link"))).toBe("staged.txt");
		expect(statSync(join(worktree, "executable.sh")).mode & 0o111).toBe(0o111);
		expect(readFileSync(join(worktree, "untracked.bin"))).toEqual(Buffer.from([0, 13, 255]));
		expect(readFileSync(join(worktree, "ignored-artifact.txt"), "utf8")).toBe("保留 ignored 成果\n");
		expect(readFileSync(join(base.repositoryPath, "base-background.txt"), "utf8")).toBe("base 背景 WIP\n");
		expect(existsSync(join(worktree, "base-background.txt"))).toBe(false);
		if (!snapshot.sharedIndexName) throw new Error("测试必须实际生成 split index");
		expect(readFileSync(join(gitDirectory, snapshot.sharedIndexName))).toEqual(
			readFileSync(join(archive, "source-git-shared-index")),
		);
		expect(
			await restoreLinkedTaskWorktreeFromFrozenSnapshot(root, base.repositoryPath, archive, worktree, snapshot),
		).toBe(gitDirectory);
		await expect(
			restoreLinkedTaskWorktreeFromFrozenSnapshot(
				root,
				base.repositoryPath,
				archive,
				originalTask.worktreePath,
				snapshot,
			),
		).rejects.toThrow();
		writeFileSync(join(worktree, "staged.txt"), "后续真实工作\n");
		await expect(
			restoreLinkedTaskWorktreeFromFrozenSnapshot(root, base.repositoryPath, archive, worktree, snapshot),
		).rejects.toThrow("漂移");
		expect(readFileSync(join(worktree, "staged.txt"), "utf8")).toBe("后续真实工作\n");
		await assertSourceGitWorkingStateMatchesSnapshot(originalTask.worktreePath, archive);
		await assertSourceGitWorkingStateMatchesSnapshot(source.repositoryPath, baseArchive);
	});
});
