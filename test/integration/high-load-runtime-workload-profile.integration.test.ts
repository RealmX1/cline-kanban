import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { type BrowserContext, chromium } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const baselineCliPath = process.env.KANBAN_HIGH_LOAD_BASELINE_CLI_PATH;
const candidateCliPath = process.env.KANBAN_HIGH_LOAD_RELIABILITY_PACKAGED_CLI_PATH;
const evidenceDirectory = process.env.KANBAN_HIGH_LOAD_PROFILE_EVIDENCE_DIRECTORY;
const pairCount = Number(process.env.KANBAN_HIGH_LOAD_PROFILE_PAIR_COUNT ?? "5");
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const metricsResponseSchema = z.object({
	id: z.number(),
	ok: z.boolean(),
	metrics: z.record(z.string(), z.number().nullable()).optional(),
	error: z.string().optional(),
});
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe.skipIf(!baselineCliPath || !candidateCliPath || !evidenceDirectory)(
	"隔离高负载的版本绑定 profile 与 AB/BA 对照",
	{ timeout: 1_800_000 },
	() => {
		it("固定 1/10/30 项目、0/1/4 浏览器与四种工作负载，不调用外部模型", async (testContext) => {
			assert(baselineCliPath && candidateCliPath && evidenceDirectory);
			assert(Number.isInteger(pairCount) && pairCount >= 1 && pairCount <= 5);
			await mkdir(evidenceDirectory, { recursive: true });
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const fixtureEnvironment = fixture.createIsolatedChildProcessEnvironment();
			for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"])
				vi.stubEnv(name, fixtureEnvironment[name] ?? "");
			vi.stubEnv("CODEX_HOME", join(fixture.fixtureRootDirectoryPath, "codex-home"));
			vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.fixtureRootDirectoryPath, "codex-sqlite-home"));
			const repositories: { workspaceId: string; repositoryPath: string; taskId: string }[] = [];
			for (let project = 0; project < 30; project += 1) {
				const repository = fixture.createNonBareRepository({
					repositoryDirectoryName: `load-project-${project}`,
					initialBranchName: "main",
				});
				for (let file = 0; file < 40; file += 1)
					await writeFile(
						join(repository.repositoryPath, `source-${file}.ts`),
						`export const fixtureValue${file} = ${file};\n`.repeat(20),
					);
				repository.commitAllRepositoryFilesAtDate({
					message: "固定高负载语料",
					authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
				});
				const context = await loadWorkspaceContext(repository.repositoryPath);
				const initial = await loadWorkspaceState(repository.repositoryPath);
				const taskId = `load-task-${project}`;
				await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: {
						...initial.board,
						columns: initial.board.columns.map((column) => ({
							...column,
							cards:
								column.id === "in_progress"
									? [
											{
												id: taskId,
												title: `[TEST]负载项目 ${project}`,
												prompt: "隔离性能核验",
												baseRef: "main",
												startInPlanMode: false,
												createdAt: 1_000 + project,
												updatedAt: 1_000 + project,
												worktreeMode: "inplace",
											},
										]
									: [],
						})),
					},
					sessions: {},
					expectedRevision: initial.revision,
				});
				repositories.push({ workspaceId: context.workspaceId, repositoryPath: repository.repositoryPath, taskId });
			}
			const completeIndex = JSON.parse(
				await readFile(join(fixture.isolatedHomeDirectoryPath, ".cline/kanban/workspaces/index.json"), "utf8"),
			);
			const binaries = join(fixture.fixtureRootDirectoryPath, "fixture-agent-binaries");
			await mkdir(binaries);
			await writeFile(
				join(binaries, "claude"),
				`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');const args=process.argv.slice(2);
if(args.includes('--version'))process.stdout.write('2.1.23 (Claude Code)\\n');else{
 const position=args.indexOf('--session-id');const id=position>=0?args[position+1]:crypto.randomUUID();let parent=crypto.randomUUID();
 const record=(type,text)=>{const uuid=crypto.randomUUID();fs.appendFileSync(process.env.KANBAN_LOAD_TRANSCRIPT_PATH,JSON.stringify({type,uuid,parentUuid:parent,sessionId:id,cwd:process.cwd(),timestamp:new Date().toISOString(),message:{role:type,content:[{type:'text',text}]}})+'\\n');parent=uuid};
 fs.writeFileSync(process.env.KANBAN_LOAD_LAUNCH_RECORD_PATH,JSON.stringify({id,pid:process.pid}));record('user','隔离性能核验');record('assistant','模拟回复');
 process.stdout.write('Claude Code\\n❯ ');process.stdin.on('data',()=>process.stdout.write('模拟输入已接收\\n❯ '));
 setInterval(()=>{if(fs.existsSync(process.env.KANBAN_LOAD_OUTPUT_MARKER_PATH)){process.stdout.write('模拟持续输出 '.repeat(80)+'\\n');record('assistant','模拟持续进展 '.repeat(20))}},50);
}
`,
				{ mode: 0o755 },
			);
			const browser = await chromium.launch({ headless: true });
			const allRows: Record<string, unknown>[] = [];
			const versionBindings = await Promise.all(
				[baselineCliPath, candidateCliPath].map(async (path) => ({
					path,
					sha256: createHash("sha256")
						.update(await readFile(path))
						.digest("hex"),
				})),
			);
			await writeFile(
				join(evidenceDirectory, "version-and-corpus-binding.json"),
				JSON.stringify(
					{
						node: process.version,
						versions: versionBindings,
						projectCounts: [1, 10, 30],
						browserStaticAssetTransport:
							"Playwright 从对应冻结 dist 交付 assets；API、PTY 与 WebSocket 仍直连隔离 runtime。静态传输耗时不计入比较。",
						browserCounts: [0, 1, 4],
						workloads: ["quiet", "continuous_output", "git_changes", "history_increment"],
						fileCountPerRepository: 40,
						pairsRequested: pairCount,
					},
					null,
					2,
				),
			);
			try {
				for (let pair = 0; pair < pairCount; pair += 1)
					for (const variant of pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
						for (const repository of repositories) {
							for (const entry of await readdir(repository.repositoryPath)) {
								if (entry === ".git") continue;
								if (!/^source-\d+\.ts$/u.test(entry))
									await rm(join(repository.repositoryPath, entry), { recursive: true, force: true });
							}
							for (let file = 0; file < 40; file += 1)
								await writeFile(
									join(repository.repositoryPath, `source-${file}.ts`),
									`export const fixtureValue${file} = ${file};\n`.repeat(20),
								);
						}
						const trialDirectory = join(fixture.fixtureRootDirectoryPath, `trial-${pair}-${variant}`);
						const trialHome = join(trialDirectory, "home");
						await mkdir(trialDirectory);
						await cp(fixture.isolatedHomeDirectoryPath, trialHome, { recursive: true });
						const indexPath = join(trialHome, ".cline/kanban/workspaces/index.json");
						const selectProjects = async (count: number) => {
							const selected = new Set(repositories.slice(0, count).map((entry) => entry.workspaceId));
							await writeFile(
								indexPath,
								JSON.stringify({
									...completeIndex,
									entries: Object.fromEntries(
										Object.entries(completeIndex.entries).filter(([id]) => selected.has(id)),
									),
									repoPathToId: Object.fromEntries(
										Object.entries(completeIndex.repoPathToId).filter(([, id]) => selected.has(String(id))),
									),
								}),
							);
						};
						await selectProjects(1);
						const reservation = createServer();
						await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
						const address = reservation.address();
						assert(address && typeof address !== "string");
						await new Promise<void>((resolve) => reservation.close(() => resolve()));
						const environment: NodeJS.ProcessEnv = {};
						for (const [name, value] of Object.entries(fixtureEnvironment))
							if (/^(GIT_|LANG$|LC_|TMPDIR$|TMP$|TEMP$|XDG_CONFIG_HOME$)/u.test(name)) environment[name] = value;
						Object.assign(environment, {
							HOME: trialHome,
							USERPROFILE: trialHome,
							PATH: `${binaries}:${dirname(process.execPath)}:/usr/bin:/bin`,
							CODEX_HOME: join(trialHome, "codex"),
							CODEX_SQLITE_HOME: join(trialHome, "codex-sqlite"),
							KANBAN_RUNTIME_PORT: String(address.port),
							KANBAN_AGENT_SESSION_PTY_HOST_MODE: "disabled",
							KANBAN_LOAD_TRANSCRIPT_PATH: join(trialDirectory, "native-transcript.jsonl"),
							KANBAN_LOAD_LAUNCH_RECORD_PATH: join(trialDirectory, "launch.json"),
							KANBAN_LOAD_OUTPUT_MARKER_PATH: join(trialDirectory, "output-enabled"),
						});
						const first = repositories[0];
						assert(first);
						const launchRecordPath = environment.KANBAN_LOAD_LAUNCH_RECORD_PATH;
						const transcriptPath = environment.KANBAN_LOAD_TRANSCRIPT_PATH;
						const outputMarkerPath = environment.KANBAN_LOAD_OUTPUT_MARKER_PATH;
						assert(launchRecordPath && transcriptPath && outputMarkerPath);
						const cli = variant === "baseline" ? baselineCliPath : candidateCliPath;
						const runtime = children.register(
							spawn(
								process.execPath,
								[
									"--require",
									resolve("test/integration/shutdown-ipc-hook.cjs"),
									"--require",
									resolve("test/integration/fixtures/high-load-runtime-metrics-preload.cjs"),
									cli,
									"--no-open",
									"--no-passcode",
									"--port",
									String(address.port),
								],
								{
									cwd: first.repositoryPath,
									env: environment,
									stdio: ["ignore", "pipe", "pipe", "ipc"],
								},
							),
						);
						let runtimeOutput = "";
						runtime.stdout?.on("data", (chunk) => {
							runtimeOutput += String(chunk);
						});
						runtime.stderr?.on("data", (chunk) => {
							runtimeOutput += String(chunk);
						});
						const origin = `http://127.0.0.1:${address.port}`;
						const client = createTRPCProxyClient<RuntimeAppRouter>({
							links: [
								httpLink({
									url: `${origin}/api/trpc`,
									headers: { "x-kanban-workspace-id": first.workspaceId },
								}),
							],
						});
						let contexts: BrowserContext[] = [];
						const staticAssetDeliveryFailures: string[] = [];
						let messageId = 0;
						const metrics = (operation: string, options: Record<string, unknown> = {}) =>
							new Promise<Record<string, unknown>>((resolveMetrics, reject) => {
								const id = ++messageId;
								const timer = setTimeout(() => {
									runtime.off("message", onMessage);
									reject(new Error("隔离指标 IPC 超时。"));
								}, 15_000);
								const onMessage = (message: unknown) => {
									if (!message || typeof message !== "object" || !("id" in message) || message.id !== id)
										return;
									clearTimeout(timer);
									runtime.off("message", onMessage);
									const parsed = metricsResponseSchema.safeParse(message);
									if (!parsed.success) reject(new Error("隔离指标响应格式无效。"));
									else if (!parsed.data.ok) reject(new Error(parsed.data.error));
									else resolveMetrics(parsed.data.metrics ?? {});
								};
								runtime.on("message", onMessage);
								runtime.send({ kind: "high_load_fixture_metrics", operation, id, ...options });
							});
						try {
							await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
							const started = await client.runtime.startTaskSession.mutate({
								taskId: first.taskId,
								agentId: "claude",
								prompt: "隔离性能核验",
								baseRef: "main",
								startInPlanMode: false,
								worktreeMode: "inplace",
							});
							expect(started.ok).toBe(true);
							await expect
								.poll(async () =>
									readFile(launchRecordPath, "utf8")
										.then(JSON.parse)
										.catch(() => null),
								)
								.not.toBeNull();
							const launch = JSON.parse(await readFile(launchRecordPath, "utf8"));
							await client.hooks.ingest.mutate({
								taskId: first.taskId,
								workspaceId: first.workspaceId,
								event: "agent_conversation_session_identity_observed",
								agentNativeConversationSessionIdentity: {
									sourceAgentId: "claude",
									nativeSessionId: launch.id,
									transcriptPath: transcriptPath,
									observedAt: Date.now(),
								},
							});
							if (pair === 0) {
								const calibration = [];
								for (const instrumentationEnabled of [false, true, true, false, false, true]) {
									await metrics("begin", { instrumentationEnabled, profileEnabled: false });
									const before = performance.now();
									for (let index = 0; index < 30; index += 1)
										await Promise.all([client.workspace.getState.query(), client.projects.list.query()]);
									calibration.push({
										instrumentationEnabled,
										batchCount: 30,
										elapsedMs: performance.now() - before,
										...(await metrics("finish")),
									});
								}
								await writeFile(
									join(evidenceDirectory, `${variant}-instrumentation-calibration.json`),
									JSON.stringify(calibration, null, 2),
								);
							}
							for (const projectCount of [1, 10, 30]) {
								await selectProjects(projectCount);
								expect((await client.projects.list.query()).projects).toHaveLength(projectCount);
								for (const browserCount of [0, 1, 4]) {
									for (const context of contexts) {
										await context.unrouteAll({ behavior: "wait" });
										await context.close();
									}
									contexts = [];
									for (let index = 0; index < browserCount; index += 1) {
										const context = await browser.newContext();
										contexts.push(context);
										// 宿主直传 4 MB 资源可在独立静态服务器复现停滞；两组使用相同传输，保留真实 bundle 与控制面。
										await context.route(
											(url) => url.origin === origin && url.pathname.startsWith("/assets/"),
											async (route) => {
												try {
													await route.fulfill({
														path: join(dirname(cli), "web-ui", new URL(route.request().url()).pathname),
													});
												} catch (error) {
													staticAssetDeliveryFailures.push(String(error));
													await route.abort().catch(() => undefined);
												}
											},
										);
										const page = await context.newPage();
										const pendingRequests = new Set<string>();
										const browserErrors: string[] = [];
										const responses: { url: string; status: number }[] = [];
										const browserProfiler = await context.newCDPSession(page);
										await browserProfiler.send("Profiler.enable");
										await browserProfiler.send("Profiler.start");
										page.on("request", (request) => pendingRequests.add(request.url()));
										page.on("requestfinished", (request) => pendingRequests.delete(request.url()));
										page.on("requestfailed", (request) => pendingRequests.delete(request.url()));
										page.on("pageerror", (error) => browserErrors.push(error.message));
										page.on("response", (response) =>
											responses.push({ url: response.url(), status: response.status() }),
										);
										try {
											await page.goto(`${origin}/${first.workspaceId}`, { waitUntil: "domcontentloaded" });
											await page.getByText("[TEST]负载项目 0", { exact: true }).first().waitFor();
										} catch (error) {
											await writeFile(
												join(evidenceDirectory, `browser-startup-failure-${pair}-${variant}.json`),
												JSON.stringify(
													{
														pendingRequests: [...pendingRequests],
														responses,
														browserErrors,
														url: page.url(),
													},
													null,
													2,
												),
											);
											const { profile } = await browserProfiler.send("Profiler.stop");
											await writeFile(
												join(evidenceDirectory, `browser-startup-failure-${pair}-${variant}.cpuprofile`),
												JSON.stringify(profile),
											);
											throw error;
										}
										await browserProfiler.send("Profiler.stop");
										await browserProfiler.detach();
									}
									for (const workload of ["quiet", "continuous_output", "git_changes", "history_increment"]) {
										if (workload === "continuous_output") await writeFile(outputMarkerPath, "enabled");
										else await rm(outputMarkerPath, { force: true });
										const profileEnabled =
											pair === 0 &&
											((projectCount === 30 && browserCount === 4 && workload === "history_increment") ||
												(projectCount === 1 && browserCount === 0 && workload === "quiet"));
										const profilePath = join(
											evidenceDirectory,
											`${variant}-${projectCount}-${browserCount}-${workload}-runtime.cpuprofile`,
										);
										await metrics("begin", { instrumentationEnabled: true, profileEnabled });
										const latencies: number[] = [];
										const startedAt = performance.now();
										let iteration = 0;
										while (performance.now() - startedAt < 1_500) {
											if (workload === "git_changes")
												await writeFile(
													join(first.repositoryPath, "source-0.ts"),
													`export const changed = ${iteration};\n`,
												);
											if (workload === "history_increment")
												await writeFile(
													transcriptPath,
													`${JSON.stringify({ type: "assistant", uuid: randomUUID(), sessionId: launch.id, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: `历史增量 ${iteration}` }] } })}\n`,
													{ flag: "a" },
												);
											const before = performance.now();
											await Promise.all([
												client.projects.list.query(),
												client.workspace.getState.query(),
												client.workspace.getChanges.query({
													taskId: first.taskId,
													baseRef: "main",
													worktreeMode: "inplace",
												}),
												client.runtime.getTaskConversationHistoryPage.query({
													workspaceTaskId: first.taskId,
													taskConversationSessionId: first.taskId,
													transcriptReadConsistency: "stable_snapshot",
												}),
											]);
											latencies.push(performance.now() - before);
											iteration += 1;
										}
										const elapsedMs = performance.now() - startedAt;
										const measured = await metrics("finish", { profilePath });
										latencies.sort((a, b) => a - b);
										const row = {
											pair,
											variant,
											projectCount,
											browserCount,
											workload,
											profileEnabled,
											elapsedMs,
											sampleCount: latencies.length,
											batchP95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
											batchP99Ms: latencies[Math.ceil(latencies.length * 0.99) - 1],
											...measured,
										};
										allRows.push(row);
										await writeFile(
											join(evidenceDirectory, "measurements.json"),
											JSON.stringify(allRows, null, 2),
										);
										await writeFile(
											join(evidenceDirectory, "progress.json"),
											JSON.stringify({
												pair,
												variant,
												projectCount,
												browserCount,
												workload,
												measurementsCompleted: allRows.length,
												measurementsExpected: pairCount * 72,
											}),
										);
									}
								}
							}
							const saveState = await client.workspace.getState.query();
							expect(staticAssetDeliveryFailures).toEqual([]);
							const saveStart = performance.now();
							await client.workspace.saveState.mutate({
								board: saveState.board,
								sessions: saveState.sessions,
								expectedRevision: saveState.revision,
							});
							const saveLatencyMs = performance.now() - saveStart;
							const inputStart = performance.now();
							expect(
								(
									await client.runtime.sendTaskSessionInput.mutate({
										taskId: first.taskId,
										text: "隔离输入核验",
										appendNewline: true,
									})
								).ok,
							).toBe(true);
							const inputLatencyMs = performance.now() - inputStart;
							const stopStart = performance.now();
							expect((await client.runtime.stopTaskSession.mutate({ taskId: first.taskId })).ok).toBe(true);
							await writeFile(
								join(evidenceDirectory, `critical-input-stop-${pair}-${variant}.json`),
								JSON.stringify({ saveLatencyMs, inputLatencyMs, stopLatencyMs: performance.now() - stopStart }),
							);
						} finally {
							for (const context of contexts) {
								await context.unrouteAll({ behavior: "wait" });
								await context.close();
							}
							runtime.kill("SIGINT");
							await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, runtime, {
								softDeadlineMsExpectedOnUncontendedHost: 10_000,
								hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
								waitedForDescription: "隔离 profile 运行时关闭",
							});
							await writeFile(join(evidenceDirectory, `runtime-${pair}-${variant}.log`), runtimeOutput);
						}
					}
			} finally {
				await browser.close();
				fixture.cleanup();
			}
		});
	},
);
