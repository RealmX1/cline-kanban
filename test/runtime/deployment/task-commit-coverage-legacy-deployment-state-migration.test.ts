import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimePostDeployVerificationState } from "../../../src/core/api-contract";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { readTaskCommitCoverageInCurrentDeploymentForWorkspace } from "../../../src/deployment/task-commit-coverage-in-current-deployment";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe.sequential("提交覆盖读取兼容 legacy 部署状态", () => {
	let fixture: IsolatedGitTestWorkspaceFixture;
	let repository: IsolatedGitTestRepository;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	let deployedCommit: string;
	const workspaceId = "legacy-deployment-coverage-project";
	const taskId = "retained-task";
	const legacyDeploymentId = "10000000-0000-4000-8000-000000000001";
	const currentDeploymentId = "10000000-0000-4000-8000-000000000002";

	beforeEach(() => {
		fixture = createIsolatedGitTestWorkspaceFixture();
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		process.env.USERPROFILE = fixture.isolatedHomeDirectoryPath;
		repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "legacy-deployment-coverage",
			initialBranchName: "main",
		});
		const baseCommit = commit("初始内容");
		deployedCommit = commit("任务内容");
		for (const recordedWorkspaceId of [workspaceId, "workspace-without-deployment"]) {
			const directory = getWorkspaceDirectoryPath(recordedWorkspaceId);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "task-commit-integration-provenance.json"),
				JSON.stringify({
					schemaVersion: 1,
					tasks: {
						[taskId]: {
							taskId,
							baseRef: "main",
							incarnations: [
								{
									incarnationId: "retained-incarnation",
									initialBaseCommit: baseCommit,
									captureSource: "worktree_creation",
									startedAt: 1,
									observedTaskCommits: [{ commitSha: deployedCommit, stablePatchId: null }],
								},
							],
							lastWorkspaceGitSnapshot: null,
							retainedCommittedLineChangeHistory: {
								summary: {
									status: "complete",
									commitCount: 1,
									additions: 1,
									deletions: 1,
									historyVersion: deployedCommit,
									unavailableReason: null,
								},
								commits: [
									{
										commitSha: deployedCommit,
										subject: "任务内容",
										committedAtMs: 1,
										additions: 1,
										deletions: 1,
									},
								],
							},
						},
					},
				}),
			);
		}
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fixture.cleanup();
	});

	function commit(content: string): string {
		writeFileSync(join(repository.repositoryPath, "task.txt"), content);
		repository.runGit(["add", "task.txt"]);
		repository.runGit(["commit", "--quiet", "-m", content]);
		return repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
	}

	function deploymentState(deploymentId: string): RuntimePostDeployVerificationState {
		return {
			deploymentGroups: [
				{
					workspaceId,
					deploymentId,
					deployedSourceCommit: deployedCommit,
					previousDeployedSourceCommit: null,
					deployedAtIso: "2026-10-23T09:00:00.000Z",
					foldedAtIso: null,
					tasks: [],
				},
			],
		};
	}

	async function readCoverage(requestedWorkspaceId = workspaceId) {
		const coverage = await readTaskCommitCoverageInCurrentDeploymentForWorkspace({
			workspaceId: requestedWorkspaceId,
			repositoryPath: repository.repositoryPath,
			taskIds: [taskId],
		});
		return coverage.get(taskId);
	}

	it("仅旧文件时先迁移再核对部署提交，并保持 workspace 隔离", async () => {
		const currentStatePath = getPostDeployVerificationStatePath();
		const legacyStatePath = join(dirname(currentStatePath), "guided-verification-state.json");
		const legacyStateContents = JSON.stringify(deploymentState(legacyDeploymentId), null, 2);
		mkdirSync(dirname(legacyStatePath), { recursive: true });
		writeFileSync(legacyStatePath, legacyStateContents);
		expect(existsSync(currentStatePath)).toBe(false);

		expect(await readCoverage()).toMatchObject({
			coverageStatus: "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 1,
			matchedTaskCommitCountInCurrentDeployment: 1,
			currentDeploymentId: legacyDeploymentId,
			currentDeployedSourceCommit: deployedCommit,
			unavailableReason: null,
		});
		expect(existsSync(legacyStatePath)).toBe(false);
		expect(readFileSync(currentStatePath, "utf8")).toBe(legacyStateContents);
		expect(await readCoverage("workspace-without-deployment")).toMatchObject({
			coverageStatus: "unknown",
			currentDeploymentId: null,
			unavailableReason: "current_deployment_record_unavailable",
		});
	});

	it("新文件优先于旧文件，重复读取后仍能察觉当前部署更新", async () => {
		const currentStatePath = getPostDeployVerificationStatePath();
		const legacyStatePath = join(dirname(currentStatePath), "guided-verification-state.json");
		const legacyStateContents = JSON.stringify(deploymentState(legacyDeploymentId));
		mkdirSync(dirname(currentStatePath), { recursive: true });
		writeFileSync(legacyStatePath, legacyStateContents);
		writeFileSync(currentStatePath, JSON.stringify(deploymentState(currentDeploymentId)));
		const previousCoverage = await readCoverage();
		expect(previousCoverage?.currentDeploymentId).toBe(currentDeploymentId);
		expect(await readCoverage()).toEqual(previousCoverage);

		writeFileSync(currentStatePath, JSON.stringify(deploymentState(legacyDeploymentId)));
		const nextCoverage = await readCoverage();
		expect(nextCoverage?.currentDeploymentId).toBe(legacyDeploymentId);
		expect(nextCoverage?.coverageVersion).not.toBe(previousCoverage?.coverageVersion);
		expect(readFileSync(legacyStatePath, "utf8")).toBe(legacyStateContents);
	});
});
