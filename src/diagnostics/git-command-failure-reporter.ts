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
	appendDiagnosticEventToRotatingJsonlJournal("git-command-failure", {
		failureKind: failure.kind,
		errorCode: failure.errorCode,
		signal: failure.signal,
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
	try {
		process.stderr.write(
			`[warn] [git-command-failure] git 子进程未能正常执行（非 git 自身退出码）kind=${failure.kind} errorCode=${failure.errorCode ?? "(none)"} signal=${failure.signal ?? "(none)"} args=${JSON.stringify(context.args)} cwd=${context.cwd}${suppressedSuffix}\n`,
		);
	} catch {
		// Best-effort diagnostic logging only.
	}
}
