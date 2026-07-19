import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { searchWorkspaceFiles } from "../../src/workspace/search-workspace-files";
import { createIsolatedGitTestWorkspaceFixture } from "../dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture";

describe.sequential("search workspace files runtime", () => {
	it("finds modified tracked files with non-ASCII paths using UTF-8 query text", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "nonascii-tracked-search" });
		const directory = "提出書類";
		const fileName = "設計書.md";
		const relativePath = `${directory}/${fileName}`;
		mkdirSync(join(repository.repositoryPath, directory), { recursive: true });
		writeFileSync(join(repository.repositoryPath, relativePath), "first\n", "utf8");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "add non-ascii tracked file"]);
		writeFileSync(join(repository.repositoryPath, relativePath), "updated\n", "utf8");

		const results = await searchWorkspaceFiles(repository.repositoryPath, "提出", 20);

		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			path: relativePath,
			name: fileName,
			changed: true,
		});
	});

	it("finds untracked files with non-ASCII paths using UTF-8 query text", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "nonascii-untracked-search" });
		const directory = "新規資料";
		const fileName = "メモ.txt";
		const relativePath = `${directory}/${fileName}`;
		mkdirSync(join(repository.repositoryPath, directory), { recursive: true });
		writeFileSync(join(repository.repositoryPath, relativePath), "draft\n", "utf8");

		const results = await searchWorkspaceFiles(repository.repositoryPath, "新規", 20);

		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			path: relativePath,
			name: fileName,
			changed: true,
		});
	});
});
