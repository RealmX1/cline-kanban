import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCodexNativeAgentTurnExecution } from "../../src/agent-session-history/codex-native-agent-turn-execution-reader";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { resolveSessionFacets } from "../../src/core/session-activity";
import { createNativeAgentConversationActivityObserver } from "../../src/server/native-agent-conversation-activity-observer";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { configureCodexHooks } from "../../src/terminal/codex-hook-config";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { moveTaskCardIntoInProgressAfterCodexNativeReviewMisclassification } from "../../src/trpc/task-card-action-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// 真实 Codex、PTY、控制宿主及活动读取；模型与 HOME 全部隔离，工具仅在 fixture 中等待。
vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY || process.platform === "win32")(
	"真实 Codex 后台终端等待（本地模型，无外部推理）",
	{ timeout: 120_000 },
	() => {
		it.for(["idle_stall", "hook"] as const)("%s：后台等待纠偏保留原回合", async (mode, test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kcb-wait-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "background-wait" });
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			await mkdir(codexHome);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("TMPDIR", "/tmp");
			vi.stubEnv("CODEX_HOME", codexHome);
			vi.stubEnv("CODEX_SQLITE_HOME", codexHome);
			const workspace = await loadWorkspaceState(repository.repositoryPath);
			const { workspaceId } = await loadWorkspaceContext(repository.repositoryPath);
			const taskId = "isolated-background-wait";
			await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{ id: "in_progress", title: "In Progress", cards: [] },
						{
							id: "review",
							title: "Review",
							cards: [
								{
									id: taskId,
									title: "隔离后台等待",
									prompt: "隔离后台等待",
									startInPlanMode: false,
									baseRef: "main",
									createdAt: Date.now() - 1000,
									updatedAt: Date.now() - 1000,
								},
							],
						},
						{ id: "trash", title: "Done", cards: [] },
					],
				},
				sessions: {},
				expectedRevision: workspace.revision,
			});
			const observedToolCalls: Array<{ name: string; arguments: string }> = [];
			let commandStarted = false;
			let waitsSent = 0;
			let stopObserved: RuntimeTaskSessionSummary | null = null;
			let stopHookPayload: unknown = null;
			const server = createServer(async (request, response) => {
				let body = "";
				for await (const chunk of request) body += String(chunk);
				if (request.url === "/fixture-stop-hook") {
					const payload = JSON.parse(body) as {
						hook_event_name?: string;
						session_id: string;
						transcript_path: string;
					};
					if (payload.hook_event_name === "Stop" && !stopObserved) {
						stopHookPayload = payload;
						manager.applyAgentNativeConversationSessionIdentity(taskId, {
							sourceAgentId: "codex",
							nativeSessionId: payload.session_id,
							transcriptPath: payload.transcript_path,
							observedAt: Date.now(),
						});
						manager.applyHookActivity(taskId, { source: "codex", hookEventName: "Stop" });
						manager.transitionToReview(taskId, "hook");
						stopObserved = current();
						await observer.observeTaskSessionSummary(workspaceId, current(), current);
						response.writeHead(200, { "Content-Type": "application/json" });
						response.end(
							JSON.stringify({
								decision: "block",
								reason: "继续评审，执行后台终端 CODEX_BACKGROUND_WAIT_FIXTURE",
							}),
						);
					} else {
						response.writeHead(200, { "Content-Type": "application/json" });
						response.end("{}");
					}
					return;
				}
				const parsed = JSON.parse(body || "{}") as {
					input?: {
						type?: string;
						role?: string;
						call_id?: string;
						output?: unknown;
						content?: { text?: string }[];
					}[];
				};
				const input = parsed.input ?? [];
				const isMainRequest = input.some(
					(item) =>
						item.role === "user" &&
						item.content?.some((part) => part.text?.includes("CODEX_BACKGROUND_WAIT_FIXTURE")),
				);
				const commandResult = input.find(
					(item) => item.type === "function_call_output" && item.call_id === "background-start",
				);
				const sessionId = /session ID\s+(\d+)/iu.exec(JSON.stringify(commandResult?.output ?? ""))?.[1];
				let item: Record<string, unknown>;
				if (mode === "hook" && isMainRequest && !stopObserved) {
					item = {
						type: "message",
						id: "before-stop",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "触发隔离 Stop hook", annotations: [] }],
					};
				} else if (isMainRequest && !commandStarted) {
					commandStarted = true;
					item = {
						type: "function_call",
						id: "background-start-item",
						call_id: "background-start",
						name: "exec_command",
						arguments: JSON.stringify({ cmd: "sleep 60", yield_time_ms: 1000, max_output_tokens: 100 }),
						status: "completed",
					};
				} else if (isMainRequest && sessionId) {
					waitsSent += 1;
					item = {
						type: "function_call",
						id: `background-wait-item-${waitsSent}`,
						call_id: `background-wait-${waitsSent}`,
						name: "write_stdin",
						arguments: JSON.stringify({
							session_id: Number(sessionId),
							chars: "",
							yield_time_ms: waitsSent < 3 ? 1000 : 10_000,
							max_output_tokens: 100,
						}),
						status: "completed",
					};
				} else {
					item = {
						type: "message",
						id: "isolated-message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "隔离测试响应", annotations: [] }],
					};
				}
				if (item.type === "function_call")
					observedToolCalls.push({ name: String(item.name), arguments: String(item.arguments) });
				const result = {
					id: `isolated-response-${observedToolCalls.length}`,
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
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("隔离模型端口不可用");
			await writeFile(
				join(codexHome, "config.toml"),
				`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离后台等待模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
			);
			await writeFile(
				join(codexHome, "auth.json"),
				JSON.stringify({ OPENAI_API_KEY: "sk-isolated-no-external-inference" }),
				{ mode: 0o600 },
			);
			const environment = fixture.createIsolatedChildProcessEnvironment({
				CODEX_HOME: codexHome,
				CODEX_SQLITE_HOME: codexHome,
				TERM: "xterm-256color",
				CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
			});
			const manager = new TerminalSessionManager({ prepareCodexNativeSessionControlHostLaunch });
			manager.setCodexReviewMisclassificationPersistenceHandler(async (before, observation, applyCorrection) => {
				const result = await moveTaskCardIntoInProgressAfterCodexNativeReviewMisclassification({
					workspaceId,
					summaryBeforeRead: before,
					observation,
					getCurrentSummary: () => manager.getSummary(taskId),
				});
				return result.sessionCorrectionAllowed ? applyCorrection() : null;
			});
			let output = "";
			manager.attach(taskId, {
				onOutput: (chunk) => {
					output += chunk.toString();
					if (chunk.toString().includes("\x1b[6n")) manager.writeInput(taskId, Buffer.from("\x1b[1;1R"));
					if (chunk.toString().includes("\x1b[c")) manager.writeInput(taskId, Buffer.from("\x1b[?1;2c"));
				},
			});
			const current = () => manager.getSummary(taskId) as RuntimeTaskSessionSummary;
			const observer = createNativeAgentConversationActivityObserver({
				onAccepted: () => {},
				cooldownMs: 0,
				// 宿主判定会推进虚拟时钟；观察器也须读同一时钟，不能提前绑定真实 Date.now。
				nowMs: () => Date.now(),
				onCodexNativeAgentTurnExecution: async (observation, before) => {
					await manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
						taskId,
						before,
						observation,
					);
				},
				onActivity: (observation) => {
					manager.recordEffectiveAgentConversationActivity(taskId, observation);
				},
			});
			const hookArguments: string[] = [];
			if (mode === "hook") {
				const hookRecorderPath = join(fixture.fixtureRootDirectoryPath, "continue-after-stop-hook.cjs");
				await writeFile(
					hookRecorderPath,
					`let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",async()=>{const response=await fetch("http://127.0.0.1:${address.port}/fixture-stop-hook",{method:"POST",body,signal:AbortSignal.timeout(6000)});process.stdout.write(await response.text());});`,
				);
				const originalEntrypoint = process.argv[1];
				try {
					process.argv[1] = hookRecorderPath;
					configureCodexHooks(hookArguments);
				} finally {
					process.argv[1] = originalEntrypoint;
				}
			}
			let waitingNativeThread: { id: string; path: string; turnId: string } | null = null;
			try {
				await manager.startTaskSession({
					taskId,
					agentId: "codex",
					binary: process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY ?? "codex",
					args: [
						...hookArguments,
						"--no-alt-screen",
						"--dangerously-bypass-approvals-and-sandbox",
						"-C",
						repository.repositoryPath,
						"验证后台等待 CODEX_BACKGROUND_WAIT_FIXTURE",
					],
					cwd: repository.repositoryPath,
					prompt: "验证后台等待 CODEX_BACKGROUND_WAIT_FIXTURE",
					workspaceId,
					env: environment,
					cols: 140,
					rows: 42,
				});
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "真实后台命令启动且 write_stdin 已连续等待空输出",
						softDeadlineMsExpectedOnUncontendedHost: 15_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
					},
					async () => {
						const endpoint = current().codexNativeSessionControlEndpoint;
						if (!endpoint || waitsSent < 3) return false;
						return withRunningCodexAppServerControlSocketConnection(
							async (port) => {
								const loaded = (await port.request("thread/loaded/list", {})) as { data: string[] };
								if (!loaded.data[0]) return false;
								const read = (await port.request("thread/read", {
									threadId: loaded.data[0],
									includeTurns: false,
								})) as { thread: { id: string; path: string; status: { type: string } } };
								const page = (await port.request("thread/turns/list", {
									threadId: loaded.data[0],
									cursor: null,
									limit: 1,
									sortDirection: "desc",
									itemsView: "summary",
								})) as { data: { id: string; status: string }[] };
								if (read.thread.status.type !== "active" || page.data[0]?.status !== "inProgress") return false;
								waitingNativeThread = {
									id: read.thread.id,
									path: read.thread.path,
									turnId: page.data[0].id,
								};
								return true;
							},
							{ socketPath: endpoint.socketPath },
						).catch(() => false);
					},
					{
						describeLastObservedStateForFailureMessage: () =>
							JSON.stringify({ observedToolCalls, output: output.slice(-1500) }),
					},
				);
				const native = waitingNativeThread as { id: string; path: string; turnId: string } | null;
				if (!native) throw new Error("没有取得当前原生回合证明");
				manager.applyAgentNativeConversationSessionIdentity(taskId, {
					sourceAgentId: "codex",
					nativeSessionId: native.id,
					transcriptPath: native.path,
					observedAt: Date.now(),
				});
				if (mode === "idle_stall")
					manager.recordEffectiveAgentConversationActivity(taskId, {
						observedAtMs: Date.now(),
						activityKind: "tool_activity",
						evidenceKind: "structured_agent_session_event",
						eventId: `codex:${native.id}:${native.turnId}:observed-background-wait`,
						nativeSessionId: native.id,
					});
				await observer.observeTaskSessionSummary(workspaceId, current(), current);
				const before = current();
				// 只推进宿主判定时间，真实 Codex 仍在同一后台 write_stdin 调用中；不需要墙钟空等五分钟。
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
				await (manager as unknown as { scanForStalls: () => Promise<void> }).scanForStalls();
				if (mode === "idle_stall") expect(resolveSessionFacets(current()).turnOwner).toBe("agent");
				if (mode === "idle_stall")
					expect(current().lastAgentConversationUserHandoffObservation).toEqual(
						before.lastAgentConversationUserHandoffObservation,
					);
				if (mode === "idle_stall") {
					manager.transitionToReview(taskId, "idle_stall");
					expect(current().reviewReason).toBe("idle_stall");
				}
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "同回合误判被原生证据自动纠正",
						softDeadlineMsExpectedOnUncontendedHost: 5000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
					},
					async () => {
						await observer.observeTaskSessionSummary(workspaceId, current(), current);
						return resolveSessionFacets(current()).turnOwner === "agent";
					},
				);
				expect(resolveSessionFacets(current())).toEqual({
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
				});
				expect(current().agentResponseGenerationTurnSequence).toBe(before.agentResponseGenerationTurnSequence);
				expect(current().agentResponseGenerationTurnStarted).toEqual(before.agentResponseGenerationTurnStarted);
				expect(current().currentAgentProcessUserTurnIdleRetentionStarted).toBeNull();
				expect(current().lastAgentConversationUserHandoffObservation).toBeNull();
				expect(current().lastAgentConversationPromptCacheReferenceObservation).toEqual(
					before.lastAgentConversationPromptCacheReferenceObservation,
				);
				const persisted = await loadWorkspaceState(repository.repositoryPath);
				expect(persisted.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(taskId);
				if (mode === "hook") expect(stopObserved).toMatchObject({ reviewReason: "hook" });
				const evidenceDirectory = process.env.KANBAN_CODEX_BACKGROUND_WAIT_EVIDENCE_DIRECTORY;
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					await writeFile(
						join(evidenceDirectory, `native-background-wait-${mode}-result.json`),
						JSON.stringify(
							{
								observedToolCalls,
								native,
								before,
								stopObserved,
								stopHookPayload,
								corrected: current(),
								board: persisted.board,
							},
							null,
							2,
						),
					);
					await writeFile(
						join(evidenceDirectory, `native-background-wait-${mode}-transcript.jsonl`),
						await readFile(native.path),
					);
				}
			} finally {
				vi.restoreAllMocks();
				try {
					const evidenceDirectory = process.env.KANBAN_CODEX_BACKGROUND_WAIT_EVIDENCE_DIRECTORY;
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await writeFile(
							join(evidenceDirectory, `native-background-wait-${mode}-final-observation.json`),
							JSON.stringify(
								{
									observedToolCalls,
									stopObserved,
									stopHookPayload,
									summary: current(),
									output,
									execution: await readCodexNativeAgentTurnExecution({
										workspaceId,
										summary: current(),
										observedAtMs: Date.now(),
									}).catch(String),
								},
								null,
								2,
							),
						);
						const transcriptPath = current().agentNativeConversationSessionIdentity?.transcriptPath;
						if (transcriptPath)
							await writeFile(
								join(evidenceDirectory, `native-background-wait-${mode}-transcript.jsonl`),
								await readFile(transcriptPath),
							);
					}
				} finally {
					observer.dispose();
					await manager.forceStopTaskSession(taskId);
					manager.dispose();
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					vi.unstubAllEnvs();
				}
			}
		});
	},
);
