import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";
import {
	classifyGitCommandProcessLevelFailure,
	reportGitCommandProcessLevelFailure,
} from "../diagnostics/git-command-failure-reporter";

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
			killed?: unknown;
			signal?: unknown;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
		};
		const rawStdout = String(candidate.stdout ?? "");
		const stdout = options.trimStdout === false ? rawStdout : rawStdout.trim();
		const stderr = String(candidate.stderr ?? "").trim();
		const message = String(candidate.message ?? "").trim();
		const command = `git ${args.join(" ")} failed`;
		// git 自身的非零退出码是本仓的常规控制流；只有进程层失败（spawn errno、被信号杀掉）才既值得
		// 记录、也必须让错误文案带上可 grep 的错误码——否则又会重演「EBADF 全程不出现在任何日志里」。
		const processLevelFailure = classifyGitCommandProcessLevelFailure(candidate);
		const processLevelFailureSuffix =
			processLevelFailure === null
				? ""
				: `\n processLevelFailure=${processLevelFailure.kind} errorCode=${processLevelFailure.errorCode ?? "(none)"} signal=${processLevelFailure.signal ?? "(none)"}`;
		const errorMessage = `Failed to run Git Command: \n Command: \n ${command} \n ${stderr || message}${processLevelFailureSuffix}`;
		const exitCode = normalizeProcessExitCode(candidate.code);
		if (processLevelFailure !== null) {
			reportGitCommandProcessLevelFailure(processLevelFailure, { cwd, args, message });
		}

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
// 保持不导出：只服务本文件单提交的 patch-id 两步管道（按区间批量的走下方 runGitLogPatchesPipedIntoGitStablePatchId）。
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

// `git log -p` 的整段输出随区间线性增长（约两个月、130 个提交的部署区间实测 15MB），读进内存会撞上 runGit 的
// maxBuffer、让整次调用失败。这里不经内存中转：`git log` 的 stdout 直接 pipe 进 `git patch-id --stable` 的 stdin，
// 只收集 patch-id 那份很小的输出（每个提交一行 `<patch-id> <commit-id>`）。
// 任一进程 spawn 失败或非零退出都算失败；一方失败时杀掉另一方，免得 pipe 堵住后永远等不到 close。
async function runGitLogPatchesPipedIntoGitStablePatchId(
	cwd: string,
	gitLogArgs: string[],
): Promise<{ ok: boolean; patchIdStdout: string; stderr: string }> {
	return await new Promise((resolve) => {
		const env = createGitProcessEnv();
		const gitLogProducer = spawn("git", ["-c", "core.quotepath=false", ...gitLogArgs], { cwd, env });
		const gitStablePatchIdConsumer = spawn("git", ["-c", "core.quotepath=false", "patch-id", "--stable"], {
			cwd,
			env,
		});
		let patchIdStdout = "";
		let gitLogStderr = "";
		let gitStablePatchIdStderr = "";
		let gitLogExitCode: number | null | undefined;
		let gitStablePatchIdExitCode: number | null | undefined;
		let resolved = false;
		const finish = (ok: boolean, processSpawnFailureMessage?: string) => {
			if (resolved) {
				return;
			}
			resolved = true;
			resolve({
				ok,
				patchIdStdout,
				stderr: [processSpawnFailureMessage, gitLogStderr.trim(), gitStablePatchIdStderr.trim()]
					.filter(Boolean)
					.join("\n"),
			});
		};
		const finishOnceBothProcessesClosed = () => {
			if (gitLogExitCode === undefined || gitStablePatchIdExitCode === undefined) {
				return;
			}
			finish(gitLogExitCode === 0 && gitStablePatchIdExitCode === 0);
		};
		gitLogProducer.on("error", (error) => {
			gitStablePatchIdConsumer.kill();
			finish(false, error instanceof Error ? error.message : String(error));
		});
		gitStablePatchIdConsumer.on("error", (error) => {
			gitLogProducer.kill();
			finish(false, error instanceof Error ? error.message : String(error));
		});
		gitLogProducer.stderr.on("data", (chunk) => {
			gitLogStderr += chunk.toString();
		});
		gitStablePatchIdConsumer.stderr.on("data", (chunk) => {
			gitStablePatchIdStderr += chunk.toString();
		});
		gitStablePatchIdConsumer.stdout.on("data", (chunk) => {
			patchIdStdout += chunk.toString();
		});
		// patch-id 提前退出时 `git log` 往 pipe 里写会 EPIPE——吞掉，交给两个 close 事件裁决成败。
		gitStablePatchIdConsumer.stdin.on("error", () => {});
		gitLogProducer.stdout.pipe(gitStablePatchIdConsumer.stdin);
		gitLogProducer.on("close", (code) => {
			gitLogExitCode = code;
			finishOnceBothProcessesClosed();
		});
		gitStablePatchIdConsumer.on("close", (code) => {
			gitStablePatchIdExitCode = code;
			// patch-id 异常退出后不再有人读 pipe，`git log` 会堵在写上，必须杀掉它才等得到 close。
			if (code !== 0 && gitLogExitCode === undefined) {
				gitLogProducer.kill();
			}
			finishOnceBothProcessesClosed();
		});
	});
}

/**
 * 一次算出某个提交区间里全部非 merge 提交的 stable patch-id（commitSha → patchId）。与逐个
 * `computeStablePatchId` 结果相同（同一份默认 diff 输出喂 `git patch-id --stable`），但整段区间只起两个 git 进程——
 * 部署归属要对每次部署的 delta 求 patch-id，逐个算会随提交数线性起进程。`git log -p` 的输出流式 pipe 给 patch-id、
 * 不进内存，区间再长也不受 runGit 的 maxBuffer 限制。
 * 无 diff 的提交（空提交）没有输出行，不在返回的 Map 里。git 失败返回 null。
 */
export async function computeStablePatchIdsOfNonMergeCommitsInRevisionRange(
	cwd: string,
	revisionRange: string,
): Promise<Map<string, string> | null> {
	const patchIds = await runGitLogPatchesPipedIntoGitStablePatchId(cwd, [
		"log",
		"-p",
		"--no-merges",
		"--no-color",
		"--no-ext-diff",
		"--format=commit %H",
		revisionRange,
	]);
	if (!patchIds.ok) {
		return null;
	}
	const patchIdByCommitSha = new Map<string, string>();
	for (const line of patchIds.patchIdStdout.split("\n")) {
		const [patchId, commitSha] = line.trim().split(/\s+/);
		if (patchId && commitSha) {
			patchIdByCommitSha.set(commitSha, patchId);
		}
	}
	return patchIdByCommitSha;
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
