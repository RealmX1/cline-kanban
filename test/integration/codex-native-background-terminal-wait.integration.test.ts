import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { resolveSessionFacets } from "../../src/core/session-activity";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createNativeAgentConversationActivityObserver } from "../../src/server/native-agent-conversation-activity-observer";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

// 真实 Codex、PTY、控制宿主及活动读取；模型与 HOME 全部隔离，工具仅在 fixture 中等待。
vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex 后台终端等待（本地模型，无外部推理）",
	{ timeout: 120_000 },
	() => {
		it("空输出 write_stdin 期间保持 Running，并纠正同回合 idle_stall", async (test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kcb-wait-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "background-wait" });
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			await mkdir(codexHome);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("TMPDIR", "/tmp");
			const observedToolCalls: Array<{ name: string; arguments: string }> = [];
			let commandStarted = false;
			let waitsSent = 0;
			const server = createServer(async (request, response) => {
				let body = "";
				for await (const chunk of request) body += String(chunk);
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
				if (isMainRequest && !commandStarted) {
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
				TERM: "xterm-256color",
				CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
			});
			const manager = new TerminalSessionManager({ prepareCodexNativeSessionControlHostLaunch });
			const taskId = "isolated-background-wait";
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
				onCodexNativeAgentTurnExecution: (observation, before) => {
					manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(taskId, before, observation);
				},
			});
			let waitingNativeThread: { id: string; path: string; turnId: string } | null = null;
			try {
				await manager.startTaskSession({
					taskId,
					agentId: "codex",
					binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					args: [
						"--no-alt-screen",
						"--dangerously-bypass-approvals-and-sandbox",
						"-C",
						repository.repositoryPath,
						"验证后台等待 CODEX_BACKGROUND_WAIT_FIXTURE",
					],
					cwd: repository.repositoryPath,
					prompt: "",
					workspaceId: "isolated-background",
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
								waitingNativeThread = { id: read.thread.id, path: read.thread.path, turnId: page.data[0].id };
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
				manager.recordEffectiveAgentConversationActivity(taskId, {
					observedAtMs: Date.now(),
					activityKind: "tool_activity",
					evidenceKind: "structured_agent_session_event",
					eventId: `codex:${native.id}:${native.turnId}:observed-background-wait`,
					nativeSessionId: native.id,
				});
				await observer.observeTaskSessionSummary("isolated-background", current(), current);
				const before = current();
				// 只推进宿主判定时间，真实 Codex 仍在同一后台 write_stdin 调用中；不需要墙钟空等五分钟。
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
				await (manager as unknown as { scanForStalls: () => Promise<void> }).scanForStalls();
				expect(resolveSessionFacets(current()).turnOwner).toBe("agent");
				expect(current().lastAgentConversationUserHandoffObservation).toEqual(
					before.lastAgentConversationUserHandoffObservation,
				);
				manager.transitionToReview(taskId, "idle_stall");
				expect(current().reviewReason).toBe("idle_stall");
				await observer.observeTaskSessionSummary("isolated-background", current(), current);
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
				const evidenceDirectory = process.env.KANBAN_CODEX_BACKGROUND_WAIT_EVIDENCE_DIRECTORY;
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					await writeFile(
						join(evidenceDirectory, "native-background-wait-result.json"),
						JSON.stringify({ observedToolCalls, native, before, corrected: current() }, null, 2),
					);
				}
			} finally {
				vi.restoreAllMocks();
				observer.dispose();
				await manager.forceStopTaskSession(taskId);
				manager.dispose();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				vi.unstubAllEnvs();
			}
		});
	},
);
