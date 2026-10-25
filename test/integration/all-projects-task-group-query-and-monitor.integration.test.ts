import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AllProjectsTaskGroupQueryResult } from "../../src/core/all-projects-task-group-query";
import type { RuntimeAllProjectsTaskGroupQuerySnapshot, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { createPersistedTaskSessionFactsCacheForUnloadedProjects } from "../../src/server/persisted-task-session-facts-cache-for-unloaded-projects";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import {
	getPersistedWorkspaceBoardFilePathById,
	getPersistedWorkspaceSessionsFilePathById,
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceSessionsById,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
} from "../../src/state/workspace-state";
import { runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const taskGroupQueryPackagedCliFilePath = process.env.KANBAN_TASK_GROUP_QUERY_TEST_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit(), 30_000);
const cliExitDeadline = {
	waitedForDescription: "全项目任务查询 CLI 退出",
	softDeadlineMsExpectedOnUncontendedHost: 15_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};

describe("全项目分组查询与监控的真实读路径", () => {
	it("损坏看板、会话和最近打开记录均返回不完整，修复后自动恢复；查询不创建运行时会话", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		try {
			const project = fixture.createNonBareRepository({ repositoryDirectoryName: "group-query-read-coverage" });
			const state = await loadWorkspaceState(project.repositoryPath);
			const context = await loadWorkspaceContext(project.repositoryPath);
			await mkdir(context.statePath, { recursive: true });
			const boardPath = getPersistedWorkspaceBoardFilePathById(context.workspaceId);
			const sessionsPath = getPersistedWorkspaceSessionsFilePathById(context.workspaceId);
			const openedPath = join(context.statePath, "task-last-opened-by-user-records.json");
			await writeFile(boardPath, JSON.stringify(state.board));
			await writeFile(sessionsPath, "{}");
			const registry = await createWorkspaceRegistry({
				cwd: fixture.isolatedHomeDirectoryPath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
			});
			const caller = runtimeAppRouter.createCaller({
				requestedWorkspaceId: null,
				kanbanRequestOriginActorEvidence: {},
				projectsApi: { getAllProjectsTaskGroupQuerySnapshot: registry.getAllProjectsTaskGroupQuerySnapshot },
			} as never);
			expect(
				(await caller.projects.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).projects[0]
					.taskEntriesReadStatus,
			).toBe("complete");
			for (const path of [boardPath, sessionsPath, openedPath]) {
				const original = await readFile(path, "utf8").catch(() => "{}");
				await writeFile(path, "损坏的 JSON");
				const failed = await caller.projects.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 });
				expect(failed.projects[0]).toMatchObject({
					taskEntriesReadStatus: "unavailable",
					crossProjectTaskSwitcherEntries: [],
				});
				await writeFile(path, original);
				expect(
					(await caller.projects.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).projects[0]
						.taskEntriesReadStatus,
				).toBe("complete");
			}
			expect(registry.listManagedWorkspaces()).toEqual([]);
			await expect(
				caller.projects.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 99 } as never),
			).rejects.toThrow();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			fixture.cleanup();
		}
	});

	it.each(["原子替换", "原位损坏"])(
		"严格会话读取识别同尺寸保留 mtime 的%s，并在恢复后重新读取",
		async (changeKind) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const previousHome = process.env.HOME;
			process.env.HOME = fixture.isolatedHomeDirectoryPath;
			try {
				const project = fixture.createNonBareRepository({ repositoryDirectoryName: "session-read-integrity" });
				const context = await loadWorkspaceContext(project.repositoryPath);
				await mkdir(context.statePath, { recursive: true });
				const sessionsPath = getPersistedWorkspaceSessionsFilePathById(context.workspaceId);
				const session: RuntimeTaskSessionSummary = {
					taskId: "session-read-task",
					state: "idle",
					agentId: "claude",
					workspacePath: null,
					pid: null,
					startedAt: null,
					updatedAt: 1,
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				};
				const original = JSON.stringify({ [session.taskId]: session });
				const preservedModificationTime = new Date(1_700_000_000_000);
				await writeFile(sessionsPath, original);
				await utimes(sessionsPath, preservedModificationTime, preservedModificationTime);
				const originalStat = await stat(sessionsPath);
				const cache = createPersistedTaskSessionFactsCacheForUnloadedProjects();
				const compatibleFacts = await cache.loadTaskSessionFactsByTaskId(context.workspaceId);
				const strictFacts = await cache.loadTaskSessionFactsByTaskId(context.workspaceId, {
					requireCompleteRead: true,
				});
				expect(strictFacts.get(session.taskId)?.agentId).toBe("claude");
				expect(await cache.loadTaskSessionFactsByTaskId(context.workspaceId, { requireCompleteRead: true })).toBe(
					strictFacts,
				);
				const replacement =
					changeKind === "原子替换"
						? JSON.stringify({ [session.taskId]: { ...session, agentId: "cursor" } })
						: "!".repeat(Buffer.byteLength(original));
				const replacementPath =
					changeKind === "原子替换" ? join(context.statePath, "sessions-replacement.json") : sessionsPath;
				await writeFile(replacementPath, replacement);
				await utimes(replacementPath, preservedModificationTime, preservedModificationTime);
				if (replacementPath !== sessionsPath) await rename(replacementPath, sessionsPath);
				const replacementStat = await stat(sessionsPath);
				expect(replacementStat.size).toBe(originalStat.size);
				expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);
				if (changeKind === "原子替换") {
					expect(
						(await cache.loadTaskSessionFactsByTaskId(context.workspaceId, { requireCompleteRead: true })).get(
							session.taskId,
						)?.agentId,
					).toBe("cursor");
				} else {
					await expect(
						cache.loadTaskSessionFactsByTaskId(context.workspaceId, { requireCompleteRead: true }),
					).rejects.toThrow("sessions.json");
					expect(await cache.loadTaskSessionFactsByTaskId(context.workspaceId)).toBe(compatibleFacts);
				}
				await writeFile(sessionsPath, original);
				await utimes(sessionsPath, preservedModificationTime, preservedModificationTime);
				expect(
					(await cache.loadTaskSessionFactsByTaskId(context.workspaceId, { requireCompleteRead: true })).get(
						session.taskId,
					)?.agentId,
				).toBe("claude");
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				fixture.cleanup();
			}
		},
	);

	it.each(["board.json", "sessions.json", "index.json"])(
		"严格查询拒绝 %s 正文 null，即使宽松读取已缓存空数据；修复后自动恢复",
		async (fileName) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const previousHome = process.env.HOME;
			process.env.HOME = fixture.isolatedHomeDirectoryPath;
			try {
				const project = fixture.createNonBareRepository({ repositoryDirectoryName: "null-json-read-integrity" });
				const state = await loadWorkspaceState(project.repositoryPath);
				const context = await loadWorkspaceContext(project.repositoryPath);
				await mkdir(context.statePath, { recursive: true });
				const boardPath = getPersistedWorkspaceBoardFilePathById(context.workspaceId);
				const sessionsPath = getPersistedWorkspaceSessionsFilePathById(context.workspaceId);
				const indexPath = join(getWorkspacesRootPath(), "index.json");
				await writeFile(boardPath, JSON.stringify(state.board));
				await writeFile(sessionsPath, "{}");
				const registry = await createWorkspaceRegistry({
					cwd: fixture.isolatedHomeDirectoryPath,
					loadGlobalRuntimeConfig: async () => ({}) as never,
					loadRuntimeConfig: async () => ({}) as never,
					hasGitRepository: () => false,
					inspectRuntimeProjectAvailability: async () => ({ status: "available" }),
				});
				const path =
					fileName === "board.json" ? boardPath : fileName === "sessions.json" ? sessionsPath : indexPath;
				const original = await readFile(path, "utf8");
				await writeFile(path, "null");
				if (fileName === "index.json") {
					expect(await listWorkspaceIndexEntries()).toEqual([]);
					for (let attempt = 0; attempt < 2; attempt++) {
						await expect(registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).rejects.toThrow(
							"index.json",
						);
					}
				} else {
					if (fileName === "board.json")
						expect(await loadWorkspaceBoardById(context.workspaceId)).toEqual(state.board);
					else expect(await loadPersistedWorkspaceSessionsById(context.workspaceId)).toEqual({});
					await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
					for (let attempt = 0; attempt < 2; attempt++) {
						expect(
							(await registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).projects[0],
						).toMatchObject({
							taskEntriesReadStatus: "unavailable",
							crossProjectTaskSwitcherEntries: [],
						});
					}
				}
				await writeFile(path, original);
				expect(
					(await registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).projects[0]
						.taskEntriesReadStatus,
				).toBe("complete");
				expect(registry.listManagedWorkspaces()).toEqual([]);
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				fixture.cleanup();
			}
		},
	);

	it("严格查询将尚未建立 index、board 和 sessions 文件的项目视为有效空数据，且不创建文件或会话", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		try {
			const registry = await createWorkspaceRegistry({
				cwd: fixture.isolatedHomeDirectoryPath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
			});
			expect((await registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).projects).toEqual([]);
			await expect(readFile(join(getWorkspacesRootPath(), "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
			const project = fixture.createNonBareRepository({ repositoryDirectoryName: "missing-initial-state-files" });
			const context = await loadWorkspaceContext(project.repositoryPath);
			for (let attempt = 0; attempt < 2; attempt++) {
				expect((await registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 })).projects[0]).toMatchObject({
					taskEntriesReadStatus: "complete",
					crossProjectTaskSwitcherEntries: [],
				});
			}
			for (const path of [
				getPersistedWorkspaceBoardFilePathById(context.workspaceId),
				getPersistedWorkspaceSessionsFilePathById(context.workspaceId),
			]) {
				await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
			}
			expect(registry.listManagedWorkspaces()).toEqual([]);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			fixture.cleanup();
		}
	});

	it.skipIf(!taskGroupQueryPackagedCliFilePath)(
		"真实暂停读取的 pipe 在快照、停止事件及最终排空时均可中断，第二次信号保留首次退出码",
		async (testContext) => {
			if (!taskGroupQueryPackagedCliFilePath) throw new Error("缺少全项目分组查询测试的隔离打包 CLI 路径");
			const cliEntrypoint = resolve(taskGroupQueryPackagedCliFilePath);
			if (!(await stat(cliEntrypoint)).isFile())
				throw new Error("全项目分组查询测试的隔离打包 CLI 路径必须指向文件");
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const outputBackpressureObservationHookDirectory = join(
				fixture.fixtureRootDirectoryPath,
				"watch-output-backpressure-observation-hook",
			);
			await mkdir(outputBackpressureObservationHookDirectory);
			const observationHookPath = join(
				outputBackpressureObservationHookDirectory,
				"watch-output-backpressure-observation-hook.cjs",
			);
			await writeFile(
				observationHookPath,
				`
const originalWrite = process.stdout.write.bind(process.stdout);
const outputPhase = process.env.KANBAN_TEST_WATCH_BLOCKED_OUTPUT_PHASE;
const reportPhase = (phase) => process.send?.({ phase });
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => reportPhase("observed_" + signalName));
}
process.stdout.write = (chunk, encodingOrCallback, callback) => {
  const text = String(chunk);
  const normalStop = text.includes('"reason":"selected_result_empty_confirmed"');
  const originalCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
  let completed = false;
  if (outputPhase === "stop_event" && normalStop) originalWrite("x".repeat(4 * 1024 * 1024));
  const onComplete = (error) => {
    completed = true;
    // 先让停止事件写完，再制造最终排空自己的真实 pipe 背压。
    if (outputPhase === "final_drain" && normalStop && !error) originalWrite("x".repeat(4 * 1024 * 1024));
    originalCallback?.(error);
  };
  const accepted = typeof encodingOrCallback === "string"
    ? originalWrite(chunk, encodingOrCallback, onComplete)
    : originalWrite(chunk, onComplete);
  const phase = text === "" ? "final_drain"
    : normalStop ? "stop_event"
    : text.includes('"eventType":"all_projects_task_group_snapshot"') ? "snapshot"
    : "interrupted_stop";
  setImmediate(() => {
    if (!completed && process.stdout.writableLength > 0) reportPhase(phase);
  });
  return accepted;
};
`,
			);
			let blockedOutputPhase = "snapshot";
			const observedAtMs = Date.now();
			const largeSnapshot: RuntimeAllProjectsTaskGroupQuerySnapshot = {
				observedAtMs,
				recentDays: 7,
				projects: [
					{
						workspaceId: "isolated-backpressure-project",
						projectName: "背压验证项目",
						projectPath: fixture.isolatedHomeDirectoryPath,
						taskEntriesReadStatus: "complete",
						crossProjectTaskSwitcherEntries: [
							{
								taskId: "large-monitor-output",
								title: "x".repeat(4 * 1024 * 1024),
								agentId: "claude",
								createdAt: observedAtMs,
								lastOutputAt: null,
								lastSubstantiveOutputAt: null,
								turnOwner: "agent",
								liveness: "live",
								userTurnKind: null,
								columnId: "in_progress",
								isParkedAwaitingDispatchedBackgroundWork: false,
								taskDescriptionLastUpdatedAt: observedAtMs,
								lastOpenedByUserAt: null,
								pinnedToTaskPinboardAt: null,
								taskPinboardPinReason: null,
							},
						],
					},
				],
			};
			const server = createHttpServer((_request, response) => {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify([
						{
							result: {
								data:
									blockedOutputPhase === "snapshot"
										? largeSnapshot
										: { observedAtMs, recentDays: 7, projects: [] },
							},
						},
					]),
				);
			});
			try {
				await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("未取得隔离端口");
				const environment = fixture.createIsolatedChildProcessEnvironment();
				for (const key of Object.keys(environment))
					if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
						delete environment[key];
				Object.assign(environment, {
					PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
					KANBAN_RUNTIME_HOST: "127.0.0.1",
					KANBAN_RUNTIME_PORT: String(address.port),
					KANBAN_CLI_HARD_TIMEOUT_MS: "50",
				});
				for (const phase of ["snapshot", "stop_event", "final_drain"]) {
					blockedOutputPhase = phase;
					for (const signalName of ["SIGINT", "SIGTERM"] as const) {
						const child = children.register(
							spawn(
								process.execPath,
								[
									"--require",
									resolve("test/integration/shutdown-ipc-hook.cjs"),
									"--require",
									observationHookPath,
									cliEntrypoint,
									"task",
									"watch",
									"--all-projects",
									"--group",
									"running",
									"--interval-ms",
									"1000",
									...(phase === "snapshot" ? [] : ["--exit-when-empty"]),
								],
								{
									cwd: fixture.isolatedHomeDirectoryPath,
									env: { ...environment, KANBAN_TEST_WATCH_BLOCKED_OUTPUT_PHASE: phase },
									stdio: ["ignore", "pipe", "pipe", "ipc"],
								},
							),
						);
						child.stdout?.pause();
						let stderr = "";
						child.stderr?.on("data", (chunk) => {
							stderr += String(chunk);
						});
						const observedPhases = new Set<string>();
						child.on("message", (message) => {
							if (typeof message === "object" && message !== null && "phase" in message)
								observedPhases.add(String(message.phase));
						});
						const waitForOutputPhase = async (expectedPhase: string) => {
							await waitForConditionWithinLoadSensitiveTwoTierDeadline(
								testContext,
								{
									waitedForDescription: `监控到达 ${expectedPhase} 等待点`,
									softDeadlineMsExpectedOnUncontendedHost: 5_000,
									hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
								},
								() => observedPhases.has(expectedPhase) || hasChildProcessExited(child),
								{ describeLastObservedStateForFailureMessage: () => `${[...observedPhases]}\n${stderr}` },
							);
							expect(observedPhases.has(expectedPhase), stderr).toBe(true);
						};
						await waitForOutputPhase(phase);
						child.kill(signalName);
						await waitForOutputPhase(`observed_${signalName}`);
						if (phase !== "final_drain") await waitForOutputPhase("final_drain");
						child.kill(signalName === "SIGINT" ? "SIGTERM" : "SIGINT");
						await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, {
							waitedForDescription: "暂停读取 pipe 后的监控中断退出",
							softDeadlineMsExpectedOnUncontendedHost: 5_000,
							hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
						});
						expect(child.exitCode, `${phase}\n${stderr}`).toBe(signalName === "SIGTERM" ? 143 : 130);
						child.stdout?.destroy();
					}
				}
			} finally {
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				fixture.cleanup();
			}
		},
		120_000,
	);

	it.skipIf(!taskGroupQueryPackagedCliFilePath)(
		"真实 CLI 大输出保持完整，监控越过命令硬超时并跨 runtime 重启恢复，SIGTERM 正常退出",
		async (testContext) => {
			if (!taskGroupQueryPackagedCliFilePath) throw new Error("缺少全项目分组查询测试的隔离打包 CLI 路径");
			const absolutePackagedCliFilePath = resolve(taskGroupQueryPackagedCliFilePath);
			if (!(await stat(absolutePackagedCliFilePath)).isFile())
				throw new Error("全项目分组查询测试的隔离打包 CLI 路径必须指向文件");
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const project = fixture.createNonBareRepository({ repositoryDirectoryName: "group-query-live-runtime" });
			const previousHome = process.env.HOME;
			let workspaceId: string;
			const expectedTaskCount = 256;
			try {
				process.env.HOME = fixture.isolatedHomeDirectoryPath;
				const state = await loadWorkspaceState(project.repositoryPath);
				const context = await loadWorkspaceContext(project.repositoryPath);
				workspaceId = context.workspaceId;
				const timestamp = Date.now();
				for (let index = 0; index < expectedTaskCount; index++) {
					const suffix = String(index).padStart(3, "0");
					state.board.columns
						.find((column) => column.id === "review")
						?.cards.push({
							id: `pipeline-task-${suffix}`,
							title: `分组查询-${suffix}`,
							prompt: "不应出现在轻量查询中",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: timestamp,
							updatedAt: timestamp,
							...(index === 0 ? { pinnedToTaskPinboardAt: timestamp } : {}),
						});
				}
				await mkdir(context.statePath, { recursive: true });
				await writeFile(getPersistedWorkspaceBoardFilePathById(workspaceId), JSON.stringify(state.board));
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
			}
			try {
				const reservation = createServer();
				await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
				const address = reservation.address();
				if (!address || typeof address === "string") throw new Error("未取得隔离端口");
				const port = address.port;
				await new Promise<void>((done) => reservation.close(() => done()));
				expect(port).not.toBe(3484);
				const environment = fixture.createIsolatedChildProcessEnvironment();
				for (const key of Object.keys(environment))
					if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
						delete environment[key];
				Object.assign(environment, {
					PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
					KANBAN_RUNTIME_PORT: String(port),
					KANBAN_CLI_HARD_TIMEOUT_MS: "50",
				});
				const spawnCli = (args: string[]) =>
					children.register(
						spawn(
							process.execPath,
							[
								"--require",
								resolve("test/integration/shutdown-ipc-hook.cjs"),
								absolutePackagedCliFilePath,
								...args,
							],
							{ cwd: project.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
						),
					);
				const collectOutput = (child: ChildProcess) => {
					const output = { stdout: "", stderr: "" };
					child.stdout?.on("data", (chunk) => {
						output.stdout += String(chunk);
					});
					child.stderr?.on("data", (chunk) => {
						output.stderr += String(chunk);
					});
					return output;
				};
				const startRuntime = async () => {
					const child = spawnCli([
						"--port",
						String(port),
						"--no-open",
						"--no-passcode",
						"--skip-shutdown-cleanup",
					]);
					collectOutput(child);
					await waitForRuntimeServerStartupBannerOrSigkillChild(child);
					return child;
				};
				let runtime = await startRuntime();
				// 普通查询保留原有预算；只有 watch 获得长驻豁免。
				delete environment.KANBAN_CLI_HARD_TIMEOUT_MS;
				const list = spawnCli(["task", "list", "--all-projects"]);
				const listOutput = collectOutput(list);
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, list, cliExitDeadline, {
					describeChildProcessOutputForFailureMessage: () => listOutput.stderr,
				});
				expect(list.exitCode, listOutput.stderr).toBe(0);
				const listed = JSON.parse(listOutput.stdout);
				const expectPinnedTaskNestedFieldTypesPreserved = (
					result: AllProjectsTaskGroupQueryResult,
					outputFormat: string,
				) => {
					const repeatedTasks = result.groups
						.flatMap((group) => group.tasks)
						.filter((task) => task.taskId === "pipeline-task-000");
					expect(repeatedTasks).toHaveLength(2);
					for (const task of repeatedTasks)
						expect
							.soft(task.taskConversationSessionActivityObservations, outputFormat)
							.toEqual([expect.objectContaining({ sessionId: "pipeline-task-000", role: "main" })]);
				};
				expectPinnedTaskNestedFieldTypesPreserved(listed, "list JSON");
				expect(listed.count).toBe(expectedTaskCount);
				expect(Buffer.byteLength(listOutput.stdout)).toBeGreaterThan(64 * 1024);
				expect(listed.groups[0].tasks[0]).toMatchObject({
					workspaceId,
					taskId: "pipeline-task-000",
					title: "分组查询-000",
				});
				expect(listed.groups[0].tasks[0]).not.toHaveProperty("prompt");
				environment.KANBAN_CLI_HARD_TIMEOUT_MS = "50";
				const emptyWatch = spawnCli([
					"task",
					"watch",
					"--all-projects",
					"--group",
					"running",
					"--interval-ms",
					"1000",
					"--exit-when-empty",
				]);
				const emptyOutput = collectOutput(emptyWatch);
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, emptyWatch, cliExitDeadline, {
					describeChildProcessOutputForFailureMessage: () => emptyOutput.stderr,
				});
				expect(emptyWatch.exitCode, emptyOutput.stdout + emptyOutput.stderr).toBe(0);
				expect(
					emptyOutput.stdout
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
						.at(-1),
				).toMatchObject({ reason: "selected_result_empty_confirmed" });
				const watch = spawnCli(["tasks", "watch", "--all-projects", "--interval-ms", "1000"]);
				const watchOutput = collectOutput(watch);
				const events = () =>
					watchOutput.stdout
						.split("\n")
						.slice(0, -1)
						.filter(Boolean)
						.map((line) => JSON.parse(line));
				const waitForObservation = async (predicate: () => boolean) => {
					await waitForConditionWithinLoadSensitiveTwoTierDeadline(
						testContext,
						{
							waitedForDescription: "全项目分组监控状态转换",
							softDeadlineMsExpectedOnUncontendedHost: 15_000,
							hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
						},
						() => predicate() || watch.exitCode !== null,
						{ describeLastObservedStateForFailureMessage: () => watchOutput.stdout + watchOutput.stderr },
					);
					expect(predicate(), watchOutput.stdout + watchOutput.stderr).toBe(true);
				};
				await waitForObservation(() =>
					events().some((event) => event.eventType === "all_projects_task_group_snapshot"),
				);
				expectPinnedTaskNestedFieldTypesPreserved(
					events().find((event) => event.eventType === "all_projects_task_group_snapshot"),
					"watch NDJSON",
				);
				const firstSnapshotEvent = events().find((event) => event.eventType === "all_projects_task_group_snapshot");
				expect(firstSnapshotEvent).toMatchObject({ count: expectedTaskCount });
				expect(Buffer.byteLength(JSON.stringify(firstSnapshotEvent))).toBeGreaterThan(64 * 1024);
				runtime.kill("SIGKILL");
				await waitForChildProcessExit(runtime, 10_000);
				await waitForObservation(() =>
					events().some((event) => event.eventType === "all_projects_task_group_query_unavailable"),
				);
				const beforeRecovery = events().length;
				runtime = await startRuntime();
				await waitForObservation(() =>
					events()
						.slice(beforeRecovery)
						.some((event) => event.eventType === "all_projects_task_group_snapshot" && event.ok),
				);
				watch.kill("SIGTERM");
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, watch, cliExitDeadline);
				expect(watch.exitCode).toBe(143);
				expect(events().at(-1)).toMatchObject({ reason: "interrupted", exitCode: 143 });
				const endpoint = `http://127.0.0.1:${port}/api/trpc/projects.getAllProjectsTaskGroupQuerySnapshot?input=${encodeURIComponent(JSON.stringify({ recentDays: 7 }))}`;
				const response = await fetch(endpoint);
				const snapshot = (await response.json()) as { result: { data: RuntimeAllProjectsTaskGroupQuerySnapshot } };
				expect(snapshot.result.data.projects).toHaveLength(1);
			} finally {
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
				fixture.cleanup();
			}
		},
		computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 165_000,
			cliChildProcessSpawns: { cliChildProcessSpawnCount: 3, cliChildProcessExitTwoTierDeadline: cliExitDeadline },
		}),
	);
});
