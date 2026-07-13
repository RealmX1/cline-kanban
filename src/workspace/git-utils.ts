import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface GitCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	output: string;
	error: string | null;
	exitCode: number;
}

export interface RunGitOptions {
	trimStdout?: boolean;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

function normalizeProcessExitCode(code: unknown): number {
	if (typeof code === "number" && Number.isFinite(code)) {
		return code;
	}
	if (typeof code === "string") {
		const parsed = Number(code);
		if (Number.isInteger(parsed)) {
			return parsed;
		}
	}
	return -1;
}

export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
	try {
		const fullArgs = ["-c", "core.quotepath=false", ...args];
		const { stdout, stderr } = await execFileAsync("git", fullArgs, {
			cwd,
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER_BYTES,
			env: options.env || createGitProcessEnv(),
			...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		});
		const normalizedStdout = String(stdout ?? "").trim();
		const normalizedStderr = String(stderr ?? "").trim();
		return {
			ok: true,
			stdout: options.trimStdout === false ? stdout : normalizedStdout,
			stderr: normalizedStderr,
			output: [normalizedStdout, normalizedStderr].filter(Boolean).join("\n"),
			error: null,
			exitCode: 0,
		};
	} catch (error) {
		const candidate = error as {
			code?: string | number | null;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
		};
		const rawStdout = String(candidate.stdout ?? "");
		const stdout = options.trimStdout === false ? rawStdout : rawStdout.trim();
		const stderr = String(candidate.stderr ?? "").trim();
		const message = String(candidate.message ?? "").trim();
		const command = `git ${args.join(" ")} failed`;
		const errorMessage = `Failed to run Git Command: \n Command: \n ${command} \n ${stderr || message}`;
		const exitCode = normalizeProcessExitCode(candidate.code);

		return {
			ok: false,
			stdout,
			stderr,
			output: [stdout, stderr].filter(Boolean).join("\n"),
			error: errorMessage,
			exitCode,
		};
	}
}

export async function getGitStdout(args: string[], cwd: string, options: RunGitOptions = {}): Promise<string> {
	const result = await runGit(cwd, args, options);
	if (!result.ok) {
		throw new Error(result.error || result.stdout);
	}

	return result.stdout;
}

// `runGit` 走 execFile，无法向 git 的 stdin 灌数据；`git patch-id` 只从 stdin 读 patch，故需一个 spawn 版本。
// 保持不导出：目前唯一用途是 computeStablePatchId 的两步管道。
async function runGitReadingStdin(
	cwd: string,
	args: string[],
	stdin: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return await new Promise((resolve) => {
		const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			env: createGitProcessEnv(),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			resolve({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
		});
		child.on("close", (code) => {
			resolve({ ok: code === 0, stdout, stderr: stderr.trim() });
		});
		// git 可能在读完前关闭 stdin（如空 diff）——吞掉 EPIPE，让 close 事件裁决成败。
		child.stdin.on("error", () => {});
		child.stdin.write(stdin);
		child.stdin.end();
	});
}

/**
 * 计算某个 commit 的 stable patch-id，语义等价 `git show <sha> | git patch-id --stable`。
 * 用于 cherry-pick 后 hash 变更但 patch 相同的等价匹配（部署关联引擎）。
 * 无 diff 的提交（如 merge commit 的 combined diff、空提交）patch-id 无输出，返回 null。
 */
export async function computeStablePatchId(cwd: string, sha: string): Promise<string | null> {
	const show = await runGit(cwd, ["show", sha], { trimStdout: false });
	if (!show.ok || show.stdout.trim() === "") {
		return null;
	}
	const patchId = await runGitReadingStdin(cwd, ["patch-id", "--stable"], show.stdout);
	if (!patchId.ok) {
		return null;
	}
	// 输出形如 `<patch-id> <commit-id>`，取首列。
	const firstToken = patchId.stdout.trim().split(/\s+/)[0];
	return firstToken !== undefined && firstToken !== "" ? firstToken : null;
}

export interface GitHeadInfo {
	branch: string | null;
	headCommit: string | null;
	isDetached: boolean;
}

/**
 * Read the current HEAD commit, branch name, and detached state for a
 * repository (or worktree) at `cwd`.
 */
export async function readGitHeadInfo(cwd: string): Promise<GitHeadInfo> {
	const headResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	const headCommit = headResult.ok ? headResult.stdout : null;
	const branchResult = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = branchResult.ok ? branchResult.stdout : null;
	return {
		branch,
		headCommit,
		isDetached: headCommit !== null && branch === null,
	};
}

export function getGitCommandErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === "string" && stderr.trim()) {
			return stderr.trim();
		}
	}
	return error instanceof Error ? error.message : String(error);
}
