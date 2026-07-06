import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getWorkspaceChanges } from "../../../src/workspace/get-workspace-changes";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const gitEnv = createGitTestEnv();

function runGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
}

// 生成一份 old+new 合计远超内联上限（1MB）的大文件内容。
function makeLargeContent(marker: string): string {
	const line = `${marker} ${"x".repeat(80)}\n`;
	return line.repeat(20_000); // ~1.6MB，old+new 合计 ~3.2MB
}

describe("getWorkspaceChanges size limit", () => {
	let repoPath: string;
	let cleanup: () => void;

	beforeEach(() => {
		const temp = createTempDir("kanban-workspace-changes-size-");
		repoPath = temp.path;
		cleanup = temp.cleanup;
		runGit(repoPath, ["init", "-q"]);
		runGit(repoPath, ["config", "user.name", "Test User"]);
		runGit(repoPath, ["config", "user.email", "test@example.com"]);
		writeFileSync(join(repoPath, "huge.txt"), makeLargeContent("base"));
		writeFileSync(join(repoPath, "small.ts"), "const a = 1;\n");
		runGit(repoPath, ["add", "."]);
		runGit(repoPath, ["commit", "-qm", "initial"]);
		// 改动两文件：大文件仍然巨大，小文件保持小。
		writeFileSync(join(repoPath, "huge.txt"), makeLargeContent("changed"));
		writeFileSync(join(repoPath, "small.ts"), "const a = 2;\n");
	});

	afterEach(() => {
		cleanup();
	});

	it("omits full text for oversized files but keeps line stats, and leaves small files intact", async () => {
		const response = await getWorkspaceChanges(repoPath);
		const huge = response.files.find((file) => file.path === "huge.txt");
		const small = response.files.find((file) => file.path === "small.ts");

		expect(huge).toBeDefined();
		expect(huge?.contentOmittedForSize).toBe(true);
		expect(huge?.oldText).toBeNull();
		expect(huge?.newText).toBeNull();
		// additions/deletions 仍从 numstat 带出，供表头显示。
		expect((huge?.additions ?? 0) + (huge?.deletions ?? 0)).toBeGreaterThan(0);

		expect(small).toBeDefined();
		expect(small?.contentOmittedForSize).toBeFalsy();
		// getGitStdout 会 trim 输出，故用 contain 而非严格等值断言。关键是小文件全文被保留、未被省略。
		expect(small?.oldText).toContain("const a = 1;");
		expect(small?.newText).toContain("const a = 2;");
	});
});
