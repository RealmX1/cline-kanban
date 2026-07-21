import { existsSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import type * as NodeFsPromisesModule from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

const lockedFileSystemMocks = vi.hoisted(() => ({
	withLock: vi.fn(),
	writeTextFileAtomic: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	getRuntimeHomePath: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	loadWorkspaceContext: vi.fn(),
}));

const taskWorktreePathMocks = vi.hoisted(() => ({
	getWorkspaceFolderLabelForWorktreePath: vi.fn(),
	normalizeTaskIdForWorktreePath: vi.fn(),
}));

// 仅 TOCTOU 单测按需覆写:在 resolveTaskCwd 的 pathExists(access) await 返回「真」之前注入并发 setup 登记,
// 复现「pathExists 之后 setup 才登记」的 check-then-act 时序。默认 null 时该包装纯透传真实 access,
// 其余用例(以及本文件其它 describe)完全不受影响。
const nodeFsPromisesTestHooks = vi.hoisted(() => ({
	onAccessBeforeReal: null as ((path: string) => Promise<void> | void) | null,
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

vi.mock("../../src/fs/locked-file-system.js", () => ({
	lockedFileSystem: {
		withLock: lockedFileSystemMocks.withLock,
		writeTextFileAtomic: lockedFileSystemMocks.writeTextFileAtomic,
	},
}));

vi.mock("../../src/state/workspace-state.js", () => ({
	getRuntimeHomePath: workspaceStateMocks.getRuntimeHomePath,
	getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	loadWorkspaceContext: workspaceStateMocks.loadWorkspaceContext,
}));

vi.mock("../../src/workspace/task-worktree-path.js", () => ({
	getWorkspaceFolderLabelForWorktreePath: taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath,
	KANBAN_TASK_WORKTREES_DIR_NAME: "worktrees",
	normalizeTaskIdForWorktreePath: taskWorktreePathMocks.normalizeTaskIdForWorktreePath,
}));

// node:fs/promises 部分 mock:只包装 access(pathExists 依赖它),其余导出透传真实实现。
// 默认行为与真实 access 完全一致;只有装载了 onAccessBeforeReal 钩子的用例才会在 access 返回前注入时序。
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof NodeFsPromisesModule;
	return {
		...actual,
		access: async (path: Parameters<typeof actual.access>[0], mode?: Parameters<typeof actual.access>[1]) => {
			const hook = nodeFsPromisesTestHooks.onAccessBeforeReal;
			if (hook) {
				await hook(typeof path === "string" ? path : path.toString());
			}
			return actual.access(path, mode);
		},
	};
});

import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspacePathInfo,
	removeTaskWorktreeSetupLock,
	resolveTaskCwd,
	TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX,
	TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX,
} from "../../src/workspace/task-worktree";

type ExecFileOptions = {
	cwd?: string;
	encoding?: string;
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
};

function createGitError(message: string): NodeJS.ErrnoException & { stdout: string; stderr: string; code: number } {
	const error = new Error(message) as NodeJS.ErrnoException & { stdout: string; stderr: string };
	Object.assign(error, {
		code: 1,
		stdout: "",
		stderr: message,
	});
	return error as NodeJS.ErrnoException & { stdout: string; stderr: string; code: number };
}

function stripConfigFlags(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c" && i + 1 < args.length) {
			i += 1;
			continue;
		}
		result.push(args[i] as string);
	}
	return result;
}

function getCommandArgs(args: readonly string[], options?: ExecFileOptions): { cwd: string; command: string[] } {
	const cleaned = stripConfigFlags(args);
	if (cleaned[0] === "-C" && typeof cleaned[1] === "string") {
		return {
			cwd: cleaned[1],
			command: cleaned.slice(2),
		};
	}
	if (typeof options?.cwd === "string") {
		return {
			cwd: options.cwd,
			command: cleaned,
		};
	}
	throw new Error(`Unexpected git args: ${args.join(" ")}`);
}

