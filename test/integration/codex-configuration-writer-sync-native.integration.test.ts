import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createCodexConfigurationSyncService } from "../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	buildCodexConfigurationWriterEnvironment,
	prepareCodexConfigurationWriterBinding,
} from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import { withStoppedCodexNativeThreadWriterLock } from "../../src/codex-conversation-storage/codex-native-thread-writer-lock";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../src/core/codex-configuration-sync-contract";
import {
	withCodexAppServerRequestConnection,
	withRunningCodexAppServerControlSocketConnection,
} from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});
const threadResponse = z.object({ thread: z.object({ id: z.string(), path: z.string().nullable() }) });
const hooksResponse = z.object({
	data: z.array(
		z.object({ hooks: z.array(z.object({ key: z.string(), currentHash: z.string(), trustStatus: z.string() })) }),
	),
});

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY)(
	"真实 Codex 配置 writer 隔离与原所有者重载",
	{ timeout: 180_000 },
	() => {
		it("本地模型重放磁盘、错误进程、正确所有者和回合内重载，并核验多线程、fork/resume 和原生写锁", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-configuration-native-",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const binary = process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY ?? "codex";
			const root = fixture.fixtureRootDirectoryPath;
			const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
			await mkdir(sourceHome, { recursive: true });
			// Unix socket 使用短且独占的临时目录，交付证据另存到持久目录。
			const socketDirectory = await mkdtemp("/tmp/kanban-codex-config-sync-");
			onTestFinished(() => rm(socketDirectory, { recursive: true, force: true }));
			const observationsPath = join(root, "observed-stop-hooks.jsonl");
			const recorder = join(root, "record-native-stop-hook.cjs");
			await writeFile(
				recorder,
				`const fs=require('node:fs');let body='';process.stdin.on('data',chunk=>body+=chunk);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(observationsPath)},JSON.stringify(JSON.parse(body))+'\\n'));`,
			);
			await writeFile(
				join(sourceHome, "hooks.json"),
				JSON.stringify({
					hooks: {
						Stop: [
							{
								hooks: [
									{
										type: "command",
										command: `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)}`,
										timeout: 5,
									},
								],
							},
						],
					},
				}),
			);
			let responseSequence = 0;
			let holdNextResponse = false;
			let releaseResponse: (() => void) | null = null;
			const model = createServer(async (request, response) => {
				for await (const _chunk of request) {
					/* 排空本地模型请求，不保存提示正文。 */
				}
				if (!request.url?.includes("responses")) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end('{"data":[]}');
					return;
				}
				const sendResponse = () => {
					const sequence = ++responseSequence;
					const item = {
						type: "message",
						id: `local-message-${sequence}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "配置同步隔离验证", annotations: [] }],
					};
					const result = {
						id: `local-response-${sequence}`,
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
				};
				if (holdNextResponse) {
					holdNextResponse = false;
					releaseResponse = sendResponse;
				} else sendResponse();
			});
			await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
			onTestFinished(async () => {
				model.closeAllConnections();
				await new Promise<void>((resolve) => model.close(() => resolve()));
			});
			const address = model.address();
			if (!address || typeof address === "string") throw new Error("本地响应服务未启动。");
			const configuration: TomlTable = {
				model: "gpt-5.4",
				model_provider: "isolated_configuration_sync",
				check_for_update_on_startup: false,
				features: { hooks: true, memories: false },
				analytics: { enabled: false },
				feedback: { enabled: false },
				model_providers: {
					isolated_configuration_sync: {
						name: "本地合成响应",
						base_url: `http://127.0.0.1:${address.port}/v1`,
						wire_api: "responses",
						requires_openai_auth: false,
						supports_websockets: false,
					},
				},
				projects: { [root]: { trust_level: "trusted" } },
			};
			await writeFile(join(sourceHome, "config.toml"), stringify(configuration));
			const initialHook = await withCodexAppServerRequestConnection(
				{
					binary,
					workingDirectory: root,
					experimentalApi: true,
					environment: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: sourceHome,
						CODEX_SQLITE_HOME: sourceHome,
					}),
				},
				async (port) => hooksResponse.parse(await port.request("hooks/list", { cwds: [root] })).data[0].hooks[0],
			);
			expect(initialHook.trustStatus).toBe("untrusted");
			configuration.hooks = {
				state: { [initialHook.key]: { enabled: true, trusted_hash: initialHook.currentHash } },
			};
			await writeFile(join(sourceHome, "config.toml"), stringify(configuration));
			const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
			const sessions: Array<{ workspaceId: string; summary: RuntimeTaskSessionSummary }> = [];
			const startWriter = async (sessionId: string, previousBinding?: CodexConfigurationWriterBinding) => {
				const environment = fixture.createIsolatedChildProcessEnvironment();
				const binding = await prepareCodexConfigurationWriterBinding({
					purpose: "native_session",
					storageHome,
					workspaceId: "native-fixture",
					conversationSessionId: sessionId,
					runtimeSessionIncarnationId: randomUUID(),
					previousBinding,
					binary,
					environment,
				});
				const socketPath = join(socketDirectory, `${sessionId}.sock`);
				const child = children.register(
					spawn(binary, ["app-server", "--listen", `unix://${socketPath}`], {
						cwd: root,
						env: { ...environment, ...buildCodexConfigurationWriterEnvironment(binding) },
						stdio: ["ignore", "ignore", "ignore"],
					}),
				);
				const request = (method: string, parameters: Record<string, unknown>) =>
					withRunningCodexAppServerControlSocketConnection((port) => port.request(method, parameters), {
						socketPath,
						requestTimeoutMs: 5_000,
					});
				await vi.waitFor(
					async () => {
						await request("config/read", { includeLayers: false });
					},
					{ timeout: 30_000, interval: 100 },
				);
				const thread = threadResponse.parse(
					await request("thread/start", {
						cwd: root,
						approvalPolicy: "never",
						sandbox: "danger-full-access",
						persistExtendedHistory: true,
					}),
				).thread;
				const summary = runtimeTaskSessionSummarySchema.parse({
					taskId: sessionId,
					agentId: "codex",
					state: "running",
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
					workspacePath: root,
					pid: child.pid,
					startedAt: Date.now(),
					updatedAt: Date.now(),
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
					codexConversationStorageHomeDirectoryPath: storageHome,
					codexConfigurationWriterBinding: binding,
					codexNativeSessionControlEndpoint: {
						socketPath,
						workspaceId: "native-fixture",
						conversationSessionId: sessionId,
						runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
					},
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: thread.id,
						transcriptPath: thread.path ?? "",
						observedAt: Date.now(),
					},
				});
				sessions.push({ workspaceId: "native-fixture", summary });
				return { binding, child, request, threadId: thread.id };
			};
			const origin = await startWriter("origin"),
				target = await startWriter("target");
			const sync = createCodexConfigurationSyncService({ listSessions: () => sessions, onUpdated: () => {} });
			onTestFinished(() => sync.close());
			const observations = async () => {
				try {
					return (await readFile(observationsPath, "utf8")).trim().split("\n").filter(Boolean);
				} catch {
					return [];
				}
			};
			const stages: Array<{ label: string; stopHookCount: number }> = [];
			const runTurn = async (label: string, threadId = target.threadId, duringTurn?: () => Promise<void>) => {
				const before = (await observations()).length;
				if (duringTurn) holdNextResponse = true;
				const turn = z.object({ turn: z.object({ id: z.string() }) }).parse(
					await target.request("turn/start", {
						threadId,
						input: [{ type: "text", text: `本地配置同步验证 ${label}` }],
					}),
				).turn;
				if (duringTurn) {
					await vi.waitFor(() => expect(releaseResponse).not.toBeNull(), { timeout: 30_000, interval: 50 });
					try {
						await duringTurn();
					} finally {
						const release = releaseResponse as (() => void) | null;
						releaseResponse = null;
						release?.();
					}
				}
				await vi.waitFor(
					async () => {
						const response = z
							.object({ thread: z.object({ turns: z.array(z.object({ id: z.string(), status: z.string() })) }) })
							.parse(await target.request("thread/read", { threadId, includeTurns: true }));
						expect(response.thread.turns.find((item) => item.id === turn.id)?.status).toBe("completed");
					},
					{ timeout: 60_000, interval: 50 },
				);
				const stopHookCount = (await observations()).length - before;
				stages.push({ label, stopHookCount });
				return stopHookCount;
			};
			expect(await runTurn("隔离 writer 启动后保持同一信任")).toBe(1);
			const secondThreadId = threadResponse.parse(
				await target.request("thread/start", {
					cwd: root,
					approvalPolicy: "never",
					sandbox: "danger-full-access",
					persistExtendedHistory: true,
				}),
			).thread.id;
			const targetConfigurationPath = join(target.binding.configurationHomeDirectoryPath, "config.toml");
			const initialTargetText = await readFile(targetConfigurationPath, "utf8");
			const targetKey = `${await realpath(target.binding.configurationHomeDirectoryPath)}/hooks.json:stop:0:0`;
			const disabled = parse(initialTargetText);
			disabled.hooks = { state: { [targetKey]: { enabled: false, trusted_hash: initialHook.currentHash } } };
			await writeFile(targetConfigurationPath, stringify(disabled));
			expect(await runTurn("只更新磁盘，原线程仍使用已加载状态")).toBe(1);
			await withCodexAppServerRequestConnection(
				{
					binary,
					workingDirectory: root,
					experimentalApi: true,
					environment: fixture.createIsolatedChildProcessEnvironment(
						buildCodexConfigurationWriterEnvironment(target.binding),
					),
				},
				(port) => port.request("config/batchWrite", { edits: [], reloadUserConfig: true }),
			);
			expect(await runTurn("另一进程重载不能刷新原所有者")).toBe(1);
			await writeFile(targetConfigurationPath, initialTargetText);
			const decideAtOrigin = async (state: TomlTable) =>
				origin.request("config/batchWrite", {
					edits: [
						{
							keyPath: "hooks.state",
							value: { [`${origin.binding.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: state },
							mergeStrategy: "replace",
						},
					],
					reloadUserConfig: true,
				});
			await decideAtOrigin({ enabled: false, trusted_hash: initialHook.currentHash });
			const change = (await sync.getState()).changes[0];
			await sync.synchronize({
				changeId: change.changeId,
				expectedVersion: change.version,
				idempotencyKey: randomUUID(),
				synchronizeExistingSessions: false,
			});
			expect(await runTurn("默认关闭同步，其他会话继续原状态")).toBe(1);
			expect(
				await runTurn("原所有者在回合内采用禁用", target.threadId, async () => {
					const result = await sync.synchronize({
						changeId: change.changeId,
						expectedVersion: change.version,
						idempotencyKey: randomUUID(),
						synchronizeExistingSessions: true,
					});
					expect(result.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe(
						"applied",
					);
				}),
			).toBe(0);
			expect(await runTurn("同一所有者的另一线程也采用禁用", secondThreadId)).toBe(0);
			await expect(
				withStoppedCodexNativeThreadWriterLock(storageHome, target.threadId, async () => undefined),
			).rejects.toThrow("仍被写入");
			const fork = threadResponse.parse(
				await target.request("thread/fork", { threadId: target.threadId, cwd: root, persistExtendedHistory: true }),
			).thread;
			expect(fork.id).not.toBe(target.threadId);
			expect(fork.path).toBeTruthy();
			await decideAtOrigin({ enabled: true, trusted_hash: initialHook.currentHash });
			const enabledChange = (await sync.getState()).changes[0];
			await sync.synchronize({
				changeId: enabledChange.changeId,
				expectedVersion: enabledChange.version,
				idempotencyKey: randomUUID(),
				synchronizeExistingSessions: true,
			});
			expect(await runTurn("较新的明确重新启用")).toBe(1);
			await decideAtOrigin({ enabled: true });
			const revokedChange = (await sync.getState()).changes[0];
			await sync.synchronize({
				changeId: revokedChange.changeId,
				expectedVersion: revokedChange.version,
				idempotencyKey: randomUUID(),
				synchronizeExistingSessions: true,
			});
			expect(await runTurn("原所有者撤销信任")).toBe(0);
			await sigkillChildProcessAndWaitForExit(target.child);
			await withStoppedCodexNativeThreadWriterLock(storageHome, target.threadId, async () => undefined);
			const replacementBinding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome,
				workspaceId: "native-fixture",
				conversationSessionId: "target",
				runtimeSessionIncarnationId: randomUUID(),
				previousBinding: target.binding,
			});
			await withCodexAppServerRequestConnection(
				{
					binary,
					workingDirectory: root,
					experimentalApi: true,
					environment: fixture.createIsolatedChildProcessEnvironment(
						buildCodexConfigurationWriterEnvironment(replacementBinding),
					),
				},
				async (port) => {
					const resumed = threadResponse.parse(
						await port.request("thread/resume", {
							threadId: target.threadId,
							cwd: root,
							approvalPolicy: "never",
							sandbox: "danger-full-access",
						}),
					);
					expect(resumed.thread.id).toBe(target.threadId);
				},
			);
			expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe(stringify(configuration));
			const evidenceDirectory = process.env.KANBAN_CODEX_CONFIGURATION_SYNC_EVIDENCE_DIRECTORY;
			if (evidenceDirectory) {
				await mkdir(evidenceDirectory, { recursive: true });
				await writeFile(
					join(evidenceDirectory, "native-configuration-sync-result.json"),
					JSON.stringify(
						{
							status: "passed",
							stages,
							localSyntheticResponseCount: responseSequence,
							nativeVersion: "codex-cli 0.164.0",
							writerIds: [origin.binding.writerId, target.binding.writerId, replacementBinding.writerId],
							sourceConfigurationUnchanged: true,
							nativeWriterLockShared: true,
						},
						null,
						2,
					),
				);
			}
		});
	},
);
