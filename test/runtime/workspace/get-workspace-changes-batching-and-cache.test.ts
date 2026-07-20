import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../../../src/workspace/get-workspace-changes";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
} from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("getWorkspaceChanges batching + cache", () => {
	let repoPath: string;
	let repository: IsolatedGitTestRepository;

	beforeEach(() => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		repository = fixture.createNonBareRepository({ repositoryDirectoryName: "workspace-changes-batching" });
		repoPath = repository.repositoryPath;
	});

	it("parses a renamed file's batch numstat (pair format) between two refs", async () => {
		writeFileSync(join(repoPath, "a.txt"), "line1\nline2\nline3\nline4\nline5\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "c1"]);
		const fromRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		// rename + 追加一行：相似度足够高，git 检测为 rename（numstat -z 走「空 path + 两条 NUL 路径」的 pair 格式）。
		repository.runGit(["mv", "a.txt", "b.txt"]);
		writeFileSync(join(repoPath, "b.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "c2"]);
		const toRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();

		const response = await getWorkspaceChangesBetweenRefs({ cwd: repoPath, fromRef, toRef });

		expect(response.files).toHaveLength(1);
		const renamed = response.files[0];
		expect(renamed?.path).toBe("b.txt");
		expect(renamed?.previousPath).toBe("a.txt");
		expect(renamed?.status).toBe("renamed");
		// numstat 对该 rename 记录为 +1 / -0（key 取 postimage 路径 b.txt）。
		expect(renamed?.additions).toBe(1);
		expect(renamed?.deletions).toBe(0);
		expect(renamed?.oldText).toContain("line5");
		expect(renamed?.oldText).not.toContain("line6");
		expect(renamed?.newText).toContain("line6");
	});

	it("reports zero additions/deletions for a binary file and toLineCount for an untracked file", async () => {
		const binaryOriginal = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		writeFileSync(join(repoPath, "blob.bin"), binaryOriginal);
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "init"]);
		// 修改二进制文件（tracked，numstat 记为 `-\t-` → {0,0}）。
		writeFileSync(join(repoPath, "blob.bin"), Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 42]));
		// 新增 untracked 文本文件（走 toLineCount 路径，不进 numstat）。
		const untrackedContent = "alpha\nbeta\ngamma\n";
		writeFileSync(join(repoPath, "fresh.txt"), untrackedContent);

		const response = await getWorkspaceChanges(repoPath);

		const binary = response.files.find((file) => file.path === "blob.bin");
		expect(binary).toBeDefined();
		expect(binary?.status).toBe("modified");
		expect(binary?.additions).toBe(0);
		expect(binary?.deletions).toBe(0);

		const untracked = response.files.find((file) => file.path === "fresh.txt");
		expect(untracked).toBeDefined();
		expect(untracked?.status).toBe("untracked");
		expect(untracked?.additions).toBe(untrackedContent.split("\n").length);
		expect(untracked?.deletions).toBe(0);
	});

	it("returns the cached response object on repeat working_copy calls and invalidates on change", async () => {
		writeFileSync(join(repoPath, "tracked.txt"), "one\ntwo\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "init"]);
		writeFileSync(join(repoPath, "tracked.txt"), "one\ntwo\nthree\n");

		const first = await getWorkspaceChanges(repoPath);
		const second = await getWorkspaceChanges(repoPath);
		// 同一引用 ⇔ 命中缓存、未重算（未再 fan-out per-file git 读取）。
		expect(second).toBe(first);

		// 新增一个 untracked 文件 → untracked 输出变化 → stateKey 变化 → 强制 cache miss。
		writeFileSync(join(repoPath, "added.txt"), "new\n");
		const third = await getWorkspaceChanges(repoPath);
		expect(third).not.toBe(first);
		expect(third.files.some((file) => file.path === "added.txt")).toBe(true);
	});

	it("caches between-refs results keyed by the immutable ref pair", async () => {
		writeFileSync(join(repoPath, "x.txt"), "a\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "c1"]);
		const fromRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		writeFileSync(join(repoPath, "x.txt"), "a\nb\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "c2"]);
		const toRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();

		const first = await getWorkspaceChangesBetweenRefs({ cwd: repoPath, fromRef, toRef });
		const second = await getWorkspaceChangesBetweenRefs({ cwd: repoPath, fromRef, toRef });
		expect(second).toBe(first);
		expect(first.files.some((file) => file.path === "x.txt")).toBe(true);
	});

	it("invalidates the between-refs cache when a movable ref moves to new content with unchanged name-status", async () => {
		// 基线是不可变 commit；toRef 是可移动分支 feature。base..feature 恒为 `M m.txt`，
		// 仅内容在两次 feature 提交间变化 → name-status 输出不变、ref 字符串不变，唯有解析后的 SHA 变化。
		writeFileSync(join(repoPath, "m.txt"), "base\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "base"]);
		const baseRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();

		repository.runGit(["checkout", "--quiet", "-b", "feature"]);
		writeFileSync(join(repoPath, "m.txt"), "content-one\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "feature-1"]);

		const first = await getWorkspaceChangesBetweenRefs({ cwd: repoPath, fromRef: baseRef, toRef: "feature" });
		const firstFile = first.files.find((file) => file.path === "m.txt");
		expect(firstFile?.status).toBe("modified");
		expect(firstFile?.newText).toContain("content-one");

		// feature 前进到新提交：文件集合与 name-status 状态字母不变（仍是 `M m.txt`），仅内容改变。
		writeFileSync(join(repoPath, "m.txt"), "content-two\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "feature-2"]);

		const second = await getWorkspaceChangesBetweenRefs({ cwd: repoPath, fromRef: baseRef, toRef: "feature" });
		// ref 移动 → 解析后的 SHA 变化 → stateKey 变化 → 必须重算，不得跨内容误命中旧缓存。
		expect(second).not.toBe(first);
		const secondFile = second.files.find((file) => file.path === "m.txt");
		expect(secondFile?.newText).toContain("content-two");
		expect(secondFile?.newText).not.toContain("content-one");
	});

	it("returns correct, consistent results for many files under concurrent callers (no deadlock/starvation)", async () => {
		// 复现「突发负载」：一个多变更文件的 workspace 被多路请求同时打（多个可见面板 + 轮询）。
		// 全部经共享的模块级并发限流器 fan-out——本用例证明该共享路径在并发下正确、且绝不死锁/饿死。
		const FILE_COUNT = 40;
		for (let index = 0; index < FILE_COUNT; index += 1) {
			writeFileSync(join(repoPath, `file-${String(index).padStart(3, "0")}.txt`), `base-${index}\n`);
		}
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "init"]);
		const fromRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		for (let index = 0; index < FILE_COUNT; index += 1) {
			writeFileSync(
				join(repoPath, `file-${String(index).padStart(3, "0")}.txt`),
				`base-${index}\nchanged-${index}\n`,
			);
		}

		// 混合三种变体的并发请求，全部争用同一个共享 limiter。
		const concurrentResponses = await Promise.all([
			getWorkspaceChanges(repoPath),
			getWorkspaceChanges(repoPath),
			getWorkspaceChangesFromRef({ cwd: repoPath, fromRef }),
			getWorkspaceChangesFromRef({ cwd: repoPath, fromRef }),
			getWorkspaceChanges(repoPath),
			getWorkspaceChangesFromRef({ cwd: repoPath, fromRef }),
		]);

		for (const response of concurrentResponses) {
			expect(response.files).toHaveLength(FILE_COUNT);
			// 每个文件都应带出 +1 的改动，且内容完整。
			for (const file of response.files) {
				expect(file.status).toBe("modified");
				expect(file.additions).toBe(1);
				expect(file.newText).toContain("changed-");
			}
		}
	}, 30_000);

	it("caches from-ref results while the working tree is idle and invalidates on change", async () => {
		writeFileSync(join(repoPath, "y.txt"), "base\n");
		repository.runGit(["add", "."]);
		repository.runGit(["commit", "--quiet", "-m", "c1"]);
		const fromRef = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		writeFileSync(join(repoPath, "y.txt"), "base\nworking-change\n");

		const first = await getWorkspaceChangesFromRef({ cwd: repoPath, fromRef });
		const second = await getWorkspaceChangesFromRef({ cwd: repoPath, fromRef });
		expect(second).toBe(first);

		writeFileSync(join(repoPath, "z.txt"), "brand-new\n");
		const third = await getWorkspaceChangesFromRef({ cwd: repoPath, fromRef });
		expect(third).not.toBe(first);
		expect(third.files.some((file) => file.path === "z.txt")).toBe(true);
	});
});
