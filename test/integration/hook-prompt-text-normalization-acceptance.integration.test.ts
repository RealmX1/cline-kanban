import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	reconcileCodexPromptSubmissionAcceptance,
	submittedPromptSha256,
} from "../../src/agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import { type RuntimeHookIngestRequest, runtimeHookIngestRequestSchema } from "../../src/core/api-contract";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createHooksApi } from "../../src/trpc/hooks-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromTest = createRequire(import.meta.url);
const spawnedHookProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await spawnedHookProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe("真实 hook stdin 到候选及原生接受的正文保真", { timeout: 60_000 }, () => {
	it.for(["UserPromptSubmit", "BeforeAgent"])(
		"%s 保留多行、缩进、Tab、连续空格和 CRLF，延迟接受仍能补证",
		async (hookEventName, test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const prompt = "  修复正文\r\n\t保留  连续空格\n    缩进代码\n\n完成验证  ";
			let capturedRequest: RuntimeHookIngestRequest | undefined;
			const server = createServer(async (request, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				capturedRequest = runtimeHookIngestRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString())["0"]);
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify([{ result: { data: { ok: true } } }]));
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("隔离端口不可用");
			const manager = new TerminalSessionManager();
			try {
				const child = spawnedHookProcesses.register(
					spawn(
						process.execPath,
						[
							"--import",
							pathToFileURL(requireFromTest.resolve("tsx")).href,
							resolve("src/cli.ts"),
							"hooks",
							"ingest",
							"--event",
							"to_in_progress",
							"--source",
							"codex",
						],
						{
							cwd: fixture.fixtureRootDirectoryPath,
							env: fixture.createIsolatedChildProcessEnvironment({
								KANBAN_RUNTIME_HOST: "127.0.0.1",
								KANBAN_RUNTIME_PORT: String(address.port),
								KANBAN_RUNTIME_HTTPS: undefined,
								KANBAN_HOOK_TASK_ID: "acceptance-task",
								KANBAN_HOOK_WORKSPACE_ID: "acceptance-workspace",
								AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB: undefined,
							}),
							stdio: ["pipe", "pipe", "pipe"],
						},
					),
				);
				let stderr = "";
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.stdout?.resume();
				child.stdin?.end(JSON.stringify({ hook_event_name: hookEventName, prompt }));
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					test,
					child,
					{
						waitedForDescription: "真实 hook CLI 接收 stdin 并发出请求",
						softDeadlineMsExpectedOnUncontendedHost: 5_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
					},
					{ describeChildProcessOutputForFailureMessage: () => stderr },
				);
				expect(child.exitCode, stderr).toBe(0);
				expect(capturedRequest?.submittedPromptText).toBe(prompt);
				expect(capturedRequest).toMatchObject({ submittedPromptTextNormalization: "preserve_internal_whitespace" });
				if (!capturedRequest) throw new Error("未收到 hook 请求");
				const attemptedAtMs = capturedRequest.hookEventCapturedAtEpochMs ?? Date.now();
				const transcriptPath = join(fixture.fixtureRootDirectoryPath, "native-acceptance.jsonl");
				manager.hydrateFromRecord({
					"acceptance-task": {
						taskId: "acceptance-task",
						agentId: "codex",
						workspacePath: fixture.fixtureRootDirectoryPath,
						state: "awaiting_review",
						turnOwner: "user",
						liveness: "exited",
						userTurnKind: "review",
						pid: null,
						startedAt: attemptedAtMs - 1000,
						updatedAt: attemptedAtMs,
						lastOutputAt: null,
						reviewReason: "hook",
						exitCode: 0,
						lastHookAt: null,
						latestHookActivity: null,
						runtimeSessionIncarnationId: "acceptance-incarnation",
						agentNativeConversationSessionIdentity: {
							sourceAgentId: "codex",
							nativeSessionId: "acceptance-native",
							transcriptPath,
							observedAt: attemptedAtMs,
						},
					},
				});
				const api = createHooksApi({
					getWorkspacePathById: () => fixture.fixtureRootDirectoryPath,
					ensureTerminalManagerForWorkspace: async () => manager,
					broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
					broadcastTaskReadyForReview: vi.fn(),
				});
				expect(await api.ingest({ ...capturedRequest, notificationCandidateId: undefined })).toMatchObject({
					ok: true,
				});
				const summary = manager.getSummary("acceptance-task");
				if (!summary) throw new Error("缺少候选摘要");
				expect(summary.agentConversationPromptSubmissionAcceptance).toMatchObject({
					submittedPromptSha256: submittedPromptSha256(prompt),
					submittedPromptTextNormalization: "preserve_internal_whitespace",
				});
				await writeFile(
					transcriptPath,
					`${[
						{
							type: "session_meta",
							payload: { id: "acceptance-native", cwd: fixture.fixtureRootDirectoryPath, source: "cli" },
						},
						{
							timestamp: new Date(attemptedAtMs + 30_000).toISOString(),
							type: "event_msg",
							payload: {
								type: "item_completed",
								thread_id: "acceptance-native",
								turn_id: "turn",
								item: {
									type: "UserMessage",
									id: "input",
									content: [{ type: "text", text: prompt.replace(/\r\n/g, "\n").trim() }],
								},
							},
						},
					]
						.map((record) => JSON.stringify(record))
						.join("\n")}\n`,
				);
				const result = await reconcileCodexPromptSubmissionAcceptance({
					summary,
					observedAtMs: attemptedAtMs + 60_000,
				});
				expect(result?.accepted?.acceptedAtMs).toBe(attemptedAtMs + 30_000);
				if (result) manager.reconcileAgentConversationPromptSubmissionAcceptance("acceptance-task", result);
				expect(manager.getSummary("acceptance-task")?.agentConversationPromptSubmissionAcceptance?.status).toBe(
					"accepted",
				);
			} finally {
				manager.dispose();
				await new Promise<void>((done) => server.close(() => done()));
			}
		},
	);
});
