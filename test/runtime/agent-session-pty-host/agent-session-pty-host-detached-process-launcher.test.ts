import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-detached-process-launcher";

// 替身 host：在 --socket-path 上监听，第一个连接（launcher 的就绪探测）到来后退出，另有 5s 自杀兜底。
// 不启动真 host，也就不会留下 daemon（测试永不 daemonize host）。`-e` 后要有 `--`，否则 node 会把 launcher
// 追加的 `--daemonize` 当成自己的选项拒绝。
const STAND_IN_HOST_SCRIPT = `
const net = require("node:net");
const socketPath = process.argv[process.argv.indexOf("--socket-path") + 1];
const server = net.createServer((connection) => { connection.destroy(); server.close(); process.exit(0); });
server.listen(socketPath);
setTimeout(() => process.exit(0), 5000).unref();
`;

function createShortTemporaryDirectory(): string {
	// /tmp 下的短目录：macOS 的 sun_path 上限 104 字节。
	const temporaryDirectoryPath = mkdtempSync("/tmp/kphl-");
	onTestFinished(() => rmSync(temporaryDirectoryPath, { recursive: true, force: true }));
	return temporaryDirectoryPath;
}

describe.skipIf(process.platform === "win32")(
	"launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections",
	() => {
		it("creates a missing host working directory instead of failing the spawn", async () => {
			const temporaryDirectoryPath = createShortTemporaryDirectory();
			const missingRuntimeHomeDirectoryPath = join(temporaryDirectoryPath, "fresh-home", ".cline", "kanban");

			await launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections({
				launchCommand: { executablePath: process.execPath, leadingArguments: ["-e", STAND_IN_HOST_SCRIPT, "--"] },
				socketPath: join(temporaryDirectoryPath, "host.sock"),
				hostBuildIdentity: "stand-in",
				hostLogFilePath: join(temporaryDirectoryPath, "host.log"),
				hostWorkingDirectoryPath: missingRuntimeHomeDirectoryPath,
			});

			expect(existsSync(missingRuntimeHomeDirectoryPath)).toBe(true);
		});

		it("rejects with the spawn error instead of waiting out the readiness deadline", async () => {
			const temporaryDirectoryPath = createShortTemporaryDirectory();

			// 确定性判据：错误文案来自 spawn 的 error 事件（「could not launch」），而不是就绪期限耗尽（「did not start listening」）。
			await expect(
				launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections({
					launchCommand: {
						executablePath: join(temporaryDirectoryPath, "missing-node-binary"),
						leadingArguments: [],
					},
					socketPath: join(temporaryDirectoryPath, "host.sock"),
					hostBuildIdentity: "stand-in",
					hostLogFilePath: join(temporaryDirectoryPath, "host.log"),
					hostWorkingDirectoryPath: temporaryDirectoryPath,
				}),
			).rejects.toThrow(/could not launch agent session pty host/);
		});
	},
);
