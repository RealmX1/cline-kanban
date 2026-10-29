import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/codex-native-session-protocol/codex-app-server-control-socket-request-connection";
import { readCodexConversationTurns } from "../../src/codex-native-session-protocol/codex-native-conversation-history";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../../src/core/task-message-injection-ledger";
import { getWorkspaceDirectoryPath } from "../../src/state/workspace-state";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createAutomaticFailureContinuationBrowserVerificationFixture } from "./automatic-agent-failure-continuation-browser-verification-fixture";

vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY || process.platform === "win32")(
	"真实 Codex 容量不足自动恢复（隔离本地模型）",
	{ timeout: 120_000 },
	() => {
		it("一次容量失败只接受一条 self prompt，并保留原生会话、模型、推理档、Plan Mode 与权限", async (test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kac-capacity-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "capacity" });
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			await mkdir(codexHome);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", codexHome);
			vi.stubEnv("CODEX_SQLITE_HOME", codexHome);
			vi.stubEnv("TMPDIR", "/tmp");
			const requests: Record<string, unknown>[] = [];
			let releaseSuccess: (() => void) | undefined;
			let releaseCapacityFailure: (() => void) | undefined;
			const server = createServer(async (request, response) => {
				let body = "";
				for await (const chunk of request) body += String(chunk);
				if (request.method !== "POST" || !request.url?.includes("responses")) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ data: [] }));
					return;
				}
				const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
				const isTitleRequest = JSON.stringify(parsed.input).includes("Generate a concise, single-line task title");
				if (!isTitleRequest) requests.push(parsed);
				const ordinal = requests.length;
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				const send = (type: string, fields: Record<string, unknown>) =>
					response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
				const base = {
					id: `local-capacity-${ordinal}`,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					model: "gpt-5.4",
					output: [],
					usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
				};
				send("response.created", { response: { ...base, status: "in_progress" } });
				if (!isTitleRequest && ordinal === 1) {
					releaseCapacityFailure = () => {
						send("response.failed", {
							response: {
								...base,
								status: "failed",
								error: {
									code: "server_is_overloaded",
									message: "Selected model is at capacity. Please try a different model.",
								},
							},
						});
						response.end();
					};
					return;
				}
				const completeResponse = () => {
					const item = {
						type: "message",
						id: `local-answer-${ordinal}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "隔离容量已恢复，原任务执行完成。", annotations: [] }],
					};
					send("response.output_item.done", { output_index: 0, item });
					send("response.completed", { response: { ...base, status: "completed", output: [item] } });
					response.end();
				};
				if (isTitleRequest) completeResponse();
				else releaseSuccess = completeResponse;
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("本地模型端口不可用");
			await writeFile(
				join(codexHome, "config.toml"),
				`model="gpt-5.4"\nmodel_provider="isolated_loopback"\nmodel_reasoning_effort="high"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离容量模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
			);
			await writeFile(
				join(codexHome, "auth.json"),
				JSON.stringify({ OPENAI_API_KEY: "sk-isolated-no-external-inference" }),
				{ mode: 0o600 },
			);
			const workspaceId = "capacity-native-isolated",
				taskId = "capacity-native";
			const manager = new TerminalSessionManager({
				prepareCodexNativeSessionControlHostLaunch,
				enableManagedTaskPromptDeliveryRecording: true,
				automaticFailureContinuationWorkspaceId: workspaceId,
				readAutomaticFailureContinuationEligibility: async () => ({
					eligible: true,
					taskIncarnationCreatedAtEpochMs: 1,
					connectionEnabled: true,
					capacityEnabled: true,
				}),
			});
			let output = "";
			manager.attach(taskId, {
				onOutput: (chunk) => {
					output += chunk.toString();
					if (chunk.toString().includes("\x1b[6n")) manager.writeInput(taskId, Buffer.from("\x1b[1;1R"));
					if (chunk.toString().includes("\x1b[c")) manager.writeInput(taskId, Buffer.from("\x1b[?1;2c"));
				},
			});
			const wait = (description: string, condition: () => boolean | Promise<boolean>) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: description,
						softDeadlineMsExpectedOnUncontendedHost: 30_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 60_000,
					},
					condition,
					{
						describeLastObservedStateForFailureMessage: () =>
							JSON.stringify({
								requests: requests.length,
								summary: manager.getSummary(taskId),
								output: output.slice(-2000),
							}),
					},
				);
			let native: { id: string; path: string } | undefined;
			let browserVerification:
				| Awaited<ReturnType<typeof createAutomaticFailureContinuationBrowserVerificationFixture>>
				| undefined;
			try {
				await manager.startTaskSession({
					taskId,
					agentId: "codex",
					binary: process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY ?? "codex",
					args: ["--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox", "-C", repository.repositoryPath],
					cwd: repository.repositoryPath,
					prompt: "",
					workspaceId,
					env: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: codexHome,
						CODEX_SQLITE_HOME: codexHome,
						TERM: "xterm-256color",
						CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
					}),
					cols: 140,
					rows: 42,
				});
				await wait("TUI 已加载原生会话", async () => {
					const endpoint = manager.getSummary(taskId)?.codexNativeSessionControlEndpoint;
					if (!endpoint) return false;
					return withRunningCodexAppServerControlSocketConnection(
						async (port) => {
							const loaded = (await port.request("thread/loaded/list", {})) as { data: string[] };
							if (!loaded.data[0]) return false;
							const read = (await port.request("thread/read", {
								threadId: loaded.data[0],
								includeTurns: false,
							})) as { thread: { id: string; path: string } };
							native = read.thread;
							return true;
						},
						{ socketPath: endpoint.socketPath },
					).catch(() => false);
				});
				if (!native) throw new Error("原生身份不可用");
				const target = native;
				manager.applyAgentNativeConversationSessionIdentity(taskId, {
					sourceAgentId: "codex",
					nativeSessionId: target.id,
					transcriptPath: target.path,
					observedAt: Date.now(),
				});
				const endpoint = manager.getSummary(taskId)?.codexNativeSessionControlEndpoint;
				if (!endpoint) throw new Error("控制宿主不可用");
				manager.transitionToRunning(taskId);
				await wait(
					"TUI 启动初始化完成",
					() => output.includes("gpt-5.4 high") && !output.slice(-300).includes("loading"),
				);
				manager.writeInput(taskId, Buffer.from("\x1b[Z"));
				await wait("首轮提交前已切换 Plan Mode", () => output.includes("Plan mode"));
				manager.writeInput(taskId, Buffer.from("\x1b[200~CODEX_CAPACITY_RECOVERY_FIXTURE 执行原任务\x1b[201~"));
				await wait("首轮提示已显示在输入框", () => output.includes("CODEX_CAPACITY_RECOVERY_FIXTURE"));
				manager.writeInput(taskId, Buffer.from("\r"));
				await wait("首轮原生接受已写入", async () => {
					try {
						return (
							(
								await withRunningCodexAppServerControlSocketConnection(
									(port) => readCodexConversationTurns(port, target.id),
									{ socketPath: endpoint.socketPath },
								)
							)
								.at(-1)
								?.items.some((item) => item.type === "userMessage") ?? false
						);
					} catch {
						return false;
					}
				});
				const initialTurns = await withRunningCodexAppServerControlSocketConnection(
					(port) => readCodexConversationTurns(port, target.id),
					{ socketPath: endpoint.socketPath },
				);
				const initialTurn = initialTurns.at(-1);
				const initialUser = initialTurn?.items.find((item) => item.type === "userMessage");
				if (!initialTurn || !initialUser || initialTurn.status !== "inProgress")
					throw new Error("初始原生接受证据不可用");
				const initialSummary = manager.getSummary(taskId);
				if (!initialSummary?.runtimeSessionIncarnationId) throw new Error("初始进程身份不可用");
				manager.confirmAcceptedAgentConversationInput(taskId, {
					observedAtMs: Date.now(),
					eventId: `codex:${target.id}:${initialTurn.id}:${initialUser.id}`,
					nativeSessionId: target.id,
					runtimeSessionIncarnationId: initialSummary.runtimeSessionIncarnationId,
					submittedPromptText: "CODEX_CAPACITY_RECOVERY_FIXTURE 执行原任务",
					acceptedNativeAgentTurnIsInProgress: true,
				});
				if (process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_BROWSER_CHECK === "1") {
					const evidenceDirectory = process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY;
					if (!evidenceDirectory) throw new Error("浏览器验证必须保存持久证据");
					browserVerification = await createAutomaticFailureContinuationBrowserVerificationFixture({
						fixture,
						manager,
						workspaceId,
						taskId,
						evidenceDirectory,
					});
				}
				await wait("本地容量失败响应已准备", () => !!releaseCapacityFailure);
				releaseCapacityFailure?.();
				await wait(
					"容量失败进入持久等待恢复",
					() => manager.getSummary(taskId)?.automaticAgentFailureContinuation?.reason === "model_capacity",
				);
				const initial = manager.getSummary(taskId)?.automaticAgentFailureContinuation;
				if (!initial) throw new Error("未登记恢复 episode");
				expect(initial.nextCheckAtMs).toBe(initial.firstErrorAtMs + 30_000);
				expect(initial.deadlineAtMs).toBe(initial.firstErrorAtMs + 30 * 60_000);
				await browserVerification?.assertPhase("waiting_backoff");
				expect(await manager.actOnAutomaticFailureContinuation(taskId, initial.episodeId, "retry_now")).toBe(true);
				await wait(
					"原生 self prompt 唯一接受且执行",
					() => manager.getSummary(taskId)?.automaticAgentFailureContinuation?.phase === "executing",
				);
				await browserVerification?.assertPhase("executing");
				expect(requests).toHaveLength(2);
				releaseSuccess?.();
				await manager.actOnAutomaticFailureContinuation(taskId, initial.episodeId, "retry_now");
				await wait(
					"成功回合完成并结束恢复",
					() => manager.getSummary(taskId)?.automaticAgentFailureContinuation?.phase === "recovered",
				);
				await browserVerification?.assertPhase("recovered");
				const turns = await withRunningCodexAppServerControlSocketConnection(
					(port) => readCodexConversationTurns(port, target.id),
					{ socketPath: endpoint.socketPath },
				);
				expect(turns).toHaveLength(2);
				expect(turns.map((turn) => turn.status)).toEqual(["failed", "completed"]);
				const selfPrompts = turns
					.flatMap((turn) => turn.items)
					.filter(
						(item) =>
							item.type === "userMessage" &&
							item.content?.some((part) => part.text?.includes("核对上一步的真实执行结果")),
					);
				expect(selfPrompts).toHaveLength(1);
				const contexts = (await readFile(target.path, "utf8")).split("\n").flatMap((line) => {
					try {
						const value = JSON.parse(line);
						return value.type === "turn_context" ? [value.payload] : [];
					} catch {
						return [];
					}
				});
				if (process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY)
					await writeFile(
						join(
							process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY,
							"native-settings-contexts.json",
						),
						JSON.stringify(contexts, null, 2),
					);
				expect(contexts).toHaveLength(2);
				for (const key of ["model", "effort", "approval_policy", "sandbox_policy", "collaboration_mode"])
					expect(contexts[1][key]).toEqual(contexts[0][key]);
				expect(contexts[0].collaboration_mode?.mode).toBe("plan");
				expect(contexts[0].model).toBe("gpt-5.4");
				expect(contexts[0].effort).toBeTypeOf("string");
				expect(contexts[0].effort).toBe(contexts[0].collaboration_mode.settings.reasoning_effort);
				expect(contexts[0].approval_policy).toBe("never");
				expect(contexts[0].sandbox_policy.type).toBe("danger-full-access");
				const ledger = await readTaskMessageInjectionLedger(
					getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId)),
				);
				expect(ledger).toHaveLength(1);
				expect(ledger[0]?.codex_native_prompt_delivery_operation?.actualSendAttemptCount).toBe(1);
				const evidenceDirectory = process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY;
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					await writeFile(
						join(evidenceDirectory, "real-native-capacity-result.json"),
						JSON.stringify(
							{
								externalInferenceRequestCount: 0,
								requests,
								contexts,
								turns,
								initial,
								final: manager.getSummary(taskId),
								ledger,
							},
							null,
							2,
						),
					);
				}
			} finally {
				const failureEvidenceDirectory = process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY;
				if (failureEvidenceDirectory) {
					await mkdir(failureEvidenceDirectory, { recursive: true });
					await writeFile(
						join(failureEvidenceDirectory, "latest-real-native-observation.json"),
						JSON.stringify({ requests, summary: manager.getSummary(taskId), output }, null, 2),
					);
				}
				releaseSuccess?.();
				await browserVerification?.dispose();
				await manager.forceStopTaskSession(taskId);
				manager.dispose();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				vi.unstubAllEnvs();
			}
		});
	},
);
