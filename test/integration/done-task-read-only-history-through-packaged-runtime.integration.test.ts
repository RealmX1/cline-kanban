import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe(
	"Done 会话历史的真实打包运行时",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 1,
			testBodyTimeoutBudgetMs: 30_000,
		}),
	},
	() => {
		it("工作树已删除时可分页读取主会话和侧会话，跨项目不串内容且不改任务、会话与队列", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "done-history-project",
				initialBranchName: "main",
			});
			await writeFile(join(repository.repositoryPath, "README.md"), "隔离的历史浏览验证");
			repository.commitAllRepositoryFilesAtDate({
				message: "建立隔离测试仓库",
				authorAndCommitterIsoDate: "2026-10-23T00:00:00Z",
			});
			const workspace = await loadWorkspaceContext(repository.repositoryPath);
			const foreignRepository = fixture.createNonBareRepository({
				repositoryDirectoryName: "other-history-project",
				initialBranchName: "main",
			});
			const foreignWorkspace = await loadWorkspaceContext(foreignRepository.repositoryPath);
			const taskId = "completed-task";
			const mainSessionId = "main-after-handover";
			const sideSessionId = "side-session";
			const foreignSessionId = "foreign-session-with-same-task-id";
			const board: RuntimeBoardData = {
				columns: [
					{
						id: "trash",
						title: "Done",
						cards: [
							{
								id: taskId,
								title: "已完成的真实持久任务",
								prompt: "保留完整工作台",
								agentId: "codex",
								mainTaskConversationSessionId: mainSessionId,
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			};
			const deletedWorktreePath = join(
				fixture.isolatedHomeDirectoryPath,
				".cline/worktrees",
				taskId,
				"done-history-project",
			);
			const sessions: Record<string, RuntimeTaskSessionSummary> = {};
			for (const sessionId of [mainSessionId, sideSessionId, foreignSessionId]) {
				const transcriptPath = join(fixture.fixtureRootDirectoryPath, `${sessionId}.jsonl`);
				const records = [
					{ type: "session_meta", payload: { id: sessionId } },
					...Array.from({ length: sessionId === mainSessionId ? 105 : 1 }, (_, index) => ({
						type: "response_item",
						payload: {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: `${sessionId} 回答 ${index}` }],
						},
					})),
				];
				await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
				sessions[sessionId] = {
					taskId: sessionId,
					agentId: "codex",
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					workspacePath:
						sessionId === foreignSessionId
							? join(fixture.isolatedHomeDirectoryPath, ".cline/worktrees", taskId, "other-history-project")
							: deletedWorktreePath,
					pid: null,
					startedAt: 1,
					updatedAt: 1,
					lastOutputAt: 1,
					lastHookAt: null,
					latestHookActivity: null,
					reviewReason: null,
					exitCode: 0,
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: sessionId,
						transcriptPath,
						observedAt: 1,
					},
					taskConversationSessionMetadata: {
						workspaceTaskId: taskId,
						taskConversationSessionRole: sessionId === mainSessionId ? "main" : "by_the_way",
						taskConversationSessionContextSource: sessionId === mainSessionId ? "main" : "started_from_scratch",
						parentTaskConversationSessionId: sessionId === mainSessionId ? null : mainSessionId,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
				};
			}
			const workspaceDirectory = getWorkspaceDirectoryPath(workspace.workspaceId);
			await mkdir(workspaceDirectory, { recursive: true });
			await mkdir(getWorkspaceDirectoryPath(foreignWorkspace.workspaceId), { recursive: true });
			const boardPath = join(workspaceDirectory, "board.json");
			const sessionsPath = join(workspaceDirectory, "sessions.json");
			await writeFile(boardPath, JSON.stringify(board));
			await writeFile(sessionsPath, JSON.stringify(sessions));
			await writeFile(
				join(getWorkspaceDirectoryPath(foreignWorkspace.workspaceId), "board.json"),
				JSON.stringify(board),
			);
			const packagedDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-packaged-runtime");
			await mkdir(join(packagedDirectory, "web-ui", "assets"), { recursive: true });
			await writeFile(join(packagedDirectory, "package.json"), JSON.stringify({ type: "module" }));
			await writeFile(join(packagedDirectory, "web-ui/index.html"), "<!doctype html><title>Done 历史验证</title>");
			await symlink(resolve("node_modules"), join(packagedDirectory, "node_modules"), "dir");
			for (const worker of [
				"notifications/notification-lifecycle-database-worker.mjs",
				"inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
			]) {
				await copyFile(resolve("src", worker), join(packagedDirectory, worker.split("/").at(-1) ?? ""));
			}
			const packagedCliPath = join(packagedDirectory, "cli.js");
			await build({
				entryPoints: [resolve("src/cli.ts")],
				outfile: packagedCliPath,
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				external: ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"],
				define: { "process.env.NODE_ENV": '"production"' },
				banner: {
					js: 'import { createRequire as createDoneHistoryRequire } from "node:module"; const require = createDoneHistoryRequire(import.meta.url);',
				},
			});
			const child = children.register(
				spawn(
					process.execPath,
					[packagedCliPath, "--host", "127.0.0.1", "--port", "auto", "--no-open", "--skip-shutdown-cleanup"],
					{
						cwd: repository.repositoryPath,
						stdio: ["ignore", "pipe", "pipe"],
						env: fixture.createIsolatedChildProcessEnvironment({
							PATH: "/usr/bin:/bin",
							KANBAN_RUNTIME_PORT: undefined,
							DO_NOT_TRACK: "1",
						}),
					},
				),
			);
			try {
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				const client = (workspaceId: string) =>
					createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({
								url: `${origin}/api/trpc`,
								headers: { "x-kanban-workspace-id": workspaceId },
							}),
						],
					});
				const api = client(workspace.workspaceId);
				// 启动水合可能清理旧条目，查询前重新注入真实 sessions.json，覆盖历史串写且卡号相同的场景。
				await writeFile(sessionsPath, JSON.stringify(sessions));
				const beforeBoard = await readFile(boardPath, "utf8");
				const beforeSessions = await readFile(sessionsPath, "utf8");
				const beforeQueue = await api.runtime.getTaskPromptDeliveryQueue.query({});
				const latest = await api.runtime.getTaskConversationHistoryPage.query({
					workspaceTaskId: taskId,
					taskConversationSessionId: mainSessionId,
				});
				expect(latest.availability).toBe("available");
				expect(latest.messages).toHaveLength(100);
				const older = await api.runtime.getTaskConversationHistoryPage.query({
					workspaceTaskId: taskId,
					taskConversationSessionId: mainSessionId,
					cursor: latest.nextCursor,
				});
				expect([...older.messages, ...latest.messages].map((message) => message.content)).toEqual(
					Array.from({ length: 105 }, (_, index) => `${mainSessionId} 回答 ${index}`),
				);
				const side = await api.runtime.getTaskConversationHistoryPage.query({
					workspaceTaskId: taskId,
					taskConversationSessionId: sideSessionId,
				});
				expect(side.messages[0]?.content).toBe(`${sideSessionId} 回答 0`);
				const foreignSummaryInCurrentWorkspace = await api.runtime.getTaskConversationHistoryPage.query({
					workspaceTaskId: taskId,
					taskConversationSessionId: foreignSessionId,
				});
				expect(foreignSummaryInCurrentWorkspace.availability).toBe("unavailable");
				expect(foreignSummaryInCurrentWorkspace.messages).toEqual([]);
				const foreign = await client(foreignWorkspace.workspaceId).runtime.getTaskConversationHistoryPage.query({
					workspaceTaskId: taskId,
					taskConversationSessionId: mainSessionId,
				});
				expect(foreign.availability).toBe("unavailable");
				expect(foreign.messages).toEqual([]);
				expect(await readFile(boardPath, "utf8")).toBe(beforeBoard);
				expect(await readFile(sessionsPath, "utf8")).toBe(beforeSessions);
				expect(await api.runtime.getTaskPromptDeliveryQueue.query({})).toEqual(beforeQueue);
				expect(existsSync(deletedWorktreePath)).toBe(false);
			} finally {
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			}
		});
	},
);
