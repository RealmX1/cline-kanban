import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { buildCodexArgumentsUsingCompleteProfilePermissions } from "../../src/codex-configuration-sync/codex-configuration-profile-launch-settings";
import {
	createCodexConfigurationProfile,
	updateCodexConfigurationProfileFields,
} from "../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	buildCodexConfigurationWriterEnvironment,
	prepareCodexConfigurationWriterBinding,
} from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { readCodexNativeTurnPermissionEvidence } from "../../src/codex-configuration-sync/codex-native-turn-permission-evidence";
import { prepareManagedCodexConversationStorageHome } from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import { withStoppedCodexNativeThreadWriterLock } from "../../src/codex-conversation-storage/codex-native-thread-writer-lock";
import { bootstrapCodexRemoteConversationBeforeTuiAttach } from "../../src/codex-native-session-control-host/codex-remote-conversation-bootstrap";
import { prepareCodexRemoteConversationLaunchPlan } from "../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";
import {
	withCodexAppServerRequestConnection,
	withRunningCodexAppServerControlSocketConnection,
} from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../src/core/codex-configuration-sync-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { withExplicitApprovalOfObservedCodexConfigurationProposals } from "../utilities/explicitly-approve-observed-codex-configuration-proposals";
import { requireDefinedTestFixtureValue } from "../utilities/require-defined-test-fixture-value";
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
			let latestSyntheticModelRequest: { model?: unknown; reasoning?: unknown } | undefined;
			const model = createServer(async (request, response) => {
				const requestChunks: Buffer[] = [];
				for await (const chunk of request) requestChunks.push(Buffer.from(chunk));
				if (!request.url?.includes("responses")) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end('{"data":[]}');
					return;
				}
				const parsedRequest = JSON.parse(Buffer.concat(requestChunks).toString("utf8"));
				latestSyntheticModelRequest = { model: parsedRequest.model, reasoning: parsedRequest.reasoning };
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
			const startWriter = async (
				sessionId: string,
				previousBinding?: CodexConfigurationWriterBinding,
				codexConfigurationProfileId?: string,
			) => {
				const environment = fixture.createIsolatedChildProcessEnvironment();
				const binding = await prepareCodexConfigurationWriterBinding({
					purpose: "native_session",
					codexConfigurationProfileId,
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
			const otherProfile = await mutateCodexConfigurationSyncStore((store) => {
				const profile = createCodexConfigurationProfile(store, {
					name: "原生跨 profile 验证",
					copyFromProfileId: requireDefinedTestFixtureValue(
						store.writers[origin.binding.writerId].codexConfigurationProfileId,
					),
				});
				const fieldKey = JSON.stringify(["config.toml", "hooks", "state", `${sourceHome}/hooks.json:stop:0:0`]);
				updateCodexConfigurationProfileFields(store, profile.profileId, {
					[fieldKey]: {
						...profile.fields[fieldKey],
						value: { enabled: false, trusted_hash: initialHook.currentHash },
					},
				});
				return profile;
			});
			const otherProfileTarget = await startWriter("other-profile", undefined, otherProfile.profileId);
			const sync = withExplicitApprovalOfObservedCodexConfigurationProposals(
				createCodexConfigurationSyncService({ listSessions: () => sessions, onUpdated: () => {} }),
			);
			onTestFinished(() => sync.close());
			const observations = async () => {
				try {
					return (await readFile(observationsPath, "utf8")).trim().split("\n").filter(Boolean);
				} catch {
					return [];
				}
			};
			const stages: Array<{ label: string; stopHookCount: number }> = [];
			const runTurn = async (
				label: string,
				threadId = target.threadId,
				duringTurn?: () => Promise<void>,
				request = target.request,
				expectedStopHookCount?: number,
			) => {
				const before = (await observations()).length;
				if (duringTurn) holdNextResponse = true;
				const turn = z.object({ turn: z.object({ id: z.string() }) }).parse(
					await request("turn/start", {
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
							.parse(await request("thread/read", { threadId, includeTurns: true }));
						expect(response.thread.turns.find((item) => item.id === turn.id)?.status).toBe("completed");
					},
					{ timeout: 60_000, interval: 50 },
				);
				if (expectedStopHookCount === 1) {
					const hookObservationStartedAtMs = Date.now();
					await vi.waitFor(async () => expect((await observations()).length - before).toBe(1), {
						timeout: 10_000,
						interval: 25,
					});
					if (Date.now() - hookObservationStartedAtMs > 1_000)
						process.stderr.write("原生 Stop hook 落盘超过软等待档，已在硬档内核验真实执行。\n");
				}
				const stopHookCount = (await observations()).length - before;
				stages.push({ label, stopHookCount });
				return stopHookCount;
			};
			expect(await runTurn("隔离 writer 启动后保持同一信任", undefined, undefined, undefined, 1)).toBe(1);
			expect(
				await runTurn(
					"另一个 profile 保持独立禁用",
					otherProfileTarget.threadId,
					undefined,
					otherProfileTarget.request,
				),
			).toBe(0);
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
			expect(await runTurn("只更新磁盘，原线程仍使用已加载状态", undefined, undefined, undefined, 1)).toBe(1);
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
			expect(await runTurn("另一进程重载不能刷新原所有者", undefined, undefined, undefined, 1)).toBe(1);
			await target.request("config/batchWrite", { edits: [], reloadUserConfig: true });
			expect(await runTurn("当前安装版本的原所有者重载确实采用磁盘禁用")).toBe(0);
			await writeFile(targetConfigurationPath, initialTargetText);
			await target.request("config/batchWrite", { edits: [], reloadUserConfig: true });
			expect(await runTurn("原所有者恢复同一定义的信任", undefined, undefined, undefined, 1)).toBe(1);
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
			expect(
				await runTurn("profile 在回合内自动传播禁用", target.threadId, async () => {
					await decideAtOrigin({ enabled: false, trusted_hash: initialHook.currentHash });
					await sync.scan();
					const result = await sync.getState();
					expect(result.changes[0].targets[0].status).toBe("applied");
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
			await sync.scan();
			const enabledChange = (await sync.getState()).changes[0];
			await sync.synchronize({
				changeId: enabledChange.changeId,
				expectedVersion: enabledChange.version,
				idempotencyKey: randomUUID(),
				synchronizeExistingSessions: true,
			});
			expect(await runTurn("较新的明确重新启用", undefined, undefined, undefined, 1)).toBe(1);
			expect(
				await runTurn(
					"启停变化不广播到另一 profile",
					otherProfileTarget.threadId,
					undefined,
					otherProfileTarget.request,
				),
			).toBe(0);
			await otherProfileTarget.request("config/batchWrite", {
				edits: [
					{
						keyPath: "hooks.state",
						value: {
							[`${otherProfileTarget.binding.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: {
								enabled: true,
								trusted_hash: initialHook.currentHash,
							},
						},
						mergeStrategy: "replace",
					},
				],
				reloadUserConfig: true,
			});
			await sync.scan();
			expect(
				await runTurn(
					"另一 profile 明确启用后使用已确认信任",
					otherProfileTarget.threadId,
					undefined,
					otherProfileTarget.request,
					1,
				),
			).toBe(1);
			await decideAtOrigin({ enabled: true });
			await sync.scan();
			const revokedChange = (await sync.getState()).changes[0];
			await sync.synchronize({
				changeId: revokedChange.changeId,
				expectedVersion: revokedChange.version,
				idempotencyKey: randomUUID(),
				synchronizeExistingSessions: true,
			});
			expect(await runTurn("原所有者撤销信任")).toBe(0);
			expect(
				await runTurn(
					"撤销信任自动跨 profile 生效且不改启停",
					otherProfileTarget.threadId,
					undefined,
					otherProfileTarget.request,
				),
			).toBe(0);
			await decideAtOrigin({ enabled: true, trusted_hash: initialHook.currentHash });
			await sync.scan();
			expect(
				await runTurn(
					"同一定义重新确认信任后跨 profile 复用",
					otherProfileTarget.threadId,
					undefined,
					otherProfileTarget.request,
					1,
				),
			).toBe(1);
			const updatedHookDefinition = JSON.parse(
				await readFile(join(origin.binding.configurationHomeDirectoryPath, "hooks.json"), "utf8"),
			);
			updatedHookDefinition.hooks.Stop[0].hooks[0].command += " && true";
			for (const owner of [origin, otherProfileTarget])
				await writeFile(
					join(owner.binding.configurationHomeDirectoryPath, "hooks.json"),
					JSON.stringify(updatedHookDefinition),
				);
			await otherProfileTarget.request("config/batchWrite", { edits: [], reloadUserConfig: true });
			await sync.scan();
			expect(
				await runTurn("定义改变后旧信任失效", otherProfileTarget.threadId, undefined, otherProfileTarget.request),
			).toBe(0);
			const updatedHook = requireDefinedTestFixtureValue(
				hooksResponse
					.parse(await origin.request("hooks/list", { cwds: [root] }))
					.data.flatMap((item) => item.hooks)
					.find((hook) => hook.key.endsWith("/hooks.json:stop:0:0")),
			);
			expect(updatedHook.currentHash).not.toBe(initialHook.currentHash);
			await decideAtOrigin({ enabled: true, trusted_hash: updatedHook.currentHash });
			await sync.scan();
			expect(
				await runTurn(
					"新定义在一个 profile 确认后复用到同定义 profile",
					otherProfileTarget.threadId,
					undefined,
					otherProfileTarget.request,
					1,
				),
			).toBe(1);
			await sigkillChildProcessAndWaitForExit(target.child);
			await withStoppedCodexNativeThreadWriterLock(storageHome, target.threadId, async () => undefined);
			await mutateCodexConfigurationSyncStore((store) =>
				updateCodexConfigurationProfileFields(
					store,
					requireDefinedTestFixtureValue(target.binding.codexConfigurationProfileId),
					{
						[JSON.stringify(["config.toml", "model"])]: { value: "gpt-5.4-mini" },
						[JSON.stringify(["config.toml", "model_reasoning_effort"])]: { value: "high" },
						[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
						[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
					},
				),
			);
			const replacementBinding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome,
				workspaceId: "native-fixture",
				conversationSessionId: "target",
				runtimeSessionIncarnationId: randomUUID(),
				previousBinding: target.binding,
			});
			const adoptedFields = (await readCodexConfigurationSyncStore()).writers[replacementBinding.writerId]
				.launchBaselineFields;
			const permissionArguments = requireDefinedTestFixtureValue(
				buildCodexArgumentsUsingCompleteProfilePermissions(
					["resume", target.threadId, "--model", "gpt-5.4-mini", "-c", 'model_reasoning_effort="high"'],
					adoptedFields,
				),
			);
			const launchPlan = requireDefinedTestFixtureValue(
				prepareCodexRemoteConversationLaunchPlan(permissionArguments, root),
			);
			await withCodexAppServerRequestConnection(
				{
					binary,
					workingDirectory: root,
					experimentalApi: true,
					argumentsBeforeSubcommand: launchPlan.appServerRootArguments,
					environment: fixture.createIsolatedChildProcessEnvironment(
						buildCodexConfigurationWriterEnvironment(replacementBinding),
					),
				},
				async (port) => {
					const adopted = await bootstrapCodexRemoteConversationBeforeTuiAttach(port, launchPlan);
					expect(adopted.nativeSessionId).toBe(target.threadId);
					expect(adopted.effectiveApprovalPolicy).toBe("on-request");
					expect(adopted.effectiveSandbox.type).toBe("workspaceWrite");
					await runTurn(
						"同一原生会话续接后实际使用 profile 的模型与 Effort",
						target.threadId,
						undefined,
						port.request.bind(port),
					);
					expect(latestSyntheticModelRequest?.model).toBe("gpt-5.4-mini");
					expect(latestSyntheticModelRequest?.reasoning).toMatchObject({ effort: "high" });
					const currentNativeSummary = runtimeTaskSessionSummarySchema.parse({
						...sessions.find((session) => session.summary.taskId === "target")?.summary,
						startedAt: replacementBinding.createdAt,
						agentNativeConversationSessionIdentity: {
							sourceAgentId: "codex",
							nativeSessionId: target.threadId,
							transcriptPath: adopted.nativeTranscriptPath,
							observedAt: Date.now(),
						},
					});
					expect(
						await readCodexNativeTurnPermissionEvidence({
							summary: currentNativeSummary,
							configurationChangedAtMs: replacementBinding.createdAt,
							selectedFields: adoptedFields,
						}),
					).toMatchObject({
						[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
						[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
					});
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
							nativeVersion: (await readCodexConfigurationSyncStore()).writers[origin.binding.writerId]
								.nativeBinaryVersion,
							writerIds: [origin.binding.writerId, target.binding.writerId, replacementBinding.writerId],
							sourceConfigurationUnchanged: true,
							nativeResumedProfilePermissions: { approvalPolicy: "on-request", sandbox: "workspaceWrite" },
							actualResumedModelRequest: latestSyntheticModelRequest,
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
