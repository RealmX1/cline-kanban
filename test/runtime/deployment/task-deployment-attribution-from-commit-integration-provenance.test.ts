import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	computeTaskDeploymentAttributionsAgainstDeployment,
	type DeploymentForTaskDeploymentAttribution,
	findTaskIdsWhoseCommitsAreIncludedInDeploymentDelta,
} from "../../../src/deployment/task-deployment-attribution-from-commit-integration-provenance";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import {
	computeStablePatchId,
	computeStablePatchIdsOfNonMergeCommitsInRevisionRange,
	runGit,
} from "../../../src/workspace/git-utils";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

// 部署归属三区（2026-10-11）：拿任务提交来历（sha + stable patch-id）去一对一匹配部署区间。
// 场景：v 早于保留的部署记录就已上线；x 经 merge 随部署 1 上线；y 被 cherry-pick（patch-id 等价）随部署 2 上线；
// z 还没合进 main；empty 来历里没有提交；missing 没有来历。目标部署 = 部署 2。
describe.sequential("部署归属：提交来历 × 部署区间", () => {
	const WORKSPACE_ID = "workspace-deployment-attribution";
	const NOW_ISO = "2026-10-11T12:00:00.000Z";
	let gitFixture: IsolatedGitTestWorkspaceFixture;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		gitFixture = createIsolatedGitTestWorkspaceFixture();
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		process.env.USERPROFILE = gitFixture.isolatedHomeDirectoryPath;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		gitFixture.cleanup();
	});

	function commitFile(repository: IsolatedGitTestRepository, fileName: string, message: string): string {
		writeFileSync(join(repository.repositoryPath, fileName), `${message}\n`, "utf8");
		repository.runGit(["add", fileName]);
		repository.runGit(["commit", "--quiet", "-m", message]);
		return repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
	}

	async function writeProvenance(
		repositoryPath: string,
		initialBaseCommit: string,
		observedCommitShasByTaskId: Record<string, string[]>,
	): Promise<void> {
		const tasks: Record<string, unknown> = {};
		for (const [taskId, commitShas] of Object.entries(observedCommitShasByTaskId)) {
			tasks[taskId] = {
				taskId,
				baseRef: "main",
				incarnations: [
					{
						incarnationId: `${initialBaseCommit}:1`,
						initialBaseCommit,
						captureSource: "worktree_creation",
						startedAt: 1,
						observedTaskCommits: await Promise.all(
							commitShas.map(async (commitSha) => ({
								commitSha,
								stablePatchId: await computeStablePatchId(repositoryPath, commitSha),
							})),
						),
					},
				],
				lastWorkspaceGitSnapshot: null,
			};
		}
		const workspaceDirectory = getWorkspaceDirectoryPath(WORKSPACE_ID);
		mkdirSync(workspaceDirectory, { recursive: true });
		writeFileSync(
			join(workspaceDirectory, "task-commit-integration-provenance.json"),
			JSON.stringify({ schemaVersion: 1, tasks }, null, 2),
			"utf8",
		);
	}

	it("按三区归属，并给出首次上线的部署（早于保留记录时如实标注）", async () => {
		const repository = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "deployment-attribution",
			initialBranchName: "main",
		});
		const landedLongAgo = commitFile(repository, "v.txt", "v1");
		const firstRetainedDeploymentFloor = commitFile(repository, "base.txt", "c0");
		repository.runGit(["checkout", "--quiet", "-b", "task-x"]);
		const taskXCommit = commitFile(repository, "x.txt", "x1");
		repository.runGit(["checkout", "--quiet", "main"]);
		repository.runGit(["merge", "--quiet", "--no-ff", "task-x", "-m", "merge task-x"]);
		const firstDeployedSourceCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		repository.runGit(["checkout", "--quiet", "-b", "task-y"]);
		const taskYCommit = commitFile(repository, "y.txt", "y1");
		repository.runGit(["checkout", "--quiet", "main"]);
		// main 先前进一步：cherry-pick 落在不同父提交上，必然得到新 SHA（只剩 patch-id 等价）。
		commitFile(repository, "unrelated.txt", "unrelated main commit");
		repository.runGit(["cherry-pick", taskYCommit]);
		const secondDeployedSourceCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		repository.runGit(["checkout", "--quiet", "-b", "task-z"]);
		const taskZCommit = commitFile(repository, "z.txt", "z1");
		repository.runGit(["checkout", "--quiet", "main"]);

		await writeProvenance(repository.repositoryPath, landedLongAgo, {
			v: [landedLongAgo],
			x: [taskXCommit],
			y: [taskYCommit],
			z: [taskZCommit],
			empty: [],
		});
		const firstDeployment: DeploymentForTaskDeploymentAttribution = {
			deploymentId: "deployment-1",
			deployedSourceCommit: firstDeployedSourceCommit,
			previousDeployedSourceCommit: firstRetainedDeploymentFloor,
			deployedAtIso: "2026-10-10T00:00:00.000Z",
		};
		const secondDeployment: DeploymentForTaskDeploymentAttribution = {
			deploymentId: "deployment-2",
			deployedSourceCommit: secondDeployedSourceCommit,
			previousDeployedSourceCommit: firstDeployedSourceCommit,
			deployedAtIso: "2026-10-11T00:00:00.000Z",
		};

		const attributions = await computeTaskDeploymentAttributionsAgainstDeployment({
			workspaceId: WORKSPACE_ID,
			repositoryPath: repository.repositoryPath,
			targetDeployment: secondDeployment,
			retainedEarlierDeploymentsInAscendingOrder: [firstDeployment],
			taskIds: ["v", "x", "y", "z", "empty", "missing"],
			nowIso: NOW_ISO,
		});

		expect(attributions.get("y")).toMatchObject({
			taskDeploymentAttribution: {
				taskDeploymentAttributionZone: "task_commits_included_in_this_deployment_delta",
				matchedDeployedCommitsInThisDeploymentDelta: [
					{
						taskCommitSha: taskYCommit,
						deployedCommitSha: secondDeployedSourceCommit,
						taskCommitMatchKind: "stable_patch_id_equivalent",
					},
				],
			},
			firstDeployedInDeploymentId: "deployment-2",
		});
		expect(attributions.get("x")).toMatchObject({
			taskDeploymentAttribution: {
				taskDeploymentAttributionZone: "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
			},
			firstDeployedInDeploymentId: "deployment-1",
			firstDeploymentPredatesRetainedDeploymentRecords: false,
		});
		expect(attributions.get("v")).toMatchObject({
			taskDeploymentAttribution: {
				taskDeploymentAttributionZone: "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
			},
			firstDeployedInDeploymentId: null,
			firstDeploymentPredatesRetainedDeploymentRecords: true,
		});
		const expectThirdZone = (taskId: string, unattributableReason: string) =>
			expect(attributions.get(taskId)?.taskDeploymentAttribution).toMatchObject({
				taskDeploymentAttributionZone: "task_commits_not_yet_deployed_or_task_unattributable",
				taskDeploymentUnattributableReason: unattributableReason,
			});
		expectThirdZone("z", "task_commits_not_contained_in_deployed_source_commit");
		expectThirdZone("empty", "task_commit_integration_provenance_has_no_observed_task_commits");
		expectThirdZone("missing", "no_task_commit_integration_provenance_entry");

		const shippedInSecondDeployment = await findTaskIdsWhoseCommitsAreIncludedInDeploymentDelta({
			workspaceId: WORKSPACE_ID,
			repositoryPath: repository.repositoryPath,
			targetDeployment: secondDeployment,
			taskIds: ["v", "x", "y", "z", "empty", "missing"],
		});
		expect([...(shippedInSecondDeployment?.keys() ?? [])]).toEqual(["y"]);
	});

	it("史上首次部署（没有前驱）仍在保留记录里：随它上线的任务以它为首次上线，不标「早于保留记录」", async () => {
		const repository = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "deployment-attribution-first-ever-deployment",
			initialBranchName: "main",
		});
		const initialBaseCommit = commitFile(repository, "base.txt", "c0");
		const taskShippedInFirstEverDeploymentCommit = commitFile(repository, "f.txt", "f1");
		const firstEverDeployedSourceCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		commitFile(repository, "after.txt", "after first-ever deployment");
		const secondDeployedSourceCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();

		await writeProvenance(repository.repositoryPath, initialBaseCommit, {
			f: [taskShippedInFirstEverDeploymentCommit],
		});
		const firstEverDeployment: DeploymentForTaskDeploymentAttribution = {
			deploymentId: "deployment-first-ever",
			deployedSourceCommit: firstEverDeployedSourceCommit,
			previousDeployedSourceCommit: null,
			deployedAtIso: "2026-10-10T00:00:00.000Z",
		};
		const secondDeployment: DeploymentForTaskDeploymentAttribution = {
			deploymentId: "deployment-2",
			deployedSourceCommit: secondDeployedSourceCommit,
			previousDeployedSourceCommit: firstEverDeployedSourceCommit,
			deployedAtIso: "2026-10-11T00:00:00.000Z",
		};

		const attributions = await computeTaskDeploymentAttributionsAgainstDeployment({
			workspaceId: WORKSPACE_ID,
			repositoryPath: repository.repositoryPath,
			targetDeployment: secondDeployment,
			retainedEarlierDeploymentsInAscendingOrder: [firstEverDeployment],
			taskIds: ["f"],
			nowIso: NOW_ISO,
		});

		expect(attributions.get("f")).toMatchObject({
			taskDeploymentAttribution: {
				taskDeploymentAttributionZone: "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
			},
			firstDeployedInDeploymentId: "deployment-first-ever",
			firstDeployedAtIso: "2026-10-10T00:00:00.000Z",
			firstDeploymentPredatesRetainedDeploymentRecords: false,
		});
	});

	it("部署区间的 `git log -p` 超过 runGit 的 10MB maxBuffer 时归属照常算出（log 流式 pipe 给 patch-id）", async () => {
		const repository = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "deployment-attribution-large-deployment-delta",
			initialBranchName: "main",
		});
		const initialBaseCommit = commitFile(repository, "base.txt", "c0");
		// 高度重复的内容：`git log -p` 输出约 12MB（超过 runGit 的 10MB maxBuffer），对象压缩后却只有几 KB，不必真造大仓库。
		writeFileSync(
			join(repository.repositoryPath, "large-generated.txt"),
			`${"x".repeat(99)}\n`.repeat(120_000),
			"utf8",
		);
		repository.runGit(["add", "large-generated.txt"]);
		repository.runGit(["commit", "--quiet", "-m", "large generated file"]);
		const largeTaskCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		const smallTaskCommit = commitFile(repository, "small.txt", "small1");
		repository.runGit(["commit", "--quiet", "--allow-empty", "-m", "empty commit without patch-id"]);
		const deployedSourceCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		const revisionRange = `${initialBaseCommit}..${deployedSourceCommit}`;

		// 前提自检：同一段 `git log -p` 按 runGit 整段读进内存会撞上 maxBuffer——否则本测试测不到要防的失败。
		const bufferedGitLogPatches = await runGit(
			repository.repositoryPath,
			["log", "-p", "--no-merges", "--no-color", "--no-ext-diff", "--format=commit %H", revisionRange],
			{ trimStdout: false },
		);
		expect(bufferedGitLogPatches.ok).toBe(false);

		const patchIdByCommitSha = await computeStablePatchIdsOfNonMergeCommitsInRevisionRange(
			repository.repositoryPath,
			revisionRange,
		);
		expect(patchIdByCommitSha?.get(largeTaskCommit)).toMatch(/^[0-9a-f]{40}$/);
		expect(patchIdByCommitSha?.get(smallTaskCommit)).toBe(
			await computeStablePatchId(repository.repositoryPath, smallTaskCommit),
		);
		expect(patchIdByCommitSha?.size).toBe(2);

		await writeProvenance(repository.repositoryPath, initialBaseCommit, {
			large: [largeTaskCommit],
			small: [smallTaskCommit],
		});
		const attributions = await computeTaskDeploymentAttributionsAgainstDeployment({
			workspaceId: WORKSPACE_ID,
			repositoryPath: repository.repositoryPath,
			targetDeployment: {
				deploymentId: "deployment-with-large-delta",
				deployedSourceCommit,
				previousDeployedSourceCommit: initialBaseCommit,
				deployedAtIso: "2026-10-11T00:00:00.000Z",
			},
			retainedEarlierDeploymentsInAscendingOrder: [],
			taskIds: ["large", "small"],
			nowIso: NOW_ISO,
		});
		for (const taskId of ["large", "small"]) {
			expect(attributions.get(taskId)?.taskDeploymentAttribution).toMatchObject({
				taskDeploymentAttributionZone: "task_commits_included_in_this_deployment_delta",
				taskDeploymentUnattributableReason: null,
			});
		}
	});

	it("区间读不出（revision 不存在）时批量 patch-id 返回 null，不挂起", async () => {
		const repository = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "deployment-attribution-unknown-revision-range",
			initialBranchName: "main",
		});
		const initialBaseCommit = commitFile(repository, "base.txt", "c0");
		expect(
			await computeStablePatchIdsOfNonMergeCommitsInRevisionRange(
				repository.repositoryPath,
				`${initialBaseCommit}..${"0".repeat(40)}`,
			),
		).toBeNull();
	});
});
