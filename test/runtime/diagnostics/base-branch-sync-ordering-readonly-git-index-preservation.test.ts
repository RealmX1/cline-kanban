import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeGit } from "../../../scripts/base-branch-sync-ordering-experiment/persistent-experiment-storage";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("实验只读 Git 命令保持原始 index 字节", () => {
	it("完整内容 diff 遇到过期 stat cache 时仍不刷新 index", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "readonly-index-preservation",
			initialBranchName: "main",
		});
		const sourcePath = join(repository.repositoryPath, "unchanged-source.txt");
		writeFileSync(sourcePath, "原始内容\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "固定读取基线",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const indexPath = join(repository.repositoryPath, ".git", "index");
		const originalIndex = readFileSync(indexPath);
		const originalStat = statSync(sourcePath);
		utimesSync(sourcePath, originalStat.atime, new Date(originalStat.mtimeMs + 30_000));
		const difference = await executeGit(repository.repositoryPath, [
			"diff",
			"--binary",
			"--full-index",
			"HEAD",
			"--",
		]);
		expect(difference.toString()).toBe("");
		expect(readFileSync(indexPath)).toEqual(originalIndex);
		expect(readFileSync(sourcePath, "utf8")).toBe("原始内容\n");
	});
});
