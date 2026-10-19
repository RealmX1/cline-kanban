import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { getWorkspaceDirectoryPath, loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	vi.unstubAllEnvs();
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
});
describe("RVF 开审分界的打包态宿主与进程重启", { timeout: 90_000 }, () => {
	it.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY)(
		"真实 Codex 捕获凭据经 tRPC 写盘；重启后幂等复用；不发模型请求",
		async () => {
			const binary = process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex";
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "rvf-packaged-runtime" });
			const cwd = repository.repositoryPath;
			await writeFile(join(cwd, "implementation.txt"), "待审实现\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const codexHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
			const rvfHome = join(fixture.isolatedHomeDirectoryPath, ".rvf");
			const sessionDirectory = join(codexHome, "sessions", "2026", "10", "18");
			await mkdir(sessionDirectory, { recursive: true });
			const nativeId = randomUUID();
			const implementationTurn = randomUUID();
			const boundaryTurn = randomUUID();
			const token = "0123456789abcdef";
			const taskId = "rvf-closeout-runtime-task";
			const timestamp = new Date().toISOString();
			const records: unknown[] = [
				{
					type: "session_meta",
					timestamp,
					payload: {
						id: nativeId,
						timestamp,
						cwd,
						originator: "codex-tui",
						cli_version: "0.163.0",
						source: "cli",
						model_provider: "openai",
						base_instructions: { text: "隔离分界验收" },
					},
				},
			];
			for (const [turnId, text] of [
				[implementationTurn, "原始实现需求"],
				[boundaryTurn, `RVF 发起决策点 · RVF_DECISION_TOKEN=${token}`],
			]) {
				records.push(
					{
						type: "event_msg",
						timestamp,
						payload: { type: "task_started", turn_id: turnId, model_context_window: 128000 },
					},
					{
						type: "turn_context",
						timestamp,
						payload: {
							turn_id: turnId,
							cwd,
							approval_policy: "never",
							sandbox_policy: { type: "danger-full-access" },
							model: "gpt-6.1",
							effort: "low",
							summary: "none",
						},
					},
					{
						type: "event_msg",
						timestamp,
						payload: { type: "user_message", message: text, images: [], local_images: [], text_elements: [] },
					},
					{
						type: "response_item",
						timestamp,
						payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
					},
					{
						type: "event_msg",
						timestamp,
						payload: { type: "task_complete", turn_id: turnId, last_agent_message: "已完成" },
					},
				);
			}
			const transcriptPath = join(sessionDirectory, `rollout-2026-10-18T23-00-00-${nativeId}.jsonl`);
			await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			const tokenDirectory = join(rvfHome, "agentic-initiation-decision-tokens");
			await mkdir(tokenDirectory, { recursive: true });
			await writeFile(
				join(tokenDirectory, `${token}.json`),
				JSON.stringify({
					token,
					session_id: nativeId,
					worktree: cwd,
					candidate_fingerprint: "candidate",
					state: "injected",
					minted_at: timestamp,
					expires_at: new Date(Date.now() + 120_000).toISOString(),
					candidate_summary: {},
				}),
			);
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
					spawn(process.execPath, [resolve("dist/cli.js"), "--port", "auto", "--no-open"], {
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
			const initial = await start();
			const first = await initial.client.runtime.captureRvfReviewStartBoundary.mutate({
				taskId,
				decisionToken: token,
			});
			expect(first.receipt).toMatchObject({
				session_id: nativeId,
				native_turn_id: boundaryTurn,
				kanban_task_id: taskId,
			});
			expect(await sigkillChildProcessAndWaitForExit(initial.process_)).toBe(true);
			const resumed = await start();
			const status = await resumed.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId });
			expect(status.records).toHaveLength(1);
			expect(status.records[0]).toMatchObject({
				status: "awaiting_rvf_completion",
				preReviewTurnIds: [implementationTurn],
			});
			expect(
				(await resumed.client.runtime.captureRvfReviewStartBoundary.mutate({ taskId, decisionToken: token }))
					.receipt,
			).toEqual(first.receipt);
		},
	);
});
