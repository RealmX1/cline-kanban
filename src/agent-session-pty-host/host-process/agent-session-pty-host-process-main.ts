// agent session PTY host 进程的主逻辑。入口文件 agent-session-pty-host-process-entry.ts 只负责调用它并注入进程退出函数
// （src/ 下只有进程入口允许直接退出进程）。
//
// host 持有 agent 会话的 PTY master，与 runtime 进程解耦：runtime 重启、崩溃、被 kill -9 时 agent 都不会收到 SIGHUP。
//
// 进程形态：
// - `--daemonize`：二次 spawn 一个 detached 的自己后立即退出，于是真正的 host 的父进程是 launchd/init（ppid=1），
//   不在 runtime 的进程树里，dev:full 之类按进程树整棵 kill 的工具碰不到它。测试永远不带这个参数。
// - 忽略 SIGINT / SIGTERM / SIGHUP：host 的 argv 里含 `cline-kanban`，`pkill -f kanban` 会误伤它，
//   而 host 一死所有 agent 一起死。终止会话只认协议消息（显式全停）与孤儿回收。系统关机的 SIGKILL 照常生效。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`、`node-pty`、wire-protocol 与同目录模块。

import { spawn as spawnChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as pty from "node-pty";
import { AgentSessionPtyHostControllerSocketServer } from "./agent-session-pty-host-controller-socket-server";
import type { HostedPtyProcess, SpawnHostedPtyProcess } from "./agent-session-pty-host-hosted-session-registry";

const DEFAULT_IDLE_EXIT_AFTER_MILLISECONDS = 60_000;
// EXPERIMENT_NODE: runtime 不在、会话都已退出时，退出记录等新 runtime 来取的时长；太短会丢退出码，太长会让空 host 常驻。
const DEFAULT_UNACKNOWLEDGED_EXIT_RECORD_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;

interface AgentSessionPtyHostProcessArguments {
	socketPath: string;
	hostBuildIdentity: string;
	hostLogFilePath: string | null;
	idleExitAfterMilliseconds: number;
	unacknowledgedExitRecordRetentionMilliseconds: number;
	daemonize: boolean;
}

function readCommandLineOptionValue(argv: readonly string[], optionName: string): string | null {
	const optionIndex = argv.indexOf(optionName);
	if (optionIndex < 0) {
		return null;
	}
	return argv[optionIndex + 1] ?? null;
}

function readPositiveIntegerCommandLineOption(argv: readonly string[], optionName: string, fallback: number): number {
	const rawValue = readCommandLineOptionValue(argv, optionName);
	const parsedValue = rawValue === null ? Number.NaN : Number(rawValue);
	return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

export function parseAgentSessionPtyHostProcessArguments(argv: readonly string[]): AgentSessionPtyHostProcessArguments {
	const socketPath = readCommandLineOptionValue(argv, "--socket-path");
	const hostBuildIdentity = readCommandLineOptionValue(argv, "--host-build-identity");
	if (!socketPath || !hostBuildIdentity) {
		throw new Error("agent session pty host requires --socket-path and --host-build-identity");
	}
	return {
		socketPath,
		hostBuildIdentity,
		hostLogFilePath: readCommandLineOptionValue(argv, "--host-log-file-path"),
		idleExitAfterMilliseconds: readPositiveIntegerCommandLineOption(
			argv,
			"--idle-exit-after-ms",
			DEFAULT_IDLE_EXIT_AFTER_MILLISECONDS,
		),
		unacknowledgedExitRecordRetentionMilliseconds: readPositiveIntegerCommandLineOption(
			argv,
			"--unacknowledged-exit-record-retention-ms",
			DEFAULT_UNACKNOWLEDGED_EXIT_RECORD_RETENTION_MILLISECONDS,
		),
		daemonize: argv.includes("--daemonize"),
	};
}

function createHostLogAppender(hostLogFilePath: string | null): (entry: Record<string, unknown>) => void {
	if (hostLogFilePath === null) {
		return () => {};
	}
	try {
		mkdirSync(dirname(hostLogFilePath), { recursive: true, mode: 0o700 });
	} catch {
		// 写日志失败不影响 host 工作。
	}
	return (entry) => {
		try {
			appendFileSync(
				hostLogFilePath,
				`${JSON.stringify({ at: new Date().toISOString(), hostProcessId: process.pid, ...entry })}\n`,
				{ mode: 0o600 },
			);
		} catch {
			// 同上。
		}
	};
}

const spawnHostedPtyProcessWithNodePty: SpawnHostedPtyProcess = (request) => {
	const ptyProcess = pty.spawn(request.binary, request.args, {
		name: request.terminalName,
		cwd: request.cwd,
		env: request.env,
		cols: request.cols,
		rows: request.rows,
		encoding: null,
	});
	return ptyProcess as unknown as HostedPtyProcess;
};

function relaunchAsDetachedDaemonAndExit(argv: readonly string[], exitProcess: (exitCode: number) => void): void {
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		throw new Error("cannot daemonize agent session pty host: unknown script path");
	}
	const argumentsWithoutDaemonizeFlag = argv.filter((argument) => argument !== "--daemonize");
	const daemonProcess = spawnChildProcess(
		process.execPath,
		[...process.execArgv, scriptPath, ...argumentsWithoutDaemonizeFlag],
		{ detached: true, stdio: "ignore" },
	);
	daemonProcess.unref();
	exitProcess(0);
}

export async function runAgentSessionPtyHostProcess(
	argv: readonly string[],
	exitProcess: (exitCode: number) => void,
): Promise<void> {
	const processArguments = parseAgentSessionPtyHostProcessArguments(argv);
	if (processArguments.daemonize) {
		relaunchAsDetachedDaemonAndExit(argv, exitProcess);
		return;
	}
	const appendHostLogEntry = createHostLogAppender(processArguments.hostLogFilePath);
	for (const ignoredSignal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(ignoredSignal, () => {
			appendHostLogEntry({ event: "termination_signal_ignored", signal: ignoredSignal });
		});
	}
	// host 一退出所有 agent 都会被挂断，所以未捕获异常只记录、不退出。
	process.on("uncaughtException", (error) => {
		appendHostLogEntry({ event: "uncaught_exception", message: error.message, stack: error.stack ?? null });
	});
	process.on("unhandledRejection", (reason) => {
		appendHostLogEntry({ event: "unhandled_rejection", message: String(reason) });
	});
	const server = new AgentSessionPtyHostControllerSocketServer({
		socketPath: processArguments.socketPath,
		hostBuildIdentity: processArguments.hostBuildIdentity,
		spawnHostedPtyProcess: spawnHostedPtyProcessWithNodePty,
		idleExitAfterMilliseconds: processArguments.idleExitAfterMilliseconds,
		unacknowledgedExitRecordRetentionMilliseconds: processArguments.unacknowledgedExitRecordRetentionMilliseconds,
		appendHostLogEntry,
		requestHostProcessExit: (exitCode) => {
			// 留一拍让最后的 socket 写出与日志落盘。
			setTimeout(() => exitProcess(exitCode), 50);
		},
	});
	const listenOutcome = await server.listen();
	if (listenOutcome === "another_host_already_listening") {
		appendHostLogEntry({ event: "another_host_already_listening_exiting", socketPath: processArguments.socketPath });
		exitProcess(0);
	}
}
