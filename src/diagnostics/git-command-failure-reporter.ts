// git 子进程「非 git 自身判决」失败的可观测性出口。
//
// 背景：`runGit` 把一切失败折叠成 `{ ok: false, error: <文案> }`，调用方几乎都只看 `ok`，
// 于是**进程层**的失败（spawn 返回 errno、被超时杀掉）与**git 层**的失败（rev-parse 说这
// 不是仓库，退出码 128）在日志里长得一模一样，且两者都不写任何日志。
//
// 代价在一次真实故障里显形：进程 fd 表被耗尽后 `posix_spawn` 建管道直接 EBADF，所有 git 调用
// 全数失败，UI 一律显示「work tree 无法验证」——而全系统没有任何一处记下过 EBADF 这三个字，
// 排障只能从零重建因果链。
//
// 因此这里只记录**进程层**失败：git 自己的非零退出码在本仓是常规控制流（大量探测性命令靠它
// 判断状态），全量记录会把真正的信号淹掉。
//
// 上报同样分两层：JSONL journal 一条不丢（机器读、可事后统计）；stderr 按错误码节流（人读）——
// 因为进程层失败一旦发生往往是系统性的（fd 耗尽时每一条 git 都失败），逐条打印会重演
// 「探针自己刷爆日志」的旧错。

import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";

const GIT_COMMAND_FAILURE_STDERR_THROTTLE_INTERVAL_MS = 60_000;

export type GitCommandProcessLevelFailureKind = "spawn_error" | "killed";

export interface GitCommandProcessLevelFailure {
	kind: GitCommandProcessLevelFailureKind;
	// spawn 层 errno（EBADF / ENOENT / EMFILE …）或 Node 的 ERR_* 码；被信号杀掉时为 null。
	errorCode: string | null;
	signal: string | null;
}

interface GitCommandFailureStderrThrottleState {
	lastEmittedAtEpochMs: number;
	suppressedSinceLastEmitCount: number;
}

const gitCommandFailureStderrThrottleStates = new Map<string, GitCommandFailureStderrThrottleState>();

// git 自身的判决一律是整数退出码；凡是拿不到整数退出码的，都不是 git 说了算，而是进程层出的事。
export function classifyGitCommandProcessLevelFailure(error: {
	code?: string | number | null;
	killed?: unknown;
	signal?: unknown;
}): GitCommandProcessLevelFailure | null {
	const signal = typeof error.signal === "string" ? error.signal : null;
	if (typeof error.code === "string" && !Number.isInteger(Number(error.code))) {
		return { kind: "spawn_error", errorCode: error.code, signal };
	}
	if (error.killed === true) {
		return { kind: "killed", errorCode: typeof error.code === "string" ? error.code : null, signal };
	}
	return null;
}

// Node 的 `spawn` 在**工作目录不存在**时报的也是 ENOENT，错误文案与「找不到可执行文件」完全一致
// （两者都是 `spawn git ENOENT`）。这不是理论歧义：实测抓到的头几条 ENOENT 全都发生在 task worktree
// 目录被创建的同一秒，是「目录还没落地就查它的 HEAD」的竞态，而现场读日志的人只会以为 git 没装。
//
// 定性**不能**靠事后去看目录在不在：那个目录由另一个进程（`git worktree add`）创建，不受本进程事件
// 循环节奏约束，而我们只能在 spawn 失败**之后**才拿到控制权。目录若在这段间隙里落地，事后探测就会
// 报「在」，把读日志的人引向与事实相反的结论——正好是本改动要消除的那种误导。
//
// 因此判决取**不参与竞态的那一侧**：可执行文件能否在 PATH 上解析是稳定量（git 不会在毫秒间装上或
// 卸掉）。git 可解析 ⇒ 这条 ENOENT 只可能出自 cwd，结论无条件成立。事后的目录观测仍照记，但只作旁证，
// 且字段名写明它是「失败之后」的观测。
export type GitCommandSpawnEnoentAttribution =
	| "working_directory_missing_at_spawn_time"
	| "git_executable_not_on_search_path"
	| "undetermined";

export type GitCommandWorkingDirectoryPresence = "present" | "missing" | "undetermined";

export type GitExecutableSearchPathResolution = "resolved" | "unresolved" | "undetermined";

const GIT_EXECUTABLE_FILE_NAME = process.platform === "win32" ? "git.exe" : "git";

// 只读目录项、不 spawn：fd 快耗尽时恰恰是开不出子进程的，靠 `which` 之类反而拿不到答案。
// `stat(2)` 是路径式系统调用，不占用文件描述符，因此这条探测在 fd 耗尽下依然可用。
export function resolveGitExecutableOnSearchPath(): GitExecutableSearchPathResolution {
	const searchPath = process.env.PATH;
	if (!searchPath) {
		return "undetermined";
	}
	// 有候选目录因权限等原因查不动时，不能把「没找到」当成「不存在」——那等于替 PATH 上看不见的
	// 部分下了结论。
	let anyCandidateUnreadable = false;
	for (const searchPathEntry of searchPath.split(delimiter)) {
		if (searchPathEntry === "") {
			continue;
		}
		try {
			if (statSync(join(searchPathEntry, GIT_EXECUTABLE_FILE_NAME)).isFile()) {
				return "resolved";
			}
		} catch (error) {
			const probeErrorCode = (error as NodeJS.ErrnoException | null)?.code;
			if (probeErrorCode !== "ENOENT" && probeErrorCode !== "ENOTDIR") {
				anyCandidateUnreadable = true;
			}
		}
	}
	return anyCandidateUnreadable ? "undetermined" : "unresolved";
}

