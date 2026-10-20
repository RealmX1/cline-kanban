import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTaskRetainedCommittedLineChangeStatistics } from "../../../src/workspace/task-retained-committed-line-change-statistics";

const runGit = vi.hoisted(() => vi.fn());
vi.mock("../../../src/workspace/git-utils", () => ({ runGit }));

beforeEach(() => {
	runGit.mockReset();
	runGit.mockImplementation(async (_cwd: string, args: string[]) => ({
		ok: true,
		stdout: args
			.filter((arg) => /^[a-f0-9]{40}$/.test(arg))
			.map((sha) => `\0KANBAN_COMMIT_LINE_STATISTICS\0${sha}\0parent\0${1792500000}\0新增文本\0\n2\t1\tfile.txt\0`)
			.join(""),
	}));
});

describe("不可变提交统计缓存", () => {
	it("130 个提交只批量读取三次，缓存命中为零次，新增一个提交只补算它", async () => {
		const retainedCommitShas = Array.from({ length: 130 }, (_, index) => index.toString(16).padStart(40, "0"));
		const first = await refreshTaskRetainedCommittedLineChangeStatistics({
			repoPath: "/isolated",
			retainedCommitShas,
			cachedStatisticsByCommitSha: {},
		});
		expect(first.history.summary).toMatchObject({
			status: "complete",
			commitCount: 130,
			additions: 260,
			deletions: 130,
		});
		expect(runGit).toHaveBeenCalledTimes(3);
		runGit.mockClear();
		const cached = await refreshTaskRetainedCommittedLineChangeStatistics({
			repoPath: "/isolated",
			retainedCommitShas,
			cachedStatisticsByCommitSha: first.cachedStatisticsByCommitSha,
		});
		expect(cached.history).toEqual(first.history);
		expect(runGit).not.toHaveBeenCalled();
		const addedSha = "f".repeat(40);
		const next = await refreshTaskRetainedCommittedLineChangeStatistics({
			repoPath: "/isolated",
			retainedCommitShas: [...retainedCommitShas, addedSha],
			cachedStatisticsByCommitSha: first.cachedStatisticsByCommitSha,
		});
		expect(next.history.summary.commitCount).toBe(131);
		expect(runGit).toHaveBeenCalledTimes(1);
		expect(runGit.mock.calls[0]?.[1].filter((arg: string) => /^[a-f0-9]{40}$/.test(arg))).toEqual([addedSha]);
	});

	it("读取失败保持未知，下一次仍会重新读取", async () => {
		const commitSha = "a".repeat(40);
		runGit.mockResolvedValueOnce({ ok: false, stdout: "" });
		const failed = await refreshTaskRetainedCommittedLineChangeStatistics({
			repoPath: "/isolated",
			retainedCommitShas: [commitSha],
			cachedStatisticsByCommitSha: {},
		});
		expect(failed.history.summary).toMatchObject({ status: "unavailable", additions: null });
		const retried = await refreshTaskRetainedCommittedLineChangeStatistics({
			repoPath: "/isolated",
			retainedCommitShas: [commitSha],
			cachedStatisticsByCommitSha: failed.cachedStatisticsByCommitSha,
		});
		expect(retried.history.summary).toMatchObject({ status: "complete", additions: 2 });
	});
});
