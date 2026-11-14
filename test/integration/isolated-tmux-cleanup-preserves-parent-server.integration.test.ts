import { spawn } from "node:child_process";
import { existsSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createIsolatedTestOwnedTmuxServer } from "../utilities/isolated-test-owned-tmux-server";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

describe.skipIf(process.platform === "win32")("隔离 tmux 清理保全父 server", { timeout: 90_000 }, () => {
	const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
	afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

	it.for(["success", "failure", "timeout"])(
		"恶意继承 TMUX，%s 后父 server 的 sentinel 和 PID 不变",
		async (outcome, test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const parentServer = createIsolatedTestOwnedTmuxServer(fixture.createIsolatedChildProcessEnvironment());
			try {
				const parentIdentity = parentServer.runTmuxCommand([
					"display-message",
					"-p",
					"-t",
					"=isolated-test-server-lifetime",
					"#{socket_path},#{pid},0|#{session_id}|#{pane_id}",
				]).stdout;
				const [inheritedTmux, , inheritedPane] = parentIdentity.split("|");
				const executablePath = join(fixture.fixtureRootDirectoryPath, "isolated-tmux-cleanup-child.mjs");
				await build({
					entryPoints: [
						resolve("test/integration/fixtures/isolated-tmux-success-failure-and-timeout-cleanup-child.ts"),
					],
					outfile: executablePath,
					bundle: true,
					platform: "node",
					format: "esm",
					target: "node22",
					logLevel: "silent",
				});
				const environment = fixture.createIsolatedChildProcessEnvironment();
				environment.TMUX = inheritedTmux;
				environment.TMUX_PANE = inheritedPane;
				environment.TMUX_TMPDIR = parentServer.environment.TMUX_TMPDIR;
				const child = children.register(
					spawn(process.execPath, [executablePath, outcome], {
						env: environment,
						stdio: ["ignore", "pipe", "pipe"],
					}),
				);
				let stdout = "";
				let stderr = "";
				let timeoutTerminationTimer: ReturnType<typeof setTimeout> | undefined;
				child.stdout?.on("data", (chunk) => {
					stdout += chunk.toString();
					// 从子测试确认创建完成后起算 watchdog，避免把启动负载误当清理失败。
					if (outcome === "timeout" && stdout.includes("\n") && !timeoutTerminationTimer) {
						timeoutTerminationTimer = setTimeout(() => child.kill("SIGTERM"), 25);
					}
				});
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, child, {
					waitedForDescription: "隔离 tmux 派生验证及其 finally 清理退出",
					softDeadlineMsExpectedOnUncontendedHost: 5_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
				});
				clearTimeout(timeoutTerminationTimer);
				expect(child.exitCode, `${stderr}\n${stdout}`).toBe(
					outcome === "success" ? 0 : outcome === "timeout" ? 143 : 17,
				);
				expect(stdout).toContain("已完成自有会话清理");
				const { socketPath } = JSON.parse(stdout.split("\n")[0]) as { socketPath: string };
				expect(socketPath).not.toBe(parentServer.socketPath);
				expect(existsSync(socketPath)).toBe(false);
				expect(
					parentServer.runTmuxCommand([
						"display-message",
						"-p",
						"-t",
						"=isolated-test-server-lifetime",
						"#{socket_path},#{pid},0|#{session_id}|#{pane_id}",
					]).stdout,
				).toBe(parentIdentity);
			} finally {
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
				parentServer.cleanup();
				fixture.cleanup();
			}
		},
	);

	it("socket 被替换时拒绝清理；恢复原归属后可幂等收尾", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const parentServer = createIsolatedTestOwnedTmuxServer(fixture.createIsolatedChildProcessEnvironment());
		const childServer = createIsolatedTestOwnedTmuxServer(fixture.createIsolatedChildProcessEnvironment());
		const savedSocketPath = `${childServer.socketPath}.original`;
		try {
			expect(() => childServer.runTmuxCommand(["-S", parentServer.socketPath, "kill-server"])).toThrow();
			expect(() => childServer.runTmuxCommand(["kill-server"])).toThrow();
			renameSync(childServer.socketPath, savedSocketPath);
			symlinkSync(parentServer.socketPath, childServer.socketPath);
			try {
				expect(() => childServer.cleanup()).toThrow("归属已改变");
				expect(parentServer.runTmuxCommand(["has-session"]).exitCode).toBe(0);
			} finally {
				unlinkSync(childServer.socketPath);
				renameSync(savedSocketPath, childServer.socketPath);
			}
		} finally {
			childServer.cleanup();
			childServer.cleanup();
			parentServer.cleanup();
			fixture.cleanup();
		}
	});
});
