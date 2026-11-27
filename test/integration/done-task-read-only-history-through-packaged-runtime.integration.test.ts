import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compress } from "zstd-stream";
import { encodeClaudeProjectDirectoryName } from "../../src/agent-session-history/bounded-agent-transcript-reader";
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
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 30_000,
		}),
	},
	() => {
		it("工作树已删除时可分页读取主会话和侧会话，跨项目不串内容且不改任务、会话与队列", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "knh-" });
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
			const legacyTaskId = "legacy-task";
			const legacyNativeSessionId = "9a378e6f-c46c-47ce-b150-e9c455a1f610";
			const isolatedWorktreeParentDirectoryPath = join(
				fixture.isolatedHomeDirectoryPath,
				".cline/worktrees",
				legacyTaskId,
			);
			await mkdir(isolatedWorktreeParentDirectoryPath, { recursive: true });
			const { worktreePath: legacyWorktree } = repository.createLinkedWorktree({
				isolatedWorktreeParentDirectoryPath,
				worktreeDirectoryName: "done-history-project",
				branchName: "legacy-history-test",
			});
			const legacyCard = {
				...board.columns[0].cards[0],
				id: legacyTaskId,
				mainTaskConversationSessionId: undefined,
				agentId: "claude" as const,
			};
			board.columns[0].cards.push(legacyCard);
			sessions[legacyTaskId] = {
				...sessions[mainSessionId],
				taskId: legacyTaskId,
				agentId: "claude",
				workspacePath: null,
				taskConversationSessionMetadata: undefined,
				agentNativeConversationSessionIdentity: undefined,
			};
			const legacyProject = join(
				fixture.isolatedHomeDirectoryPath,
				".claude/projects",
				encodeClaudeProjectDirectoryName(legacyWorktree),
			);
			await mkdir(legacyProject, { recursive: true });
			const legacyTranscript = join(legacyProject, `${legacyNativeSessionId}.jsonl`);
			await writeFile(
				legacyTranscript,
				`${JSON.stringify({
					type: "user",
					sessionId: legacyNativeSessionId,
					cwd: legacyWorktree,
					timestamp: new Date(1).toISOString(),
					promptSource: "typed",
					parentUuid: null,
					message: { role: "user", content: legacyCard.prompt },
				})}\n`,
			);
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
			const startRuntime = () =>
				children.register(
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
			let child = startRuntime();
			try {
				let origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				const client = (workspaceId: string) =>
					createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({
								url: `${origin}/api/trpc`,
								headers: { "x-kanban-workspace-id": workspaceId },
							}),
						],
					});
				let api = client(workspace.workspaceId);
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
				const readLegacyTask = () =>
					api.runtime.getTaskConversationHistoryPage.query({
						workspaceTaskId: legacyTaskId,
						taskConversationSessionId: legacyTaskId,
						transcriptReadConsistency: "stable_snapshot",
					});
				const firstLegacyRead = await readLegacyTask();
				expect(firstLegacyRead.nativeHistoryLookup?.status).toMatch(/scanning|verified/u);
				await expect.poll(async () => (await readLegacyTask()).nativeHistorySource).toBe("verified_read_only");
				expect((await readLegacyTask()).messages.map((message) => message.content)).toEqual([legacyCard.prompt]);
				const runAudit = (extraArguments: string[] = []) => {
					const audit = spawnSync(
						process.execPath,
						[
							packagedCliPath,
							"task",
							"audit-native-history",
							"--project-path",
							repository.repositoryPath,
							"--task-id",
							legacyTaskId,
							"--task-id",
							legacyTaskId,
							...extraArguments,
						],
						{
							encoding: "utf8",
							timeout: 10_000,
							env: fixture.createIsolatedChildProcessEnvironment({ PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1" }),
						},
					);
					expect(audit.stderr).not.toContain("Error");
					expect(audit.status).toBe(0);
					return JSON.parse(audit.stdout);
				};
				const audit = runAudit();
				expect(audit.rows).toHaveLength(1);
				expect(audit.rows[0].nativeHistory).toMatchObject({
					readOnlyBinding: "verified_worktree_and_initial_prompt",
					messageCount: 1,
				});
				expect(JSON.stringify(audit)).not.toContain(legacyCard.prompt);

				const archiveIdentity = {
					sourceWorkspaceId: workspace.workspaceId,
					sourceTaskId: legacyTaskId,
					sourceTaskIncarnationCreatedAtEpochMs: legacyCard.createdAt,
					sourceConversationSessionId: legacyTaskId,
					sourceAgentId: "claude",
				};
				const digest = (value: string) => createHash("sha256").update(value).digest("hex");
				const archivedMessages = JSON.stringify([
					{ id: "archive-message", role: "assistant", content: "归档正文", createdAt: 1 },
				]);
				const archiveText = JSON.stringify({
					schemaVersion: 1,
					...archiveIdentity,
					availability: "partial",
					sourceNativeSessionId: null,
					capturedAtEpochMs: 2,
					pageDigests: [digest(archivedMessages)],
					gaps: [{ source: "fixture", reason: "旧分段缺失", retryCondition: "分段出现后重验" }],
				});
				const archiveRoot = join(fixture.fixtureRootDirectoryPath, "isolated-archive");
				const archiveDirectory = join(archiveRoot, digest(archiveText));
				await mkdir(archiveDirectory, { recursive: true });
				await writeFile(join(archiveDirectory, "archive.json"), archiveText);
				const archivePagePath = join(archiveDirectory, "0.json");
				await writeFile(archivePagePath, archivedMessages);
				const sourceManifest = join(archiveRoot, "trusted-source.json");
				await writeFile(
					sourceManifest,
					JSON.stringify({
						schemaVersion: 1,
						sourceInstanceId: "source-fixture",
						sessions: [{ ...archiveIdentity, archiveDigest: digest(archiveText) }],
					}),
				);
				const archiveArguments = [
					"--archive-directory",
					archiveRoot,
					"--archive-source-manifest",
					sourceManifest,
					"--archive-source-instance-id",
					"source-fixture",
					"--include-archive-messages",
				];
				expect(runAudit(archiveArguments).rows[0].archive).toMatchObject({
					status: "partial",
					verifiedPageCount: 1,
					messages: [{ content: "归档正文" }],
				});
				await writeFile(archivePagePath, "损坏");
				expect(runAudit(archiveArguments).rows[0].archive).toMatchObject({ status: "unverified" });
				expect(await readFile(boardPath, "utf8")).toBe(beforeBoard);
				expect(await readFile(sessionsPath, "utf8")).toBe(beforeSessions);
				expect(await api.runtime.getTaskPromptDeliveryQueue.query({})).toEqual(beforeQueue);
				expect(existsSync(deletedWorktreePath)).toBe(false);
				// 浏览器持有的逻辑游标要跨过真实运行时进程重启与原生格式转换。
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
				const mainTranscriptPath = sessions[mainSessionId]?.agentNativeConversationSessionIdentity?.transcriptPath;
				if (!mainTranscriptPath) throw new Error("缺少主会话转录绑定");
				await writeFile(`${mainTranscriptPath}.zst`, await compress(await readFile(mainTranscriptPath)));
				await unlink(mainTranscriptPath);
				child = startRuntime();
				origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				api = client(workspace.workspaceId);
				const persistedBeforeRead = await readFile(sessionsPath, "utf8");
				const resumedOlder = await api.runtime.getTaskConversationHistoryPage.query({
					workspaceTaskId: taskId,
					taskConversationSessionId: mainSessionId,
					cursor: latest.nextCursor,
				});
				expect(resumedOlder.availability).toBe("available");
				expect(resumedOlder.messages).toEqual(older.messages);
				await expect.poll(async () => (await readLegacyTask()).nativeHistorySource).toBe("verified_read_only");
				expect(await readFile(sessionsPath, "utf8")).toBe(persistedBeforeRead);
				expect(existsSync(deletedWorktreePath)).toBe(false);
			} finally {
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			}
		});
	},
);
