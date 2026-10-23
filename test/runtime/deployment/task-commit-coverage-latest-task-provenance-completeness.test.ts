import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskWorkspaceMetadata } from "../../../src/core/api-contract";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { attachTaskCommitCoverageInCurrentDeploymentToMetadata } from "../../../src/deployment/task-commit-coverage-in-current-deployment";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import {
	type ObservedTaskCommit,
	readTaskRetainedCommittedLineChangeHistory,
	recordTaskWorktreeCreationCommitProvenance,
	refreshTaskCommitIntegrationProvenance,
} from "../../../src/workspace/task-commit-integration-provenance";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe.sequential("最新提交归属完整性约束部署覆盖", () => {
	let fixture: IsolatedGitTestWorkspaceFixture;
	let repository: IsolatedGitTestRepository;
	let worktreePath: string;
	const workspaceId = "latest-provenance-completeness-project";
	const taskId = "latest-provenance-task";
	const taskBranch = "task-latest-provenance";

	beforeEach(async () => {
		fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "latest-provenance-completeness",
			initialBranchName: "main",
		});
		const initialBaseCommit = commit(repository.repositoryPath, "base.txt", "初始提交");
		worktreePath = repository.createLinkedWorktree({
			worktreeDirectoryName: "task-latest-provenance-worktree",
			branchName: taskBranch,
		}).worktreePath;
		await recordTaskWorktreeCreationCommitProvenance({
			workspaceId,
			taskId,
			baseRef: "main",
			initialBaseCommit,
		});
	});

	afterEach(() => {
		fixture.cleanup();
		vi.unstubAllEnvs();
	});

	function commit(workingDirectoryPath: string, fileName: string, content: string): string {
		writeFileSync(join(workingDirectoryPath, fileName), content);
		repository.runGit(["add", fileName], { workingDirectoryPath });
		repository.runGit(["commit", "--quiet", "-m", content], { workingDirectoryPath });
		return repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath }).stdout.trim();
	}

	function recordDeployment(deployedSourceCommit: string) {
		const path = getPostDeployVerificationStatePath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				deploymentGroups: [
					{
						workspaceId,
						deploymentId: "10000000-0000-4000-8000-000000000001",
						deployedSourceCommit,
						previousDeployedSourceCommit: null,
						deployedAtIso: "2026-10-23T09:00:00.000Z",
						foldedAtIso: null,
						tasks: [],
					},
				],
			}),
		);
	}

	async function probeTaskMetadata(worktreeExists = true): Promise<RuntimeTaskWorkspaceMetadata> {
		const headCommit = worktreeExists
			? repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: worktreePath }).stdout.trim()
			: null;
		const baseRefTipCommit = repository.runGit(["rev-parse", "main"]).stdout.trim();
		const divergence = worktreeExists
			? repository
					.runGit(["rev-list", "--left-right", "--count", "main...HEAD"], {
						workingDirectoryPath: worktreePath,
					})
					.stdout.trim()
					.split(/\s+/)
					.map(Number)
			: [];
		const workspaceGitStatus = await refreshTaskCommitIntegrationProvenance({
			workspaceId,
			taskId,
			repoPath: repository.repositoryPath,
			worktreePath,
			baseRef: "main",
			worktreeExists,
			headCommit,
			baseRefTipCommit,
			commitsAheadOfBaseRef: divergence[1] ?? null,
			commitsBehindBaseRef: divergence[0] ?? null,
			isDetached: false,
		});
		return {
			taskId,
			path: worktreePath,
			exists: worktreeExists,
			baseRef: "main",
			baseCommit: null,
			commitsAheadOfBaseRef: workspaceGitStatus.commitsAheadOfBaseRef,
			commitsBehindBaseRef: workspaceGitStatus.commitsBehindBaseRef,
			workspaceGitStatus,
			branch: worktreeExists ? taskBranch : null,
			isDetached: false,
			headCommit,
			changedFiles: null,
			additions: null,
			deletions: null,
			stateVersion: 1,
		};
	}

	async function attachCoverage(metadata: RuntimeTaskWorkspaceMetadata) {
		const [enriched] = await attachTaskCommitCoverageInCurrentDeploymentToMetadata({
			workspaceId,
			repositoryPath: repository.repositoryPath,
			taskMetadata: [metadata],
		});
		return enriched?.taskCommitCoverageInCurrentDeployment;
	}

	it.each([0, 1])("最新探针归属不完整时不沿用旧的 %i 个提交分母", async (previousCommitCount) => {
		if (previousCommitCount > 0) commit(worktreePath, "previous.txt", "已保留的任务提交");
		const previousMetadata = await probeTaskMetadata();
		expect(previousMetadata.workspaceGitStatus.taskCommitIntegrationTrackingStatus).toBe("complete");
		recordDeployment(previousMetadata.headCommit ?? "");
		const previousCoverage = await attachCoverage(previousMetadata);
		expect(previousCoverage).toMatchObject({
			coverageStatus:
				previousCommitCount === 0 ? "no_known_task_commits" : "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: previousCommitCount,
			matchedTaskCommitCountInCurrentDeployment: previousCommitCount,
		});
		if (previousCommitCount > 0) {
			// 模拟归属观测缺失而完整保留快照仍在的历史文件，不能再用旧分母证明当前集合完整。
			const path = join(getWorkspaceDirectoryPath(workspaceId), "task-commit-integration-provenance.json");
			const provenance = JSON.parse(readFileSync(path, "utf8")) as {
				tasks: Record<string, { incarnations: { observedTaskCommits: ObservedTaskCommit[] }[] }>;
			};
			for (const incarnation of provenance.tasks[taskId]?.incarnations ?? []) incarnation.observedTaskCommits = [];
			writeFileSync(path, JSON.stringify(provenance));
		}
		const unobservedCommit = commit(worktreePath, "unobserved.txt", "探测间新增并落地的任务提交");
		repository.runGit(["merge", "--quiet", "--ff-only", taskBranch]);
		recordDeployment(unobservedCommit);
		const latestMetadata = await probeTaskMetadata();
		expect(latestMetadata.workspaceGitStatus.taskCommitIntegrationTrackingStatus).toBe(
			"task_commit_ownership_history_incomplete",
		);
		const retainedHistory = await readTaskRetainedCommittedLineChangeHistory(workspaceId, taskId);
		expect(retainedHistory.summary).toMatchObject({ status: "complete", commitCount: previousCommitCount });
		const latestCoverage = await attachCoverage(latestMetadata);
		expect(latestCoverage).toMatchObject({
			coverageStatus: "unknown",
			knownTaskCommitCount: null,
			matchedTaskCommitCountInCurrentDeployment: null,
			unavailableReason: "task_commit_ownership_history_incomplete",
			currentDeployedSourceCommit: unobservedCommit,
		});
		expect(latestCoverage?.coverageVersion).not.toBe(previousCoverage?.coverageVersion);
	});

	it("删除 worktree 后仍接受归属完整的持久最终快照", async () => {
		const taskCommit = commit(worktreePath, "retained.txt", "删除工作树前的完整任务提交");
		await probeTaskMetadata();
		repository.runGit(["merge", "--quiet", "--ff-only", taskBranch]);
		recordDeployment(taskCommit);
		rmSync(worktreePath, { recursive: true, force: true });
		const metadata = await probeTaskMetadata(false);
		expect(metadata.workspaceGitStatus).toMatchObject({
			taskCommitIntegrationTrackingStatus: "complete",
			observationSource: "persisted_final_snapshot",
		});
		expect(await attachCoverage(metadata)).toMatchObject({
			coverageStatus: "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 1,
			matchedTaskCommitCountInCurrentDeployment: 1,
			unavailableReason: null,
		});
	});

	it.each([
		"git_probe_unavailable",
		"legacy_history_unavailable",
		"inplace_task_commit_ownership_unavailable",
	] as const)("最新状态为 %s 时不把旧空快照当作可靠零提交", async (trackingStatus) => {
		const metadata = await probeTaskMetadata();
		metadata.workspaceGitStatus.taskCommitIntegrationTrackingStatus = trackingStatus;
		expect(await attachCoverage(metadata)).toMatchObject({
			coverageStatus: "unknown",
			knownTaskCommitCount: null,
			matchedTaskCommitCountInCurrentDeployment: null,
			unavailableReason:
				trackingStatus === "git_probe_unavailable" ? "task_git_observation_unavailable" : trackingStatus,
		});
	});
});
