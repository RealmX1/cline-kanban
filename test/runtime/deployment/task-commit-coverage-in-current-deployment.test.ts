import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { readTaskCommitCoverageInCurrentDeploymentForWorkspace } from "../../../src/deployment/task-commit-coverage-in-current-deployment";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { computeStablePatchId } from "../../../src/workspace/git-utils";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe.sequential("任务在当前部署版本中的提交覆盖", () => {
	let fixture: IsolatedGitTestWorkspaceFixture;
	let repository: IsolatedGitTestRepository;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	let retainedTaskProvenanceEntries: Record<string, unknown>;
	const workspaceId = "deployment-coverage-project";
	const taskId = "ongoing-task";

	beforeEach(() => {
		fixture = createIsolatedGitTestWorkspaceFixture();
		retainedTaskProvenanceEntries = {};
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		process.env.USERPROFILE = fixture.isolatedHomeDirectoryPath;
		repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "current-deployment-coverage",
			initialBranchName: "main",
		});
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fixture.cleanup();
	});

	function commit(fileName: string, content: string): string {
		writeFileSync(join(repository.repositoryPath, fileName), content);
		repository.runGit(["add", fileName]);
		repository.runGit(["commit", "--quiet", "-m", content]);
		return repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
	}

	async function retainTaskCommits(base: string, shas: string[], observedShas = shas, retainedTaskId = taskId) {
		const observed = await Promise.all(
			observedShas.map(async (commitSha) => ({
				commitSha,
				stablePatchId: await computeStablePatchId(repository.repositoryPath, commitSha),
			})),
		);
		const directory = getWorkspaceDirectoryPath(workspaceId);
		mkdirSync(directory, { recursive: true });
		Object.assign(retainedTaskProvenanceEntries, {
			[retainedTaskId]: {
				taskId: retainedTaskId,
				baseRef: "main",
				incarnations: [
					{
						incarnationId: "first-incarnation",
						initialBaseCommit: base,
						captureSource: "worktree_creation",
						startedAt: 1,
						observedTaskCommits: observed,
					},
				],
				lastWorkspaceGitSnapshot: null,
				retainedCommittedLineChangeHistory: {
					summary: {
						status: "complete",
						commitCount: shas.length,
						additions: shas.length,
						deletions: 0,
						historyVersion: shas.join(":"),
						unavailableReason: null,
					},
					commits: shas.map((commitSha) => ({
						commitSha,
						subject: "任务提交",
						committedAtMs: 1,
						additions: 1,
						deletions: 0,
					})),
				},
			},
		});
		writeFileSync(
			join(directory, "task-commit-integration-provenance.json"),
			JSON.stringify({ schemaVersion: 1, tasks: retainedTaskProvenanceEntries }),
		);
	}

	function recordDeployment(
		sha: string,
		deploymentId = "10000000-0000-4000-8000-000000000001",
		recordedWorkspaceId = workspaceId,
	) {
		const path = getPostDeployVerificationStatePath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				deploymentGroups: [
					{
						workspaceId: recordedWorkspaceId,
						deploymentId,
						deployedSourceCommit: sha,
						previousDeployedSourceCommit: null,
						deployedAtIso: "2026-10-23T09:00:00.000Z",
						foldedAtIso: null,
						tasks: [],
					},
				],
			}),
		);
	}

	async function readCoverage() {
		const coverage = await readTaskCommitCoverageInCurrentDeploymentForWorkspace({
			workspaceId,
			repositoryPath: repository.repositoryPath,
			taskIds: [taskId, "missing-task"],
		});
		return coverage.get(taskId);
	}

	it("无 worktree 仍按当前部署算部分、全部、新增提交与回滚，不累加历史", async () => {
		const base = commit("base.txt", "初始提交");
		const first = commit("first.txt", "第一项工作");
		const second = commit("second.txt", "第二项工作");
		await retainTaskCommits(base, [first, second]);
		recordDeployment(first);
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "some_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 2,
			matchedTaskCommitCountInCurrentDeployment: 1,
		});
		recordDeployment(second, "10000000-0000-4000-8000-000000000002");
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 2,
			matchedTaskCommitCountInCurrentDeployment: 2,
		});
		const third = commit("third.txt", "新增工作");
		await retainTaskCommits(base, [first, second, third]);
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "some_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 3,
			matchedTaskCommitCountInCurrentDeployment: 2,
		});
		recordDeployment(base, "10000000-0000-4000-8000-000000000003");
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "no_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 3,
			matchedTaskCommitCountInCurrentDeployment: 0,
			currentDeploymentId: "10000000-0000-4000-8000-000000000003",
		});
	});

	it("匹配改写 SHA 的 patch-id，分母不包含已废弃的观测版本", async () => {
		const base = commit("base.txt", "初始提交");
		repository.runGit(["checkout", "--quiet", "-b", "task-branch"]);
		const original = commit("feature.txt", "任务改动");
		repository.runGit(["checkout", "--quiet", "main"]);
		commit("unrelated.txt", "其他任务改动");
		repository.runGit(["cherry-pick", original]);
		const rewritten = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		await retainTaskCommits(base, [original]);
		recordDeployment(rewritten);
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "all_known_task_commits_in_current_deployment",
			matchedTaskCommitCountInCurrentDeployment: 1,
		});
		await retainTaskCommits(base, [rewritten], [original, rewritten]);
		expect(await readCoverage()).toMatchObject({
			knownTaskCommitCount: 1,
			matchedTaskCommitCountInCurrentDeployment: 1,
		});
		// 即使两个版本同时被保留，也不能把同一个部署提交重复消费成两个匹配。
		await retainTaskCommits(base, [original, rewritten]);
		expect(await readCoverage()).toMatchObject({
			knownTaskCommitCount: 2,
			matchedTaskCommitCountInCurrentDeployment: 1,
		});
	});

	it("旧 patch 在任务锚点前被 revert 后，单查与混合查询的覆盖一致", async () => {
		const base = commit("base.txt", "初始提交");
		const oldPatch = commit("feature.txt", "任务改动");
		repository.runGit(["revert", "--no-edit", oldPatch]);
		const afterRevert = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		repository.runGit(["checkout", "--quiet", "-b", "task-after-revert"]);
		const taskCommit = commit("feature.txt", "任务改动");
		repository.runGit(["checkout", "--quiet", "-b", "task-with-earlier-floor", base]);
		const otherTaskCommit = commit("other-task.txt", "其他任务改动");
		repository.runGit(["checkout", "--quiet", "main"]);
		await retainTaskCommits(afterRevert, [taskCommit]);
		await retainTaskCommits(base, [otherTaskCommit], [otherTaskCommit], "task-with-earlier-floor");
		recordDeployment(afterRevert);

		const single = await readCoverage();
		const batch = await readTaskCommitCoverageInCurrentDeploymentForWorkspace({
			workspaceId,
			repositoryPath: repository.repositoryPath,
			taskIds: [taskId, "task-with-earlier-floor"],
		});
		expect(single).toMatchObject({
			coverageStatus: "no_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 1,
			matchedTaskCommitCountInCurrentDeployment: 0,
		});
		expect(batch.get(taskId)).toEqual(single);
	});

	it("无效的任务 floor 只使所属任务未知，不污染其他任务的 patch 匹配", async () => {
		const base = commit("base.txt", "初始提交");
		repository.runGit(["checkout", "--quiet", "-b", "task-branch"]);
		const original = commit("feature.txt", "任务改动");
		repository.runGit(["checkout", "--quiet", "-b", "task-with-missing-floor", base]);
		const otherTaskCommit = commit("other-task.txt", "其他任务改动");
		repository.runGit(["checkout", "--quiet", "main"]);
		commit("unrelated.txt", "部署中的其他改动");
		repository.runGit(["cherry-pick", original]);
		const deployedSha = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		await retainTaskCommits(base, [original]);
		await retainTaskCommits("f".repeat(40), [otherTaskCommit], [otherTaskCommit], "task-with-missing-floor");
		recordDeployment(deployedSha);

		const single = await readCoverage();
		const batch = await readTaskCommitCoverageInCurrentDeploymentForWorkspace({
			workspaceId,
			repositoryPath: repository.repositoryPath,
			taskIds: [taskId, "task-with-missing-floor"],
		});
		expect(single).toMatchObject({
			coverageStatus: "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 1,
			matchedTaskCommitCountInCurrentDeployment: 1,
		});
		expect(batch.get(taskId)).toEqual(single);
		expect(batch.get("task-with-missing-floor")).toMatchObject({
			coverageStatus: "unknown",
			knownTaskCommitCount: 1,
			matchedTaskCommitCountInCurrentDeployment: null,
			unavailableReason: "deployment_git_history_unavailable",
		});
	});

	it("同 SHA 重部署仍更新部署身份，不把其他项目的记录串进来", async () => {
		const base = commit("base.txt", "初始提交");
		const first = commit("first.txt", "任务改动");
		await retainTaskCommits(base, [first]);
		recordDeployment(first);
		const previous = await readCoverage();
		recordDeployment(first, "10000000-0000-4000-8000-000000000004");
		const next = await readCoverage();
		expect(next?.currentDeploymentId).toBe("10000000-0000-4000-8000-000000000004");
		expect(next?.coverageVersion).not.toBe(previous?.coverageVersion);
		recordDeployment(first, "10000000-0000-4000-8000-000000000005", "other-project");
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "unknown",
			unavailableReason: "current_deployment_record_unavailable",
		});
	});

	it("缺少部署或归属、部署对象不存在时显示未知，已知空集合不判为全部", async () => {
		const base = commit("base.txt", "初始提交");
		await retainTaskCommits(base, []);
		expect(await readCoverage()).toMatchObject({ coverageStatus: "no_known_task_commits", knownTaskCommitCount: 0 });
		const first = commit("first.txt", "任务改动");
		await retainTaskCommits(base, [first]);
		expect(await readCoverage()).toMatchObject({ coverageStatus: "unknown" });
		recordDeployment("0".repeat(40));
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "unknown",
			unavailableReason: "deployment_git_history_unavailable",
		});
		const all = await readTaskCommitCoverageInCurrentDeploymentForWorkspace({
			workspaceId,
			repositoryPath: repository.repositoryPath,
			taskIds: ["missing-task"],
		});
		expect(all.get("missing-task")).toMatchObject({ coverageStatus: "unknown", knownTaskCommitCount: null });
	});
});
