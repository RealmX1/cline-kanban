import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as waitForObservationWindow } from "node:timers/promises";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import { createPendingTaskMessageInjectionRecord } from "../../src/core/task-message-injection-ledger";
import { applyQueuedTaskPromptDeliveryMutation } from "../../src/state/queued-task-prompt-delivery-store";
import { getWorkspaceDirectoryPath, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

it.skipIf(!process.env.KANBAN_RETIRED_RVF_HISTORY_PACKAGED_RUNTIME_CLI_PATH)(
	"打包运行时两次冷启动只读旧 RVF 历史，不恢复旧执行、不投递旧消息",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 30_000,
		}),
	},
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "retired-rvf-history" });
		const projectPath = repository.repositoryPath;
		await writeFile(join(projectPath, "README.md"), "保留人工 rewind 与普通任务能力\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立隔离历史验证仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		await writeFile(join(projectPath, "user-work-in-progress.txt"), "用户未提交内容\n");
		const taskId = "abc12";
		await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: {
				columns: [
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: taskId,
								title: "旧历史保留",
								prompt: "只读查询历史",
								baseRef: "main",
								agentId: "codex",
								startInPlanMode: false,
								autoReviewEnabled: false,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			},
			sessions: {},
		});
		const workspace = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: false });
		const workspaceDirectory = getWorkspaceDirectoryPath(workspace.workspaceId);
		const runLogsRoot = join(fixture.fixtureRootDirectoryPath, "historical-run-logs");
		const records = [];
		for (const [index, status] of ["completed", "failed", "in_progress"].entries()) {
			const runId = `historical-${status}`;
			const runDirectory = join(runLogsRoot, "runs", runId);
			await mkdir(join(runDirectory, "artifacts", "inputs"), { recursive: true });
			await writeFile(
				join(runDirectory, "summary.json"),
				JSON.stringify({
					run_id: runId,
					repo: projectPath,
					status,
					timestamp: 10 + index,
				}),
			);
			await writeFile(
				join(runDirectory, "artifacts", "inputs", "scope.contract.json"),
				JSON.stringify({
					run_id: runId,
					repo: projectPath,
					created_at: 10 + index,
					review_candidate_snapshot: {
						kanban_task_id: taskId,
						worktree: projectPath,
						session_id: "original-session",
						decision_token: status,
					},
				}),
			);
			records.push({
				workspaceId: workspace.workspaceId,
				taskId,
				createdAt: 10 + index,
				status,
				runId,
				runDirectory,
				receipt: {
					session_id: "original-session",
					worktree: projectPath,
					kanban_task_id: taskId,
					decision_token: status,
				},
				handoffPath: join(runDirectory, "artifacts", "handoff.md"),
				handoffSha256: "a".repeat(64),
				landExecutionResult: {
					outcome: status === "completed" ? "completed" : "blocked",
					commitSha: "b".repeat(40),
					reportedAt: 20,
				},
				baseBranchSyncExecutionResult: {
					outcome: status === "completed" ? "completed" : "blocked",
					commitSha: "b".repeat(40),
					baseRef: "main",
					reportedAt: 21,
				},
			});
		}
		const historyPath = join(workspaceDirectory, "rvf-automatic-rewind-and-closeout-records.json");
		const queuePath = join(workspaceDirectory, "queued-task-prompt-deliveries.json");
		const ledgerPath = join(workspaceDirectory, "task-message-injections.json");
		const queueSnapshot = applyQueuedTaskPromptDeliveryMutation(
			{ entriesByTaskId: {} },
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId,
				queueEntryId: "old-closeout",
				text: "旧 Land 消息不能再投递",
			},
			10,
		);
		queueSnapshot.entriesByTaskId[taskId][0].programmaticInjectionLedgerReceiptLink = {
			injectionLedgerIdempotencyKey: "old-closeout",
			injectionSource: "rvf_automatic_closeout",
			settledTerminalDeliveryReceipt: null,
		};
		const originals = new Map([
			[historyPath, JSON.stringify([...records, { status: "damaged" }], null, 2)],
			[queuePath, JSON.stringify(queueSnapshot, null, 2)],
			[
				ledgerPath,
				JSON.stringify(
					[
						createPendingTaskMessageInjectionRecord({
							taskId,
							source: "rvf_automatic_closeout",
							idempotencyKey: "old-closeout",
							promptSha256: "old-prompt",
							nowIso: new Date(10).toISOString(),
						}),
					],
					null,
					2,
				),
			],
		]);
		for (const [path, content] of originals) await writeFile(path, content);
		const agentExecutablesDirectory = join(fixture.fixtureRootDirectoryPath, "observed-agent-executables");
		const unexpectedAgentAttemptsPath = join(
			fixture.fixtureRootDirectoryPath,
			"unexpected-agent-execution-attempts.jsonl",
		);
		await mkdir(agentExecutablesDirectory);
		await writeFile(
			join(agentExecutablesDirectory, "codex"),
			`#!${process.execPath}\nconst {appendFileSync}=require('node:fs'); if(process.argv.some(value=>['app-server','resume','fork'].includes(value))) appendFileSync(${JSON.stringify(unexpectedAgentAttemptsPath)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write('codex-cli 0.0.0\\n');\n`,
			{ mode: 0o700 },
		);
		const refsBefore = repository.runGit(["show-ref"]).stdout;
		const cliPath = resolve(process.env.KANBAN_RETIRED_RVF_HISTORY_PACKAGED_RUNTIME_CLI_PATH ?? "dist/cli.js");
		for (let incarnation = 1; incarnation <= 2; incarnation++) {
			const child = children.register(
				spawn(
					process.execPath,
					[cliPath, "--host", "127.0.0.1", "--port", "auto", "--no-open", "--skip-shutdown-cleanup"],
					{
						cwd: projectPath,
						stdio: ["ignore", "pipe", "pipe"],
						env: fixture.createIsolatedChildProcessEnvironment({
							PATH: `${agentExecutablesDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
							CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-configuration"),
							CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-storage"),
							CODEX_RVF_LOG_ROOT: runLogsRoot,
							KANBAN_RVF_INSPECTION_EXECUTABLE_PATH: join(
								fixture.fixtureRootDirectoryPath,
								"must-never-execute",
							),
							KANBAN_RUNTIME_PORT: undefined,
							DO_NOT_TRACK: "1",
						}),
					},
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
			const history = await client.runtime.getTaskRvfHistory.query({ taskId });
			expect(history.hasVerifiedCompletedRvf).toBe(true);
			expect(history.currentCandidateReviewCoverage.status).toBe("unknown");
			expect(history.recentRuns.map((run) => run.completionStatus).sort()).toEqual(
				["completed", "failed", "in_progress"].sort(),
			);
			expect(history.issues.some((issue) => issue.reasonCode === "closeout_record_invalid")).toBe(true);
			for (const procedure of [
				"captureRvfReviewStartBoundary",
				"rvfAutomaticCloseoutStatus",
				"claimRvfAutomaticCloseoutExecutionStage",
			])
				expect((await fetch(`${origin}/api/trpc/runtime.${procedure}`)).status).toBe(404);
			// 观察超过旧服务的两个 2 秒调度周期；这是负向行为观察窗口，不是性能阈值。
			await waitForObservationWindow(4_100);
			await client.runtime.getTaskPromptDeliveryQueue.query({});
			expect(await sigkillChildProcessAndWaitForExit(child)).toBe(true);
			for (const [path, content] of originals) expect(await readFile(path, "utf8")).toBe(content);
			expect(await readFile(unexpectedAgentAttemptsPath, "utf8").catch(() => "")).toBe("");
			expect(repository.runGit(["show-ref"]).stdout).toBe(refsBefore);
			expect(await readFile(join(projectPath, "user-work-in-progress.txt"), "utf8")).toBe("用户未提交内容\n");
		}
	},
);
