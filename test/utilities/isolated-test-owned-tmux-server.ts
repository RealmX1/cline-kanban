import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { quoteShellArg } from "../../src/core/shell";

const ALLOWED_TEST_TMUX_COMMANDS = new Set([
	"new-session",
	"new-window",
	"has-session",
	"list-sessions",
	"list-panes",
	"display-message",
	"capture-pane",
	"kill-session",
]);
const TMUX_SESSION_OWNERSHIP_FORMAT = "#{socket_path}\t#{pid}\t#{session_id}";

export function createIsolatedTestOwnedTmuxServer(inheritedEnvironment: NodeJS.ProcessEnv, tmuxExecutable = "tmux") {
	// macOS 的 Unix socket 路径很短；独立短根同时避开继承的 TMPDIR 与 TMUX_TMPDIR。
	const socketDirectoryPath = mkdtempSync(join(realpathSync("/tmp"), "kanban-test-owned-tmux-"));
	const socketDirectoryIdentity = lstatSync(socketDirectoryPath);
	const socketPath = join(socketDirectoryPath, "server.sock");
	const environment: NodeJS.ProcessEnv = { ...inheritedEnvironment, TMUX_TMPDIR: socketDirectoryPath };
	delete environment.TMUX;
	delete environment.TMUX_PANE;

	function executeTmuxCommand(arguments_: readonly string[], expectedExitCodes: readonly number[] = [0]) {
		if (!ALLOWED_TEST_TMUX_COMMANDS.has(arguments_[0] ?? "")) {
			throw new Error("隔离 tmux 只允许显式命令，禁止 server 清理及 socket 重定向");
		}
		const result = spawnSync(tmuxExecutable, ["-S", socketPath, "-f", "/dev/null", ...arguments_], {
			env: environment,
			encoding: "utf8",
			timeout: 30_000,
			killSignal: "SIGKILL",
		});
		if (result.error) throw result.error;
		if (result.status === null || !expectedExitCodes.includes(result.status)) {
			throw new Error(`隔离 tmux ${arguments_[0]} 失败：${result.status}\n${result.stderr}`);
		}
		return { exitCode: result.status, stdout: result.stdout.trim() };
	}

	const initialSessionIdentity = executeTmuxCommand([
		"new-session",
		"-d",
		"-s",
		"isolated-test-server-lifetime",
		"-P",
		"-F",
		TMUX_SESSION_OWNERSHIP_FORMAT,
		`exec ${quoteShellArg(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
	]).stdout;
	const [reportedSocketPath, serverProcessId, initialSessionId] = initialSessionIdentity.split("\t");
	if (reportedSocketPath !== socketPath || !/^\d+$/u.test(serverProcessId) || !/^\$\d+$/u.test(initialSessionId)) {
		throw new Error(`隔离 tmux 未提供可核对的 socket、PID 与会话：${initialSessionIdentity}`);
	}
	const socketIdentity = lstatSync(socketPath);
	let cleanupCompleted = false;

	function assertOwnedSocketIdentity() {
		const currentDirectoryIdentity = lstatSync(socketDirectoryPath);
		const currentSocketIdentity = lstatSync(socketPath);
		if (
			currentDirectoryIdentity.dev !== socketDirectoryIdentity.dev ||
			currentDirectoryIdentity.ino !== socketDirectoryIdentity.ino ||
			!currentDirectoryIdentity.isDirectory() ||
			currentSocketIdentity.dev !== socketIdentity.dev ||
			currentSocketIdentity.ino !== socketIdentity.ino ||
			!currentSocketIdentity.isSocket()
		) {
			throw new Error(`隔离 tmux socket 归属已改变，拒绝操作：${socketPath}`);
		}
	}

	return {
		socketPath,
		environment,
		runTmuxCommand(arguments_: readonly string[], expectedExitCodes?: readonly number[]) {
			assertOwnedSocketIdentity();
			return executeTmuxCommand(arguments_, expectedExitCodes);
		},
		cleanup() {
			if (cleanupCompleted) return;
			assertOwnedSocketIdentity();
			const sessionIdentities = executeTmuxCommand(["list-sessions", "-F", TMUX_SESSION_OWNERSHIP_FORMAT]).stdout;
			for (const sessionIdentity of sessionIdentities.split("\n")) {
				const [currentSocketPath, currentServerProcessId, sessionId] = sessionIdentity.split("\t");
				if (
					currentSocketPath !== socketPath ||
					currentServerProcessId !== serverProcessId ||
					!/^\$\d+$/u.test(sessionId)
				) {
					throw new Error(`隔离 tmux server 或会话归属已改变，拒绝清理：${sessionIdentity}`);
				}
				assertOwnedSocketIdentity();
				executeTmuxCommand(["kill-session", "-t", sessionId]);
			}
			if (executeTmuxCommand(["has-session"], [0, 1]).exitCode !== 1) {
				throw new Error(`隔离 tmux 仍有活会话，保留目录：${socketPath}`);
			}
			rmSync(socketDirectoryPath, { recursive: true });
			cleanupCompleted = true;
		},
	};
}
