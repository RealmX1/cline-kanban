import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import {
	registerSharedTaskCommitLandingCriterionSatisfiedObservationSink,
	type SharedTaskCommitLandingCriterionSatisfiedObservation,
} from "../../src/workspace/shared-task-commit-landing-criterion-satisfied-observation-port";
import { probeAndRefreshTaskCommitIntegrationProvenance } from "../../src/workspace/task-commit-integration-provenance";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

// dd2db 1c：落地探测在每次 provenance 刷新时按共享判据求值，满足即经端口上报。这里用测试 sink 收集上报，
// 不经账本（账本去重另有集成测试）。

interface TaskWorktreeUnderLandingTest {
	repository: IsolatedGitTestRepository;
	repoPath: string;
	worktreePath: string;
	workspaceId: string;
	taskId: string;
}

let reportedObservations: SharedTaskCommitLandingCriterionSatisfiedObservation[] = [];

beforeEach(() => {
	reportedObservations = [];
	registerSharedTaskCommitLandingCriterionSatisfiedObservationSink({
		recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking: (observation) => {
			reportedObservations.push(observation);
		},
	});
});

afterEach(() => {
	registerSharedTaskCommitLandingCriterionSatisfiedObservationSink(null);
});

async function withIsolatedGitHome<T>(
	run: (createRepository: (repositoryDirectoryName: string) => IsolatedGitTestRepository) => Promise<T>,
): Promise<T> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const isolatedHome = join(gitFixture.fixtureRootDirectoryPath, "shared-landing-criterion-home");
	mkdirSync(isolatedHome);
	const previousHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	try {
		return await run((repositoryDirectoryName) =>
			gitFixture.createNonBareRepository({ repositoryDirectoryName, initialBranchName: "main" }),
		);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		gitFixture.cleanup();
	}
}

async function createTaskWorktreeWithCommits(
	createRepository: (repositoryDirectoryName: string) => IsolatedGitTestRepository,
	taskId: string,
	taskCommitFileNames: string[],
): Promise<TaskWorktreeUnderLandingTest & { taskCommitShas: string[] }> {
	const repository = createRepository(`${taskId}-repository`);
	const repoPath = repository.repositoryPath;
	writeFileSync(join(repoPath, "README.md"), "initial\n", "utf8");
	repository.runGit(["add", "README.md"]);
	repository.runGit(["commit", "-m", "initial"]);
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "main" });
	if (!ensured.ok || !ensured.path) {
		throw new Error("Task worktree was not created");
	}
	const worktreePath = ensured.path;
	const taskCommitShas: string[] = [];
	for (const fileName of taskCommitFileNames) {
		writeFileSync(join(worktreePath, fileName), `${fileName}\n`, "utf8");
		repository.runGit(["add", fileName], { workingDirectoryPath: worktreePath });
		repository.runGit(["commit", "-m", `task ${fileName}`], { workingDirectoryPath: worktreePath });
		taskCommitShas.push(
			repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: worktreePath }).stdout.trim(),
		);
	}
	const workspaceId = (await loadWorkspaceContext(repoPath)).workspaceId;
	return { repository, repoPath, worktreePath, workspaceId, taskId, taskCommitShas };
}

async function probe(task: TaskWorktreeUnderLandingTest, worktreeExists: boolean): Promise<void> {
	await probeAndRefreshTaskCommitIntegrationProvenance({
		workspaceId: task.workspaceId,
		taskId: task.taskId,
		repoPath: task.repoPath,
		worktreePath: task.worktreePath,
		baseRef: "main",
		worktreeExists,
	});
}

function getProvenancePath(task: TaskWorktreeUnderLandingTest): string {
	return join(getWorkspaceDirectoryPath(task.workspaceId), "task-commit-integration-provenance.json");
}

function readPersistedTaskOwnedCommitShas(task: TaskWorktreeUnderLandingTest): string[] | undefined {
	const persisted = JSON.parse(readFileSync(getProvenancePath(task), "utf8")) as {
		tasks: Record<
			string,
			{
				lastWorkspaceGitSnapshot: {
					taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead?: { commitSha: string }[];
				};
			}
		>;
	};
	const snapshot = persisted.tasks[task.taskId]?.lastWorkspaceGitSnapshot;
	return snapshot?.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead?.map((commit) => commit.commitSha);
}

function readPersistedTaskCommitProvenanceIncarnationIds(task: TaskWorktreeUnderLandingTest): string[] {
	const persisted = JSON.parse(readFileSync(getProvenancePath(task), "utf8")) as {
		tasks: Record<string, { incarnations: { incarnationId: string }[] }>;
	};
	return persisted.tasks[task.taskId]?.incarnations.map((incarnation) => incarnation.incarnationId) ?? [];
}

function commitFileInTaskWorktree(task: TaskWorktreeUnderLandingTest, fileName: string): string {
	writeFileSync(join(task.worktreePath, fileName), `${fileName}\n`, "utf8");
	task.repository.runGit(["add", fileName], { workingDirectoryPath: task.worktreePath });
	task.repository.runGit(["commit", "-m", `task ${fileName}`], { workingDirectoryPath: task.worktreePath });
	return task.repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: task.worktreePath }).stdout.trim();
}

