import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	resolveInterWorkUnitRelationLedgerStorageRootDirectory,
} from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import { probeAndRefreshTaskCommitIntegrationProvenance } from "../../src/workspace/task-commit-integration-provenance";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

async function countLandingObservationsInLedgerAfterAllWritersClosed(taskId: string): Promise<number> {
	const readerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
		resolveInterWorkUnitRelationLedgerStorageRootDirectory(),
	);
	try {
		const events = await readerClient.listCommittedEvents({ limit: 5000 });
		return events.filter(
			(event) =>
				event.eventKind === "task_commits_integrated_into_local_base_observed" && event.subjectTaskId === taskId,
		).length;
	} finally {
		await readerClient.close();
	}
}

// 「终会发生」的单档等待：激活后首次查询要等账本 Worker 线程冷启动并加载 better-sqlite3，vi.waitFor 默认 1s
// 在高负载下不够。放宽不损失判别力——断言判的是「最终落了几条、内容对不对」，不是多快。
const LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START = { timeout: 15_000 };

describe.sequential("inter-work-unit relation ledger task commits integrated into local base observation", () => {
	it("backfills a landing that happened while no runtime was capturing (worktree already removed), records it once, and stays at one across probes and re-activations", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const isolatedHome = join(gitFixture.fixtureRootDirectoryPath, "landing-observation-home");
		mkdirSync(isolatedHome);
		const previousHome = process.env.HOME;
		process.env.HOME = isolatedHome;
		try {
			const repository = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "landing-observation-repository",
				initialBranchName: "main",
			});
			const repoPath = repository.repositoryPath;
			writeFileSync(join(repoPath, "README.md"), "initial\n", "utf8");
			repository.runGit(["add", "README.md"]);
			repository.runGit(["commit", "-m", "initial"]);
			const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "l0001", baseRef: "main" });
			if (!ensured.ok || !ensured.path) throw new Error("Task worktree was not created");
			writeFileSync(join(ensured.path, "task.txt"), "task\n", "utf8");
			repository.runGit(["add", "task.txt"], { workingDirectoryPath: ensured.path });
			repository.runGit(["commit", "-m", "task change"], { workingDirectoryPath: ensured.path });
			const taskCommitSha = repository
				.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: ensured.path })
				.stdout.trim();
			const workspaceId = (await loadWorkspaceContext(repoPath)).workspaceId;
			const probeInput = {
				workspaceId,
				taskId: "l0001",
				repoPath,
				worktreePath: ensured.path,
				baseRef: "main",
			};
			// 没有 runtime 在记账时：探测照常、只是没人收观测（1a–1c 期间的处境）。
			await probeAndRefreshTaskCommitIntegrationProvenance({ ...probeInput, worktreeExists: true });
			repository.runGit(["merge", "--no-ff", "-m", "land l0001", taskCommitSha]);
			await deleteTaskWorktree({ repoPath, taskId: "l0001" });

			const firstActivation = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			try {
				await firstActivation.sharedTaskCommitLandingCriterionActivationBackfillSweepCompletion;
				await vi.waitFor(async () => {
					const landingObservations = (
						await firstActivation.ledgerClient.listCommittedEvents({ limit: 5000 })
					).filter((event) => event.eventKind === "task_commits_integrated_into_local_base_observed");
					expect(landingObservations).toHaveLength(1);
					expect(landingObservations[0]?.subjectWorkspaceId).toBe(workspaceId);
					expect(landingObservations[0]?.subjectTaskId).toBe("l0001");
					expect(landingObservations[0]?.actor).toMatchObject({
						kanbanActorKind: "kanban_runtime_system_component",
						kanbanRuntimeSystemComponentName: "shared_task_commit_landing_criterion_detector",
					});
					expect(landingObservations[0]?.eventPayload).toMatchObject({
						sharedTaskCommitLandingCriterionVersion: 1,
						localBaseRef: "main",
						lastKnownTaskHeadCommit: taskCommitSha,
						lastKnownTaskHeadObservationSource: "persisted_last_task_worktree_snapshot_after_worktree_removal",
						taskOwnedNonMergeCommitsIntegratedIntoLocalBase: [
							expect.objectContaining({
								taskCommitSha,
								taskCommitIntegrationIntoBaseRefMatchKind: "exact_commit_sha",
							}),
						],
					});
				}, LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START);
				// 同一实例里再次探测：内存去重，不再往返 worker。
				await probeAndRefreshTaskCommitIntegrationProvenance({ ...probeInput, worktreeExists: false });
			} finally {
				await firstActivation.deactivate();
			}

			// 重启后再扫一遍：账本按幂等键原子去重。
			const secondActivation = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			try {
				await secondActivation.sharedTaskCommitLandingCriterionActivationBackfillSweepCompletion;
			} finally {
				await secondActivation.deactivate();
			}
			expect(await countLandingObservationsInLedgerAfterAllWritersClosed("l0001")).toBe(1);
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
		// 用例超时覆盖：账本提交等待 15s + 两次激活 / 停用 Worker + 真实 git worktree 操作。
	}, 45_000);
});