// 三态而非布尔：路径非法、权限不足等情况下这次探测本身会失败，那时既不能说目录在、也不能说目录
// 不在——谎报成 "missing" 会把排障引向完全错误的方向。
export function probeGitCommandWorkingDirectoryPresence(cwd: string): GitCommandWorkingDirectoryPresence {
	try {
		return statSync(cwd).isDirectory() ? "present" : "missing";
	} catch (error) {
		const probeErrorCode = (error as NodeJS.ErrnoException | null)?.code;
		if (probeErrorCode === "ENOENT" || probeErrorCode === "ENOTDIR") {
			return "missing";
		}
		return "undetermined";
	}
}

// 注意入参是**可执行文件**的解析结果而非目录观测：定性只认不参与竞态的那一侧。
export function deriveGitCommandSpawnEnoentAttribution(
	gitExecutableSearchPathResolution: GitExecutableSearchPathResolution,
): GitCommandSpawnEnoentAttribution {
	if (gitExecutableSearchPathResolution === "resolved") {
		return "working_directory_missing_at_spawn_time";
	}
	if (gitExecutableSearchPathResolution === "unresolved") {
		return "git_executable_not_on_search_path";
	}
	return "undetermined";
}

// 返回本次是否该向 stderr 输出，以及自上次输出以来被压掉的条数（供在告警里如实交代）。
export function decideGitCommandFailureStderrEmission(
	throttleKey: string,
	nowEpochMs: number,
): { shouldEmit: boolean; suppressedSinceLastEmitCount: number } {
	const throttleState = gitCommandFailureStderrThrottleStates.get(throttleKey);
	if (
		throttleState === undefined ||
		nowEpochMs - throttleState.lastEmittedAtEpochMs >= GIT_COMMAND_FAILURE_STDERR_THROTTLE_INTERVAL_MS
	) {
		const suppressedSinceLastEmitCount = throttleState?.suppressedSinceLastEmitCount ?? 0;
		gitCommandFailureStderrThrottleStates.set(throttleKey, {
			lastEmittedAtEpochMs: nowEpochMs,
			suppressedSinceLastEmitCount: 0,
		});
		return { shouldEmit: true, suppressedSinceLastEmitCount };
	}
	throttleState.suppressedSinceLastEmitCount += 1;
	return { shouldEmit: false, suppressedSinceLastEmitCount: throttleState.suppressedSinceLastEmitCount };
}

export function reportGitCommandProcessLevelFailure(
	failure: GitCommandProcessLevelFailure,
	context: { cwd: string; args: string[]; message: string },
): void {
	// 只有 ENOENT 需要消歧，别的错误码（EBADF、EMFILE 等）不必为此多做系统调用。
	const isSpawnEnoent = failure.errorCode === "ENOENT";
	const gitExecutableSearchPathResolution = isSpawnEnoent ? resolveGitExecutableOnSearchPath() : null;
	const spawnEnoentAttribution =
		gitExecutableSearchPathResolution === null
			? null
			: deriveGitCommandSpawnEnoentAttribution(gitExecutableSearchPathResolution);
	// 旁证，不参与定性：它是失败**之后**的观测，目录可能已被另一进程补上（见本文件上方说明）。
	const workingDirectoryPresenceObservedAfterFailure = isSpawnEnoent
		? probeGitCommandWorkingDirectoryPresence(context.cwd)
		: null;

	appendDiagnosticEventToRotatingJsonlJournal("git-command-failure", {
		failureKind: failure.kind,
		errorCode: failure.errorCode,
		signal: failure.signal,
		spawnEnoentAttribution,
		gitExecutableSearchPathResolution,
		workingDirectoryPresenceObservedAfterFailure,
		cwd: context.cwd,
		args: context.args,
		message: context.message,
	});

	const throttleKey = `${failure.kind}:${failure.errorCode ?? failure.signal ?? "unknown"}`;
	const { shouldEmit, suppressedSinceLastEmitCount } = decideGitCommandFailureStderrEmission(throttleKey, Date.now());
	if (!shouldEmit) {
		return;
	}
	const suppressedSuffix =
		suppressedSinceLastEmitCount > 0 ? ` suppressedSinceLastWarning=${suppressedSinceLastEmitCount}` : "";
	// 定性直接写出来，免得读日志的人照着 ENOENT 的字面去查 PATH 里有没有 git。
	const spawnEnoentAttributionSuffix =
		spawnEnoentAttribution === null
			? ""
			: ` spawnEnoentAttribution=${spawnEnoentAttribution} gitExecutableSearchPathResolution=${gitExecutableSearchPathResolution} workingDirectoryPresenceObservedAfterFailure=${workingDirectoryPresenceObservedAfterFailure}`;
	try {
		process.stderr.write(
			`[warn] [git-command-failure] git 子进程未能正常执行（非 git 自身退出码）kind=${failure.kind} errorCode=${failure.errorCode ?? "(none)"} signal=${failure.signal ?? "(none)"}${spawnEnoentAttributionSuffix} args=${JSON.stringify(context.args)} cwd=${context.cwd}${suppressedSuffix}\n`,
		);
	} catch {
		// Best-effort diagnostic logging only.
	}
}
