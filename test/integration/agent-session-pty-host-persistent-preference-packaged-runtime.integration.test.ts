import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, chmod, copyFile, cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createModelFixtureServer, type Server as ModelFixtureServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { listAgentSessionPtyHostGenerationSocketPaths } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { readPosixProcessResourceTable } from "../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const modelFixtureServersClosedAfterEachTest: ModelFixtureServer[] = [];
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const server of modelFixtureServersClosedAfterEachTest.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
	}
	vi.unstubAllEnvs();
});

describe.skipIf(!process.env.KANBAN_PTY_HOST_PREFERENCE_PACKAGED_RUNTIME_CLI_PATH || process.platform === "win32")(
	"持久热接管偏好的打包 runtime 与真实浏览器",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 5,
			testBodyTimeoutBudgetMs: 90_000,
		}),
	},
	() => {
		it("无临时继承变量仍缺省启用，浏览器持久关闭，跨 build 与显式禁用仍保住原 PTY，覆盖不反写配置", async (test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kph-preference-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "persistent-host-preference" });
			await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离热接管验收\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "隔离热接管初始仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
			const realCodexExecutable = process.env.KANBAN_PTY_HOST_REAL_CODEX_EXECUTABLE;
			const realCodexTaskId = "real-codex-continuity";
			if (realCodexExecutable)
				await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: addTaskToColumn(
						state.board,
						"review",
						{
							taskId: realCodexTaskId,
							prompt: "隔离原生会话热接管检查",
							startInPlanMode: false,
							baseRef: "main",
							worktreeMode: "inplace",
						},
						() => realCodexTaskId,
					).board,
					value: null,
				}));
			vi.unstubAllEnvs();
			const reservation = createServer();
			await new Promise<void>((resolveListening) => reservation.listen(0, "127.0.0.1", resolveListening));
			const address = reservation.address();
			if (!address || typeof address === "string") throw new Error("无法分配隔离固定端口");
			const runtimePort = address.port;
			await new Promise<void>((resolveClosed) => reservation.close(() => resolveClosed()));
			const runtimeIdentity = {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban"),
				runtimePort,
			};
			const configPath = join(runtimeIdentity.runtimeHomeDirectoryPath, "config.json");
			await writeFile(configPath, JSON.stringify({ selectedAgentId: "codex" }));
			const executableDirectory = join(fixture.fixtureRootDirectoryPath, "executables");
			await mkdir(executableDirectory);
			if (realCodexExecutable) await symlink(realCodexExecutable, join(executableDirectory, "codex"));
			else {
				await writeFile(join(executableDirectory, "codex"), '#!/bin/sh\nprintf "codex-cli 隔离版本探测替身\\n"\n');
				await chmod(join(executableDirectory, "codex"), 0o755);
			}
			const nativeModelRequestBodies: string[] = [];
			if (realCodexExecutable) {
				const server = createModelFixtureServer(async (request, response) => {
					let body = "";
					for await (const chunk of request) body += String(chunk);
					nativeModelRequestBodies.push(body);
					const item = {
						type: "message",
						id: `message-${nativeModelRequestBodies.length}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "隔离原生会话回合已完成", annotations: [] }],
					};
					const result = {
						id: `response-${nativeModelRequestBodies.length}`,
						object: "response",
						created_at: Math.floor(Date.now() / 1000),
						status: "completed",
						model: "gpt-5.4",
						output: [item],
						usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
					};
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					for (const [type, fields] of [
						["response.created", { response: { ...result, status: "in_progress", output: [] } }],
						["response.output_item.done", { output_index: 0, item }],
						["response.completed", { response: result }],
					] as const)
						response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
					response.end();
				});
				modelFixtureServersClosedAfterEachTest.push(server);
				await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
				const modelAddress = server.address();
				if (!modelAddress || typeof modelAddress === "string") throw new Error("隔离模型端口不可用");
				const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
				await mkdir(codexHome);
				await writeFile(
					join(codexHome, "config.toml"),
					`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离热接管模型"\nbase_url="http://127.0.0.1:${modelAddress.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
				);
				await writeFile(
					join(codexHome, "auth.json"),
					JSON.stringify({ OPENAI_API_KEY: "sk-isolated-no-external-inference" }),
					{ mode: 0o600 },
				);
			}
			const environment = fixture.createIsolatedChildProcessEnvironment({
				PATH: `${executableDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
				SHELL: "/bin/sh",
				CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "codex-home"),
				CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "codex-sqlite-home"),
				KANBAN_AGENT_SESSION_PTY_HOST_MODE: undefined,
				KANBAN_DESKTOP: undefined,
				KANBAN_RUNTIME_PORT: String(runtimePort),
				KANBAN_RUNTIME_HOST: "127.0.0.1",
				DO_NOT_TRACK: "1",
			});
			const firstCliPath = resolve(process.env.KANBAN_PTY_HOST_PREFERENCE_PACKAGED_RUNTIME_CLI_PATH ?? "");
			const secondDistributionDirectory = join(fixture.fixtureRootDirectoryPath, "second-build-distribution");
			await cp(dirname(firstCliPath), secondDistributionDirectory, { recursive: true });
			await symlink(resolve("node_modules"), join(secondDistributionDirectory, "node_modules"), "dir").catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				},
			);
			await appendFile(
				join(secondDistributionDirectory, "agent-session-pty-host.js"),
				"\n// 隔离验收：第二个 host build。\n",
			);
			const runtimeProcesses: ChildProcess[] = [];
			const startRuntime = async (cliPath = firstCliPath, temporaryOverride?: string) => {
				const child = children.register(
					spawn(
						process.execPath,
						[cliPath, "--port", String(runtimePort), "--no-open", "--skip-shutdown-cleanup"],
						{
							cwd: repository.repositoryPath,
							env: { ...environment, KANBAN_AGENT_SESSION_PTY_HOST_MODE: temporaryOverride },
							stdio: ["ignore", "pipe", "pipe"],
						},
					),
				);
				runtimeProcesses.push(child);
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				const client = createTRPCProxyClient<RuntimeAppRouter>({
					links: [httpBatchLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } })],
				});
				return { child, client, origin };
			};
			const wait = (condition: () => boolean | Promise<boolean>) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "隔离 runtime、PTY 或浏览器偏好变化可观察",
						softDeadlineMsExpectedOnUncontendedHost: 5_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
					},
					condition,
				);
			const evidenceDirectory = process.env.KANBAN_PTY_HOST_PREFERENCE_EVIDENCE_DIRECTORY;
			const continuityVerificationEntrypoint = process.env.KANBAN_PTY_HOST_CONTINUITY_VERIFICATION_ENTRYPOINT_PATH;
			const shellTaskId = "shell-kept-across-runtime-builds";
			try {
				const first = await startRuntime();
				let originalCodexSummary: RuntimeTaskSessionSummary | null = null;
				if (realCodexExecutable) {
					const nativeStarted = await first.client.runtime.startTaskSession.mutate({
						taskId: realCodexTaskId,
						agentId: "codex",
						prompt: "只回复 REAL_CODEX_BEFORE_RUNTIME_RESTART，不调用工具。",
						baseRef: "main",
						worktreeMode: "inplace",
						startInPlanMode: false,
					});
					expect(nativeStarted.ok, nativeStarted.error).toBe(true);
					await wait(async () => {
						const state = await first.client.workspace.getState.query();
						originalCodexSummary = state.sessions[realCodexTaskId];
						return (
							!!originalCodexSummary?.agentNativeConversationSessionIdentity &&
							nativeModelRequestBodies.some((body) => body.includes("REAL_CODEX_BEFORE_RUNTIME_RESTART"))
						);
					});
				}
				const before = await first.client.runtime.getAgentSessionPtyHostDiagnostics.query();
				expect(before).toMatchObject({
					configuredPreferenceSource: "default_enabled",
					newSessionHostingMode: "independent_host",
					startupDecision: { enablementPreferenceSource: "default_enabled", environmentOverride: null },
				});
				const started = await first.client.runtime.startShellSession.mutate({
					taskId: shellTaskId,
					baseRef: "main",
					worktreeMode: "inplace",
				});
				expect(started.ok, started.error).toBe(true);
				const originalPid = started.summary?.pid;
				const originalProcess = (await readPosixProcessResourceTable()).find(
					(process) => process.processId === originalPid,
				);
				expect(originalProcess).toBeTruthy();
				expect(
					(
						await first.client.runtime.sendTaskSessionInput.mutate({
							taskId: shellTaskId,
							text: "while :; do printf 'continuous-output\\n'; printf x >> continuity-output.txt; sleep 0.2; done &",
							appendNewline: true,
						})
					).ok,
				).toBe(true);
				await wait(() =>
					stat(join(repository.repositoryPath, "continuity-output.txt")).then(
						(status) => status.size > 1,
						() => false,
					),
				);
				const ownershipBefore = await first.client.runtime.getAgentSessionPtyHostDiagnostics.query();
				expect(ownershipBefore.runtimePtySessions).toContainEqual(
					expect.objectContaining({ processId: originalPid, ownership: "independent_host" }),
				);
				const runReadOnlyCli = async (entrypoint: string, arguments_: string[]) => {
					const child = children.register(
						spawn(process.execPath, [entrypoint, ...arguments_], {
							cwd: repository.repositoryPath,
							env: environment,
							stdio: ["ignore", "pipe", "pipe"],
						}),
					);
					let stdout = "";
					let stderr = "";
					child.stdout?.on("data", (chunk) => {
						stdout += String(chunk);
					});
					child.stderr?.on("data", (chunk) => {
						stderr += String(chunk);
					});
					await wait(() => child.exitCode !== null || child.signalCode !== null);
					expect(child.exitCode, stderr).toBe(0);
					return JSON.parse(stdout);
				};
				const cliDiagnostics = await runReadOnlyCli(firstCliPath, [
					"diagnostics",
					"agent-session-pty-hosts",
					"--json",
				]);
				expect(cliDiagnostics.runtimeProcessId).toBe(first.child.pid);
				const deploymentBaselinePath = join(fixture.fixtureRootDirectoryPath, "before-runtime-restart.json");
				const candidateSourceCommit = "a".repeat(40);
				const deploymentPreflight = await runReadOnlyCli(
					resolve("scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
					[
						"--before-runtime-restart",
						"--candidate-source-commit",
						candidateSourceCommit,
						"--evidence-file",
						deploymentBaselinePath,
					],
				);
				expect(deploymentPreflight.validatedHostedSessions).toContainEqual(
					expect.objectContaining({ processId: originalPid }),
				);
				const requireFromWebUi = createRequire(resolve("web-ui/package.json"));
				const { chromium } = requireFromWebUi("playwright-core") as { chromium: BrowserType };
				const browser = await chromium.launch({ headless: true });
				try {
					const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
					await page.goto(first.origin);
					const onboarding = page.getByRole("dialog", { name: "Get started" });
					await onboarding.waitFor({ timeout: 15_000 });
					await onboarding.getByRole("button", { name: "Close", exact: true }).click();
					await page.getByTestId("open-settings-button").click();
					const toggle = page.getByRole("switch", { name: "默认启用会话热接管" });
					await toggle.waitFor();
					await toggle.scrollIntoViewIfNeeded();
					expect(await toggle.getAttribute("aria-checked")).toBe("true");
					await page.getByText("当前实际模式：独立 host 已就绪", { exact: true }).waitFor();
					await toggle.click();
					await page.getByRole("button", { name: "Save", exact: true }).click();
					await wait(
						async () =>
							(await first.client.runtime.getConfig.query()).agentSessionPtyHostEnablementPreference ===
							"disabled",
					);
					await page.getByTestId("open-settings-button").click();
					expect(await toggle.getAttribute("aria-checked")).toBe("false");
					await page.getByText("已保存的偏好等待下次 runtime 启动生效。", { exact: true }).waitFor();
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await toggle.scrollIntoViewIfNeeded();
						await page.screenshot({
							path: join(evidenceDirectory, "persistent-pty-host-preference-pending-restart.png"),
						});
					}
				} finally {
					await browser.close();
				}
				const outputSizeBeforeRestart = (await stat(join(repository.repositoryPath, "continuity-output.txt"))).size;
				await sigkillChildProcessAndWaitForExit(first.child);
				await wait(
					async () =>
						(await stat(join(repository.repositoryPath, "continuity-output.txt"))).size > outputSizeBeforeRestart,
				);
				const second = await startRuntime(join(secondDistributionDirectory, "cli.js"));
				const disabled = await second.client.runtime.getAgentSessionPtyHostDiagnostics.query();
				expect(disabled).toMatchObject({
					newSessionHostingMode: "disabled",
					startupDecision: {
						enablementPreferenceSource: "persistent_preference",
						effectiveStartupIntent: "disabled",
					},
				});
				expect(disabled.runtimePtySessions).toContainEqual(
					expect.objectContaining({ processId: originalPid, ownership: "independent_host" }),
				);
				expect(
					(await readPosixProcessResourceTable()).find((process) => process.processId === originalPid)
						?.processStartTimeText,
				).toBe(originalProcess?.processStartTimeText);
				expect(
					(
						await second.client.runtime.sendTaskSessionInput.mutate({
							taskId: shellTaskId,
							text: "printf 'input-after-restart\\n' >> input-evidence.txt",
							appendNewline: true,
						})
					).ok,
				).toBe(true);
				await wait(() =>
					readFile(join(repository.repositoryPath, "input-evidence.txt"), "utf8").then(
						(contents) => contents === "input-after-restart\n",
						() => false,
					),
				);
				const inProcessShell = await second.client.runtime.startShellSession.mutate({
					taskId: "explicit-disabled-new-shell",
					baseRef: "main",
				});
				expect(inProcessShell.ok, inProcessShell.error).toBe(true);
				expect(
					(await second.client.runtime.getAgentSessionPtyHostDiagnostics.query()).runtimePtySessions,
				).toContainEqual(
					expect.objectContaining({
						conversationSessionId: "explicit-disabled-new-shell",
						ownership: "runtime_process",
					}),
				);
				await second.client.runtime.stopTaskSession.mutate({ taskId: "explicit-disabled-new-shell" });
				await second.client.runtime.saveConfig.mutate({ agentSessionPtyHostEnablementPreference: "enabled" });
				await sigkillChildProcessAndWaitForExit(second.child);
				const overridden = await startRuntime(join(secondDistributionDirectory, "cli.js"), " disabled ");
				expect(await overridden.client.runtime.getAgentSessionPtyHostDiagnostics.query()).toMatchObject({
					newSessionHostingMode: "disabled",
					configuredPersistentPreference: "enabled",
					startupDecision: { enablementPreferenceSource: "environment_override" },
				});
				await sigkillChildProcessAndWaitForExit(overridden.child);
				const restored = await startRuntime(join(secondDistributionDirectory, "cli.js"));
				const after = await restored.client.runtime.getAgentSessionPtyHostDiagnostics.query();
				expect(after).toMatchObject({
					newSessionHostingMode: "independent_host",
					configuredPersistentPreference: "enabled",
					startupDecision: { enablementPreferenceSource: "persistent_preference", environmentOverride: null },
				});
				expect(after.runtimePtySessions).toContainEqual(
					expect.objectContaining({
						processId: originalPid,
						ownership: "independent_host",
						runtimeSessionIncarnationId: started.summary?.runtimeSessionIncarnationId ?? null,
					}),
				);
				expect(JSON.parse(await readFile(configPath, "utf8")).agentSessionPtyHostEnablementPreference).toBe(
					"enabled",
				);
				if (realCodexExecutable) {
					const original = originalCodexSummary as RuntimeTaskSessionSummary | null;
					const nativeAfter = (await restored.client.workspace.getState.query()).sessions[realCodexTaskId];
					expect(nativeAfter.pid).toBe(original?.pid);
					expect(nativeAfter.runtimeSessionIncarnationId).toBe(original?.runtimeSessionIncarnationId);
					expect(nativeAfter.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
						original?.agentNativeConversationSessionIdentity?.nativeSessionId,
					);
					const observationStartingPoint = await runReadOnlyCli(
						resolve("scripts/observe-agent-session-pty-host-runtime-restart-continuity.mjs"),
						[
							"--before-restart-evidence-file",
							deploymentBaselinePath,
							"--record-for-current-runtime",
							"--deployed-source-commit",
							candidateSourceCommit,
						],
					);
					expect(observationStartingPoint.identityContinuityVerified).toBe(true);
					expect(observationStartingPoint.sessionIoProgressVerified).toBe(false);
					if (continuityVerificationEntrypoint) {
						await writeFile(
							join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban", "last-deployed-source-commit.json"),
							JSON.stringify({ deployedSourceCommit: candidateSourceCommit }),
						);
						await expect(runReadOnlyCli(continuityVerificationEntrypoint, [])).rejects.toThrow(
							"尚未观察到新 runtime 起点之后",
						);
					}
					const delivered = await restored.client.runtime.sendTaskChatMessage.mutate({
						taskId: realCodexTaskId,
						text: "只回复 REAL_CODEX_AFTER_RUNTIME_RESTART，不调用工具。",
					});
					expect(delivered.ok, delivered.error).toBe(true);
					await wait(() =>
						nativeModelRequestBodies.some((body) => body.includes("REAL_CODEX_AFTER_RUNTIME_RESTART")),
					);
					const continuityObservation = await runReadOnlyCli(
						resolve("scripts/observe-agent-session-pty-host-runtime-restart-continuity.mjs"),
						[
							"--before-restart-evidence-file",
							deploymentBaselinePath,
							"--require-session-io-progress",
							"--observation-deadline-ms",
							"10000",
							"--record-for-current-runtime",
							"--deployed-source-commit",
							candidateSourceCommit,
						],
					);
					expect(continuityObservation.identityContinuityVerified).toBe(true);
					if (continuityVerificationEntrypoint) {
						const verification = await runReadOnlyCli(continuityVerificationEntrypoint, []);
						expect(verification.ok).toBe(true);
					}
					expect(continuityObservation.ioProgressObservations).toContainEqual(
						expect.objectContaining({
							conversationSessionId: realCodexTaskId,
							outputProgressObserved: true,
							nativeInputAcceptanceObserved: true,
						}),
					);
					const nativeAfterInput = (await restored.client.workspace.getState.query()).sessions[realCodexTaskId];
					if (evidenceDirectory)
						await writeFile(
							join(evidenceDirectory, "real-codex-continuity-evidence.json"),
							JSON.stringify(
								{
									original,
									nativeAfter,
									nativeAfterInput,
									deploymentPreflight,
									continuityObservation,
									nativeModelRequestCount: nativeModelRequestBodies.length,
									externalInference: false,
								},
								null,
								2,
							),
						);
					if (evidenceDirectory) {
						const transcriptPath = nativeAfter.agentNativeConversationSessionIdentity?.transcriptPath;
						if (!transcriptPath) throw new Error("真实 Codex 缺少原生转录证据");
						const transcript = await readFile(transcriptPath, "utf8");
						const userMessages = transcript
							.split("\n")
							.slice(0, -1)
							.map(
								(line) => JSON.parse(line) as { type?: string; payload?: { role?: string; content?: unknown } },
							)
							.filter((record) => record.type === "response_item" && record.payload?.role === "user");
						expect(
							userMessages.filter((record) =>
								JSON.stringify(record.payload?.content).includes("REAL_CODEX_BEFORE_RUNTIME_RESTART"),
							),
						).toHaveLength(1);
						expect(
							userMessages.filter((record) =>
								JSON.stringify(record.payload?.content).includes("REAL_CODEX_AFTER_RUNTIME_RESTART"),
							),
						).toHaveLength(1);
						await writeFile(join(evidenceDirectory, "real-codex-native-transcript.jsonl"), transcript);
						await copyFile(
							join(
								runtimeIdentity.runtimeHomeDirectoryPath,
								"agent-session-pty-host",
								"logs",
								`p${runtimePort}-agent-session-pty-host.log`,
							),
							join(evidenceDirectory, "real-codex-pty-host.log"),
						);
						const processes = await readPosixProcessResourceTable();
						const descendants = new Set<number>(nativeAfter.pid ? [nativeAfter.pid] : []);
						let previousCount = -1;
						while (previousCount !== descendants.size) {
							previousCount = descendants.size;
							for (const row of processes)
								if (descendants.has(row.parentProcessId)) descendants.add(row.processId);
						}
						await writeFile(
							join(evidenceDirectory, "real-codex-native-descendant-process-identities.json"),
							JSON.stringify(
								processes.filter((row) => descendants.has(row.processId)),
								null,
								2,
							),
						);
					}
					await restored.client.runtime.stopTaskSession.mutate({ taskId: realCodexTaskId });
				}
				if (evidenceDirectory)
					await writeFile(
						join(evidenceDirectory, "packaged-runtime-continuity-evidence.json"),
						JSON.stringify({ before: ownershipBefore, disabled, after, originalProcess }, null, 2),
					);
				await restored.client.runtime.stopTaskSession.mutate({ taskId: shellTaskId });
			} finally {
				for (const child of runtimeProcesses) await sigkillChildProcessAndWaitForExit(child);
				for (const socketPath of listAgentSessionPtyHostGenerationSocketPaths(runtimeIdentity)) {
					const connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath).catch(
						() => null,
					);
					if (connection) {
						const hostProcessId = connection.hostHello.hostProcessId;
						connection.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
						await connection.closeAfterFlushingPendingFrames();
						await wait(() => {
							try {
								process.kill(hostProcessId, 0);
								return false;
							} catch {
								return true;
							}
						});
					}
				}
			}
		});
	},
);
