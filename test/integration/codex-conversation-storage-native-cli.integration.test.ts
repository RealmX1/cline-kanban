import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	prepareManagedCodexConversationStorageHome,
	resolveMigratedCodexConversationHome,
} from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import {
	migrateStoppedCodexConversationStorage,
	rollbackStoppedCodexConversationStorage,
} from "../../src/codex-conversation-storage/codex-conversation-storage-migration";
import { withCodexAppServerRequestConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const configurationReaderChildProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await configurationReaderChildProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex 会话存储隔离（仅回环模拟模型）",
	{ timeout: 120_000 },
	() => {
		it.for(["main", "external_profile"] as const)(
			"%s：原生配置读取保留原文件引用，并隔离 SQLite",
			async (sourceConfigurationKind, test) => {
				const fixture = createIsolatedGitTestWorkspaceFixture({
					fixtureRootDirectoryNamePrefix: "codex-storage-native-configuration-",
				});
				vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
				try {
					const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
					await mkdir(join(sourceHome, "agents"), { recursive: true });
					await mkdir(join(sourceHome, "instructions"));
					await writeFile(join(sourceHome, "instructions", "model.md"), "隔离模型指令");
					await writeFile(join(sourceHome, "instructions", "compact.md"), "隔离压缩指令");
					const roleConfiguration = 'model_instructions_file="../instructions/model.md"\n';
					await writeFile(join(sourceHome, "agents", "worker.toml"), roleConfiguration);
					await writeFile(join(sourceHome, "auth.json"), '{"OPENAI_API_KEY":"synthetic-config-read-only"}');
					const fileReferences = {
						model_instructions_file: "instructions/model.md",
						experimental_compact_prompt_file: "instructions/compact.md",
					};
					const agents = { worker: { description: "隔离工作角色", config_file: "agents/worker.toml" } };
					const sourceConfiguration = stringify({
						check_for_update_on_startup: false,
						cli_auth_credentials_store: "file",
						sqlite_home: join(sourceHome, "original-sqlite"),
						model_provider: "isolated_config_read",
						model_providers: {
							isolated_config_read: {
								name: "隔离配置读取",
								base_url: "http://127.0.0.1:1/v1",
								wire_api: "responses",
								requires_openai_auth: false,
							},
						},
						...(sourceConfigurationKind === "main" ? { ...fileReferences, agents } : {}),
					});
					await writeFile(join(sourceHome, "config.toml"), sourceConfiguration);
					const sourceProfile = stringify({ ...fileReferences, agents });
					if (sourceConfigurationKind === "external_profile")
						await writeFile(join(sourceHome, "review.config.toml"), sourceProfile);
					const managed = await prepareManagedCodexConversationStorageHome(sourceHome);
					for (const home of [sourceHome, managed]) {
						const environment = fixture.createIsolatedChildProcessEnvironment({
							CODEX_HOME: home,
							CODEX_SQLITE_HOME: home,
							OPENAI_API_KEY: "synthetic-config-read-only",
						});
						if (sourceConfigurationKind === "external_profile") {
							// 0.164 的 app-server 不支持 --profile；此只读入口会实际加载 profile 指令，不启动模型回合。
							const child = configurationReaderChildProcesses.register(
								spawn(
									process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY ?? "codex",
									["--profile", "review", "debug", "prompt-input"],
									{
										cwd: fixture.fixtureRootDirectoryPath,
										env: environment,
										stdio: ["ignore", "pipe", "pipe"],
									},
								),
							);
							let stdout = "";
							child.stdout?.on("data", (chunk) => {
								stdout += String(chunk);
							});
							child.stderr?.resume();
							const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
							await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, child, {
								waitedForDescription: "原生 profile 指令只读加载",
								softDeadlineMsExpectedOnUncontendedHost: 5_000,
								hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
							});
							await closed;
							expect(child.exitCode).toBe(0);
							expect(stdout).toContain("隔离模型指令");
							continue;
						}
						await withCodexAppServerRequestConnection(
							{
								binary: process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY,
								workingDirectory: fixture.fixtureRootDirectoryPath,
								environment,
							},
							async (port) => {
								const { config } = z
									.object({
										config: z.object({
											model_instructions_file: z.string(),
											experimental_compact_prompt_file: z.string(),
											sqlite_home: z.string(),
											agents: z.object({ worker: z.object({ config_file: z.string() }) }),
										}),
									})
									.parse(await port.request("config/read", { includeLayers: false }));
								for (const [field, sourceRelativePath] of Object.entries(fileReferences))
									expect(await realpath(config[field as keyof typeof fileReferences])).toBe(
										await realpath(join(sourceHome, sourceRelativePath)),
									);
								expect(await readFile(config.agents.worker.config_file, "utf8")).toBe(roleConfiguration);
								if (home === managed) expect(await realpath(config.sqlite_home)).toBe(await realpath(managed));
							},
						);
					}
					expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe(sourceConfiguration);
					if (sourceConfigurationKind === "external_profile")
						expect(await readFile(join(sourceHome, "review.config.toml"), "utf8")).toBe(sourceProfile);
				} finally {
					vi.unstubAllEnvs();
				}
			},
		);
		it.for(["legacy", "paginated"] as const)(
			"%s：保护活体、保留完整上下文，迁移后能继续对话并带新增历史回退",
			async (historyMode, test) => {
				const binary = process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY ?? "codex";
				const fixture = createIsolatedGitTestWorkspaceFixture({
					fixtureRootDirectoryNamePrefix: "codex-storage-native-",
				});
				vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
				const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
				const workingDirectory = join(fixture.fixtureRootDirectoryPath, "former-task-workspace");
				await mkdir(sourceHome);
				await mkdir(workingDirectory);
				const requests: string[] = [];
				const server = createServer(async (request, response) => {
					let body = "";
					for await (const chunk of request) body += String(chunk);
					requests.push(body);
					const number = requests.length;
					const text = `隔离模拟回复 ${number}`;
					const item = {
						id: `message_${number}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text, annotations: [] }],
					};
					const result = {
						id: `response_${number}`,
						object: "response",
						created_at: Math.floor(Date.now() / 1000),
						status: "completed",
						model: "gpt-5.4",
						output: [item],
						usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
					};
					const events: [string, Record<string, unknown>][] = [
						["response.created", { response: { ...result, status: "in_progress", output: [] } }],
						[
							"response.output_item.added",
							{ output_index: 0, item: { ...item, status: "in_progress", content: [] } },
						],
						[
							"response.content_part.added",
							{
								item_id: item.id,
								output_index: 0,
								content_index: 0,
								part: { type: "output_text", text: "", annotations: [] },
							},
						],
						["response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text }],
						["response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text }],
						["response.output_item.done", { output_index: 0, item }],
						["response.completed", { response: result }],
					];
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					for (const [type, fields] of events)
						response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
					response.end();
				});
				try {
					await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
					const address = server.address();
					if (!address || typeof address === "string") throw new Error("未分配隔离模型端口。");
					await writeFile(
						join(sourceHome, "config.toml"),
						`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[features]\nmemories=false\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`,
					);
					await writeFile(
						join(sourceHome, "auth.json"),
						JSON.stringify({ OPENAI_API_KEY: "synthetic-local-model-only" }),
						{ mode: 0o600 },
					);
					const environment = fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: sourceHome,
						CODEX_SQLITE_HOME: sourceHome,
					});
					let nativeSessionId = "";
					const waitForCompletedTurns = async (home: string, count: number) => {
						await withCodexAppServerRequestConnection(
							{
								binary,
								workingDirectory: home,
								codexConversationStorageHomeDirectoryPath: home,
								environment: fixture.createIsolatedChildProcessEnvironment({
									CODEX_HOME: home,
									CODEX_SQLITE_HOME: home,
								}),
								argumentsBeforeSubcommand: ["--disable", "memories"],
							},
							async (reader) => {
								await waitForConditionWithinLoadSensitiveTwoTierDeadline(
									test,
									{
										waitedForDescription: "真实 Codex 回环模拟回合持久化",
										softDeadlineMsExpectedOnUncontendedHost: 10_000,
										hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
									},
									async () => {
										const turns = await readCodexConversationTurns(reader, nativeSessionId);
										return turns.length === count && turns.every((turn) => turn.status === "completed");
									},
								);
							},
						);
					};
					const migrationRequest = () => ({
						sourceHomeDirectoryPath: sourceHome,
						nativeSessionId,
						workingDirectoryPath: workingDirectory,
						binary,
						assertSessionStillStopped: () => {},
					});
					await withCodexAppServerRequestConnection(
						{ binary, workingDirectory: workingDirectory, environment, experimentalApi: true },
						async (port) => {
							const started = z.object({ thread: z.object({ id: z.string() }) }).parse(
								await port.request("thread/start", {
									cwd: workingDirectory,
									model: "gpt-5.4",
									approvalPolicy: "never",
									sandbox: "read-only",
									historyMode,
								}),
							);
							nativeSessionId = started.thread.id;
							await port.request("turn/start", {
								threadId: nativeSessionId,
								input: [{ type: "text", text: "ORIGINAL_STORAGE_HISTORY_SENTINEL", text_elements: [] }],
							});
							await waitForCompletedTurns(sourceHome, 1);
							await expect(migrateStoppedCodexConversationStorage(migrationRequest())).rejects.toThrow(
								"已延后迁移",
							);
						},
					);
					await rename(workingDirectory, `${workingDirectory}-finished`);
					await migrateStoppedCodexConversationStorage(migrationRequest());
					const targetHome = getManagedCodexConversationStorageHomeDirectoryPath();
					expect(requests).toHaveLength(1);
					await withCodexAppServerRequestConnection(
						{
							binary,
							workingDirectory: fixture.fixtureRootDirectoryPath,
							environment: fixture.createIsolatedChildProcessEnvironment({
								CODEX_HOME: targetHome,
								CODEX_SQLITE_HOME: targetHome,
							}),
						},
						async (port) => {
							const resumed = z.object({ thread: z.object({ id: z.string() }) }).parse(
								await port.request("thread/resume", {
									threadId: nativeSessionId,
									excludeTurns: true,
									cwd: fixture.fixtureRootDirectoryPath,
								}),
							);
							expect(resumed.thread.id).toBe(nativeSessionId);
							await port.request("turn/start", {
								threadId: nativeSessionId,
								input: [{ type: "text", text: "AFTER_STORAGE_MIGRATION_SENTINEL", text_elements: [] }],
							});
							await waitForCompletedTurns(targetHome, 2);
						},
					);
					expect(requests).toHaveLength(2);
					expect(requests[1]).toContain("ORIGINAL_STORAGE_HISTORY_SENTINEL");
					expect(requests[1]).toContain("AFTER_STORAGE_MIGRATION_SENTINEL");
					await rollbackStoppedCodexConversationStorage(migrationRequest());
					expect(await resolveMigratedCodexConversationHome(targetHome, nativeSessionId)).toBe(sourceHome);
					await withCodexAppServerRequestConnection(
						{ binary, workingDirectory: fixture.fixtureRootDirectoryPath, environment },
						async (port) => {
							expect(await readCodexConversationTurns(port, nativeSessionId)).toHaveLength(2);
						},
					);
					const state = new Database(join(sourceHome, "state_5.sqlite"));
					try {
						expect(state.prepare("SELECT archived FROM threads WHERE id = ?").get(nativeSessionId)).toEqual({
							archived: 0,
						});
					} finally {
						state.close();
					}
				} finally {
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					vi.unstubAllEnvs();
				}
			},
		);
	},
);

import { spawn } from "node:child_process";
