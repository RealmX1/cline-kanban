import type * as NodeChildProcess from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	getWorkspacesRootPath,
	resolveRegisteredWorkspaceScopeByIdWithoutGitProbe,
} from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof NodeChildProcess>();
	return {
		...original,
		spawnSync: vi.fn(() => {
			throw new Error("工作区范围解析不应执行 Git");
		}),
	};
});

afterEach(() => vi.unstubAllEnvs());

describe("登记工作区的无 Git 范围解析", () => {
	it("识别主仓与 worktree 标记，跟踪索引替换、目录和项目删除", async () => {
		const { path: home, cleanup } = createTempDir("registered-workspace-scope-home-");
		onTestFinished(cleanup);
		vi.stubEnv("HOME", home);
		const main = join(home, "registered-project");
		const worktree = join(home, "registered-task-worktree");
		await mkdir(join(main, ".git"), { recursive: true });
		await mkdir(worktree);
		await writeFile(join(worktree, ".git"), "gitdir: /仅作为已登记标记的隔离测试路径");
		await mkdir(getWorkspacesRootPath(), { recursive: true });
		const indexPath = join(getWorkspacesRootPath(), "index.json");
		const entries = {
			main: { repoPath: main, workspaceId: "main" },
			task: { repoPath: worktree, workspaceId: "task" },
		};
		const index = { version: 1, entries, repoPathToId: { [main]: "main", [worktree]: "task" } };
		await writeFile(indexPath, JSON.stringify(index));
		expect(await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe("main")).toEqual(entries.main);
		expect(await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe("task")).toEqual(entries.task);
		expect(await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe("unknown")).toBeNull();
		await rm(join(worktree, ".git"));
		expect(await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe("task")).toBeNull();
		const replacement = join(getWorkspacesRootPath(), "replacement-index.json");
		await writeFile(replacement, JSON.stringify({ version: 1, entries: {}, repoPathToId: {} }));
		await rename(replacement, indexPath);
		expect(await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe("main")).toBeNull();
	});
});
