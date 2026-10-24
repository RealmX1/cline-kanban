import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createNativeAgentConversationActivityObserver } from "../../src/server/native-agent-conversation-activity-observer";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { stripAnsiAndControl } from "../../src/terminal/terminal-output-normalization";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

// 隔离模型与 hook：保留真实 Codex、PTY、控制宿主、manager、原生观察器和广播，不连接生产 runtime。
vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
	"普通 Codex rewind 的原生状态校正（无 RVF、无外部模型）",
	{ timeout: 180_000 },
	() => {
		it.for(["fresh_review", "restored_needs_input"])(
			"%s：回退后不再发 prompt，同一进程状态与原生空闲事实一致",
			async (mode, test) => {
				vi.stubEnv("TMPDIR", "/tmp");
				const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kcr-rewind-" });
				const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "ordinary-conversation" });
				await writeFile(join(repository.repositoryPath, "fixture.txt"), "隔离测试\n");
				repository.commitAllRepositoryFilesAtDate({
					message: "隔离初始提交",
					authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
				});
				vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
				const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
				await mkdir(codexHome);
				let requestCount = 0;
				let mainConversationRequestCount = 0;
				const modelRequestObservations: unknown[] = [];
				const server = createServer(async (request, response) => {
					let body = "";
					for await (const chunk of request) body += String(chunk);
					const parsed = body ? JSON.parse(body) : {};
					const input = parsed.input as
						| { role?: string; type?: string; call_id?: string; content?: { text?: string }[] }[]
						| undefined;
					const lastUserMessageText =
						input
							?.filter((item) => item.role === "user")
							.at(-1)
							?.content?.map((part) => part.text ?? "")
							.join("") ?? "";
					// Codex 也会用同一 provider 后台生成标题；它不代表主对话收到新 prompt。
					if (["ORDINARY_FIRST_PROMPT", "ORDINARY_SECOND_PROMPT"].includes(lastUserMessageText))
						mainConversationRequestCount++;
					modelRequestObservations.push({ path: request.url, method: request.method, lastUserMessageText });
					const count = ++requestCount;
					const text = `ORDINARY_RESPONSE_${count}`;
					const item = {
						id: `message_${count}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text, annotations: [] }],
					};
					const shouldAsk =
						lastUserMessageText === "ORDINARY_PENDING_INPUT" &&
						!input?.some(
							(item) => item.type === "function_call_output" && item.call_id === "native_pending_input",
						);
					const outputItem = shouldAsk
						? {
								id: `question_${count}`,
								type: "function_call",
								name: "request_user_input",
								call_id: "native_pending_input",
								arguments: JSON.stringify({
									questions: [
										{
											id: "choice",
											header: "测试选择",
											question: "采用哪个隔离方案？",
											options: [
												{ label: "方案一", description: "第一个隔离选项" },
												{ label: "方案二", description: "第二个隔离选项" },
											],
										},
									],
								}),
								status: "completed",
							}
						: item;
					const result = {
						id: `response_${count}`,
						object: "response",
						created_at: Math.floor(Date.now() / 1000),
						status: "completed",
						model: "gpt-5.4",
						output: [outputItem],
						usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
					};
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					const events: [string, Record<string, unknown>][] = shouldAsk
						? [
								["response.created", { response: { ...result, status: "in_progress", output: [] } }],
								["response.output_item.done", { output_index: 0, item: outputItem }],
								["response.completed", { response: result }],
							]
						: [
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
								[
									"response.output_text.delta",
									{ item_id: item.id, output_index: 0, content_index: 0, delta: text },
								],
								["response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text }],
								["response.output_item.done", { output_index: 0, item }],
								["response.completed", { response: result }],
							];
					for (const [type, fields] of events)
						response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
					response.end();
				});
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("隔离模型端口分配失败");
				await writeFile(
					join(codexHome, "config.toml"),
					`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
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
				const taskId = "ordinary-rewind-conversation";
				let output = "";
				const emittedSummaries: RuntimeTaskSessionSummary[] = [];
				const unsubscribeSummary = manager.onSummary((summary) => emittedSummaries.push(summary));
				manager.attach(taskId, {
					onOutput: (chunk) => {
						const text = chunk.toString();
						output += text;
						if (text.includes("\x1b[6n")) manager.writeInput(taskId, Buffer.from("\x1b[1;1R"));
						if (text.includes("\x1b[c")) manager.writeInput(taskId, Buffer.from("\x1b[?1;2c"));
					},
				});
				const binary = process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex";
				const start = (resumeFromTrash: boolean, nativeId?: string) =>
					manager.startTaskSession({
						taskId,
						agentId: "codex",
						binary,
						args: [
							"--no-alt-screen",
							"-C",
							repository.repositoryPath,
							...(nativeId ? ["resume", nativeId] : ["ORDINARY_FIRST_PROMPT"]),
						],
						cwd: repository.repositoryPath,
						prompt: "",
						workspaceId: "isolated-rewind",
						env: environment,
						cols: 140,
						rows: 42,
						resumeFromTrash,
					});
				const current = () => manager.getSummary(taskId) as RuntimeTaskSessionSummary;
				const query = async () => {
					const endpoint = current().codexNativeSessionControlEndpoint;
					if (!endpoint) throw new Error("缺少本代控制端点");
					return withRunningCodexAppServerControlSocketConnection(
						async (port) => {
							const loaded = (await port.request("thread/loaded/list", {})) as { data: string[] };
							if (!loaded.data[0]) return null;
							const read = (await port.request("thread/read", {
								threadId: loaded.data[0],
								includeTurns: false,
							})) as {
								thread: { id: string; path: string; status: { type: string }; canAcceptDirectInput: boolean };
							};
							const turns = (await port.request("thread/turns/list", {
								threadId: loaded.data[0],
								cursor: null,
								limit: 10,
								sortDirection: "desc",
								itemsView: "full",
							})) as {
								data: {
									id: string;
									status: string;
									items: { type: string; content?: { text?: string }[] }[];
								}[];
							};
							return { ...read.thread, turns: turns.data };
						},
						{ socketPath: endpoint.socketPath },
					).catch(() => null);
				};
				const wait = (description: string, predicate: () => Promise<boolean>) =>
					waitForConditionWithinLoadSensitiveTwoTierDeadline(
						test,
						{
							waitedForDescription: description,
							softDeadlineMsExpectedOnUncontendedHost: 10_000,
							hardDeadlineMsOnlyExplainedByRealHangOrRegression: 35_000,
						},
						predicate,
						{ describeLastObservedStateForFailureMessage: () => output.slice(-2500) },
					);
				const onAccepted = vi.fn();
				const onActivity = vi.fn();
				const observer = createNativeAgentConversationActivityObserver({
					onAccepted,
					onActivity,
					cooldownMs: 0,
					onCodexNativeDirectInputReadiness: (observation, before) => {
						manager.reconcileCodexNeedsInputWithNativeDirectInputReadiness(taskId, before, observation);
					},
				});
				try {
					await start(false);
					await wait(
						"首次普通回合完成",
						async () => (await query())?.turns.some((turn) => turn.status === "completed") === true,
					);
					const first = await query();
					if (!first) throw new Error("原生会话未加载");
					manager.applyAgentNativeConversationSessionIdentity(taskId, {
						sourceAgentId: "codex",
						nativeSessionId: first.id,
						transcriptPath: first.path,
						observedAt: Date.now(),
					});
					manager.transitionToReview(taskId, "hook");
					manager.writeInput(taskId, Buffer.from("ORDINARY_SECOND_PROMPT"));
					await delay(250);
					manager.writeInput(taskId, Buffer.from("\r"));
					manager.transitionToRunning(taskId);
					await wait(
						"第二个普通回合完成",
						async () => (await query())?.turns.filter((turn) => turn.status === "completed").length === 2,
					);
					manager.transitionToReview(taskId, "hook");
					if (mode === "restored_needs_input") {
						await manager.forceStopTaskSession(taskId);
						const resumeOutputStart = output.length;
						await start(true, first.id);
						await wait("既有会话恢复到原生输入框", async () => (await query())?.canAcceptDirectInput === true);
						await wait(
							"恢复后 TUI 已显示历史与输入框",
							async () =>
								output.slice(resumeOutputStart).includes("ORDINARY_SECOND_PROMPT") &&
								output.slice(resumeOutputStart).includes("Ask Codex to do anything"),
						);
					}
					const beforeRewind = await query();
					const nativeTurnBeforeRewind = beforeRewind?.turns[0]?.id;
					const pidBeforeRewind = current().pid;
					expect(current().userTurnKind).toBe(mode === "fresh_review" ? "review" : "needs_input");
					const requestsBeforeRewind = mainConversationRequestCount;
					const rewindOutputStart = output.length;
					manager.writeInput(taskId, Buffer.from("\x1b"));
					await delay(450);
					manager.writeInput(taskId, Buffer.from("\x1b"));
					await wait("普通 rewind 历史预览出现", async () =>
						/Browsing transcript.*rewind/is.test(stripAnsiAndControl(output.slice(rewindOutputStart))),
					);
					manager.writeInput(taskId, Buffer.from("\r"));
					await wait("原生当前分支排除刚回退的普通回合", async () => {
						const value = await query();
						return (
							value?.status.type === "idle" &&
							value.canAcceptDirectInput &&
							!value.turns.some((turn) => turn.id === nativeTurnBeforeRewind)
						);
					});
					const beforeCorrection = current();
					await observer.observeTaskSessionSummary("isolated-rewind", beforeCorrection, current);
					await wait("原生空闲与运行时 review 一致", async () => {
						await observer.observeTaskSessionSummary("isolated-rewind", current(), current);
						return current().userTurnKind === "review";
					});
					expect(current().pid).toBe(pidBeforeRewind);
					expect(mainConversationRequestCount, JSON.stringify(modelRequestObservations)).toBe(
						requestsBeforeRewind,
					);
					expect(onAccepted).not.toHaveBeenCalled();
					expect(onActivity).not.toHaveBeenCalled();
					for (const key of [
						"agentConversationPromptSubmissionAcceptance",
						"lastEffectiveAgentConversationActivityObservation",
						"lastAgentConversationUserHandoffObservation",
						"currentAgentProcessUserTurnIdleRetentionStarted",
						"agentResponseGenerationTurnSequence",
						"restorationContinuationGuardState",
					] as const)
						expect(current()[key]).toEqual(beforeCorrection[key]);
					expect(emittedSummaries.at(-1)?.userTurnKind).toBe("review");
					const evidenceDirectory = process.env.KANBAN_CODEX_REWIND_RECONCILIATION_EVIDENCE_DIRECTORY;
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await writeFile(
							join(evidenceDirectory, `${mode}-model-requests.json`),
							JSON.stringify(modelRequestObservations, null, 2),
						);
					}
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await writeFile(
							join(evidenceDirectory, `${mode}.json`),
							JSON.stringify(
								{
									mode,
									nativeThreadId: first.id,
									pidBeforeRewind,
									pidAfterRewind: current().pid,
									nativeTurnBeforeRewind,
									nativeTurnsAfterRewind: (await query())?.turns.map((turn) => turn.id),
									requestsBeforeRewind,
									requestsAfterRewind: mainConversationRequestCount,
									beforeCorrection,
									afterCorrection: current(),
								},
								null,
								2,
							),
						);
					}
					if (mode === "restored_needs_input") {
						manager.writeInput(taskId, Buffer.from("\x15/plan"));
						await delay(250);
						manager.writeInput(taskId, Buffer.from("\r"));
						await delay(500);
						const questionOutputStart = output.length;
						manager.writeInput(taskId, Buffer.from("\x15ORDINARY_PENDING_INPUT"));
						await delay(250);
						manager.writeInput(taskId, Buffer.from("\r"));
						await wait("真实 Codex 问答选择器正在等待用户", async () =>
							stripAnsiAndControl(output.slice(questionOutputStart)).includes("采用哪个隔离方案"),
						);
						manager.transitionToRunning(taskId);
						manager.transitionToReview(taskId, "hook", "needs_input");
						await observer.observeTaskSessionSummary("isolated-rewind", current(), current);
						expect(current().userTurnKind).toBe("needs_input");
						if (evidenceDirectory)
							await writeFile(
								join(evidenceDirectory, "native-pending-question-protected.json"),
								JSON.stringify(
									{
										nativeState: (await query())?.status ?? "unavailable",
										nativeQuestionSelectorVisible: true,
										userTurnKind: current().userTurnKind,
									},
									null,
									2,
								),
							);
					}
				} finally {
					const evidenceDirectory = process.env.KANBAN_CODEX_REWIND_RECONCILIATION_EVIDENCE_DIRECTORY;
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await writeFile(
							join(evidenceDirectory, `${mode}-model-requests.json`),
							JSON.stringify(modelRequestObservations, null, 2),
						);
					}
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await writeFile(join(evidenceDirectory, `${mode}-terminal.log`), stripAnsiAndControl(output));
					}
					observer.dispose();
					unsubscribeSummary();
					await manager.forceStopTaskSession(taskId);
					manager.dispose();
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					vi.unstubAllEnvs();
				}
			},
		);
	},
);