// 第一世提交 A 且 A 尚未落地 → 删 worktree、重建第二世（锚点 = 当时的 base tip，不含 A）→ A 经别的途径进 base →
// 第二世吸收 base（fast-forward 到含 A 的 merge 提交）。第二世自己没有任何提交。
async function absorbFirstIncarnationCommitLandedElsewhereIntoSecondIncarnation(
	createRepository: (repositoryDirectoryName: string) => IsolatedGitTestRepository,
	taskId: string,
): Promise<{
	task: TaskWorktreeUnderLandingTest;
	firstIncarnationTaskCommitSha: string;
	secondIncarnationId: string;
}> {
	const task = await createTaskWorktreeWithCommits(createRepository, taskId, ["a.txt"]);
	const firstIncarnationTaskCommitSha = task.taskCommitShas[0] ?? "";
	await probe(task, true);

	await deleteTaskWorktree({ repoPath: task.repoPath, taskId: task.taskId });
	const recreated = await ensureTaskWorktreeIfDoesntExist({
		cwd: task.repoPath,
		taskId: task.taskId,
		baseRef: "main",
	});
	if (!recreated.ok || recreated.path !== task.worktreePath) {
		throw new Error("Second task worktree incarnation was not created at the same path");
	}
	await probe(task, true);
	const incarnationIds = readPersistedTaskCommitProvenanceIncarnationIds(task);
	expect(incarnationIds).toHaveLength(2);

	task.repository.runGit(["merge", "--no-ff", "-m", "land first incarnation commit", firstIncarnationTaskCommitSha]);
	task.repository.runGit(["merge", "main"], { workingDirectoryPath: task.worktreePath });
	return { task, firstIncarnationTaskCommitSha, secondIncarnationId: incarnationIds[1] ?? "" };
}

function rewritePersistedTaskOwnedCommitSet(
	task: TaskWorktreeUnderLandingTest,
	rewrite: (snapshot: Record<string, unknown>) => void,
): void {
	const persisted = JSON.parse(readFileSync(getProvenancePath(task), "utf8")) as {
		tasks: Record<string, { lastWorkspaceGitSnapshot: Record<string, unknown> }>;
	};
	const snapshot = persisted.tasks[task.taskId]?.lastWorkspaceGitSnapshot;
	if (!snapshot) throw new Error("expected a persisted snapshot");
	rewrite(snapshot);
	writeFileSync(getProvenancePath(task), JSON.stringify(persisted, null, 2), "utf8");
}

