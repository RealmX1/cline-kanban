import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import * as gitUtilities from "../../src/workspace/git-utils";
import {
	probeAndRefreshTaskCommitIntegrationProvenance,
	readTaskRetainedCommittedLineChangeHistory,
} from "../../src/workspace/task-commit-integration-provenance";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import {
	type CachedTaskWorkspaceMetadata,
	createBaseRefTipResolver,
	loadTaskWorkspaceMetadata,
} from "../../src/workspace/task-worktree-git-metadata-probe";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

let fixture: IsolatedGitTestWorkspaceFixture;
let previousHome: string | undefined;
let repository: IsolatedGitTestRepository;
let workspaceId: string;
let worktreePath: string;
let initialCommit: string;
const taskId = "retained-lines";

beforeEach(async () => {
	fixture = createIsolatedGitTestWorkspaceFixture();
	previousHome = process.env.HOME;
	process.env.HOME = fixture.isolatedHomeDirectoryPath;
	repository = fixture.createNonBareRepository({ repositoryDirectoryName: "retained-lines-repository" });
	writeFileSync(join(repository.repositoryPath, "initial.txt"), "initial\n");
	initialCommit = repository.commitAllRepositoryFilesAtDate({
		message: "初始化",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repository.repositoryPath, taskId, baseRef: "main" });
	if (!ensured.path) throw new Error("隔离任务 worktree 创建失败");
	worktreePath = ensured.path;
	workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
});

afterEach(() => {
	vi.restoreAllMocks();
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	fixture.cleanup();
});

function taskGit(args: string[]): string {
	return repository.runGit(args, { workingDirectoryPath: worktreePath }).stdout.trim();
}

function commitText(text: string, message: string): string {
	writeFileSync(join(worktreePath, "task.txt"), text);
	taskGit(["add", "task.txt"]);
	taskGit(["commit", "-m", message]);
	return taskGit(["rev-parse", "HEAD"]);
}

async function probe(worktreeExists = true) {
	return await probeAndRefreshTaskCommitIntegrationProvenance({
		workspaceId,
		taskId,
		repoPath: repository.repositoryPath,
		worktreePath,
		baseRef: "main",
		worktreeExists,
	});
}

async function history() {
	return await readTaskRetainedCommittedLineChangeHistory(workspaceId, taskId);
}

async function metadata(current: CachedTaskWorkspaceMetadata | null = null) {
	return await loadTaskWorkspaceMetadata(
		workspaceId,
		repository.repositoryPath,
		{ taskId, baseRef: "main", taskCardBoardColumnId: "review", taskCardAutoReviewEnabled: false },
		current,
		createBaseRefTipResolver(repository.repositoryPath),
	);
}

function failCommitLineStatisticsWhile(shouldFail: () => boolean) {
	const realRunGit = gitUtilities.runGit;
	return vi.spyOn(gitUtilities, "runGit").mockImplementation(async (cwd, args, options) => {
		if (args.includes("--numstat") && shouldFail()) {
			return { ok: false, stdout: "", stderr: "临时读取失败", output: "", error: "临时读取失败", exitCode: 1 };
		}
		return await realRunGit(cwd, args, options);
	});
}

