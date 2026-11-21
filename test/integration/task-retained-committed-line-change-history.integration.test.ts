import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import * as gitUtilities from "../../src/workspace/git-utils";
import {
	probeAndRefreshTaskCommitIntegrationProvenance,
	readSourceTaskCommitLandingReadiness,
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

async function metadata(
	current: CachedTaskWorkspaceMetadata | null = null,
	resolveBaseRefTip = createBaseRefTipResolver(repository.repositoryPath),
) {
	return await loadTaskWorkspaceMetadata(
		workspaceId,
		repository.repositoryPath,
		{ taskId, baseRef: "main", taskCardBoardColumnId: "review", taskCardAutoReviewEnabled: false },
		current,
		resolveBaseRefTip,
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
	it("门控取样后 base 推进且任务吸收时，两次探针均不登记继承提交", async () => {
		const concurrentRefresh = await metadata(null, async () => {
			writeFileSync(join(repository.repositoryPath, "base.txt"), "其他任务\n".repeat(19));
			repository.runGit(["add", "base.txt"]);
			repository.runGit(["commit", "-m", "门控取样后推进 base"]);
			taskGit(["merge", "--ff-only", "main"]);
			return initialCommit;
		});
		expect(concurrentRefresh?.data.workspaceGitStatus).toMatchObject({
			commitsAheadOfBaseRef: 0,
			commitsBehindBaseRef: 0,
			taskCommitsIntegratedIntoBaseRef: 0,
		});
		expect((await history()).summary).toMatchObject({ status: "complete", commitCount: 0, additions: 0 });
		expect((await probe()).taskCommitsIntegratedIntoBaseRef).toBe(0);
		expect((await history()).commits).toEqual([]);
	});

	it("base 吸收后回退到创建锚点，继承提交仍不算自有产出", async () => {
		writeFileSync(join(repository.repositoryPath, "base.txt"), "其他任务\n");
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "随后回退的 base 提交"]);
		taskGit(["merge", "--ff-only", "main"]);
		repository.runGit(["reset", "--hard", initialCommit]);
		const status = await probe();
		expect(status.commitsAheadOfBaseRef).toBe(1);
		expect((await history()).summary).toMatchObject({ status: "complete", commitCount: 0, additions: 0 });
	});

	it("HEAD 读取与廉价 token 取样之间新增提交时，下一次刷新会重新读取 HEAD", async () => {
		const realRunGit = gitUtilities.runGit;
		let newHeadCommit: string | undefined;
		vi.spyOn(gitUtilities, "runGit").mockImplementation(async (cwd, args, options) => {
			const result = await realRunGit(cwd, args, options);
			if (!newHeadCommit && cwd === worktreePath && args.includes("--porcelain=v2") && args.includes("--branch")) {
				newHeadCommit = commitText("并发新增\n", "探针读取 HEAD 后创建提交");
			}
			return result;
		});
		const previousHeadMetadata = await metadata();
		expect(previousHeadMetadata?.data.headCommit).toBe(initialCommit);
		expect(newHeadCommit).toBeDefined();
		const refreshedMetadata = await metadata(previousHeadMetadata);
		expect(refreshedMetadata?.data.headCommit).toBe(newHeadCommit);
		expect(refreshedMetadata?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 1,
			additions: 1,
		});
	});

	it("旧快照证明落地后，本次探针缺证且 HEAD 已变时不再证明落地", async () => {
		const landedCommit = commitText("a\n", "已落地的一行");
		repository.runGit(["merge", "--ff-only", landedCommit]);
		await probe();
		const readinessInput = {
			workspaceId,
			taskId,
			repoPath: repository.repositoryPath,
			localBaseRef: "main",
			liveWorktreePath: worktreePath,
		};
		expect(await readSourceTaskCommitLandingReadiness(readinessInput)).toBe(true);
		writeFileSync(join(repository.repositoryPath, "base.txt"), "继承\n");
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "推进 base"]);
		taskGit(["merge", "--ff-only", "main"]);
		taskGit(["reflog", "expire", "--expire=all", "HEAD"]);
		commitText("a\nb\n", "当前未落地提交");
		expect((await probe()).taskCommitIntegrationTrackingStatus).toBe("task_commit_ownership_history_incomplete");
		expect(await readSourceTaskCommitLandingReadiness(readinessInput)).toBe(false);
		expect((await history()).commits.map(({ commitSha }) => commitSha)).toEqual([landedCommit]);
	});

	it("早先落地的提交首次探测前已被 amend，仍保留旧提交及当前版本", async () => {
		const landedCommit = commitText("a\n", "早先已落地的一行");
		repository.runGit(["merge", "--ff-only", landedCommit]);
		writeFileSync(join(worktreePath, "task.txt"), "a\nb\n");
		taskGit(["add", "task.txt"]);
		taskGit(["commit", "--amend", "-m", "当前未落地的两行"]);
		const amendedCommit = taskGit(["rev-parse", "HEAD"]);
		await probe();
		const retained = await history();
		expect(retained.summary).toMatchObject({ status: "complete", commitCount: 2, additions: 3 });
		expect(retained.commits.map(({ commitSha }) => commitSha)).toEqual([amendedCommit, landedCommit]);
	});

	it.each(["切换到同 SHA 分支", "完成 detached rebase"])("%s 后首次落地探测可补采", async (operation) => {
		if (operation === "切换到同 SHA 分支") taskGit(["checkout", "-b", "task-branch"]);
		commitText("a\nb\n", "任务新增两行");
		if (operation === "完成 detached rebase") {
			writeFileSync(join(repository.repositoryPath, "base.txt"), "继承\n");
			repository.runGit(["add", "base.txt"]);
			repository.runGit(["commit", "-m", "推进 base"]);
			taskGit(["rebase", "main"]);
		}
		const landedCommit = taskGit(["rev-parse", "HEAD"]);
		repository.runGit(["merge", "--ff-only", landedCommit]);
		await probe();
		expect((await history()).summary).toMatchObject({ status: "complete", commitCount: 1, additions: 2 });
		expect((await history()).commits.map(({ commitSha }) => commitSha)).toEqual([landedCommit]);
	});

	it("已核验的继承前缀在 reflog 过期后可供新 HEAD 使用", async () => {
		writeFileSync(join(repository.repositoryPath, "base.txt"), "继承\n");
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "推进 base"]);
		taskGit(["merge", "--ff-only", "main"]);
		expect((await metadata())?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 0,
		});
		taskGit(["reflog", "expire", "--expire=all", "HEAD"]);
		const soleTaskCommit = commitText("a\nb\n", "过期后新增两行");
		expect((await metadata())?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 1,
			additions: 2,
		});
		expect((await history()).commits.map(({ commitSha }) => commitSha)).toEqual([soleTaskCommit]);
	});

	it("同秒提交跨本地 base 和当前 HEAD 时子提交排在父提交前", async () => {
		const commitAtSameSecond = (contents: string, message: string) => {
			writeFileSync(join(worktreePath, "task.txt"), contents);
			return repository.commitAllRepositoryFilesAtDate({
				message,
				authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
				workingDirectoryPath: worktreePath,
			});
		};
		const parent = commitAtSameSecond("a\n", "已落地的一行");
		repository.runGit(["merge", "--ff-only", parent]);
		const child = commitAtSameSecond("a\nb\n", "仍在任务工作树的一行");
		await probe();
		expect((await history()).commits.map(({ commitSha }) => commitSha)).toEqual([child, parent]);
	});

	it("首次探测前 reset 到创建锚点时只恢复已落地的任务提交", async () => {
		const landedCommit = commitText("a\nb\n", "仍在 base 的两行");
		repository.runGit(["merge", "--ff-only", landedCommit]);
		commitText("a\nb\nc\n", "随后丢弃的一行");
		taskGit(["reset", "--hard", initialCommit]);
		expect((await metadata())?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 1,
			additions: 2,
		});
		expect((await history()).commits.map(({ commitSha }) => commitSha)).toEqual([landedCommit]);
		await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		expect((await metadata())?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 1,
			additions: 2,
		});
	});

	it("只吸收 base 时仍是零提交，补回 reflog 后同一探针缓存能重验", async () => {
		writeFileSync(join(repository.repositoryPath, "base.txt"), "其他任务的改动\n");
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "推进 base"]);
		taskGit(["merge", "--ff-only", "main"]);
		const before = await metadata();
		expect(before?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({ status: "complete", commitCount: 0 });
		const commit = commitText("a\n", "任务提交");
		writeFileSync(join(worktreePath, "task.txt"), "a\nb\n");
		taskGit(["add", "task.txt"]);
		taskGit(["commit", "--amend", "--no-edit"]);
		const amendedCommit = taskGit(["rev-parse", "HEAD"]);
		expect(amendedCommit).not.toBe(commit);
		repository.runGit(["merge", "--ff-only", amendedCommit]);
		const reflogPath = resolve(worktreePath, taskGit(["rev-parse", "--git-path", "logs/HEAD"]));
		const reflog = readFileSync(reflogPath);
		taskGit(["reflog", "expire", "--expire=all", "HEAD"]);
		const missingEvidence = await metadata(before);
		expect(missingEvidence?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "unavailable",
			unavailableReason: "task_commit_ownership_history_incomplete",
		});
		expect(await metadata(missingEvidence)).toBe(missingEvidence);
		writeFileSync(reflogPath, reflog);
		const recovered = await metadata(missingEvidence);
		expect(recovered?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 1,
			additions: 2,
			deletions: 0,
		});
		expect((await history()).commits.map(({ commitSha }) => commitSha)).toEqual([amendedCommit]);
		taskGit(["reflog", "expire", "--expire=all", "HEAD"]);
		expect((await metadata())?.data.taskRetainedCommittedLineChangeSummary).toEqual(
			recovered?.data.taskRetainedCommittedLineChangeSummary,
		);
	});

	it.each([false, true])("任务提交在探测前合入 base，已有任务提交记录：%s", async (hasEarlierObservation) => {
		const first = commitText("a\nb\n", "任务先新增两行");
		if (hasEarlierObservation) await probe();
		const second = commitText("a\nb\nc\n", "随后漏采的一行");
		writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n".repeat(100));
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "-m", "其他任务的一百行"]);
		taskGit(["merge", "main", "--no-edit"]);
		repository.runGit(["merge", "--ff-only", taskGit(["rev-parse", "HEAD"])]);
		const recoveredMetadata = await metadata();
		expect(recoveredMetadata?.data.taskRetainedCommittedLineChangeSummary).toMatchObject({
			status: "complete",
			commitCount: 2,
			additions: 3,
			deletions: 0,
		});
		const recoveredHistory = await history();
		expect(recoveredHistory.commits.map((commit) => commit.commitSha)).toEqual([second, first]);
		expect(recoveredHistory.summary).toEqual(recoveredMetadata?.data.taskRetainedCommittedLineChangeSummary);
		await deleteTaskWorktree({ repoPath: repository.repositoryPath, taskId });
		expect((await metadata())?.data.taskRetainedCommittedLineChangeSummary).toEqual(recoveredHistory.summary);
		expect(await history()).toEqual(recoveredHistory);
	});

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
