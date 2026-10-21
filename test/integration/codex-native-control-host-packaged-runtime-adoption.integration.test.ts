import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { listAgentSessionPtyHostGenerationSocketPaths } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe("打包 runtime 的 Codex 独享控制宿主接管", { timeout: 180_000 }, () => {
	it
		.skipIf(!process.env.KANBAN_CODEX_CONTROL_HOST_PACKAGED_RUNTIME_CLI_PATH || process.platform === "win32")
		.for(["responsive-children", "children-ignore-stop-signals"])(
		"%s：热接管后刷新清理旧代目录，保留另一会话",
		async (failureMode, test) => {
			vi.stubEnv("TMPDIR", "/tmp");
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kch-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "control-host-runtime" });
			await writeFile(join(repository.repositoryPath, "implementation.txt"), "隔离实现\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "隔离初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const executableDirectory = join(fixture.fixtureRootDirectoryPath, "executables");
			await mkdir(executableDirectory);
			await copyFile(
				resolve("test/integration/fixtures/codex-native-control-host-fake-cli.cjs"),
				join(executableDirectory, "codex"),
			);
			await chmod(join(executableDirectory, "codex"), 0o755);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
			const workspace = await loadWorkspaceContext(repository.repositoryPath);
			const taskIds = ["synthetic-host-alpha", "synthetic-host-beta"];
			await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => {
				let board = state.board;
				for (const taskId of taskIds)
					board = addTaskToColumn(
						board,
						"review",
						{
							taskId,
							prompt: "隔离会话",
							startInPlanMode: false,
							baseRef: "main",
							worktreeMode: "inplace",
						},
						() => taskId,
					).board;
				return { board, value: null };
			});
			vi.unstubAllEnvs();
			const reservation = createServer();
			await new Promise<void>((resolveListening) => reservation.listen(0, "127.0.0.1", resolveListening));
			const address = reservation.address();
			if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
			const runtimePort = address.port;
			await new Promise<void>((resolveClosed) => reservation.close(() => resolveClosed()));
			const runtimeIdentity = {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban"),
				runtimePort,
			};
			const codexHomeDirectoryPath = join(fixture.fixtureRootDirectoryPath, "shared-codex-home");
			const environment = fixture.createIsolatedChildProcessEnvironment({
				PATH: `${executableDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
				CODEX_HOME: codexHomeDirectoryPath,
				KANBAN_AGENT_SESSION_PTY_HOST_MODE: "enabled",
				KANBAN_TEST_NATIVE_CONTROL_WS_MODULE_PATH: resolve("node_modules/ws"),
				KANBAN_TEST_NATIVE_CONTROL_RECORDS_DIRECTORY: fixture.fixtureRootDirectoryPath,
				KANBAN_TEST_NATIVE_CONTROL_FAILURE_MODE: failureMode,
				KANBAN_RUNTIME_PORT: String(runtimePort),
				DO_NOT_TRACK: "1",
			});
			const runtimeProcesses: ChildProcess[] = [];
			const startRuntime = async () => {
				const child = children.register(
					spawn(
						process.execPath,
						[
							process.env.KANBAN_CODEX_CONTROL_HOST_PACKAGED_RUNTIME_CLI_PATH ?? "",
							"--port",
							String(runtimePort),
							"--no-open",
						],
						{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe"] },
					),
				);
				runtimeProcesses.push(child);
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				return {
					child,
					client: createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({
								url: `${origin}/api/trpc`,
								headers: { "x-kanban-workspace-id": workspace.workspaceId },
							}),
						],
					}),
				};
			};
			const wait = (condition: () => boolean | Promise<boolean>) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "打包 runtime 完成原生控制宿主启动、接管或清理",
						softDeadlineMsExpectedOnUncontendedHost: 5_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
					},
					condition,
				);
			try {
				const initial = await startRuntime();
				for (const taskId of taskIds) {
					const started = await initial.client.runtime.startTaskSession.mutate({
						taskId,
						prompt: "隔离会话",
						baseRef: "main",
						agentId: "codex",
						worktreeMode: "inplace",
						startInPlanMode: false,
					});
					expect(started.ok, started.error).toBe(true);
					expect(started.summary?.codexNativeSessionControlEndpoint).toBeTruthy();
				}
				await wait(
					async () =>
						(await readFile(join(fixture.fixtureRootDirectoryPath, "process-observations.jsonl"), "utf8"))
							.trim()
							.split("\n").length === 4,
				);
				const before = (await initial.client.workspace.getState.query()).sessions;
				expect(before[taskIds[0]].codexNativeSessionControlEndpoint?.socketPath).not.toBe(
					before[taskIds[1]].codexNativeSessionControlEndpoint?.socketPath,
				);
				expect(await sigkillChildProcessAndWaitForExit(initial.child)).toBe(true);
				const restarted = await startRuntime();
				await wait(
					async () =>
						(await restarted.client.workspace.getState.query()).sessions[taskIds[0]]?.pid ===
						before[taskIds[0]].pid,
				);
				const adopted = (await restarted.client.workspace.getState.query()).sessions;
				// 模拟 CLI 不执行 hook；提供隔离主转录并经真实 API 登记身份，满足共享 cwd 与持久转录预检。
				const recordSyntheticNativeIdentityForRefresh = async (taskId: string) => {
					const nativeSessionId = randomUUID();
					const transcriptPath = join(codexHomeDirectoryPath, "sessions", `rollout-${nativeSessionId}.jsonl`);
					await mkdir(dirname(transcriptPath), { recursive: true });
					await writeFile(
						transcriptPath,
						`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
					);
					const recorded = await restarted.client.hooks.ingest.mutate({
						taskId,
						workspaceId: workspace.workspaceId,
						event: "agent_conversation_session_identity_observed",
						agentNativeConversationSessionIdentity: {
							sourceAgentId: "codex",
							nativeSessionId,
							transcriptPath,
							observedAt: Date.now(),
						},
					});
					expect(recorded.ok, recorded.error).toBe(true);
					expect(
						(await restarted.client.workspace.getState.query()).sessions[taskId]
							.agentNativeConversationSessionIdentity?.nativeSessionId,
					).toBe(nativeSessionId);
				};
				for (const taskId of taskIds) {
					expect(adopted[taskId].runtimeSessionIncarnationId).toBe(before[taskId].runtimeSessionIncarnationId);
					expect(adopted[taskId].codexNativeSessionControlEndpoint).toEqual(
						before[taskId].codexNativeSessionControlEndpoint,
					);
					expect(
						(await stat(adopted[taskId].codexNativeSessionControlEndpoint?.socketPath ?? "")).isSocket(),
					).toBe(true);
				}
				await recordSyntheticNativeIdentityForRefresh(taskIds[0]);
				const fresh = await restarted.client.runtime.refreshTaskTerminal.mutate({ taskId: taskIds[0] });
				expect(fresh.ok, fresh.error).toBe(true);
				const oldLaunchDirectory = join(
					runtimeIdentity.runtimeHomeDirectoryPath,
					"codex-native-session-control-host-launches",
					before[taskIds[0]].runtimeSessionIncarnationId ?? "",
				);
				await wait(async () => {
					const remainingDirectories = await Promise.all(
						[
							stat(dirname(before[taskIds[0]].codexNativeSessionControlEndpoint?.socketPath ?? "")),
							stat(oldLaunchDirectory),
						].map((pending) =>
							pending.then(
								() => true,
								() => false,
							),
						),
					);
					return remainingDirectories.every((exists) => !exists);
				});
				expect(
					(await stat(adopted[taskIds[1]].codexNativeSessionControlEndpoint?.socketPath ?? "")).isSocket(),
				).toBe(true);
				expect(fresh.summary?.codexNativeSessionControlEndpoint?.socketPath).not.toBe(
					before[taskIds[0]].codexNativeSessionControlEndpoint?.socketPath,
				);
				expect(fresh.summary?.runtimeSessionIncarnationId).not.toBe(before[taskIds[0]].runtimeSessionIncarnationId);
				// 监督进程暂停后不能执行 finally；强杀必须由接管时恢复的目录所有权兜底。
				const adoptedBetaPid = adopted[taskIds[1]].pid;
				if (!adoptedBetaPid) throw new Error("隔离接管会话缺少监督进程 PID");
				await recordSyntheticNativeIdentityForRefresh(taskIds[1]);
				process.kill(adoptedBetaPid, "SIGSTOP");
				const refreshedBeta = await restarted.client.runtime.refreshTaskTerminal.mutate({ taskId: taskIds[1] });
				expect(refreshedBeta.ok, refreshedBeta.error).toBe(true);
				await wait(async () => {
					const oldBetaDirectories = [
						dirname(adopted[taskIds[1]].codexNativeSessionControlEndpoint?.socketPath ?? ""),
						join(
							runtimeIdentity.runtimeHomeDirectoryPath,
							"codex-native-session-control-host-launches",
							adopted[taskIds[1]].runtimeSessionIncarnationId ?? "",
						),
					];
					return (
						await Promise.all(
							oldBetaDirectories.map((path) =>
								stat(path).then(
									() => false,
									() => true,
								),
							),
						)
					).every(Boolean);
				});
				expect((await stat(fresh.summary?.codexNativeSessionControlEndpoint?.socketPath ?? "")).isSocket()).toBe(
					true,
				);
				for (const taskId of taskIds) await restarted.client.runtime.stopTaskSession.mutate({ taskId });
				await wait(async () =>
					(
						await Promise.all(
							[fresh, refreshedBeta].map((result) =>
								stat(dirname(result.summary?.codexNativeSessionControlEndpoint?.socketPath ?? "")).then(
									() => false,
									() => true,
								),
							),
						)
					).every(Boolean),
				);
			} finally {
				for (const child of runtimeProcesses) await sigkillChildProcessAndWaitForExit(child);
				for (const socketPath of listAgentSessionPtyHostGenerationSocketPaths(runtimeIdentity)) {
					const controller = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath).catch(
						() => null,
					);
					if (!controller) continue;
					const ownedHostPid = controller.hostHello.hostProcessId;
					controller.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
					await controller.closeAfterFlushingPendingFrames();
					await wait(() => {
						try {
							process.kill(ownedHostPid, 0);
							return false;
						} catch {
							return true;
						}
					});
				}
			}
		},
	);
});
