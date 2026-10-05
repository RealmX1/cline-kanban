// 以 detached + `--daemonize` 拉起当前 build 的 agent session PTY host，并等到它的 socket 可连接。
//
// `--daemonize` 让 host 再 spawn 一次自己后退出，真正的 host 因此被 launchd/init 收养（ppid=1），
// 不在 runtime 的进程树里：runtime 被 kill -9、dev 工具按进程树整棵 kill 时都碰不到它。

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import type { AgentSessionPtyHostLaunchCommand } from "./agent-session-pty-host-build-identity-and-launch-command";

const AGENT_SESSION_PTY_HOST_SOCKET_READINESS_POLL_INTERVAL_MS = 50;
const AGENT_SESSION_PTY_HOST_SOCKET_READINESS_DEADLINE_MS = 10_000;

export interface AgentSessionPtyHostDetachedLaunchRequest {
	launchCommand: AgentSessionPtyHostLaunchCommand;
	socketPath: string;
	hostBuildIdentity: string;
	hostLogFilePath: string;
	hostWorkingDirectoryPath: string;
	// 仅测试用：缩短空闲自退时长。
	idleExitAfterMilliseconds?: number;
}

function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createConnection(socketPath);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
}

export async function launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections(
	request: AgentSessionPtyHostDetachedLaunchRequest,
): Promise<void> {
	const hostArguments = [
		...request.launchCommand.leadingArguments,
		"--daemonize",
		"--socket-path",
		request.socketPath,
		"--host-build-identity",
		request.hostBuildIdentity,
		"--host-log-file-path",
		request.hostLogFilePath,
		...(request.idleExitAfterMilliseconds !== undefined
			? ["--idle-exit-after-ms", String(request.idleExitAfterMilliseconds)]
			: []),
	];
	// 全新 HOME 下 runtime home 此刻可能还不存在；cwd 不存在时 spawn 只会异步报 ENOENT。
	mkdirSync(request.hostWorkingDirectoryPath, { recursive: true });
	let launcherSpawnError: Error | null = null;
	const launcherProcess = spawn(request.launchCommand.executablePath, hostArguments, {
		cwd: request.hostWorkingDirectoryPath,
		detached: true,
		stdio: "ignore",
	});
	// 没有 error 监听时 spawn 失败会变成未捕获异常；记下来，让等待立刻带着真实原因失败，而不是空等到超时。
	launcherProcess.once("error", (error) => {
		launcherSpawnError = error;
	});
	launcherProcess.unref();
	const deadlineEpochMs = Date.now() + AGENT_SESSION_PTY_HOST_SOCKET_READINESS_DEADLINE_MS;
	while (Date.now() < deadlineEpochMs) {
		if (launcherSpawnError !== null) {
			throw new Error(`could not launch agent session pty host: ${(launcherSpawnError as Error).message}`);
		}
		if (await isSocketAcceptingConnections(request.socketPath)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, AGENT_SESSION_PTY_HOST_SOCKET_READINESS_POLL_INTERVAL_MS));
	}
	throw new Error(
		`agent session pty host did not start listening on ${request.socketPath} within ${AGENT_SESSION_PTY_HOST_SOCKET_READINESS_DEADLINE_MS}ms (see ${request.hostLogFilePath})`,
	);
}