describe.sequential("任务保留提交的累计增删行", () => {
	it("逐提交累计，dirty 编辑不计入，重复探测不再读取已缓存提交的 diff", async () => {
		const first = commitText("a\nb\nc\n", "新增三行");
		const second = commitText("a\nc\n", "删除一行");
		await probe();
		const before = await history();
		expect(before.summary).toMatchObject({ status: "complete", commitCount: 2, additions: 3, deletions: 1 });
		expect(before.commits.map((commit) => commit.commitSha)).toEqual([second, first]);
		const runGit = vi.spyOn(gitUtilities, "runGit");
		writeFileSync(join(worktreePath, "task.txt"), "dirty\n".repeat(100));
		await probe();
		expect(await history()).toEqual(before);
		expect(runGit.mock.calls.filter(([, args]) => args[0] === "show" || args[0] === "diff-tree")).toHaveLength(0);
		const persisted = readFileSync(
			join(getWorkspaceDirectoryPath(workspaceId), "task-commit-integration-provenance.json"),
			"utf8",
		);
		expect(persisted).toContain("新增三行");
	});

	it("吸收 base 与合回后保留任务统计，删除 worktree 后仍能读取缓存", async () => {
		const ownCommit = commitText("a\nb\n", "任务新增两行");
		await probe();
		writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n".repeat(100));
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "其他任务的一百行"]);
		taskGit(["merge", "main", "--no-edit"]);
		await probe();
		expect((await history()).summary).toMatchObject({ commitCount: 1, additions: 2, deletions: 0 });
		repository.runGit(["merge", "--no-ff", "-m", "任务合回", taskGit(["rev-parse", "HEAD"])]);
		await probe();
		expect((await history()).commits.map((commit) => commit.commitSha)).toEqual([ownCommit]);
		await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		await probe(false);
		expect((await history()).summary).toMatchObject({ status: "complete", commitCount: 1, additions: 2 });
	});

	it("删除 worktree 后统计暂时失败仍保持未知，全量刷新重试后恢复且成功缓存不重复读取", async () => {
		commitText("a\nb\n", "任务新增两行");
		let shouldFail = true;
		const runGit = failCommitLineStatisticsWhile(() => shouldFail);
		await probe();
		await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		const failed = await metadata();
		expect(failed?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "unavailable",
			additions: null,
			deletions: null,
			unavailableReason: "commit_statistics_unavailable",
		});
		const readsBeforeRecovery = runGit.mock.calls.filter(([, args]) => args.includes("--numstat")).length;
		shouldFail = false;
		expect(await metadata(failed)).toBe(failed);
		expect(runGit.mock.calls.filter(([, args]) => args.includes("--numstat"))).toHaveLength(readsBeforeRecovery);
		if (!failed) throw new Error("缺少失败探测结果");
		const recovered = await metadata({ ...failed, lastFullRefreshAtMs: 0 });
		expect(recovered?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 1,
			additions: 2,
			deletions: 0,
		});
		expect(runGit.mock.calls.filter(([, args]) => args.includes("--numstat"))).toHaveLength(readsBeforeRecovery + 1);
		runGit.mockClear();
		if (!recovered) throw new Error("缺少恢复探测结果");
		const cached = { ...recovered, lastFullRefreshAtMs: 0 };
		expect(await metadata(cached)).toBe(cached);
		expect((await history()).summary).toEqual(recovered.data.taskRetainedCommittedLineChangeSummary);
		expect(runGit.mock.calls.filter(([, args]) => args.includes("--numstat"))).toHaveLength(0);
	});

	it("新提交统计暂时失败时摘要未知，live 与删除 worktree 的刷新都保留最后完整明细且读取不运行 Git", async () => {
		commitText("a\nb\n", "任务新增两行");
		await probe();
		const savedHistory = await history();
		commitText("a\nb\nc\n", "任务再新增一行");
		let shouldFail = true;
		const runGit = failCommitLineStatisticsWhile(() => shouldFail);
		const liveFailure = await metadata();
		expect(liveFailure?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "unavailable",
			additions: null,
			deletions: null,
			historyVersion: "unavailable:commit_statistics_unavailable",
		});
		runGit.mockClear();
		expect(await history()).toEqual(savedHistory);
		expect(runGit).not.toHaveBeenCalled();
		await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		const deletedFailure = await metadata(liveFailure);
		expect(deletedFailure?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "unavailable",
			additions: null,
			deletions: null,
			historyVersion: "unavailable:commit_statistics_unavailable",
		});
		runGit.mockClear();
		expect(await history()).toEqual(savedHistory);
		expect(runGit).not.toHaveBeenCalled();
		shouldFail = false;
		if (!deletedFailure) throw new Error("缺少删除后的失败探测结果");
		const recovered = await metadata({ ...deletedFailure, lastFullRefreshAtMs: 0 });
		expect(recovered?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 2,
			additions: 3,
			deletions: 0,
		});
		expect((await history()).summary).toEqual(recovered?.data.taskRetainedCommittedLineChangeSummary);
	});

	it("amend、rebase 和 reset 后不累计废弃的旧版本", async () => {
		commitText("a\n", "原始提交");
		await probe();
		writeFileSync(join(worktreePath, "task.txt"), "a\nb\n");
		taskGit(["add", "task.txt"]);
		taskGit(["commit", "--amend", "-m", "修订为两行"]);
		await probe();
		expect((await history()).summary).toMatchObject({ commitCount: 1, additions: 2, deletions: 0 });
		writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n");
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "推进 base"]);
		taskGit(["rebase", "main"]);
		await probe();
		expect((await history()).summary).toMatchObject({ commitCount: 1, additions: 2, deletions: 0 });
		taskGit(["reset", "--hard", initialCommit]);
		await probe();
		expect((await history()).summary).toMatchObject({
			status: "complete",
			commitCount: 0,
			additions: 0,
			deletions: 0,
		});
	});

	it.each([true, false])("仅改标题的 amend 等价落地后只累计当前版本，worktree 存在：%s", async (worktreeExists) => {
		const supersededCommit = commitText("a\nb\n", "原始两行提交");
		await probe();
		taskGit(["commit", "--amend", "-m", "仅修订提交标题"]);
		const retainedCommit = taskGit(["rev-parse", "HEAD"]);
		expect(retainedCommit).not.toBe(supersededCommit);
		await probe();
		expect((await history()).summary).toMatchObject({ commitCount: 1, additions: 2, deletions: 0 });
		if (!worktreeExists) await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		repository.runGit(["cherry-pick", "-x", retainedCommit]);
		expect(repository.runGit(["rev-parse", "HEAD"]).stdout.trim()).not.toBe(retainedCommit);
		const status = await probe(worktreeExists);
		expect(status.taskCommitsIntegratedIntoBaseRef).toBe(1);
		const retainedHistory = await history();
		expect(retainedHistory.summary).toMatchObject({ status: "complete", commitCount: 1, additions: 2, deletions: 0 });
		expect(retainedHistory.commits.map((commit) => commit.commitSha)).toEqual([retainedCommit]);
	});

	it("reset 后仍累计此前独立等价落地的提交", async () => {
		const landedCommit = commitText("a\nb\n", "先独立落地的两行");
		await probe();
		repository.runGit(["cherry-pick", "-x", landedCommit]);
		await probe();
		taskGit(["reset", "--hard", initialCommit]);
		const currentCommit = commitText("c\nd\ne\n", "reset 后的新三行");
		await probe();
		expect((await history()).summary).toMatchObject({ commitCount: 2, additions: 5, deletions: 0 });
		expect(new Set((await history()).commits.map((commit) => commit.commitSha))).toEqual(
			new Set([landedCommit, currentCommit]),
		);
		await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		await probe(false);
		expect((await history()).summary).toMatchObject({
			status: "complete",
			commitCount: 2,
			additions: 5,
			deletions: 0,
		});
	});

	it("空提交、重命名和二进制文件不虚增文本行数", async () => {
		commitText("a\nb\n", "新增文本");
		taskGit(["mv", "task.txt", "重命名\t多行\n文件.txt"]);
		writeFileSync(join(worktreePath, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		taskGit(["add", "binary.bin"]);
		taskGit(["commit", "-m", "重命名与二进制"]);
		taskGit(["commit", "--allow-empty", "-m", "空提交"]);
		await probe();
		expect((await history()).summary).toMatchObject({
			status: "complete",
			commitCount: 3,
			additions: 2,
			deletions: 0,
		});
	});

	it("没有可靠任务历史时显示未知，不冒充零", async () => {
		const result = await readTaskRetainedCommittedLineChangeHistory(workspaceId, "missing-task");
		expect(result.summary).toMatchObject({ status: "unavailable", additions: null, deletions: null });
	});
});
