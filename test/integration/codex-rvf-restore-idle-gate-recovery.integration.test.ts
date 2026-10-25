import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../src/core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { createRvfAutomaticCloseoutRuntimeService } from "../../src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service";
import { readRvfCloseoutWorkspaceStateDigest } from "../../src/rvf-automatic-closeout/rvf-closeout-workspace-state-digest";
import type * as WorkspaceState from "../../src/state/workspace-state";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { deliverCodexNativePromptWithoutChangingComposer } from "../../src/terminal/codex-native-prompt-delivery";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { enqueueAgentIdleGatedProgrammaticTaskChatMessage } from "../../src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

const workspace = vi.hoisted(() => ({
	directory: "",
	summaryProvider: () => ({}) as Record<string, RuntimeTaskSessionSummary>,
	board: {
		columns: [
			{
				id: "review",
				cards: [{ id: "idle-gate-task", baseRef: "main", prompt: "隔离空闲门禁验证", startInPlanMode: false }],
			},
		],
	},
}));
vi.mock("../../src/state/workspace-state", async (importOriginal) => ({
	...(await importOriginal<typeof WorkspaceState>()),
	getWorkspaceDirectoryPath: () => workspace.directory,
	getWorkspacesRootPath: () => dirname(workspace.directory),
	loadWorkspaceBoardById: async () => workspace.board,
	loadPersistedWorkspaceStateById: async () => ({ board: workspace.board, sessions: workspace.summaryProvider() }),
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: async () => {},
}));
vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex TUI 的 RVF 空闲门禁补证",
	{ timeout: 180_000 },
	() => {
		it("接受投影漏报后自动 fork、重启与原生收尾各一次，保留工作区与暂存内容", async (test) => {
			vi.stubEnv("TMPDIR", "/tmp");
			vi.stubEnv(
				"PATH",
				`${dirname(process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "/opt/homebrew/bin/codex")}:${process.env.PATH ?? ""}`,
			);
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "k-rvf-idle-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "project" });
			await writeFile(join(repository.repositoryPath, "implementation.txt"), "初始实现\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-home");
			workspace.directory = join(fixture.fixtureRootDirectoryPath, "workspace");
			vi.stubEnv("RVF_HOME", rvfHome);
			await mkdir(workspace.directory);
			await mkdir(codexHome);
			let modelRequests = 0;
			const modelServer = createServer(async (request, response) => {
				for await (const _chunk of request) {
					/* 排空本地模型请求。 */
				}
				modelRequests++;
				const item = {
					type: "message",
					id: `message-${modelRequests}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "隔离验证已完成", annotations: [] }],
				};
				const result = {
					id: `response-${modelRequests}`,
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
			await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
			const address = modelServer.address();
			if (!address || typeof address === "string") throw new Error("隔离模型端口不可用");
			await writeFile(
				join(codexHome, "config.toml"),
				`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离空闲门禁模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
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
			const scope = { workspaceId: "isolated-rvf-idle", workspacePath: repository.repositoryPath };
			const taskId = "idle-gate-task";
			const manager = new TerminalSessionManager({ prepareCodexNativeSessionControlHostLaunch });
			let terminalOutput = "";
			manager.attach(taskId, {
				onOutput: (chunk) => {
					terminalOutput += chunk.toString();
					if (chunk.toString().includes("\x1b[6n")) manager.writeInput(taskId, Buffer.from("\x1b[1;1R"));
					if (chunk.toString().includes("\x1b[c")) manager.writeInput(taskId, Buffer.from("\x1b[?1;2c"));
				},
			});
			let sourceThreadId = "";
			let sourceTranscriptPath = "";
			let attemptedAtMs = 0;
			const current = () => {
				const summary = manager.getSummary(taskId);
				if (!summary) throw new Error("隔离主会话不可用");
				return summary;
			};
			workspace.summaryProvider = () => ({ [taskId]: current() });
			const projected = () => {
				const summary = current();
				return summary.agentNativeConversationSessionIdentity?.nativeSessionId === sourceThreadId
					? {
							...summary,
							turnOwner: "agent" as const,
							userTurnKind: null,
							agentConversationPromptSubmissionAcceptance: {
								status: "unconfirmed" as const,
								attemptedAtMs,
								runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? "",
							},
						}
					: summary;
			};
			const awaitNativeCompletion = async () => {
				let observed: {
					id: string;
					path: string;
					turns: Awaited<ReturnType<typeof readCodexConversationTurns>>;
				} | null = null;
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "真实 TUI 的最新原生回合完成",
						softDeadlineMsExpectedOnUncontendedHost: 15_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
					},
					async () => {
						const endpoint = current().codexNativeSessionControlEndpoint;
						// 新 thread 创建前不抢先 initialize，避免探针的 clientName 影响原生创建来源。
						if (!endpoint || (!current().agentNativeConversationSessionIdentity && modelRequests === 0))
							return false;
						return withRunningCodexAppServerControlSocketConnection(
							async (port) => {
								const loaded = (await port.request("thread/loaded/list", {})) as { data: string[] };
								const threadId =
									current().agentNativeConversationSessionIdentity?.nativeSessionId ?? loaded.data[0];
								if (!threadId || !loaded.data.includes(threadId)) return false;
								const response = (await port.request("thread/read", { threadId, includeTurns: false })) as {
									thread: { id: string; path: string; status: { type: string } };
								};
								const turns = await readCodexConversationTurns(port, threadId);
								if (response.thread.status.type !== "idle" || turns.at(-1)?.status !== "completed")
									return false;
								observed = { id: threadId, path: response.thread.path, turns };
								return true;
							},
							{ socketPath: endpoint.socketPath, requestTimeoutMs: 2000 },
						).catch(() => false);
					},
					{ describeLastObservedStateForFailureMessage: () => terminalOutput.slice(-1500) },
				);
				if (!observed) throw new Error("未获得真实原生完成证据");
				return observed as {
					id: string;
					path: string;
					turns: Awaited<ReturnType<typeof readCodexConversationTurns>>;
				};
			};
			const launch = (resumeNativeSessionId?: string) =>
				manager.startTaskSession({
					taskId,
					workspaceId: scope.workspaceId,
					agentId: "codex",
					binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
					args: [
						"--no-alt-screen",
						"--dangerously-bypass-approvals-and-sandbox",
						"-C",
						repository.repositoryPath,
						...(resumeNativeSessionId ? ["resume", resumeNativeSessionId] : ["准备实现，仅回复就绪"]),
					],
					cwd: repository.repositoryPath,
					prompt: "",
					env: environment,
					cols: 140,
					rows: 42,
				});
			const facade = {
				getSummary: () => projected(),
				listSummaries: () => [projected()],
				isTaskSessionAutomaticContinuationSuppressed:
					manager.isTaskSessionAutomaticContinuationSuppressed.bind(manager),
				getAwaitingDispatchedBackgroundWork: manager.getAwaitingDispatchedBackgroundWork.bind(manager),
				hasPendingProgrammaticTaskChatInputDelivery:
					manager.hasPendingProgrammaticTaskChatInputDelivery.bind(manager),
				resolveTaskTerminalInputBoxOccupancy: manager.resolveTaskTerminalInputBoxOccupancy.bind(manager),
				getTaskTerminalInputSideMutationSnapshot: manager.getTaskTerminalInputSideMutationSnapshot.bind(manager),
				forceStopTaskSession: vi.fn(manager.forceStopTaskSession.bind(manager)),
				applyAgentNativeConversationSessionIdentity: vi.fn(
					manager.applyAgentNativeConversationSessionIdentity.bind(manager),
				),
				publishRvfAutomaticCloseoutPaused: vi.fn(),
				publishRvfAutomaticCloseoutWaiting: vi.fn(),
			};
			const runtimeApi = {
				cancelTaskChatDelivery: vi.fn(async () => ({ ok: true, cancelResult: "no_pending_delivery" as const })),
				startTaskSession: vi.fn(async () => {
					await launch(current().agentNativeConversationSessionIdentity?.nativeSessionId);
					await awaitNativeCompletion();
					return { ok: true, summary: current() };
				}),
				enqueueAgentIdleGatedProgrammaticTaskChatMessage: vi.fn(
					async (
						_scope: unknown,
						input: Parameters<typeof enqueueAgentIdleGatedProgrammaticTaskChatMessage>[2],
					) => {
						const result = await enqueueAgentIdleGatedProgrammaticTaskChatMessage({}, scope.workspaceId, input);
						const delivered = await deliverCodexNativePromptWithoutChangingComposer({
							summary: current(),
							workspaceId: scope.workspaceId,
							text: input.text,
							clientUserMessageId: randomUUID(),
							isCurrent: () => true,
							beforeSubmit: async () => true,
							onRequestAttempted: () => {},
						});
						if (delivered.status !== "confirmed") throw new Error(`收尾原生投递未确认：${delivered.status}`);
						await recordTaskMessageTerminalDeliveryOutcome({
							ledgerPath: getTaskMessageInjectionLedgerPath(workspace.directory),
							taskId,
							idempotencyKey: input.idempotencyKey ?? "",
							status: "delivered_and_submit_confirmed",
							codexNativePromptDeliveryEvidence: delivered.evidence,
							nowIso: new Date().toISOString(),
						});
						return result;
					},
				),
			};
			const dependencies = {
				getManager: async () => facade,
				runtimeApi,
				listWorkspaces: async () => [scope],
				warn: vi.fn(),
			};
			const service = createRvfAutomaticCloseoutRuntimeService(dependencies);
			let report: unknown;
			try {
				await launch();
				const implementation = await awaitNativeCompletion();
				sourceThreadId = implementation.id;
				sourceTranscriptPath = implementation.path;
				manager.applyAgentNativeConversationSessionIdentity(taskId, {
					sourceAgentId: "codex",
					nativeSessionId: implementation.id,
					transcriptPath: implementation.path,
					observedAt: Date.now(),
				});
				await writeFile(join(repository.repositoryPath, "implementation.txt"), "已暂存修复\n");
				repository.runGit(["add", "implementation.txt"]);
				await writeFile(join(repository.repositoryPath, "implementation.txt"), "未暂存修复\n");
				await writeFile(join(repository.repositoryPath, "untracked.txt"), "未跟踪内容\n");
				const workspaceDigest = await readRvfCloseoutWorkspaceStateDigest(repository.repositoryPath);
				const token = "0123456789abcdef";
				const boundaryText = `RVF 发起决策点 · RVF_DECISION_TOKEN=${token}`;
				const tokenDirectory = join(rvfHome, "agentic-initiation-decision-tokens");
				await mkdir(tokenDirectory, { recursive: true });
				await writeFile(
					join(tokenDirectory, `${token}.json`),
					JSON.stringify({
						token,
						session_id: sourceThreadId,
						worktree: repository.repositoryPath,
						candidate_fingerprint: "isolated-candidate",
						state: "injected",
						minted_at: new Date().toISOString(),
						expires_at: new Date(Date.now() + 120_000).toISOString(),
						initiated_by_explicit_user_request: false,
						candidate_summary: { kanban_task_id: taskId, candidates: [] },
					}),
				);
				attemptedAtMs = Date.now();
				const boundaryDelivery = await deliverCodexNativePromptWithoutChangingComposer({
					summary: current(),
					workspaceId: scope.workspaceId,
					text: boundaryText,
					clientUserMessageId: randomUUID(),
					isCurrent: () => true,
					beforeSubmit: async () => true,
					onRequestAttempted: () => {},
				});
				expect(boundaryDelivery.status).toBe("confirmed");
				if (boundaryDelivery.status !== "confirmed") throw new Error("开审消息投递未确认");
				await awaitNativeCompletion();
				const captured = await service.capture(scope, { taskId, decisionToken: token });
				if (captured.status !== "captured")
					throw new Error(
						JSON.stringify({
							captured,
							nativeMetadata: JSON.parse((await readFile(implementation.path, "utf8")).split("\n")[0] ?? "{}")
								.payload?.originator,
						}),
					);
				const ledgerPath = getTaskMessageInjectionLedgerPath(workspace.directory);
				await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
					records: [
						{
							task_id: taskId,
							source: "review-validate-fix",
							idempotency_key: captured.receipt.idempotency_key,
							prompt_sha256: computeRvfTextSha256(boundaryText),
							message_id: "boundary-delivery",
							created_at: new Date(attemptedAtMs).toISOString(),
							terminal_delivery_status: "delivery_failed",
							terminal_delivery_failure_reason: "codex_native_prompt_delivery_unconfirmed",
							terminal_delivery_status_updated_at: new Date().toISOString(),
							codex_native_prompt_delivery_evidence: boundaryDelivery.evidence,
						},
					],
					result: null,
				}));
				const boundaryLedgerBefore = (await readTaskMessageInjectionLedger(ledgerPath))[0];
				const runId = "isolated-native-idle-gate-run";
				const runDirectory = join(rvfHome, "runs", runId);
				const handoffPath = join(runDirectory, "artifacts", "handoff.md");
				for (const path of [
					join(runDirectory, "inputs"),
					join(runDirectory, "artifacts", "inputs"),
					join(rvfHome, "automatic-closeout-completion-notifications"),
				])
					await mkdir(path, { recursive: true });
				await writeFile(
					join(runDirectory, "inputs", "automatic-closeout-review-start-receipt.json"),
					JSON.stringify(captured.receipt),
				);
				await writeFile(
					join(runDirectory, "artifacts", "inputs", "scope.contract.json"),
					JSON.stringify({ run_id: runId, base_ref: "main" }),
				);
				const ordered = Object.fromEntries(
					Object.entries(captured.receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
				);
				await writeFile(
					join(rvfHome, "review-start-independent-user-turn-boundary-receipts", `${token}.run-binding.json`),
					JSON.stringify({
						run_id: runId,
						run_dir: runDirectory,
						receipt_sha256: computeRvfTextSha256(JSON.stringify(ordered)),
					}),
				);
				await service.activateAfterRunBinding(scope, { taskId, decisionToken: token });
				const handoff = "隔离测试的 RVF 已完成";
				await writeFile(handoffPath, handoff);
				await writeFile(
					join(runDirectory, "artifacts", ".finalize.lock"),
					JSON.stringify({
						run_id: runId,
						run_dir: runDirectory,
						repo: repository.repositoryPath,
						decision_kind: "handoff-advisory",
						completed_at: new Date().toISOString(),
						errors: [],
					}),
				);
				await writeFile(
					join(rvfHome, "automatic-closeout-completion-notifications", `${token}.json`),
					JSON.stringify({
						schema: "rvf-automatic-closeout-completion/v1",
						decision_token: token,
						session_id: sourceThreadId,
						worktree: repository.repositoryPath,
						run_id: runId,
						run_dir: runDirectory,
						handoff_path: handoffPath,
						handoff_sha256: computeRvfTextSha256(handoff),
					}),
				);
				await service.sweepPendingCloseoutsOnce();
				const state = await service.status(scope, { taskId });
				expect(
					state.records[0]?.preReviewConversationRestoreIdleGateRecovery?.status,
					JSON.stringify({ state, warnings: dependencies.warn.mock.calls }),
				).toBe("qualified");
				expect(state.records[0]?.status).toBe("closeout_prompt_submitted");
				await createRvfAutomaticCloseoutRuntimeService(dependencies).sweepPendingCloseoutsOnce();
				const restored = await awaitNativeCompletion();
				expect(restored.id).not.toBe(sourceThreadId);
				expect(restored.turns).toHaveLength(2);
				expect(restored.turns[0]?.id).toBe(implementation.turns[0]?.id);
				expect(JSON.stringify(restored.turns)).not.toContain(boundaryText);
				expect(
					restored.turns
						.flatMap((turn) => turn.items)
						.filter(
							(item) =>
								item.type === "userMessage" &&
								JSON.stringify(item).includes(`RVF_AUTOMATIC_CLOSEOUT_TOKEN=${token}`),
						),
				).toHaveLength(1);
				expect(facade.forceStopTaskSession).toHaveBeenCalledOnce();
				expect(facade.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
				expect(runtimeApi.startTaskSession).toHaveBeenCalledOnce();
				expect(runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
				expect((await readTaskMessageInjectionLedger(ledgerPath))[0]).toEqual(boundaryLedgerBefore);
				expect(await readRvfCloseoutWorkspaceStateDigest(repository.repositoryPath)).toBe(workspaceDigest);
				report = {
					status: "passed",
					modelRequests,
					state,
					restoredThreadId: restored.id,
					restoredTurns: restored.turns.map((turn) => turn.id),
					workspaceDigestPreserved: true,
				};
			} finally {
				const evidenceDirectory = process.env.KANBAN_CODEX_RVF_IDLE_GATE_EVIDENCE_DIRECTORY;
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					for (const [name, path] of [
						["original-native-transcript.jsonl", sourceTranscriptPath],
						[
							"restored-native-transcript.jsonl",
							current().agentNativeConversationSessionIdentity?.transcriptPath,
						],
					] as const) {
						if (path) {
							const bytes = await readFile(path).catch(() => null);
							if (bytes) await writeFile(join(evidenceDirectory, name), bytes);
						}
					}
					await writeFile(
						join(evidenceDirectory, "native-idle-gate-result.json"),
						JSON.stringify(
							report ?? {
								status: "failed",
								state: await service.status(scope, { taskId }).catch(() => null),
								warnings: dependencies.warn.mock.calls,
								terminalOutput: terminalOutput.slice(-6000),
							},
							null,
							2,
						),
					);
				}
				await manager.forceStopTaskSession(taskId);
				manager.dispose();
				modelServer.closeAllConnections();
				await new Promise<void>((resolve) => modelServer.close(() => resolve()));
			}
		});
	},
);