describe.sequential("shared task commit landing criterion detection over task commit integration probes", () => {
	it("keeps the task-owned set after a no-ff merge landing, reports it as landed, and keeps reporting the same set after the task absorbs base and after its worktree is removed", async () => {
		await withIsolatedGitHome(async (createRepository) => {
			const task = await createTaskWorktreeWithCommits(createRepository, "t-merge", ["a.txt", "b.txt"]);
			const taskHeadBeforeLanding = task.taskCommitShas.at(-1) ?? "";

			await probe(task, true);
			expect(reportedObservations).toEqual([]);

			task.repository.runGit(["merge", "--no-ff", "-m", "land t-merge", taskHeadBeforeLanding]);
			await probe(task, true);
			// 1c 之前这里会被清成空（`main..HEAD` 已经没有东西了），判据就看不到「已落地」。
			expect(readPersistedTaskOwnedCommitShas(task)).toEqual(task.taskCommitShas);
			expect(reportedObservations).toHaveLength(1);
			expect(reportedObservations[0]).toMatchObject({
				workspaceId: task.workspaceId,
				taskId: "t-merge",
				localBaseRef: "main",
				lastKnownTaskHeadCommit: taskHeadBeforeLanding,
				lastKnownTaskHeadObservationSource: "live_task_worktree_probe",
			});
			expect(
				reportedObservations[0]?.taskOwnedNonMergeCommitsIntegratedIntoLocalBase.map((match) => [
					match.taskCommitSha,
					match.taskCommitIntegrationIntoBaseRefMatchKind,
				]),
			).toEqual(task.taskCommitShas.map((commitSha) => [commitSha, "exact_commit_sha"]));

			// 落地后 task 吸收 base：HEAD 前移到 base 的 merge 提交，自有集合不变。
			task.repository.runGit(["merge", "main"], { workingDirectoryPath: task.worktreePath });
			await probe(task, true);
			expect(reportedObservations).toHaveLength(2);
			expect(reportedObservations[1]?.lastKnownTaskHeadCommit).not.toBe(taskHeadBeforeLanding);
			expect(
				reportedObservations[1]?.taskOwnedNonMergeCommitsIntegratedIntoLocalBase.map((m) => m.taskCommitSha),
			).toEqual(task.taskCommitShas);

			await deleteTaskWorktree({ repoPath: task.repoPath, taskId: task.taskId });
			await probe(task, false);
			expect(reportedObservations).toHaveLength(3);
			expect(reportedObservations[2]?.lastKnownTaskHeadObservationSource).toBe(
				"persisted_last_task_worktree_snapshot_after_worktree_removal",
			);
		});
	});

	it("does not report a partial cherry-pick landing, and reports patch-id equivalence once every task commit was picked", async () => {
		await withIsolatedGitHome(async (createRepository) => {
			const task = await createTaskWorktreeWithCommits(createRepository, "t-pick", ["a.txt", "b.txt"]);
			const [firstTaskCommitSha = "", secondTaskCommitSha = ""] = task.taskCommitShas;
			await probe(task, true);

			// `-x` 往提交信息里追加来源行：同一秒、同一父提交上的 cherry-pick 否则会生成逐字节相同的提交（SHA 也相同）。
			task.repository.runGit(["cherry-pick", "-x", firstTaskCommitSha]);
			await probe(task, true);
			expect(reportedObservations).toEqual([]);

			task.repository.runGit(["cherry-pick", "-x", secondTaskCommitSha]);
			await probe(task, true);
			expect(reportedObservations).toHaveLength(1);
			const matches = reportedObservations[0]?.taskOwnedNonMergeCommitsIntegratedIntoLocalBase ?? [];
			expect(matches.map((match) => match.taskCommitIntegrationIntoBaseRefMatchKind)).toEqual([
				"stable_patch_id_equivalent",
				"stable_patch_id_equivalent",
			]);
			expect(matches.every((match) => match.matchedBaseRefCommitSha !== match.taskCommitSha)).toBe(true);
		});
	});

	it("recomputes a task-owned set that pre-1c probes wiped after a merge landing, and never evaluates snapshots probed before landing data preservation", async () => {
		await withIsolatedGitHome(async (createRepository) => {
			const task = await createTaskWorktreeWithCommits(createRepository, "t-legacy", ["a.txt"]);
			await probe(task, true);
			task.repository.runGit(["merge", "--no-ff", "-m", "land t-legacy", task.taskCommitShas[0] ?? ""]);
			await deleteTaskWorktree({ repoPath: task.repoPath, taskId: task.taskId });

			// 模拟 1c 之前的探测：merge 落地后 `main..HEAD` 为空，可达集合被记成空。
			rewritePersistedTaskOwnedCommitSet(task, (snapshot) => {
				snapshot.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead = [];
			});
			reportedObservations = [];
			await probe(task, false);
			expect(readPersistedTaskOwnedCommitShas(task)).toEqual(task.taskCommitShas);
			expect(reportedObservations).toHaveLength(1);

			// 1a 之前的快照没有这个字段：S 无从得知，不求值。
			rewritePersistedTaskOwnedCommitSet(task, (snapshot) => {
				delete snapshot.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead;
			});
			reportedObservations = [];
			await probe(task, false);
			expect(reportedObservations).toEqual([]);
		});
	});

	it("takes the task-owned set from the latest incarnation only: an earlier incarnation's commit absorbed through base never makes the latest incarnation look landed", async () => {
		await withIsolatedGitHome(async (createRepository) => {
			const { task, secondIncarnationId } = await absorbFirstIncarnationCommitLandedElsewhereIntoSecondIncarnation(
				createRepository,
				"t-reincarnated-live",
			);

			// 第二世没有自有提交（S 为空）：经 base 吸收进来的第一世提交不算第二世的，不得上报「全部落地」。
			await probe(task, true);
			expect(readPersistedTaskOwnedCommitShas(task)).toEqual([]);
			expect(reportedObservations).toEqual([]);

			const secondIncarnationTaskCommitSha = commitFileInTaskWorktree(task, "b.txt");
			await probe(task, true);
			expect(reportedObservations).toEqual([]);

			task.repository.runGit([
				"merge",
				"--no-ff",
				"-m",
				"land second incarnation commit",
				secondIncarnationTaskCommitSha,
			]);
			await probe(task, true);
			expect(reportedObservations).toHaveLength(1);
			expect(reportedObservations[0]?.taskCommitProvenanceIncarnationId).toBe(secondIncarnationId);
			expect(
				reportedObservations[0]?.taskOwnedNonMergeCommitsIntegratedIntoLocalBase.map(
					(match) => match.taskCommitSha,
				),
			).toEqual([secondIncarnationTaskCommitSha]);
		});
	});

	it("does not recompute a removed latest incarnation's empty task-owned set from an earlier incarnation's commits", async () => {
		await withIsolatedGitHome(async (createRepository) => {
			const { task } = await absorbFirstIncarnationCommitLandedElsewhereIntoSecondIncarnation(
				createRepository,
				"t-reincarnated-persisted",
			);
			await probe(task, true);
			expect(reportedObservations).toEqual([]);

			// 第二世 worktree 删除后走持久快照分支：空 S 只在最新一世确有自有提交时才重算，第一世的提交不触发重算。
			await deleteTaskWorktree({ repoPath: task.repoPath, taskId: task.taskId });
			await probe(task, false);
			expect(readPersistedTaskOwnedCommitShas(task)).toEqual([]);
			expect(reportedObservations).toEqual([]);
		});
	});
});
