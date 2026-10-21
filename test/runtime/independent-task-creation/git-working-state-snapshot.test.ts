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
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	captureSourceGitWorkingState,
	restoreSourceGitWorkingState,
} from "../../../src/independent-task-creation/git-working-state-snapshot";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("独立任务的 Git 工作状态复制", () => {
	it("保留未合入提交、分开的 index/工作文件、删除、新文件和二进制，来源不变", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "source", initialBranchName: "main" });
		writeFileSync(join(repo.repositoryPath, "file.txt"), "base\n");
		writeFileSync(join(repo.repositoryPath, "deleted.txt"), "old\n");
		repo.commitAllRepositoryFilesAtDate({ message: "初始版本", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
		repo.runGit(["branch", "source-task"]);
		repo.runGit(["switch", "source-task"]);
		writeFileSync(join(repo.repositoryPath, "committed.txt"), "task commit\n");
		repo.commitAllRepositoryFilesAtDate({ message: "任务提交", authorAndCommitterIsoDate: "2026-01-02T00:00:00Z" });
		writeFileSync(join(repo.repositoryPath, "file.txt"), "staged\n");
		repo.runGit(["add", "file.txt"]);
		writeFileSync(join(repo.repositoryPath, "file.txt"), "unstaged\n");
		repo.runGit(["rm", "deleted.txt"]);
		writeFileSync(join(repo.repositoryPath, "binary.bin"), Buffer.from([0, 1, 255, 0]));
		const before = repo.runGit(["status", "--porcelain=v1"]).stdout;
		const artifact = join(fixture.fixtureRootDirectoryPath, "persistent-source-snapshot");
		mkdirSync(artifact);
		const snapshot = await captureSourceGitWorkingState(repo.repositoryPath, artifact);
		const target = repo.createLinkedWorktree({
			worktreeDirectoryName: "destination",
			branchName: "destination-task",
			startPoint: snapshot.headCommit,
		});
		await restoreSourceGitWorkingState(target.worktreePath, artifact);
		expect(repo.runGit(["status", "--porcelain=v1"]).stdout).toBe(before);
		expect(repo.runGit(["status", "--porcelain=v1"], { workingDirectoryPath: target.worktreePath }).stdout).toBe(
			before,
		);
		expect(repo.runGit(["show", ":file.txt"], { workingDirectoryPath: target.worktreePath }).stdout).toBe("staged\n");
		expect(readFileSync(join(target.worktreePath, "file.txt"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(target.worktreePath, "binary.bin"))).toEqual(Buffer.from([0, 1, 255, 0]));
	});
	it("复制 split index、重命名、符号链接和执行位，处理文件与目录互换并排除 ignored 文件", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({
			repositoryDirectoryName: "source-kinds",
			initialBranchName: "main",
		});
		writeFileSync(join(repo.repositoryPath, ".gitignore"), "ignored.secret\n");
		writeFileSync(join(repo.repositoryPath, "file-to-directory"), "base");
		mkdirSync(join(repo.repositoryPath, "directory-to-file"));
		writeFileSync(join(repo.repositoryPath, "directory-to-file", "old"), "base");
		writeFileSync(join(repo.repositoryPath, "rename-source"), "rename");
		writeFileSync(join(repo.repositoryPath, "executable"), "script");
		repo.commitAllRepositoryFilesAtDate({ message: "初始结构", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
		rmSync(join(repo.repositoryPath, "file-to-directory"));
		mkdirSync(join(repo.repositoryPath, "file-to-directory"));
		writeFileSync(join(repo.repositoryPath, "file-to-directory", "new"), "nested");
		rmSync(join(repo.repositoryPath, "directory-to-file"), { recursive: true });
		writeFileSync(join(repo.repositoryPath, "directory-to-file"), "replacement");
		repo.runGit(["mv", "rename-source", "renamed"]);
		chmodSync(join(repo.repositoryPath, "executable"), 0o755);
		symlinkSync("renamed", join(repo.repositoryPath, "symbolic-link"));
		writeFileSync(join(repo.repositoryPath, "ignored.secret"), "不可复制");
		repo.runGit(["add", "."]);
		repo.runGit(["update-index", "--split-index"]);
		const before = repo.runGit(["status", "--porcelain=v1"]).stdout;
		const artifact = join(fixture.fixtureRootDirectoryPath, "snapshot-kinds");
		const snapshot = await captureSourceGitWorkingState(repo.repositoryPath, artifact);
		const target = repo.createLinkedWorktree({
			worktreeDirectoryName: "target-kinds",
			branchName: "target-kinds",
			startPoint: snapshot.headCommit,
		});
		await restoreSourceGitWorkingState(target.worktreePath, artifact);
		expect(repo.runGit(["status", "--porcelain=v1"], { workingDirectoryPath: target.worktreePath }).stdout).toBe(
			before,
		);
		expect(repo.runGit(["status", "--porcelain=v1"]).stdout).toBe(before);
		expect(readlinkSync(join(target.worktreePath, "symbolic-link"))).toBe("renamed");
		expect(readFileSync(join(target.worktreePath, "file-to-directory", "new"), "utf8")).toBe("nested");
		expect(readFileSync(join(target.worktreePath, "directory-to-file"), "utf8")).toBe("replacement");
		expect(statSync(join(target.worktreePath, "executable")).mode & 0o111).toBe(0o111);
		expect(existsSync(join(target.worktreePath, "ignored.secret"))).toBe(false);
	});
});
