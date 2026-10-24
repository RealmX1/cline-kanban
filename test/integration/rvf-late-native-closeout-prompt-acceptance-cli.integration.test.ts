import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RuntimeTaskSessionSummary, RvfAutomaticCloseoutRecord } from "../../src/core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../src/core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { reconcileRvfAutomaticCloseoutLateNativePromptAcceptance } from "../../src/rvf-automatic-closeout/reconcile-rvf-automatic-closeout-late-native-prompt-acceptance";
import { buildRvfAutomaticCloseoutPrompt } from "../../src/rvf-automatic-closeout/rvf-automatic-closeout-prompt";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
} from "../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const cliExitDeadline = {
	waitedForDescription: "迟到原生收尾补证 CLI 退出",
	softDeadlineMsExpectedOnUncontendedHost: 8000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};
const timeout = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 0,
	testBodyTimeoutBudgetMs: 30_000,
	cliChildProcessSpawns: { cliChildProcessSpawnCount: 6, cliChildProcessExitTwoTierDeadline: cliExitDeadline },
});

afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe("迟到接受补证的真实 CLI、HTTP/tRPC、Unix 原生控制面与持久重入", { timeout }, () => {
	it("正文迟到前退出 12；精确正文到达后 dry-run、恢复和服务重建幂等，所有查询均无原生副作用", async (testContext) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "late-native-acceptance" });
		await writeFile(join(repository.repositoryPath, "implementation.txt"), "保留实现与未提交内容\n");
		const head = repository.commitAllRepositoryFilesAtDate({
			message: "隔离实现",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		await writeFile(join(repository.repositoryPath, "implementation.txt"), "必须保留的未提交内容\n");
		const workspace = await loadWorkspaceContext(repository.repositoryPath);
		const scope = { workspaceId: workspace.workspaceId, workspacePath: workspace.repoPath };
		const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-evidence");
		const runDirectory = join(rvfHome, "runs", "bound-run");
		const handoffPath = join(runDirectory, "artifacts", "handoff.md");
		await mkdir(dirname(handoffPath), { recursive: true });
		await writeFile(handoffPath, "独立完成的 RVF 交接\n");
		const token = "0123456789abcdef";
		const taskId = "a1234";
		const transcriptPath = join(fixture.fixtureRootDirectoryPath, "restored-native-session.jsonl");
		const epoch = Date.now() - 180_000;
		const iso = (offset: number) => new Date(epoch + offset).toISOString();
		const receipt: RvfAutomaticCloseoutRecord["receipt"] = {
			schema: "rvf-independent-user-turn-boundary/v1",
			decision_token: token,
			session_id: "original-native",
			worktree: repository.repositoryPath,
			native_user_message_id: "review-message",
			native_turn_id: "review-turn",
			transcript_path: "/isolated-original-native.jsonl",
			boundary_message_sha256: "a".repeat(64),
			candidate_fingerprint: "sha256:candidate",
			worktree_head_commit_sha: head,
			checkpoint_commit: head,
			checkpoint_tree: "b".repeat(40),
			comparison_base_tip: head,
			comparison_base_ref: "main",
			comparison_base_ref_tip: head,
			source: "explicit_user_command",
			kanban_task_id: taskId,
			idempotency_key: `rvf-decision-point-${token}`,
		};
		const record: RvfAutomaticCloseoutRecord = {
			workspaceId: scope.workspaceId,
			taskId,
			conversationSessionId: taskId,
			receipt,
			preReviewTurnIds: ["implementation-turn"],
			status: "paused",
			createdAt: epoch,
			updatedAt: epoch + 16_419,
			runId: "bound-run",
			runDirectory,
			handoffPath,
			handoffSha256: computeRvfTextSha256(await readFile(handoffPath)),
			restoredNativeSessionId: "restored-native",
			restoredTranscriptPath: transcriptPath,
			restoreWorkspaceStateSha256: null,
			nativeIdentitySwitchStartedAt: epoch - 1000,
			nativeForkAttemptStartedAt: epoch - 2000,
			pauseReason: "收尾投递失败：submit_confirmation_budget_exhausted",
			promptDeliveryIdempotencyKey: `rvf-automatic-closeout-${token}`,
		};
		const storePath = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
		await updateRvfAutomaticCloseoutRecords(storePath, () => ({ records: [record], value: undefined }));
		const notificationDirectory = join(rvfHome, "automatic-closeout-completion-notifications");
		const bindingDirectory = join(rvfHome, "review-start-independent-user-turn-boundary-receipts");
		await mkdir(notificationDirectory, { recursive: true });
		await mkdir(bindingDirectory, { recursive: true });
		await writeFile(
			join(notificationDirectory, `${token}.json`),
			JSON.stringify({
				schema: "rvf-automatic-closeout-completion/v1",
				decision_token: token,
				session_id: receipt.session_id,
				worktree: receipt.worktree,
				run_id: record.runId,
				run_dir: runDirectory,
				handoff_path: handoffPath,
				handoff_sha256: record.handoffSha256,
			}),
		);
		await writeFile(
			join(bindingDirectory, `${token}.run-binding.json`),
			JSON.stringify({
				run_id: record.runId,
				run_dir: runDirectory,
				receipt_sha256: computeRvfTextSha256(
					JSON.stringify(
						Object.fromEntries(
							Object.entries(receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
						),
					),
				),
			}),
		);
		await writeFile(
			join(runDirectory, "artifacts", ".finalize.lock"),
			JSON.stringify({
				run_id: record.runId,
				run_dir: runDirectory,
				repo: repository.repositoryPath,
				decision_kind: "handoff",
				completed_at: iso(-1000),
				errors: [],
			}),
		);
		const text = buildRvfAutomaticCloseoutPrompt(record);
		const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(scope.workspaceId));
		await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
			records: [
				{
					...createPendingTaskMessageInjectionRecord({
						taskId,
						attemptId: taskId,
						source: "rvf_automatic_closeout",
						idempotencyKey: record.promptDeliveryIdempotencyKey,
						promptSha256: computeRvfTextSha256(text),
						nowIso: iso(0),
					}),
					agent_idle_gate_passed_at: iso(31),
					agent_idle_wait_deadline_at: iso(60_000),
				},
			],
			result: undefined,
		}));
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId,
			idempotencyKey: record.promptDeliveryIdempotencyKey,
			status: "delivery_failed",
			failureReason: "submit_confirmation_budget_exhausted",
			nowIso: iso(16_419),
		});
		const nativeRecords = [
			{
				type: "session_meta",
				timestamp: iso(-1000),
				payload: {
					id: "restored-native",
					originator: "codex-tui",
					source: "vscode",
					cli_version: "0.164.0",
					cwd: repository.repositoryPath,
				},
			},
			{
				type: "event_msg",
				timestamp: iso(1366),
				payload: { type: "task_started", turn_id: "closeout-turn", turn_attribution: { turn_trigger: "user" } },
			},
			{ type: "compacted", timestamp: iso(120_800), payload: { message: "隔离的压缩结果" } },
		];
		await writeFile(transcriptPath, `${nativeRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const socketDirectory = await mkdtemp("/tmp/kanban-late-acceptance-");
		const socketPath = join(socketDirectory, "s");
		const nativeServer = createServer();
		const nativeSockets = new WebSocketServer({ server: nativeServer });
		const nativeRequests: string[] = [];
		nativeSockets.on("connection", (socket) =>
			socket.on("message", (bytes) => {
				const request = JSON.parse(bytes.toString()) as { id?: number; method: string };
				nativeRequests.push(request.method);
				if (request.id === undefined) return;
				const result =
					request.method === "initialize"
						? {}
						: request.method === "thread/loaded/list"
							? { data: ["restored-native"], nextCursor: null }
							: {
									data: [
										{
											id: "closeout-turn",
											status: "completed",
											items: [
												{ id: "closeout-message", type: "userMessage", content: [{ type: "text", text }] },
											],
										},
									],
									nextCursor: null,
								};
				socket.send(JSON.stringify({ id: request.id, result }));
			}),
		);
		let httpServer: ReturnType<typeof createHTTPServer> | null = null;
		onTestFinished(async () => {
			for (const socket of nativeSockets.clients) socket.terminate();
			await new Promise<void>((done) => nativeSockets.close(() => done()));
			if (nativeServer.listening) await new Promise<void>((done) => nativeServer.close(() => done()));
			if (httpServer?.listening) await new Promise<void>((done) => httpServer?.close(() => done()));
			await rm(socketDirectory, { recursive: true, force: true });
		});
		await new Promise<void>((done, reject) => {
			nativeServer.once("error", reject);
			nativeServer.listen(socketPath, done);
		});
		const summary: RuntimeTaskSessionSummary = {
			taskId,
			state: "awaiting_review",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			agentId: "codex",
			workspacePath: repository.repositoryPath,
			pid: null,
			startedAt: epoch - 1000,
			updatedAt: epoch,
			lastOutputAt: epoch,
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			runtimeSessionIncarnationId: "isolated-incarnation",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "restored-native",
				transcriptPath,
				observedAt: epoch,
			},
			codexNativeSessionControlEndpoint: {
				workspaceId: scope.workspaceId,
				conversationSessionId: taskId,
				runtimeSessionIncarnationId: "isolated-incarnation",
				socketPath,
			},
		};
		async function startHttpRuntimeApi() {
			// 只挂接本次实际消费的服务接口，原生身份与事件由隔离宿主控制；其余会话起停能力不参与。
			const api: Pick<
				NonNullable<RuntimeTrpcContext["rvfAutomaticCloseoutApi"]>,
				"reconcileLateNativePromptAcceptance"
			> = {
				reconcileLateNativePromptAcceptance: async (_scope, input) =>
					reconcileRvfAutomaticCloseoutLateNativePromptAcceptance(
						{
							workspaceId: scope.workspaceId,
							rvfHome,
							getMainSummary: async () => summary,
							isExplicitlyStopped: () => false,
						},
						input,
					),
			};
			httpServer = createHTTPServer({
				router: runtimeAppRouter,
				basePath: "/api/trpc/",
				createContext: ({ req }) =>
					({
						requestedWorkspaceId: req.headers["x-kanban-workspace-id"],
						workspaceScope: scope,
						rvfAutomaticCloseoutApi: api,
						kanbanRequestOriginActorEvidence: {
							decodedCliActorClaimsRequestHeader:
								decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
						},
					}) as unknown as RuntimeTrpcContext,
			});
			await new Promise<void>((done, reject) => {
				httpServer?.once("error", reject);
				httpServer?.listen(0, "127.0.0.1", done);
			});
			const address = httpServer.address();
			if (!address || typeof address === "string") throw new Error("HTTP fixture 没有隔离端口");
			expect(address.port).not.toBe(3484);
			return address.port;
		}
		let runtimePort = await startHttpRuntimeApi();
		async function invokeCli(additionalArguments: string[] = []) {
			const child = children.register(
				spawn(
					process.execPath,
					[
						"--import",
						resolve("node_modules/tsx/dist/loader.mjs"),
						resolve("src/cli.ts"),
						"task",
						"reconcile-rvf-automatic-closeout-late-native-prompt-acceptance",
						"--project-path",
						repository.repositoryPath,
						"--task-id",
						taskId,
						"--decision-token",
						token,
						"--run-id",
						"bound-run",
						"--handoff-sha256",
						record.handoffSha256 ?? "",
						...additionalArguments,
					],
					{
						cwd: repository.repositoryPath,
						stdio: ["ignore", "pipe", "pipe"],
						env: fixture.createIsolatedChildProcessEnvironment({
							KANBAN_RUNTIME_PORT: String(runtimePort),
							RVF_HOME: rvfHome,
						}),
					},
				),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, cliExitDeadline, {
				describeChildProcessOutputForFailureMessage: () => `${stdout}\n${stderr}`,
			});
			expect(stdout.trim(), stderr).not.toBe("");
			return { exitCode: child.exitCode, response: JSON.parse(stdout) as { status: string; receipt?: unknown } };
		}
		const ledgerBefore = await readFile(ledgerPath);
		const gitBefore = repository.runGit(["status", "--porcelain=v2"]).stdout;
		expect(await invokeCli()).toMatchObject({ exitCode: 12, response: { status: "unknown" } });
		expect((await readRvfAutomaticCloseoutRecords(storePath))[0]?.status).toBe("paused");
		await writeFile(
			transcriptPath,
			`${nativeRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n${JSON.stringify({
				type: "event_msg",
				timestamp: iso(121_574),
				payload: {
					type: "item_completed",
					turn_id: "closeout-turn",
					item: { type: "UserMessage", id: "closeout-message", content: [{ type: "text", text }] },
				},
			})}\n`,
		);
		const storeBeforeDryRun = await readFile(storePath);
		expect(await invokeCli(["--dry-run"])).toMatchObject({ exitCode: 0, response: { status: "eligible" } });
		expect(await readFile(storePath)).toEqual(storeBeforeDryRun);
		const recovered = await invokeCli();
		expect(recovered).toMatchObject({ exitCode: 0, response: { status: "recovered" } });
		await new Promise<void>((done) => httpServer?.close(() => done()));
		runtimePort = await startHttpRuntimeApi();
		const repeated = await invokeCli();
		expect(repeated).toMatchObject({
			exitCode: 0,
			response: { status: "already_recovered", receipt: recovered.response.receipt },
		});
		expect((await readRvfAutomaticCloseoutRecords(storePath))[0]?.status).toBe("closeout_prompt_submitted");
		expect(await readFile(ledgerPath)).toEqual(ledgerBefore);
		expect(repository.runGit(["status", "--porcelain=v2"]).stdout).toBe(gitBefore);
		expect(
			nativeRequests.every((method) =>
				["initialize", "initialized", "thread/loaded/list", "thread/turns/list"].includes(method),
			),
		).toBe(true);
	});
});
