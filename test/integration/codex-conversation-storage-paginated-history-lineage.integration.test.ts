import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listAvailableAgentSessions } from "../../src/agent-session-history/available-agent-session-index";
import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	resolveMigratedCodexConversationHome,
} from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import {
	migrateStoppedCodexConversationStorage,
	readCodexConversationStorageMigrationRecord,
	rollbackStoppedCodexConversationStorage,
} from "../../src/codex-conversation-storage/codex-conversation-storage-migration";
import { withCodexAppServerRequestConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import {
	type CodexAppServerRequestPort,
	readCodexConversationTurns,
} from "../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

const threadResponseSchema = z.object({ thread: z.object({ id: z.string(), path: z.string().nullish() }) });

function readNativeThread(home: string, id: string) {
	const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
	try {
		return z
			.object({ rollout_path: z.string(), archived: z.number() })
			.parse(state.prepare("SELECT rollout_path, archived FROM threads WHERE id = ?").get(id));
	} finally {
		state.close();
	}
}

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex 分页 lineage 存储迁移（仅回环模型）",
	{ timeout: 180_000 },
	() => {
		it.for(["fork", "resume"] as const)(
			"%s：保留完整祖先、当前分片与原生身份，回退后仍可携带全部上下文续聊",
			async (scenario, test) => {
				const binary = process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY ?? "codex";
				const evidenceRoot = process.env.KANBAN_CODEX_PAGINATED_LINEAGE_EVIDENCE_DIRECTORY;
				const fixture = createIsolatedGitTestWorkspaceFixture({
					fixtureRootDirectoryNamePrefix: "codex-paginated-lineage-",
				});
				vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
				vi.stubEnv("CODEX_SQLITE_HOME", "");
				const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
				vi.stubEnv("CODEX_HOME", sourceHome);
				const workingDirectory = join(fixture.fixtureRootDirectoryPath, "task-execution-workspace");
				await mkdir(sourceHome);
				await mkdir(workingDirectory);
				const requests: string[] = [];
				const observations: Record<string, unknown>[] = [];
				const server = createServer(async (request, response) => {
					let body = "";
					for await (const chunk of request) body += String(chunk);
					requests.push(body);
					const number = requests.length;
					const item = {
						id: `lineage_message_${number}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: `隔离回复 ${number}`, annotations: [] }],
					};
					const result = {
						id: `lineage_response_${number}`,
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
				let nativeSessionId = "";
				let parentId = "";
				try {
					await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
					const address = server.address();
					if (!address || typeof address === "string") throw new Error("未分配隔离回环端口。");
					await writeFile(
						join(sourceHome, "config.toml"),
						`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[features]\nmemories=false\nbackground_paginated_rollout_migration=false\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`,
					);
					await writeFile(
						join(sourceHome, "auth.json"),
						JSON.stringify({ OPENAI_API_KEY: "synthetic-loopback-only" }),
						{ mode: 0o600 },
					);
					const connect = <T>(home: string, operation: (port: CodexAppServerRequestPort) => Promise<T>) =>
						withCodexAppServerRequestConnection(
							{
								binary,
								workingDirectory,
								experimentalApi: true,
								environment: fixture.createIsolatedChildProcessEnvironment({
									CODEX_HOME: home,
									CODEX_SQLITE_HOME: home,
								}),
								argumentsBeforeSubcommand: [
									"--disable",
									"memories",
									"--disable",
									"background_paginated_rollout_migration",
								],
							},
							operation,
						);
					const waitForCompletedTurns = async (home: string, id: string, count: number) =>
						connect(home, async (reader) => {
							await waitForConditionWithinLoadSensitiveTwoTierDeadline(
								test,
								{
									waitedForDescription: "分页 lineage 原生回合持久化",
									softDeadlineMsExpectedOnUncontendedHost: 10_000,
									hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
								},
								async () => {
									const turns = await readCodexConversationTurns(reader, id);
									return turns.length === count && turns.every((turn) => turn.status === "completed");
								},
							);
							return readCodexConversationTurns(reader, id);
						});
					const sendTurn = async (
						port: CodexAppServerRequestPort,
						home: string,
						id: string,
						text: string,
						count: number,
					) => {
						await port.request("turn/start", {
							threadId: id,
							input: [{ type: "text", text, text_elements: [] }],
						});
						return waitForCompletedTurns(home, id, count);
					};
					const resumeAndSend = async (home: string, text: string, count: number) =>
						connect(home, async (port) => {
							const resumed = threadResponseSchema.parse(
								await port.request("thread/resume", {
									threadId: nativeSessionId,
									cwd: workingDirectory,
									excludeTurns: true,
								}),
							);
							expect(resumed.thread.id).toBe(nativeSessionId);
							return sendTurn(port, home, nativeSessionId, text, count);
						});
					const revertBeforeTurn = (home: string, turnId: string | undefined) =>
						connect(home, async (port) => {
							if (!turnId) throw new Error("未取得原生回退分界。");
							await port.request("thread/resume", { threadId: nativeSessionId, excludeTurns: true });
							await port.request("thread/revert", { threadId: nativeSessionId, beforeTurnId: turnId });
						});
					const migrationRequest = () => ({
						sourceHomeDirectoryPath: sourceHome,
						nativeSessionId,
						workingDirectoryPath: workingDirectory,
						binary,
						assertSessionStillStopped: () => {},
					});
					await connect(sourceHome, async (parent) => {
						parentId = threadResponseSchema.parse(
							await parent.request("thread/start", {
								cwd: workingDirectory,
								model: "gpt-5.4",
								approvalPolicy: "never",
								sandbox: "read-only",
								historyMode: "paginated",
							}),
						).thread.id;
						await sendTurn(parent, sourceHome, parentId, "PARENT_LINEAGE_FIRST_SENTINEL 中文分页祖先 🧭", 1);
						const parentTurns = await sendTurn(parent, sourceHome, parentId, "PARENT_LINEAGE_SECOND_SENTINEL", 2);
						nativeSessionId = parentId;
						if (scenario === "fork") {
							await connect(sourceHome, async (branch) => {
								nativeSessionId = threadResponseSchema.parse(
									await branch.request("thread/fork", {
										threadId: parentId,
										lastTurnId: parentTurns.at(-1)?.id,
										cwd: workingDirectory,
									}),
								).thread.id;
								await sendTurn(branch, sourceHome, nativeSessionId, "FORK_LINEAGE_LOCAL_SENTINEL", 3);
							});
							const history = new Database(join(sourceHome, "thread_history_1.sqlite"), { readonly: true });
							try {
								expect(
									history
										.prepare("SELECT COUNT(*) AS count FROM thread_turns WHERE thread_id = ?")
										.get(nativeSessionId),
								).toEqual({ count: 1 });
							} finally {
								history.close();
							}
							observations.push({
								stage: "fork-before-migration",
								nativeSessionId,
								parentId,
								thread: readNativeThread(sourceHome, nativeSessionId),
							});
							// 父会话仍由这个 app-server 持有；迁移分支不能停止或归档它。
							await migrateStoppedCodexConversationStorage(migrationRequest());
							expect(readNativeThread(sourceHome, parentId).archived).toBe(0);
							expect(await readCodexConversationStorageMigrationRecord(sourceHome, parentId)).toBeNull();
							expect(await readCodexConversationTurns(parent, parentId)).toHaveLength(2);
							await sendTurn(parent, sourceHome, parentId, "PARENT_AFTER_FORK_MIGRATION_UNRELATED_SENTINEL", 3);
						}
					});
					if (scenario === "resume") {
						const disposable = await resumeAndSend(sourceHome, "SOURCE_DISCARDED_LINEAGE_SENTINEL", 3);
						await revertBeforeTurn(sourceHome, disposable.at(-1)?.id);
						await resumeAndSend(sourceHome, "SOURCE_REWOUND_RESUME_SENTINEL", 3);
						await migrateStoppedCodexConversationStorage(migrationRequest());
					}
					const targetHome = getManagedCodexConversationStorageHomeDirectoryPath();
					const initialTurns = 3;
					const initialPrivatePath = readNativeThread(targetHome, nativeSessionId).rollout_path;
					await resumeAndSend(targetHome, "PRIVATE_LINEAGE_FIRST_SENTINEL", initialTurns + 1);
					const firstResumedPath = readNativeThread(targetHome, nativeSessionId).rollout_path;
					const beforeRevert = await resumeAndSend(targetHome, "DISCARDED_LINEAGE_SENTINEL", initialTurns + 2);
					await revertBeforeTurn(targetHome, beforeRevert.at(-1)?.id);
					await resumeAndSend(targetHome, "PRIVATE_LINEAGE_SECOND_SENTINEL", initialTurns + 2);
					const firstReplacementPath = readNativeThread(targetHome, nativeSessionId).rollout_path;
					const secondDisposable = await resumeAndSend(
						targetHome,
						"SECOND_DISCARDED_LINEAGE_SENTINEL",
						initialTurns + 3,
					);
					await revertBeforeTurn(targetHome, secondDisposable.at(-1)?.id);
					await resumeAndSend(targetHome, "PRIVATE_LINEAGE_THIRD_SENTINEL", initialTurns + 3);
					const latestPath = readNativeThread(targetHome, nativeSessionId).rollout_path;

					expect(firstReplacementPath).not.toBe(firstResumedPath);
					expect(latestPath).not.toBe(firstReplacementPath);
					observations.push({
						stage: "before-rollback",
						initialPrivatePath,
						firstResumedPath,
						latestPath,
						latestHeader: JSON.parse((await readFile(latestPath, "utf8")).split("\n")[0] ?? "null"),
					});
					for (const sentinel of [
						"PARENT_LINEAGE_FIRST_SENTINEL",
						"PARENT_LINEAGE_SECOND_SENTINEL",
						"PRIVATE_LINEAGE_FIRST_SENTINEL",
					])
						expect(requests.at(-1)?.includes(sentinel), sentinel).toBe(true);
					if (scenario === "fork") {
						expect(requests.at(-1)).toContain("FORK_LINEAGE_LOCAL_SENTINEL");
						expect(requests.at(-1)).not.toContain("PARENT_AFTER_FORK_MIGRATION_UNRELATED_SENTINEL");
						expect(requests.at(-1)).not.toContain("PRIVATE_PROMOTED_PARENT_UNRELATED_SENTINEL");
					}
					vi.stubEnv("CODEX_HOME", targetHome);
					const available = await listAvailableAgentSessions(workingDirectory, {
						agentId: "codex",
						searchScope: "all_local_sessions",
						query: "",
						pageCursor: 0,
						pageSize: 100,
						forceRefresh: true,
					});
					expect(available.sessions.map((session) => session.sourceSessionId)).toEqual([nativeSessionId]);
					vi.stubEnv("CODEX_HOME", sourceHome);
					if (scenario === "fork")
						await connect(targetHome, async (port) => {
							const listed = z
								.object({ data: z.array(z.object({ id: z.string() })) })
								.parse(await port.request("thread/list", { archived: false, limit: 100 }));
							expect(listed.data.some((thread) => thread.id === parentId)).toBe(false);
						});
					if (scenario === "fork") {
						// 祖先 Task 稍后正式迁移时，带来源凭据的只读副本可晋升；活跃私有父会话仍保持独立。
						await migrateStoppedCodexConversationStorage({ ...migrationRequest(), nativeSessionId: parentId });
						expect((await readCodexConversationStorageMigrationRecord(sourceHome, parentId))?.stage).toBe(
							"source_archived",
						);
						expect(readNativeThread(targetHome, parentId).archived).toBe(0);
						await connect(targetHome, async (parent) => {
							await parent.request("thread/resume", { threadId: parentId, excludeTurns: true });
							await sendTurn(parent, targetHome, parentId, "PRIVATE_PROMOTED_PARENT_UNRELATED_SENTINEL", 4);
							await rollbackStoppedCodexConversationStorage(migrationRequest());
							expect(await readCodexConversationTurns(parent, parentId)).toHaveLength(4);
							expect(readNativeThread(targetHome, parentId).archived).toBe(0);
						});
					} else await rollbackStoppedCodexConversationStorage(migrationRequest());
					expect(await resolveMigratedCodexConversationHome(targetHome, nativeSessionId)).toBe(sourceHome);
					await resumeAndSend(sourceHome, "ROLLED_BACK_LINEAGE_SENTINEL", initialTurns + 4);
					for (const sentinel of [
						"PARENT_LINEAGE_FIRST_SENTINEL",
						"PARENT_LINEAGE_SECOND_SENTINEL",
						"PRIVATE_LINEAGE_FIRST_SENTINEL",
						"PRIVATE_LINEAGE_SECOND_SENTINEL",
						"PRIVATE_LINEAGE_THIRD_SENTINEL",
						"ROLLED_BACK_LINEAGE_SENTINEL",
					])
						expect(requests.at(-1)?.includes(sentinel), sentinel).toBe(true);
					if (scenario === "fork") {
						expect(requests.at(-1)).toContain("FORK_LINEAGE_LOCAL_SENTINEL");
						expect(requests.at(-1)).not.toContain("PARENT_AFTER_FORK_MIGRATION_UNRELATED_SENTINEL");
						expect(requests.at(-1)).not.toContain("PRIVATE_PROMOTED_PARENT_UNRELATED_SENTINEL");
					}
					if (scenario === "resume")
						expect(requests.at(-1)?.includes("SOURCE_REWOUND_RESUME_SENTINEL")).toBe(true);
					for (const discarded of [
						"SOURCE_DISCARDED_LINEAGE_SENTINEL",
						"DISCARDED_LINEAGE_SENTINEL",
						"SECOND_DISCARDED_LINEAGE_SENTINEL",
					])
						expect(requests.at(-1)?.includes(discarded), discarded).toBe(false);
					observations.push({ stage: "rollback-resumed", thread: readNativeThread(sourceHome, nativeSessionId) });
				} finally {
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					if (evidenceRoot) {
						const evidence = join(evidenceRoot, scenario);
						await mkdir(evidence, { recursive: true });
						await writeFile(
							join(evidence, "requests-and-observations.json"),
							JSON.stringify({ nativeSessionId, parentId, requests, observations }, null, 2),
						);
						await cp(fixture.isolatedHomeDirectoryPath, join(evidence, "isolated-home"), { recursive: true });
					}
					vi.unstubAllEnvs();
				}
			},
		);
	},
);