function installTaskWorktreeTestMockDefaults(): void {
	childProcessMocks.execFile.mockReset();
	childProcessMocks.execFilePromise.mockReset();
	lockedFileSystemMocks.withLock.mockReset();
	lockedFileSystemMocks.writeTextFileAtomic.mockReset();
	workspaceStateMocks.getRuntimeHomePath.mockReset();
	workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
	workspaceStateMocks.loadWorkspaceContext.mockReset();
	taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReset();
	taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockReset();

	let lockQueue = Promise.resolve();
	lockedFileSystemMocks.withLock.mockImplementation(async (_request: unknown, operation: () => Promise<unknown>) => {
		const waitForTurn = lockQueue;
		let releaseLock: () => void = () => {};
		lockQueue = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		await waitForTurn;
		try {
			return await operation();
		} finally {
			releaseLock();
		}
	});
	lockedFileSystemMocks.writeTextFileAtomic.mockResolvedValue(undefined);
}

describe.sequential("task-worktree serialization", () => {
	beforeEach(() => {
		installTaskWorktreeTestMockDefaults();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("serializes submodule initialization across concurrent worktree creation", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-lock-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const runtimeHomePath = join(sandboxRoot, "runtime-home");
			const worktreesHomePath = join(sandboxRoot, "worktrees-home");
			mkdirSync(join(repoPath, ".git"), { recursive: true });
			mkdirSync(runtimeHomePath, { recursive: true });
			mkdirSync(worktreesHomePath, { recursive: true });

			workspaceStateMocks.getRuntimeHomePath.mockReturnValue(runtimeHomePath);
			workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
			workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
				repoPath,
			});
			taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
			taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

			const worktreeHeads = new Map<string, string>();
			let activeSubmoduleUpdates = 0;
			let maxConcurrentSubmoduleUpdates = 0;

			childProcessMocks.execFilePromise.mockImplementation(
				async (_file: string, args: readonly string[], options?: ExecFileOptions) => {
					const { cwd, command } = getCommandArgs(args, options);

					if (command[0] === "rev-parse" && command[1] === "--git-common-dir") {
						return {
							stdout: ".git\n",
							stderr: "",
						};
					}

					if (command[0] === "rev-parse" && command[1] === "HEAD") {
						const head = worktreeHeads.get(cwd);
						if (!head) {
							throw createGitError("fatal: not a git repository");
						}
						return {
							stdout: `${head}\n`,
							stderr: "",
						};
					}

					if (command[0] === "rev-parse" && command[1] === "--verify") {
						return {
							stdout: "base-commit\n",
							stderr: "",
						};
					}

					if (command[0] === "worktree" && command[1] === "add") {
						const worktreePath = command[3];
						const commit = command[4] ?? "base-commit";
						if (!worktreePath) {
							throw createGitError("fatal: missing worktree path");
						}
						mkdirSync(worktreePath, { recursive: true });
						writeFileSync(
							join(worktreePath, ".gitmodules"),
							'[submodule "evals/cline-bench"]\n\tpath = evals/cline-bench\n\turl = ../cline-bench\n',
							"utf8",
						);
						worktreeHeads.set(worktreePath, commit);
						return {
							stdout: "",
							stderr: "",
						};
					}

					if (command[0] === "config" && command[1] === "--file") {
						return {
							stdout: "submodule.evals/cline-bench.path evals/cline-bench\n",
							stderr: "",
						};
					}

					if (command[0] === "submodule" && command[1] === "update") {
						activeSubmoduleUpdates += 1;
						maxConcurrentSubmoduleUpdates = Math.max(maxConcurrentSubmoduleUpdates, activeSubmoduleUpdates);
						await new Promise((resolve) => {
							setTimeout(resolve, 25);
						});
						mkdirSync(join(cwd, "evals", "cline-bench"), { recursive: true });
						writeFileSync(join(cwd, "evals", "cline-bench", ".git"), "gitdir: fake\n", "utf8");
						activeSubmoduleUpdates -= 1;
						return {
							stdout: "",
							stderr: "",
						};
					}

					if (command[0] === "ls-files") {
						return {
							stdout: "",
							stderr: "",
						};
					}

					if (command[0] === "rev-parse" && command[1] === "--git-path") {
						return {
							stdout: ".git/info/exclude\n",
							stderr: "",
						};
					}

					throw createGitError(`Unhandled git command: ${command.join(" ")}`);
				},
			);

			const [first, second] = await Promise.all([
				ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-a",
					baseRef: "HEAD",
				}),
				ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-b",
					baseRef: "HEAD",
				}),
			]);

			const firstLockRequest = lockedFileSystemMocks.withLock.mock.calls[0]?.[0] as {
				path: string;
				type: string;
				lockfileName: string;
			};
			expect(first, JSON.stringify(first, null, 2)).toMatchObject({ ok: true, baseCommit: "base-commit" });
			expect(second, JSON.stringify(second, null, 2)).toMatchObject({ ok: true, baseCommit: "base-commit" });
			expect(firstLockRequest).toMatchObject({
				path: join(repoPath, ".git"),
				type: "directory",
				lockfileName: "kanban-task-worktree-setup.lock",
			});
			expect(maxConcurrentSubmoduleUpdates).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("removes the task worktree setup lock from the repository git directory", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-lock-cleanup-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const lockPath = join(repoPath, ".git", "kanban-task-worktree-setup.lock");
			mkdirSync(lockPath, { recursive: true });

			await expect(removeTaskWorktreeSetupLock(repoPath)).resolves.toBe(true);
			expect(existsSync(lockPath)).toBe(false);
			await expect(removeTaskWorktreeSetupLock(repoPath)).resolves.toBe(false);
		} finally {
			cleanup();
		}
	});

	it("returns the workspace repo path for inplace ensure without calling git worktree add", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-inplace-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			mkdirSync(join(repoPath, ".git"), { recursive: true });

			workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({ repoPath });
			workspaceStateMocks.getRuntimeHomePath.mockReturnValue(join(sandboxRoot, "runtime-home"));
			workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(sandboxRoot, "worktrees-home"));
			taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
			taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

			childProcessMocks.execFilePromise.mockImplementation(
				async (_file: string, args: readonly string[], options?: ExecFileOptions) => {
					const { command } = getCommandArgs(args, options);
					if (command[0] === "rev-parse" && command[1] === "HEAD") {
						return { stdout: "deadbeefdeadbeef\n", stderr: "" };
					}
					throw createGitError(`inplace ensure must not run: ${command.join(" ")}`);
				},
			);

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "inplace-task",
				baseRef: "HEAD",
				worktreeMode: "inplace",
			});

			expect(ensured.ok).toBe(true);
			if (ensured.ok) {
				expect(ensured.path).toBe(repoPath);
				expect(ensured.baseCommit).toBe("deadbeefdeadbeef");
			}
			const calls = childProcessMocks.execFilePromise.mock.calls;
			for (const [, args] of calls) {
				const command = stripConfigFlags(args as readonly string[]);
				expect(command).not.toContain("worktree");
			}
		} finally {
			cleanup();
		}
	});

	it("mirrors project-local agent skills (Codex and Claude) into an existing task worktree", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-agent-skills-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const worktreesHomePath = join(sandboxRoot, "worktrees-home");
			const worktreePath = join(worktreesHomePath, "task-agent-skills", "repo");
			const skillsPath = join(repoPath, ".codex", "skills");
			const claudeSkillsPath = join(repoPath, ".claude", "skills");
			mkdirSync(join(repoPath, ".git"), { recursive: true });
			mkdirSync(join(skillsPath, "cline-kanban-local-deploy"), { recursive: true });
			writeFileSync(
				join(skillsPath, "cline-kanban-local-deploy", "SKILL.md"),
				"name: cline-kanban-local-deploy\n",
				"utf8",
			);
			mkdirSync(join(claudeSkillsPath, "cline-kanban-local-deploy"), { recursive: true });
			writeFileSync(
				join(claudeSkillsPath, "cline-kanban-local-deploy", "SKILL.md"),
				"name: cline-kanban-local-deploy\n",
				"utf8",
			);
			mkdirSync(worktreePath, { recursive: true });

			workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({ repoPath });
			workspaceStateMocks.getRuntimeHomePath.mockReturnValue(join(sandboxRoot, "runtime-home"));
			workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
			taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
			taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

			childProcessMocks.execFilePromise.mockImplementation(
				async (_file: string, args: readonly string[], options?: ExecFileOptions) => {
					const { cwd, command } = getCommandArgs(args, options);
					if (cwd === worktreePath && command[0] === "rev-parse" && command[1] === "HEAD") {
						return { stdout: "existing-task-commit\n", stderr: "" };
					}
					if (command[0] === "ls-files") {
						return { stdout: "", stderr: "" };
					}
					if (command[0] === "rev-parse" && command[1] === "--git-path") {
						return { stdout: ".git/info/exclude\n", stderr: "" };
					}
					throw createGitError(`Unhandled git command: ${command.join(" ")}`);
				},
			);

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-agent-skills",
				baseRef: "HEAD",
			});

			expect(ensured.ok).toBe(true);
			expect(readlinkSync(join(worktreePath, ".codex", "skills"))).toBe(skillsPath);
			expect(readlinkSync(join(worktreePath, ".claude", "skills"))).toBe(claudeSkillsPath);
			expect(childProcessMocks.execFilePromise.mock.calls.some(([, args]) => args.includes("worktree"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("does not delete anything when worktreeMode is inplace", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-inplace-delete-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			mkdirSync(join(repoPath, ".git"), { recursive: true });

			workspaceStateMocks.getRuntimeHomePath.mockReturnValue(join(sandboxRoot, "runtime-home"));
			workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(join(sandboxRoot, "worktrees-home"));
			taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

			childProcessMocks.execFilePromise.mockImplementation(async (_file: string, args: readonly string[]) => {
				const command = stripConfigFlags(args as readonly string[]);
				throw createGitError(`inplace delete must not run: ${command.join(" ")}`);
			});

			const result = await deleteTaskWorktree({
				repoPath,
				taskId: "inplace-task",
				worktreeMode: "inplace",
			});

			expect(result).toEqual({ ok: true, removed: false });
			expect(childProcessMocks.execFilePromise).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe.sequential("task worktree setup readiness gating", () => {
	beforeEach(() => {
		installTaskWorktreeTestMockDefaults();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function setupSandboxWorkspaceMocks(sandboxRoot: string): { repoPath: string; worktreesHomePath: string } {
		const repoPath = join(sandboxRoot, "repo");
		const runtimeHomePath = join(sandboxRoot, "runtime-home");
		const worktreesHomePath = join(sandboxRoot, "worktrees-home");
		mkdirSync(join(repoPath, ".git"), { recursive: true });
		mkdirSync(runtimeHomePath, { recursive: true });
		mkdirSync(worktreesHomePath, { recursive: true });

		workspaceStateMocks.getRuntimeHomePath.mockReturnValue(runtimeHomePath);
		workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
		workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({ repoPath });
		taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
		taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

		return { repoPath, worktreesHomePath };
	}

	// 模拟 `git worktree add` 的非原子中间态：目录已建、HEAD 已写（rev-parse HEAD 可成功），
	// 但命令本身挂在 deferred 上——对应真实 git 正在铺工作树文件的窗口。
	function installFrozenWorktreeAddGitMocks(options: { failWorktreeAdd?: boolean }): {
		worktreeAddReached: { promise: Promise<void>; resolve: () => void };
		releaseWorktreeAdd: { promise: Promise<void>; resolve: () => void };
		getWorktreeAddCallCount: () => number;
	} {
		const worktreeHeads = new Map<string, string>();
		const worktreeAddReached = createDeferred();
		const releaseWorktreeAdd = createDeferred();
		let worktreeAddCallCount = 0;

		childProcessMocks.execFilePromise.mockImplementation(
			async (_file: string, args: readonly string[], execOptions?: ExecFileOptions) => {
				const { cwd, command } = getCommandArgs(args, execOptions);

				if (command[0] === "rev-parse" && command[1] === "--git-common-dir") {
					return { stdout: ".git\n", stderr: "" };
				}
				if (command[0] === "rev-parse" && command[1] === "HEAD") {
					const head = worktreeHeads.get(cwd);
					if (!head) {
						throw createGitError("fatal: not a git repository");
					}
					return { stdout: `${head}\n`, stderr: "" };
				}
				if (command[0] === "rev-parse" && command[1] === "--verify") {
					return { stdout: "base-commit\n", stderr: "" };
				}
				if (command[0] === "worktree" && command[1] === "prune") {
					return { stdout: "", stderr: "" };
				}
				if (command[0] === "worktree" && command[1] === "add") {
					worktreeAddCallCount += 1;
					if (options.failWorktreeAdd) {
						throw createGitError("fatal: could not create work tree");
					}
					const addedWorktreePath = command[3];
					const commit = command[4] ?? "base-commit";
					if (!addedWorktreePath) {
						throw createGitError("fatal: missing worktree path");
					}
					mkdirSync(addedWorktreePath, { recursive: true });
					worktreeHeads.set(addedWorktreePath, commit);
					worktreeAddReached.resolve();
					await releaseWorktreeAdd.promise;
					return { stdout: "", stderr: "" };
				}
				if (command[0] === "ls-files") {
					return { stdout: "", stderr: "" };
				}
				if (command[0] === "rev-parse" && command[1] === "--git-path") {
					return { stdout: ".git/info/exclude\n", stderr: "" };
				}
				throw createGitError(`Unhandled git command: ${command.join(" ")}`);
			},
		);

		return {
			worktreeAddReached,
			releaseWorktreeAdd,
			getWorktreeAddCallCount: () => worktreeAddCallCount,
		};
	}

	it("treats a worktree as not ready for readers while its setup is still in progress", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-readiness-");
		try {
			const { repoPath, worktreesHomePath } = setupSandboxWorkspaceMocks(sandboxRoot);
			const worktreePath = join(worktreesHomePath, "task-readiness", "repo");
			const { worktreeAddReached, releaseWorktreeAdd } = installFrozenWorktreeAddGitMocks({});

			const ensurePromise = ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-readiness",
				baseRef: "HEAD",
			});
			await worktreeAddReached.promise;

			// 目录已存在（pathExists 为真），但 setup 未完成:读侧必须视为未就绪。
			expect(existsSync(worktreePath)).toBe(true);
			await expect(
				getTaskWorkspacePathInfo({ cwd: repoPath, taskId: "task-readiness", baseRef: "HEAD" }),
			).resolves.toMatchObject({ exists: false, path: worktreePath });
			await expect(
				resolveTaskCwd({ cwd: repoPath, taskId: "task-readiness", baseRef: "HEAD", ensure: false }),
			).rejects.toThrow(TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX);

			releaseWorktreeAdd.resolve();
			await expect(ensurePromise).resolves.toMatchObject({ ok: true, path: worktreePath });

			await expect(
				getTaskWorkspacePathInfo({ cwd: repoPath, taskId: "task-readiness", baseRef: "HEAD" }),
			).resolves.toMatchObject({ exists: true, path: worktreePath });
			await expect(
				resolveTaskCwd({ cwd: repoPath, taskId: "task-readiness", baseRef: "HEAD", ensure: false }),
			).resolves.toBe(worktreePath);
		} finally {
			cleanup();
		}
	});

	it("re-checks the setup marker after pathExists so a setup registered mid-probe is not returned as ready", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-toctou-");
		const concurrentEnsure: { promise?: ReturnType<typeof ensureTaskWorktreeIfDoesntExist> } = {};
		try {
			const { repoPath, worktreesHomePath } = setupSandboxWorkspaceMocks(sandboxRoot);
			const worktreePath = join(worktreesHomePath, "task-toctou", "repo");
			const { worktreeAddReached, releaseWorktreeAdd } = installFrozenWorktreeAddGitMocks({});

			// 复现 check-then-act 的关键时序:resolveTaskCwd 先做 pre-check(此刻 registry 尚未登记,放行),
			// 随后进入 pathExists 的 access await。我们只在该 access 返回「真」之前才启动并发 ensure——
			// 它会 markTaskWorktreeSetupInProgress 并 `git worktree add` 建出半 checkout 目录(pathExists 转真)。
			// 这样 setup 恰好登记在 pathExists 之后,精确命中修复前缺失的复查窗口。
			nodeFsPromisesTestHooks.onAccessBeforeReal = async (path) => {
				if (concurrentEnsure.promise || path !== worktreePath) {
					return;
				}
				concurrentEnsure.promise = ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-toctou",
					baseRef: "HEAD",
				});
				// 等并发 ensure 走到冻结的 `git worktree add`:此刻 setup 已登记且半 checkout 目录已建。
				await worktreeAddReached.promise;
			};

			// 修复后:pathExists 返回真之后复查标记,命中 setup-in-progress 并抛错,而不是返回半 checkout 路径。
			await expect(
				resolveTaskCwd({ cwd: repoPath, taskId: "task-toctou", baseRef: "HEAD", ensure: false }),
			).rejects.toThrow(TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX);
			expect(concurrentEnsure.promise).toBeDefined();

			// 收尾:放行并发 ensure,worktree 就绪(标记清除)后读侧恢复正常返回。
			releaseWorktreeAdd.resolve();
			if (!concurrentEnsure.promise) {
				throw new Error("并发 ensure 未被触发,时序前提不成立");
			}
			await expect(concurrentEnsure.promise).resolves.toMatchObject({ ok: true, path: worktreePath });
			await expect(
				resolveTaskCwd({ cwd: repoPath, taskId: "task-toctou", baseRef: "HEAD", ensure: false }),
			).resolves.toBe(worktreePath);
		} finally {
			nodeFsPromisesTestHooks.onAccessBeforeReal = null;
			cleanup();
		}
	});

	it("queues a concurrent ensure behind the in-progress setup instead of trusting the half-checked-out worktree", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-concurrent-ensure-");
		try {
			const { repoPath, worktreesHomePath } = setupSandboxWorkspaceMocks(sandboxRoot);
			const worktreePath = join(worktreesHomePath, "task-concurrent", "repo");
			const { worktreeAddReached, releaseWorktreeAdd, getWorktreeAddCallCount } = installFrozenWorktreeAddGitMocks(
				{},
			);

			const completionOrder: string[] = [];
			const firstEnsurePromise = ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-concurrent",
				baseRef: "HEAD",
			}).then((result) => {
				completionOrder.push("first");
				return result;
			});
			await worktreeAddReached.promise;

			// 此刻半 checkout 的 worktree 已能通过 rev-parse HEAD;第二个 ensure 不得走快速路径直接返回它。
			const secondEnsurePromise = ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-concurrent",
				baseRef: "HEAD",
			}).then((result) => {
				completionOrder.push("second");
				return result;
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
			expect(completionOrder).toEqual([]);
			expect(getWorktreeAddCallCount()).toBe(1);

			releaseWorktreeAdd.resolve();
			const [firstResult, secondResult] = await Promise.all([firstEnsurePromise, secondEnsurePromise]);
			expect(firstResult).toMatchObject({ ok: true, path: worktreePath });
			expect(secondResult).toMatchObject({ ok: true, path: worktreePath });
			expect(completionOrder).toEqual(["first", "second"]);
			expect(getWorktreeAddCallCount()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("clears the setup-in-progress marker when worktree creation fails", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-worktree-setup-failure-");
		try {
			const { repoPath } = setupSandboxWorkspaceMocks(sandboxRoot);
			installFrozenWorktreeAddGitMocks({ failWorktreeAdd: true });

			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-setup-failure",
				baseRef: "HEAD",
			});
			expect(ensured.ok).toBe(false);

			// 标记未泄漏:读侧回到「不存在」判定,而不是永远卡在「正在创建」。
			await expect(
				getTaskWorkspacePathInfo({ cwd: repoPath, taskId: "task-setup-failure", baseRef: "HEAD" }),
			).resolves.toMatchObject({ exists: false });
			await expect(
				resolveTaskCwd({ cwd: repoPath, taskId: "task-setup-failure", baseRef: "HEAD", ensure: false }),
			).rejects.toThrow(TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX);
		} finally {
			cleanup();
		}
	});
});
