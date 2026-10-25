import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createNativeAgentConversationActivityObserver } from "../../src/server/native-agent-conversation-activity-observer";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex 的持久提交接受补证（本地模型）",
	{ timeout: 120_000 },
	() => {
		it("已结束回合的原生 UserMessage 自动清除旧标记，不发布新输入或改变交棒", async (test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kca-fact-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "acceptance-facts" });
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			await mkdir(codexHome);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("TMPDIR", "/tmp");
			let modelRequestCount = 0;
			const server = createServer(async (request, response) => {
				for await (const _chunk of request) {
					/* 只消费隔离模型请求，不记录原始上下文。 */
				}
				modelRequestCount += 1;
				const item = {
					type: "message",
					id: `fixture-answer-${modelRequestCount}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "隔离接受验证完成", annotations: [] }],
				};
				const result = {
					id: `fixture-response-${modelRequestCount}`,
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
			if (!address || typeof address === "string") throw new Error("隔离端口不可用");
			await writeFile(
				join(codexHome, "config.toml"),
				`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离接受核验模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
			);
			await writeFile(
				join(codexHome, "auth.json"),
				JSON.stringify({ OPENAI_API_KEY: "sk-isolated-no-external-inference" }),
				{ mode: 0o600 },
			);
			const manager = new TerminalSessionManager({ prepareCodexNativeSessionControlHostLaunch });
			const taskId = "isolated-acceptance-facts";
			const prompt = "PROMPT_ACCEPTANCE_FACTS_FIXTURE";
			const current = () => manager.getSummary(taskId) as RuntimeTaskSessionSummary;
			const onAccepted = vi.fn();
			const observer = createNativeAgentConversationActivityObserver({
				onAccepted,
				cooldownMs: 0,
				onPromptSubmissionAcceptanceReconciliation(sessionId, _workspaceId, result) {
					manager.reconcileAgentConversationPromptSubmissionAcceptance(sessionId, result);
				},
			});
			manager.attach(taskId, {
				onOutput: (chunk) => {
					if (chunk.toString().includes("\x1b[6n")) manager.writeInput(taskId, Buffer.from("\x1b[1;1R"));
					if (chunk.toString().includes("\x1b[c")) manager.writeInput(taskId, Buffer.from("\x1b[?1;2c"));
				},
			});
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
						prompt,
					],
					cwd: repository.repositoryPath,
					prompt: "",
					workspaceId: "isolated-acceptance",
					env: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: codexHome,
						TERM: "xterm-256color",
						CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
					}),
					cols: 140,
					rows: 42,
				});
				manager.markAgentConversationPromptSubmissionPending(taskId, current().startedAt ?? Date.now(), {
					source: "harness_submit_hook",
					submittedPromptText: prompt,
				});
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "真实原生回合完成并取得持久转录",
						softDeadlineMsExpectedOnUncontendedHost: 15_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
					},
					async () => {
						const endpoint = current().codexNativeSessionControlEndpoint;
						if (!endpoint || modelRequestCount === 0) return false;
						return withRunningCodexAppServerControlSocketConnection(
							async (port) => {
								const loaded = (await port.request("thread/loaded/list", {})) as { data: string[] };
								if (!loaded.data[0]) return false;
								const { thread } = (await port.request("thread/read", {
									threadId: loaded.data[0],
									includeTurns: false,
								})) as { thread: { id: string; path: string; status: { type: string } } };
								if (thread.status.type !== "idle") return false;
								manager.applyAgentNativeConversationSessionIdentity(taskId, {
									sourceAgentId: "codex",
									nativeSessionId: thread.id,
									transcriptPath: thread.path,
									observedAt: Date.now(),
								});
								return true;
							},
							{ socketPath: endpoint.socketPath },
						).catch(() => false);
					},
				);
				manager.transitionToReview(taskId, "hook");
				const before = current();
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "持久候选通过原生消息 ID 与当前分支自动补证",
						softDeadlineMsExpectedOnUncontendedHost: 10_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
					},
					async () => {
						await observer.observeTaskSessionSummary("isolated-acceptance", current(), current);
						return current().agentConversationPromptSubmissionAcceptance?.status === "accepted";
					},
				);
				const after = current();
				expect(after.agentConversationPromptSubmissionAcceptance).toMatchObject({
					status: "accepted",
					acceptedByHistoricalReconciliation: true,
				});
				expect(onAccepted).not.toHaveBeenCalled();
				expect(after.turnOwner).toBe(before.turnOwner);
				expect(after.lastAgentConversationUserHandoffObservation).toEqual(
					before.lastAgentConversationUserHandoffObservation,
				);
				expect(after.lastAgentConversationPromptCacheReferenceObservation).toEqual(
					before.lastAgentConversationPromptCacheReferenceObservation,
				);
				const evidenceDirectory = process.env.KANBAN_CODEX_PROMPT_ACCEPTANCE_EVIDENCE_DIRECTORY;
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					await writeFile(
						join(evidenceDirectory, "native-prompt-acceptance-result.json"),
						JSON.stringify({ modelRequestCount, before, after }, null, 2),
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
		});
	},
);
