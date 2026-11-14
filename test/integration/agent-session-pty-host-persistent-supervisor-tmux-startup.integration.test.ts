import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { describe, expect, it } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { listAgentSessionPtyHostGenerationSocketPaths } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import type { AgentSessionPtyHostDiagnostics } from "../../src/core/agent-session-pty-host-diagnostics-contract";
import { quoteShellArg } from "../../src/core/shell";
import { readPosixProcessResourceTable } from "../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createIsolatedTestOwnedTmuxServer } from "../utilities/isolated-test-owned-tmux-server";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

describe.skipIf(
	!process.env.KANBAN_PTY_HOST_PREFERENCE_PACKAGED_RUNTIME_CLI_PATH ||
		!process.env.KANBAN_PTY_HOST_PERSISTENT_SUPERVISOR_SCRIPT_PATH ||
		process.platform !== "darwin",
)("持久 supervisor 经独立 tmux server 恢复", { timeout: 180_000 }, () => {
	it("两代全新 tmux server 清空临时开关后仍读取同一持久关闭选择，健康检查不打断现有服务", async (test) => {
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kph-tmux-startup-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "tmux-restored-runtime" });
		await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离 tmux 启动链\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "隔离 tmux 恢复初始仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const scriptsDirectory = join(repository.repositoryPath, "scripts");
		await mkdir(scriptsDirectory);
		for (const file of [
			"agent-session-pty-host-deployment-evidence.mjs",
			"agent-session-pty-host-legacy-deployment-inventory.mjs",
			"verify-agent-session-pty-host-runtime-readiness.mjs",
		])
			await copyFile(resolve("scripts", file), join(scriptsDirectory, file));
		const reservation = createServer();
		await new Promise<void>((resolveListening) => reservation.listen(0, "127.0.0.1", resolveListening));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("隔离固定端口不可用");
		const runtimePort = address.port;
		await new Promise<void>((resolveClosed) => reservation.close(() => resolveClosed()));
		const runtimeIdentity = {
			runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban"),
			runtimePort,
		};
		await mkdir(runtimeIdentity.runtimeHomeDirectoryPath, { recursive: true });
		const configPath = join(runtimeIdentity.runtimeHomeDirectoryPath, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({ selectedAgentId: "codex", agentSessionPtyHostEnablementPreference: "disabled" }),
		);
		const environment = fixture.createIsolatedChildProcessEnvironment({
			PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
			SHELL: "/bin/sh",
			CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "codex-home"),
			CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "codex-sqlite-home"),
			KANBAN_AGENT_SESSION_PTY_HOST_MODE: undefined,
			KANBAN_DESKTOP: undefined,
			KANBAN_3484_SERVICE_REPOSITORY_DIRECTORY: repository.repositoryPath,
			KANBAN_3484_SERVICE_NODE_EXECUTABLE: process.execPath,
			KANBAN_3484_SERVICE_CLI_ENTRYPOINT: resolve(
				process.env.KANBAN_PTY_HOST_PREFERENCE_PACKAGED_RUNTIME_CLI_PATH ?? "",
			),
			KANBAN_3484_SERVICE_RUNTIME_PORT: String(runtimePort),
			KANBAN_RUNTIME_PORT: String(runtimePort),
			KANBAN_RUNTIME_HOST: "127.0.0.1",
			DO_NOT_TRACK: "1",
		});
		const tmuxExecutable = process.env.KANBAN_PTY_HOST_TEST_TMUX_EXECUTABLE ?? "/opt/homebrew/bin/tmux";
		const supervisorScript = resolve(process.env.KANBAN_PTY_HOST_PERSISTENT_SUPERVISOR_SCRIPT_PATH ?? "");
		const launcherPath = join(fixture.fixtureRootDirectoryPath, "start-isolated-persistent-supervisor.sh");
		await writeFile(launcherPath, `#!/bin/sh\nexec /bin/bash ${quoteShellArg(supervisorScript)}\n`);
		const client = createTRPCProxyClient<RuntimeAppRouter>({
			links: [httpBatchLink({ url: `http://127.0.0.1:${runtimePort}/api/trpc` })],
		});
		const wait = (condition: () => Promise<boolean>) =>
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				test,
				{
					waitedForDescription: "独立 tmux supervisor 恢复 runtime 或退出",
					softDeadlineMsExpectedOnUncontendedHost: 8_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
				},
				condition,
			);
		const reports: AgentSessionPtyHostDiagnostics[] = [];
		const tmuxServers: ReturnType<typeof createIsolatedTestOwnedTmuxServer>[] = [];
		let lastRuntimePid: number | null = null;
		let lastRuntimeProcessStartTimeText: string | null = null;
		const stopOwnedRuntimeIfStillRunning = async () => {
			if (!lastRuntimePid) return;
			if (
				(await readPosixProcessResourceTable()).some(
					(row) =>
						row.processId === lastRuntimePid && row.processStartTimeText === lastRuntimeProcessStartTimeText,
				)
			)
				process.kill(lastRuntimePid, "SIGTERM");
		};
		try {
			for (const _generation of [0, 1]) {
				const tmuxServer = createIsolatedTestOwnedTmuxServer(environment, tmuxExecutable);
				tmuxServers.push(tmuxServer);
				tmuxServer.runTmuxCommand([
					"new-session",
					"-d",
					"-s",
					"isolated-kanban-supervisor",
					"-c",
					repository.repositoryPath,
					`exec /usr/bin/env -u TMUX -u TMUX_PANE /bin/sh ${quoteShellArg(launcherPath)}`,
				]);
				await wait(async () => {
					try {
						return (
							(
								await client.runtime.getAgentSessionPtyHostDiagnostics.query(undefined, {
									signal: AbortSignal.timeout(2_000),
								})
							).newSessionHostingMode === "disabled"
						);
					} catch {
						return false;
					}
				});
				const report = await client.runtime.getAgentSessionPtyHostDiagnostics.query();
				expect(report.startupDecision).toMatchObject({
					persistentPreference: "disabled",
					environmentOverride: null,
					enablementPreferenceSource: "persistent_preference",
				});
				expect(report.runtimeProcessId).not.toBe(lastRuntimePid);
				lastRuntimePid = report.runtimeProcessId;
				lastRuntimeProcessStartTimeText = report.runtimeProcessStartTimeText;
				reports.push(report);
				await wait(async () => {
					const { stdout } = tmuxServer.runTmuxCommand([
						"capture-pane",
						"-p",
						"-S",
						"-200",
						"-t",
						"isolated-kanban-supervisor:0.0",
					]);
					return stdout.includes("HTTP 与实际会话托管状态均已核验");
				});
				if (!lastRuntimePid) throw new Error("隔离 runtime 缺少 PID");
				await stopOwnedRuntimeIfStillRunning();
				await wait(async () => {
					try {
						process.kill(lastRuntimePid ?? 0, 0);
						return false;
					} catch {
						return true;
					}
				});
				tmuxServer.cleanup();
			}
			expect(JSON.parse(await readFile(configPath, "utf8")).agentSessionPtyHostEnablementPreference).toBe(
				"disabled",
			);
			const evidenceDirectory = process.env.KANBAN_PTY_HOST_PREFERENCE_EVIDENCE_DIRECTORY;
			if (evidenceDirectory) {
				await mkdir(evidenceDirectory, { recursive: true });
				await writeFile(
					join(evidenceDirectory, "independent-tmux-supervisor-startup-evidence.json"),
					JSON.stringify(
						{
							reports,
							isolatedTmuxSockets: tmuxServers.map((server) => server.socketPath),
							temporaryEnablementVariableAbsent: true,
						},
						null,
						2,
					),
				);
			}
		} catch (error) {
			const paneEvidence = tmuxServers.map((server) => {
				try {
					return server.runTmuxCommand([
						"capture-pane",
						"-p",
						"-S",
						"-200",
						"-t",
						"isolated-kanban-supervisor:0.0",
					]).stdout;
				} catch (captureError) {
					return String(captureError);
				}
			});
			throw new Error(`隔离 supervisor 验收失败，清理前 pane 输出：\n${paneEvidence.join("\n")}`, { cause: error });
		} finally {
			await stopOwnedRuntimeIfStillRunning();
			for (const tmuxServer of tmuxServers) tmuxServer.cleanup();
			for (const socketPath of listAgentSessionPtyHostGenerationSocketPaths(runtimeIdentity)) {
				const connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath).catch(
					() => null,
				);
				if (connection) {
					connection.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
					await connection.closeAfterFlushingPendingFrames();
				}
			}
		}
	});
});
