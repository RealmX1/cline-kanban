import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RvfAutomaticCloseoutRecord } from "../../src/core/rvf-automatic-closeout-contract";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { computeRvfTextSha256 } from "../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import {
	getRvfAutomaticCloseoutStorePath,
	updateRvfAutomaticCloseoutRecords,
} from "../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { loadWorkspaceBoardById, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
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
	vi.unstubAllEnvs();
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

it.skipIf(!process.env.KANBAN_RVF_PACKAGED_RUNTIME_CLI_PATH)(
	"打包态启动与强制重启独立补证手动完成，旧 run 不恢复、不重复投递",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 30_000,
		}),
	},
	async () => {
		const cliPath = resolve(process.env.KANBAN_RVF_PACKAGED_RUNTIME_CLI_PATH ?? "dist/cli.js");
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "kanban-completed-rvf-",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "completed-rvf-project",
			initialBranchName: "main",
		});
		const projectPath = repository.repositoryPath;
		await writeFile(join(projectPath, "implementation.txt"), "开审前\n");
		const originalHead = repository.commitAllRepositoryFilesAtDate({
			message: "开审前",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		await writeFile(join(projectPath, "implementation.txt"), "实际已完成的手动提交\n");
		const landCommit = repository.commitAllRepositoryFilesAtDate({
			message: "手动完成",
			authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
		});
		const workspace = await loadWorkspaceContext(projectPath);
		const taskId = "abc12";
		const board = addTaskToColumn(
			await loadWorkspaceBoardById(workspace.workspaceId),
			"review",
			{
				taskId,
				prompt: "已完成旧 run 的隔离重放",
				baseRef: "main",
				worktreeMode: "inplace",
				startInPlanMode: false,
				autoReviewEnabled: false,
			},
			() => taskId,
		).board;
		await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, { board, sessions: {} });
		const runDirectory = join(fixture.fixtureRootDirectoryPath, "historical-rvf-run");
		await mkdir(join(runDirectory, "inputs"), { recursive: true });
		await mkdir(join(runDirectory, "artifacts", "inputs"), { recursive: true });
		const handoffPath = join(runDirectory, "artifacts", "handoff.md");
		await writeFile(handoffPath, "原审查已完成，正式 Land 曾被拒绝\n");
		const handoffSha256 = computeRvfTextSha256(await readFile(handoffPath));
		const token = "0123456789abcdef";
		const receipt: RvfAutomaticCloseoutRecord["receipt"] = {
			schema: "rvf-independent-user-turn-boundary/v1",
			decision_token: token,
			session_id: "historical-native",
			worktree: projectPath,
			native_user_message_id: "boundary-message",
			native_turn_id: "boundary-turn",
			transcript_path: join(runDirectory, "historical-transcript.jsonl"),
			boundary_message_sha256: "a".repeat(64),
			candidate_fingerprint: "historical-candidate",
			worktree_head_commit_sha: originalHead,
			checkpoint_commit: originalHead,
			checkpoint_tree: repository.runGit(["rev-parse", `${originalHead}^{tree}`]).stdout.trim(),
			comparison_base_tip: originalHead,
			comparison_base_ref: "main",
			comparison_base_ref_tip: originalHead,
			source: "explicit_user_command",
			kanban_task_id: taskId,
			idempotency_key: `rvf-decision-point-${token}`,
		};
		await writeFile(
			join(runDirectory, "inputs", "automatic-closeout-review-start-receipt.json"),
			JSON.stringify(receipt),
		);
		await writeFile(
			join(runDirectory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({
				run_id: "historical-run",
				repo: projectPath,
				base_ref: "main",
				created_at: Date.now(),
				review_candidate_snapshot: {
					kanban_task_id: taskId,
					decision_token: token,
					session_id: receipt.session_id,
				},
			}),
		);
		await writeFile(
			join(runDirectory, "artifacts", "after-workspace-snapshot.json"),
			JSON.stringify({
				repo: projectPath,
				head: originalHead,
				path_fingerprints: {
					"implementation.txt": {
						exists: true,
						type: "file",
						sha256: computeRvfTextSha256(await readFile(join(projectPath, "implementation.txt"))),
					},
				},
			}),
		);
		await writeFile(
			join(runDirectory, "artifacts", "manual-land-actual-execution-receipt.json"),
			JSON.stringify({
				schema: "user-authorized-manual-land-actual-execution/v1",
				taskId,
				decisionToken: token,
				runId: "historical-run",
				handoffSha256,
				commitSha: landCommit,
				headBefore: originalHead,
				committedPaths: ["implementation.txt"],
			}),
		);
		const record: RvfAutomaticCloseoutRecord = {
			workspaceId: workspace.workspaceId,
			taskId,
			conversationSessionId: taskId,
			receipt,
			preReviewTurnIds: ["implementation-turn"],
			status: "closeout_prompt_submitted",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runId: "historical-run",
			runDirectory,
			handoffPath,
			handoffSha256,
			restoredNativeSessionId: "historical-restored",
			restoredTranscriptPath: null,
			restoreWorkspaceStateSha256: null,
			nativeIdentitySwitchStartedAt: null,
			nativeForkAttemptStartedAt: null,
			pauseReason: null,
			promptDeliveryIdempotencyKey: `rvf-automatic-closeout-${token}`,
			landExecutionResult: { outcome: "blocked", reason: "保留原正式 Land 拒绝", reportedAt: 1 },
			baseBranchSyncExecutionResult: { outcome: "blocked", reason: "保留原 base 阻塞", reportedAt: 2 },
		};
		const storePath = getRvfAutomaticCloseoutStorePath(workspace.workspaceId);
		await updateRvfAutomaticCloseoutRecords(storePath, () => ({ records: [record], value: undefined }));
		const workInProgressPath = join(projectPath, "user-work-in-progress.txt");
		await writeFile(workInProgressPath, "用户 WIP 必须原样保留\n");
		const refsBefore = repository.runGit(["show-ref"]).stdout;
		const sourceBefore = await readFile(join(projectPath, "implementation.txt"));
		const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-home");
		const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-storage-and-configuration");
		const agentExecutablesDirectory = join(fixture.fixtureRootDirectoryPath, "agent-executables");
		await mkdir(agentExecutablesDirectory);
		const agentAttemptPath = join(fixture.fixtureRootDirectoryPath, "unexpected-agent-execution-attempts.jsonl");
		const agentExecutablePath = join(agentExecutablesDirectory, "codex");
		await writeFile(
			agentExecutablePath,
			`#!${process.execPath}\nconst {appendFileSync}=require('node:fs'); if(process.argv.some(value=>['app-server','resume','fork'].includes(value))) appendFileSync(${JSON.stringify(agentAttemptPath)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write('codex-cli 0.0.0\\n');\n`,
			{ mode: 0o700 },
		);
		const launch = async () => {
			const child = children.register(
				spawn(process.execPath, [cliPath, "--port", "auto", "--no-open"], {
					cwd: projectPath,
					stdio: ["ignore", "pipe", "pipe"],
					env: fixture.createIsolatedChildProcessEnvironment({
						PATH: `${agentExecutablesDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
						RVF_HOME: rvfHome,
						CODEX_HOME: codexHome,
						CODEX_SQLITE_HOME: codexHome,
						KANBAN_RUNTIME_PORT: undefined,
						DO_NOT_TRACK: "1",
					}),
				}),
			);
			const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
			return {
				child,
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
		const first = await launch();
		const firstRecord = (await first.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId })).records[0];
		expect(firstRecord?.existingCloseoutGoalCompletionReconciliation).toMatchObject({
			verdict: "completed",
			verifiedStages: [
				{ stage: "land", commitSha: landCommit },
				{ stage: "base_branch_sync", commitSha: landCommit },
			],
		});
		expect(firstRecord.landExecutionResult).toEqual(record.landExecutionResult);
		expect(firstRecord.baseBranchSyncExecutionResult).toEqual(record.baseBranchSyncExecutionResult);
		expect(firstRecord.promptDeliveryAttempts).toBeUndefined();
		expect(firstRecord.stageExecutionClaims).toBeUndefined();
		const persistedBeforeRestart = await readFile(storePath);
		expect(await sigkillChildProcessAndWaitForExit(first.child)).toBe(true);
		const restarted = await launch();
		const restoredRecord = (await restarted.client.runtime.rvfAutomaticCloseoutStatus.query({ taskId })).records[0];
		expect(restoredRecord).toEqual(firstRecord);
		expect(await readFile(storePath)).toEqual(persistedBeforeRestart);
		expect(repository.runGit(["show-ref"]).stdout).toBe(refsBefore);
		expect(await readFile(join(projectPath, "implementation.txt"))).toEqual(sourceBefore);
		expect(await readFile(workInProgressPath, "utf8")).toBe("用户 WIP 必须原样保留\n");
		expect(await readFile(agentAttemptPath, "utf8").catch(() => "")).toBe("");
		expect(await readFile(join(dirname(storePath), "task-message-injections.json"), "utf8").catch(() => "[]")).toBe(
			"[]",
		);
	},
);
