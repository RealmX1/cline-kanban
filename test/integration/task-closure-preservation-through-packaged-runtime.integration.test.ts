import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
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
	"结案分类与成果保全的真实打包运行时",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 90_000,
		}),
	},
	() => {
		it("API／CLI 分类一致、旧快照和公开删除不能绕行，归档失败跨重启自动恢复，重开与删卡保留历史", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "closure-e2e-" });
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-home"));
			const repo = fixture.createNonBareRepository({
				repositoryDirectoryName: "closure-project",
				initialBranchName: "main",
			});
			await writeFile(join(repo.repositoryPath, "README.md"), "初始成果\n");
			await writeFile(join(repo.repositoryPath, ".gitignore"), "reports/\n");
			repo.commitAllRepositoryFilesAtDate({
				message: "隔离结案仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const workspace = await loadWorkspaceContext(repo.repositoryPath);
			const board: RuntimeBoardData = {
				columns: [
					{
						id: "review",
						title: "Review",
						cards: ["aa501", "aa502", "aa503", "aa504", "aa505", "aa506", "aa507", "aa509", "aa510"].map(
							(id) => ({
								id,
								title: id,
								prompt: "隔离结案",
								agentId: "codex",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 100,
								updatedAt: 100,
							}),
						),
					},
					{
						id: "trash",
						title: "Done",
						cards: [
							{
								id: "aa508",
								title: "历史未标注",
								prompt: "历史",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 100,
								updatedAt: 100,
							},
						],
					},
				],
			};
			await mkdir(getWorkspaceDirectoryPath(workspace.workspaceId), { recursive: true });
			await writeFile(join(getWorkspaceDirectoryPath(workspace.workspaceId), "board.json"), JSON.stringify(board));
			const source = await ensureTaskWorktreeIfDoesntExist({
				cwd: repo.repositoryPath,
				taskId: "aa501",
				baseRef: "main",
			});
			if (!source.path) throw new Error(source.error ?? "隔离工作树不可用");
			await writeFile(join(source.path, "README.md"), "暂存成果\n");
			repo.runGit(["add", "README.md"], { workingDirectoryPath: source.path });
			await writeFile(join(source.path, "README.md"), "工作区成果\n");
			const recovering = await ensureTaskWorktreeIfDoesntExist({
				cwd: repo.repositoryPath,
				taskId: "aa506",
				baseRef: "main",
			});
			if (!recovering.path) throw new Error(recovering.error ?? "隔离工作树不可用");
			const packagedDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-packaged-runtime");
			await mkdir(join(packagedDirectory, "web-ui", "assets"), { recursive: true });
			await writeFile(
				join(packagedDirectory, "web-ui", "index.html"),
				"<!doctype html><title>隔离 API 验证</title>",
			);
			await writeFile(join(packagedDirectory, "package.json"), '{"type":"module"}');
			await symlink(resolve("node_modules"), join(packagedDirectory, "node_modules"), "dir");
			for (const worker of [
				"notifications/notification-lifecycle-database-worker.mjs",
				"inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
			])
				await copyFile(resolve("src", worker), join(packagedDirectory, worker.split("/").at(-1) ?? ""));
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
					js: 'import { createRequire as createClosureTestRequire } from "node:module"; const require = createClosureTestRequire(import.meta.url);',
				},
			});
			const fakeAgentDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-fake-native-agent");
			await mkdir(fakeAgentDirectory);
			await writeFile(
				join(fakeAgentDirectory, "codex"),
				`#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('codex-cli 0.164.0\\n')}else{process.stdout.write('隔离 Agent 已就绪\\n');process.stdin.resume();setInterval(()=>{},1000)}\n`,
			);
			await chmod(join(fakeAgentDirectory, "codex"), 0o755);
			const isolatedEnvironment = fixture.createIsolatedChildProcessEnvironment({
				PATH: `${fakeAgentDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
				CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-home"),
				CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite"),
				KANBAN_RUNTIME_PORT: undefined,
				DO_NOT_TRACK: "1",
			});
			const startRuntime = async () => {
				const child = children.register(
					spawn(
						process.execPath,
						[packagedCliPath, "--host", "127.0.0.1", "--port", "auto", "--no-open", "--skip-shutdown-cleanup"],
						{ cwd: repo.repositoryPath, env: isolatedEnvironment, stdio: ["ignore", "pipe", "pipe"] },
					),
				);
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
				const client = createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpBatchLink({
							url: `${origin}/api/trpc`,
							headers: { "x-kanban-workspace-id": workspace.workspaceId },
						}),
					],
				});
				return { child, origin, client };
			};
			let runtime = await startRuntime();
			const cliPreservationWorktree = await runtime.client.workspace.ensureWorktree.mutate({
				taskId: "aa510",
				baseRef: "main",
			});
			if (!cliPreservationWorktree.path) throw new Error("CLI 保全测试工作树缺失");
			await mkdir(join(cliPreservationWorktree.path, "reports"));
			await writeFile(
				join(cliPreservationWorktree.path, "reports", "accepted-ignored.md"),
				"CLI 显式选择的 ignored 成果",
			);
			const preservationCli = children.register(
				spawn(
					process.execPath,
					[
						packagedCliPath,
						"task",
						"done",
						"--task-id",
						"aa510",
						"--preserve-path",
						"reports/accepted-ignored.md",
					],
					{
						cwd: repo.repositoryPath,
						env: {
							...isolatedEnvironment,
							KANBAN_RUNTIME_HOST: "127.0.0.1",
							KANBAN_RUNTIME_PORT: new URL(runtime.origin).port,
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				),
			);
			preservationCli.stdout?.resume();
			preservationCli.stderr?.resume();
			expect(
				await new Promise<number | null>((resolveExit, reject) => {
					preservationCli.once("error", reject);
					preservationCli.once("exit", resolveExit);
				}),
			).toBe(0);
			const cliPreservationHistory = await runtime.client.taskCardAction.readTaskClosureHistory.query({
				taskId: "aa510",
				expectedTaskIncarnationCreatedAtEpochMs: 100,
			});
			const cliArchive = cliPreservationHistory.records[0]?.archiveManifest;
			expect(cliArchive?.selectedArtifactRelativePaths).toEqual(["reports/accepted-ignored.md"]);
			expect(
				await readFile(
					join(cliArchive?.archiveDirectory ?? "", "working-files", "reports", "accepted-ignored.md"),
					"utf8",
				),
			).toBe("CLI 显式选择的 ignored 成果");
			expect(existsSync(cliPreservationWorktree.path)).toBe(false);
			const close = (
				taskId: string,
				outcome: "delivery_accepted" | "plan_retired" | "implementation_unnecessary" | "cancelled_by_user",
				requestId: string,
			) =>
				runtime.client.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
					taskId,
					expectedTaskIncarnationCreatedAtEpochMs: 100,
					closure: {
						closureRequestId: requestId,
						details: {
							outcome,
							reason: "隔离验证",
							authorizationSource: outcome === "cancelled_by_user" ? "本用例明确取消" : undefined,
						},
					},
				});
			const retired = await close("aa501", "plan_retired", "11111111-1111-4111-8111-111111111111");
			expect(retired.closureRecord?.archiveManifest.availability).toBe("verified_recoverable");
			expect(retired.taskWorktreeDeletionResult?.taskWorktreeDeletionErrorMessage).toBeNull();
			expect(existsSync(source.path)).toBe(false);
			const rejectedStarts = [
				await runtime.client.runtime.startTaskSession.mutate({
					taskId: "aa501",
					prompt: "不得启动",
					baseRef: "main",
				}),
				await runtime.client.runtime.refreshTaskTerminal.mutate({ taskId: "aa501" }),
				await runtime.client.runtime.startShellSession.mutate({
					taskId: "__detail_terminal__:aa501",
					workspaceTaskId: "aa501",
					baseRef: "main",
				}),
			];
			for (const result of rejectedStarts)
				expect(result).toMatchObject({ ok: false, error: expect.stringContaining("先重新打开") });
			expect(existsSync(source.path)).toBe(false);
			await close("aa502", "delivery_accepted", "22222222-2222-4222-8222-222222222222");
			await close("aa503", "implementation_unnecessary", "33333333-3333-4333-8333-333333333333");
			await close("aa504", "cancelled_by_user", "44444444-4444-4444-8444-444444444444");
			const merged =
				await runtime.client.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
					taskId: "aa505",
					closure: {
						closureRequestId: "55555555-5555-4555-8555-555555555555",
						details: {
							outcome: "merged_into_successor_task",
							reason: "由未结案任务承接",
							successorTask: {
								workspaceId: workspace.workspaceId,
								taskId: "aa507",
								taskIncarnationCreatedAtEpochMs: 100,
							},
						},
					},
				});
			expect(merged.closureRecord?.details.successorTask?.taskId).toBe("aa507");
			await expect(runtime.client.workspace.deleteWorktree.mutate({ taskId: "aa506" })).rejects.toThrow("归档凭据");
			const snapshot = await runtime.client.workspace.getState.query();
			const forged = structuredClone(snapshot.board);
			const completed = forged.columns.find((column) => column.id === "trash");
			if (!completed) throw new Error("缺少已结案列");
			for (const card of completed.cards) {
				card.taskClosureSummary = undefined;
			}
			const saved = await runtime.client.workspace.saveState.mutate({
				board: forged,
				sessions: snapshot.sessions,
				expectedRevision: snapshot.revision,
			});
			expect(
				saved.board.columns.find((column) => column.id === "trash")?.cards.find((card) => card.id === "aa501")
					?.taskClosureSummary?.details.outcome,
			).toBe("plan_retired");
			await expect(
				runtime.client.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
					taskId: "aa506",
					closure: {
						closureRequestId: "66666666-6666-4666-8666-666666666666",
						details: { outcome: "plan_retired", reason: "保全后退役" },
						selectedArtifactRelativePaths: ["reports/accepted.md"],
					},
				}),
			).rejects.toThrow("成果保全失败");
			expect(existsSync(recovering.path)).toBe(true);
			const deleteRecovery = await ensureTaskWorktreeIfDoesntExist({
				cwd: repo.repositoryPath,
				taskId: "aa509",
				baseRef: "main",
			});
			if (!deleteRecovery.path) throw new Error("永久删除恢复工作树不可用");
			await writeFile(join(deleteRecovery.path, "README.md"), "任务侧冲突内容\n");
			repo.runGit(["add", "README.md"], { workingDirectoryPath: deleteRecovery.path });
			repo.runGit(["commit", "-m", "任务侧提交"], { workingDirectoryPath: deleteRecovery.path });
			repo.runGit(["branch", "conflicting-preservation-fixture"]);
			repo.runGit(["switch", "conflicting-preservation-fixture"]);
			await writeFile(join(repo.repositoryPath, "README.md"), "另一侧冲突内容\n");
			repo.commitAllRepositoryFilesAtDate({
				message: "另一侧提交",
				authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
			});
			repo.runGit(["merge", "--no-edit", "conflicting-preservation-fixture"], {
				workingDirectoryPath: deleteRecovery.path,
				expectedExitCodes: [1],
			});
			await expect(
				runtime.client.taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup.mutate({
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: ["aa509"],
					},
				}),
			).rejects.toThrow("成果保全失败");
			// 旧 reopened 摘要不能撤销后来新授权的结案或永久删除操作。
			const secondClosureRequestId = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF";
			const reopenedPaths: Record<string, string> = {};
			for (const taskId of ["aa502", "aa503"]) {
				const reopened =
					await runtime.client.taskCardAction.restoreTaskCardFromDoneIntoReviewResumingAgentSession.mutate({
						taskId,
					});
				expect(reopened.taskCardRestoreFromDoneOutcome).toBe("agent_session_resumed_and_task_card_kept_in_review");
				const path = await runtime.client.workspace.ensureWorktree.mutate({ taskId, baseRef: "main" });
				if (!path.path) throw new Error("重开测试工作树缺失");
				reopenedPaths[taskId] = path.path;
			}
			await expect(
				runtime.client.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
					taskId: "aa502",
					closure: {
						closureRequestId: secondClosureRequestId,
						details: { outcome: "delivery_accepted" },
						selectedArtifactRelativePaths: ["reports/second-closure.md"],
					},
				}),
			).rejects.toThrow("成果保全失败");
			const deleteRecoveryGitMetadataPath = join(reopenedPaths.aa503, ".git");
			const deleteRecoveryGitMetadata = await readFile(deleteRecoveryGitMetadataPath);
			await rm(deleteRecoveryGitMetadataPath);
			await expect(
				runtime.client.taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup.mutate({
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: ["aa503"],
					},
				}),
			).rejects.toThrow("成果保全失败");
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			await mkdir(join(reopenedPaths.aa502, "reports"));
			await writeFile(join(reopenedPaths.aa502, "reports", "second-closure.md"), "重开之后再次结案的成果");
			await writeFile(deleteRecoveryGitMetadataPath, deleteRecoveryGitMetadata);
			repo.runGit(["merge", "--abort"], { workingDirectoryPath: deleteRecovery.path });
			await mkdir(join(recovering.path, "reports"));
			await writeFile(join(recovering.path, "reports", "accepted.md"), "重启后可恢复成果");
			runtime = await startRuntime();
			await vi.waitFor(
				async () => {
					const history = await runtime.client.taskCardAction.readTaskClosureHistory.query({
						taskId: "aa502",
						expectedTaskIncarnationCreatedAtEpochMs: 100,
					});
					expect(
						history.operations.find((operation) => operation.closureRequestId === secondClosureRequestId)?.phase,
					).toBe("completed");
					expect(history.records.map((record) => record.eventKind)).toEqual(["closed", "reopened", "closed"]);
					const deleted = await runtime.client.taskCardAction.readTaskCardWithBoardColumn.query({
						taskId: "aa503",
					});
					expect(deleted.taskCardLookupOutcome).toBe("task_card_not_found_on_workspace_board");
				},
				{ timeout: 30_000, interval: 100 },
			);
			await vi.waitFor(
				async () => {
					const current = await runtime.client.taskCardAction.readTaskCardWithBoardColumn.query({
						taskId: "aa506",
					});
					expect(
						current.taskCardLookupOutcome === "task_card_found_on_workspace_board" &&
							current.taskCardSnapshot.boardColumnIdContainingTaskCard,
					).toBe("trash");
				},
				{ timeout: 15_000, interval: 100 },
			);
			await vi.waitFor(
				async () => {
					const deleted = await runtime.client.taskCardAction.readTaskCardWithBoardColumn.query({
						taskId: "aa509",
					});
					expect(deleted.taskCardLookupOutcome).toBe("task_card_not_found_on_workspace_board");
				},
				{ timeout: 15_000, interval: 100 },
			);
			expect((await runtime.client.workspace.ensureWorktree.mutate({ taskId: "aa501", baseRef: "main" })).ok).toBe(
				false,
			);
			expect(existsSync(source.path)).toBe(false);
			const reopened =
				await runtime.client.taskCardAction.restoreTaskCardFromDoneIntoReviewResumingAgentSession.mutate({
					taskId: "aa501",
					expectedTaskIncarnationCreatedAtEpochMs: 100,
				});
			expect(reopened.taskCardRestoreFromDoneOutcome).toBe("agent_session_resumed_and_task_card_kept_in_review");
			await expect(
				runtime.client.workspace.deleteWorktree.mutate({
					taskId: "aa501",
					taskClosureArchiveCleanupCredential: {
						closureRequestId: "11111111-1111-4111-8111-111111111111",
						taskIncarnationCreatedAtEpochMs: 100,
					},
				}),
			).rejects.toThrow("失效");
			expect(await readFile(join(source.path, "README.md"), "utf8")).toBe("工作区成果\n");
			expect(repo.runGit(["show", ":README.md"], { workingDirectoryPath: source.path }).stdout).toBe("暂存成果\n");
			await expect(
				runtime.client.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
					taskId: "aa501",
					closure: {
						closureRequestId: "11111111-1111-4111-8111-111111111111",
						details: { outcome: "plan_retired", reason: "隔离验证" },
					},
				}),
			).rejects.toThrow("重开");
			const cli = children.register(
				spawn(
					process.execPath,
					[
						packagedCliPath,
						"task",
						"close",
						"--task-id",
						"aa508",
						"--project-path",
						repo.repositoryPath,
						"--outcome",
						"delivery_accepted",
						"--correct-existing",
					],
					{
						cwd: repo.repositoryPath,
						env: {
							...isolatedEnvironment,
							KANBAN_RUNTIME_HOST: "127.0.0.1",
							KANBAN_RUNTIME_PORT: new URL(runtime.origin).port,
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				),
			);
			let output = "";
			cli.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			const cliExit = await new Promise<number | null>((resolveExit, reject) => {
				cli.once("error", reject);
				cli.once("exit", resolveExit);
			});
			expect(cliExit).toBe(0);
			expect(JSON.parse(output).closureRecord.details.outcome).toBe("delivery_accepted");
			await runtime.client.taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup.mutate({
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
					selectedTaskIds: ["aa501"],
				},
			});
			const history = await runtime.client.taskCardAction.readTaskClosureHistory.query({
				taskId: "aa501",
				expectedTaskIncarnationCreatedAtEpochMs: 100,
			});
			expect(history.records.map((record) => record.eventKind)).toEqual(["closed", "reopened"]);
			expect(existsSync(retired.closureRecord?.archiveManifest.archiveDirectory ?? "")).toBe(true);
		});
	},
);
