import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	rvfIndependentUserTurnBoundaryReceiptSchema,
	rvfReviewStartBoundaryResponseSchema,
} from "../../src/core/api-contract";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { computeRvfTextSha256 } from "../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { withCodexAppServerRequestConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { getWorkspaceDirectoryPath, loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const cliExitDeadline = {
	waitedForDescription: "RVF 分界捕获或激活 CLI 退出",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};
const packagedRuntimeBoundaryRestartTimeout = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 3,
	testBodyTimeoutBudgetMs: 60_000,
	cliChildProcessSpawns: { cliChildProcessSpawnCount: 4, cliChildProcessExitTwoTierDeadline: cliExitDeadline },
});

async function readPackagedBoundaryCaptureCommandResponse(
	commandResult: { exitCode: number | null; stdout: string; stderr: string },
	captureBoundaryViaRuntimeRpc: () => Promise<unknown>,
): Promise<unknown> {
	expect(commandResult.exitCode, commandResult.stderr).toBe(0);
	// caaa3 尚未修复时，直接 RPC 保留底层异常；不能用空 JSON 解析错误掩盖捕获原因。
	if (!commandResult.stdout.trim()) return captureBoundaryViaRuntimeRpc();
	return JSON.parse(commandResult.stdout);
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe("打包捕获命令响应的空 stdout 兜底", () => {
	const capturedBoundaryResponse = { receipt: { native_turn_id: "captured-boundary" } };

	it("空 stdout 使用直接 RPC 的成功结果", async () => {
		const captureBoundaryViaRuntimeRpc = vi.fn(async () => capturedBoundaryResponse);
		await expect(
			readPackagedBoundaryCaptureCommandResponse(
				{ exitCode: 0, stdout: " \n\t", stderr: "" },
				captureBoundaryViaRuntimeRpc,
			),
		).resolves.toEqual(capturedBoundaryResponse);
		expect(captureBoundaryViaRuntimeRpc).toHaveBeenCalledOnce();
	});

	it("非空 stdout 使用 CLI 结果且不重试 RPC", async () => {
		const captureBoundaryViaRuntimeRpc = vi.fn(async () => null);
		await expect(
			readPackagedBoundaryCaptureCommandResponse(
				{ exitCode: 0, stdout: JSON.stringify(capturedBoundaryResponse), stderr: "" },
				captureBoundaryViaRuntimeRpc,
			),
		).resolves.toEqual(capturedBoundaryResponse);
		expect(captureBoundaryViaRuntimeRpc).not.toHaveBeenCalled();
	});

	it("CLI 失败保留退出错误且不重试 RPC", async () => {
		const captureBoundaryViaRuntimeRpc = vi.fn(async () => capturedBoundaryResponse);
		await expect(
			readPackagedBoundaryCaptureCommandResponse(
				{ exitCode: 1, stdout: "", stderr: "捕获 CLI 失败" },
				captureBoundaryViaRuntimeRpc,
			),
		).rejects.toThrow("捕获 CLI 失败");
		expect(captureBoundaryViaRuntimeRpc).not.toHaveBeenCalled();
	});

	it("空 stdout 的 RPC 失败保留原始异常", async () => {
		const captureError = new Error("捕获 RPC 失败");
		await expect(
			readPackagedBoundaryCaptureCommandResponse({ exitCode: 0, stdout: "", stderr: "" }, async () => {
				throw captureError;
			}),
		).rejects.toBe(captureError);
	});

	it("非空但损坏的 CLI JSON 不会被成功 RPC 掩盖", async () => {
		const captureBoundaryViaRuntimeRpc = vi.fn(async () => capturedBoundaryResponse);
		await expect(
			readPackagedBoundaryCaptureCommandResponse(
				{ exitCode: 0, stdout: "{", stderr: "" },
				captureBoundaryViaRuntimeRpc,
			),
		).rejects.toThrow(SyntaxError);
		expect(captureBoundaryViaRuntimeRpc).not.toHaveBeenCalled();
	});
});

describe("RVF 开审分界的打包态宿主与进程重启", { timeout: packagedRuntimeBoundaryRestartTimeout }, () => {
	it.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY)(
		"真实 TUI 分界经打包 CLI/HTTP 捕获与激活；两个持久阶段跨重启幂等",
		async (testContext) => {
			const binary = process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex";
			const packagedRuntimeCliPath = resolve(process.env.KANBAN_RVF_PACKAGED_RUNTIME_CLI_PATH ?? "dist/cli.js");
			vi.stubEnv("TMPDIR", "/tmp");
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "kanban-rvf-package-",
			});
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "rvf-packaged-runtime" });
			const cwd = repository.repositoryPath;
			await writeFile(join(cwd, "implementation.txt"), "待审实现\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const codexHome = join(fixture.fixtureRootDirectoryPath, "c");
			const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf");
			const nativeFixture = spawnSync(
				"python3",
				[
					resolve("test/integration/fixtures/codex-native-review-start-boundary-and-rewind.py"),
					fixture.fixtureRootDirectoryPath,
					cwd,
					process.cwd(),
					process.execPath,
					binary,
					"preserve-review-boundary",
				],
				{
					encoding: "utf8",
					timeout: 75_000,
					maxBuffer: 2 * 1024 * 1024,
					env: fixture.createIsolatedChildProcessEnvironment(),
				},
			);
			expect(nativeFixture.status, nativeFixture.stdout + nativeFixture.stderr).toBe(0);
			const token = "0123456789abcdef";
			const taskId = "synthetic-native-task";
			const receipt = rvfIndependentUserTurnBoundaryReceiptSchema.parse(
				JSON.parse(
					await readFile(
						join(rvfHome, "review-start-independent-user-turn-boundary-receipts", `${token}.json`),
						"utf8",
					),
				),
			);
			const nativeId = receipt.session_id;
			const boundaryTurn = receipt.native_turn_id;
			const transcriptPath = receipt.transcript_path;
			const timestamp = new Date().toISOString();
			const records: unknown[] = (await readFile(transcriptPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const nativeTurns = await withCodexAppServerRequestConnection(
				{
					workingDirectory: cwd,
					binary,
					environment: fixture.createIsolatedChildProcessEnvironment({ CODEX_HOME: codexHome }),
				},
				(port) => readCodexConversationTurns(port, nativeId),
			);
			const implementationTurn = nativeTurns.at(-2)?.id;
			expect(implementationTurn).toBeTruthy();
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
			const workspace = await loadWorkspaceContext(cwd);
			await mutateWorkspaceState(cwd, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: addTaskToColumn(
					state.board,
					"review",
					{
						taskId,
						prompt: "待审实现",
						startInPlanMode: false,
						baseRef: "main",
						worktreeMode: "inplace",
					},
					() => taskId,
				).board,
				value: null,
			}));
			await writeFile(
				join(getWorkspaceDirectoryPath(workspace.workspaceId), "sessions.json"),
				JSON.stringify({
					[taskId]: {
						taskId,
						state: "awaiting_review",
						turnOwner: "user",
						liveness: "exited",
						userTurnKind: "review",
						agentId: "codex",
						workspacePath: cwd,
						pid: null,
						startedAt: 1,
						updatedAt: 1,
						lastOutputAt: 1,
						lastHookAt: null,
						latestHookActivity: null,
						reviewReason: "hook",
						exitCode: 0,
						agentNativeConversationSessionIdentity: {
							sourceAgentId: "codex",
							nativeSessionId: nativeId,
							transcriptPath,
							observedAt: 1,
						},
					},
				}),
			);
			vi.unstubAllEnvs();
			const start = async () => {
				const process_ = children.register(
					spawn(process.execPath, [packagedRuntimeCliPath, "--port", "auto", "--no-open"], {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						env: fixture.createIsolatedChildProcessEnvironment({
							PATH: `${dirname(binary)}:/usr/bin:/bin`,
							CODEX_HOME: codexHome,
							RVF_HOME: rvfHome,
							KANBAN_RUNTIME_PORT: undefined,
							DO_NOT_TRACK: "1",
						}),
					}),
				);
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(process_)).runtimeUrl).origin;
				return {
					process_,
					origin,
					client: createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({
								url: `${origin}/api/trpc`,
								headers: { "x-kanban-workspace-id": workspace.workspaceId },
							}),
						],
					}),
				};
			};
			const invokeTaskCommand = async (origin: string, command: string) => {
				const child = children.register(
					spawn(
						process.execPath,
						[
							packagedRuntimeCliPath,
							"task",
							command,
							"--project-path",
							cwd,
							"--task-id",
							taskId,
							"--decision-token",
							token,
						],
						{
							cwd,
							stdio: ["ignore", "pipe", "pipe"],
							env: fixture.createIsolatedChildProcessEnvironment({
								PATH: `${dirname(binary)}:/usr/bin:/bin`,
								CODEX_HOME: codexHome,
								RVF_HOME: rvfHome,
								KANBAN_RUNTIME_PORT: new URL(origin).port,
								DO_NOT_TRACK: "1",
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
				return { exitCode: child.exitCode, stdout, stderr };
			};
			const initial = await start();
			const firstCommand = await invokeTaskCommand(initial.origin, "capture-rvf-review-start-boundary");
			const first = rvfReviewStartBoundaryResponseSchema.parse(
				await readPackagedBoundaryCaptureCommandResponse(firstCommand, () =>
					initial.client.runtime.captureRvfReviewStartBoundary.mutate({ taskId, decisionToken: token }),
				),
			);
			if (first.status !== "captured") throw new Error(JSON.stringify(first));
			expect(first.receipt).toMatchObject({
				session_id: nativeId,
				native_turn_id: boundaryTurn,
				kanban_task_id: taskId,
			});
			expect((await initial.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId })).records[0]?.status).toBe(
				"captured_review_start_boundary",
			);
			expect(await sigkillChildProcessAndWaitForExit(initial.process_)).toBe(true);
			const resumed = await start();
			const status = await resumed.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId });
			expect(status.records).toHaveLength(1);
			expect(status.records[0]).toMatchObject({
				status: "captured_review_start_boundary",
				preReviewTurnIds: [implementationTurn],
			});
			await writeFile(
				transcriptPath,
				`${records.map((record) => JSON.stringify(record)).join("\n")}\n${JSON.stringify({ type: "event_msg", timestamp, payload: { type: "user_message", message: "bootstrap 已经开始" } })}\n`,
			);
			const retry = await invokeTaskCommand(resumed.origin, "capture-rvf-review-start-boundary");
			expect(retry.exitCode, retry.stderr).toBe(0);
			expect(JSON.parse(retry.stdout)).toEqual(first);
			await expect(
				resumed.client.runtime.activateRvfAutomaticCloseoutAfterRunBinding.mutate({ taskId, decisionToken: token }),
			).rejects.toThrow();
			expect((await resumed.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId })).records).toEqual(
				status.records,
			);
			const run = join(rvfHome, "run-logs", "runs", "bound-native-run");
			await mkdir(join(run, "inputs"), { recursive: true });
			await writeFile(
				join(run, "inputs", "automatic-closeout-review-start-receipt.json"),
				JSON.stringify(first.receipt),
			);
			const canonicalReceipt = Object.fromEntries(
				Object.entries(first.receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			);
			await writeFile(
				join(rvfHome, "review-start-independent-user-turn-boundary-receipts", `${token}.run-binding.json`),
				JSON.stringify({
					run_id: "bound-native-run",
					run_dir: run,
					receipt_sha256: computeRvfTextSha256(JSON.stringify(canonicalReceipt)),
				}),
			);
			const activation = await invokeTaskCommand(
				resumed.origin,
				"activate-rvf-automatic-closeout-after-run-binding",
			);
			expect(activation.exitCode, activation.stderr).toBe(0);
			expect(JSON.parse(activation.stdout)).toEqual({ receipt: first.receipt });
			const active = (await resumed.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId })).records[0];
			expect(active).toMatchObject({
				status: "awaiting_rvf_completion",
				runId: "bound-native-run",
				runDirectory: run,
				receipt: first.receipt,
				preReviewTurnIds: [implementationTurn],
			});
			expect(await sigkillChildProcessAndWaitForExit(resumed.process_)).toBe(true);
			const activatedRestart = await start();
			expect(
				(await activatedRestart.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId })).records[0],
			).toMatchObject(active ?? {});
			const repeated = await invokeTaskCommand(
				activatedRestart.origin,
				"activate-rvf-automatic-closeout-after-run-binding",
			);
			expect(repeated.exitCode, repeated.stderr).toBe(0);
			expect(JSON.parse(repeated.stdout)).toEqual({ receipt: first.receipt });
			const afterRepeat = (await activatedRestart.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId }))
				.records[0];
			expect(afterRepeat).toMatchObject({
				status: "awaiting_rvf_completion",
				updatedAt: active?.updatedAt,
				restoredNativeSessionId: null,
			});
		},
	);
});
