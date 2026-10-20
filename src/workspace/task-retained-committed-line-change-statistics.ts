import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	RuntimeTaskRetainedCommittedLineChangeCommit,
	RuntimeTaskRetainedCommittedLineChangeHistory,
} from "../core/api-contract";
import { runtimeTaskRetainedCommittedLineChangeCommitSchema } from "../core/api-contract";
import { runGit } from "./git-utils";

export const cachedTaskCommitLineChangeStatisticsSchema = runtimeTaskRetainedCommittedLineChangeCommitSchema.extend({
	isMergeCommit: z.boolean(),
});
export type CachedTaskCommitLineChangeStatistics = z.infer<typeof cachedTaskCommitLineChangeStatisticsSchema>;

export function createUnavailableTaskRetainedCommittedLineChangeHistory(
	unavailableReason: string,
): RuntimeTaskRetainedCommittedLineChangeHistory {
	return {
		summary: {
			status: "unavailable",
			commitCount: null,
			additions: null,
			deletions: null,
			historyVersion: `unavailable:${unavailableReason}`,
			unavailableReason,
		},
		commits: [],
	};
}

// NUL 分隔同时保护提交标题、带换行/制表符的路径和 rename 的双路径记录。
function parseCommitLineChangeStatistics(output: string): CachedTaskCommitLineChangeStatistics[] {
	const tokens = output.split("\0");
	const commits: CachedTaskCommitLineChangeStatistics[] = [];
	let current: CachedTaskCommitLineChangeStatistics | null = null;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.trim() === "KANBAN_COMMIT_LINE_STATISTICS") {
			const commitSha = tokens[++index] ?? "";
			const parents = tokens[++index] ?? "";
			const committedAtMs = Number(tokens[++index]) * 1000;
			const subject = tokens[++index] ?? "";
			if (!/^[a-f0-9]{40,64}$/.test(commitSha) || !Number.isFinite(committedAtMs)) {
				throw new Error("提交行数统计的 Git 输出不完整");
			}
			current = {
				commitSha,
				subject,
				committedAtMs,
				isMergeCommit: parents.split(" ").filter(Boolean).length > 1,
				additions: 0,
				deletions: 0,
			};
			commits.push(current);
			continue;
		}
		const stat = token.match(/^\n?([\d]+|-)\t([\d]+|-)\t([\s\S]*)$/);
		if (!stat || !current) continue;
		current.additions += stat[1] === "-" ? 0 : Number(stat[1]);
		current.deletions += stat[2] === "-" ? 0 : Number(stat[2]);
		if (stat[3] === "") index += 2;
	}
	return commits;
}

export async function refreshTaskRetainedCommittedLineChangeStatistics(input: {
	repoPath: string;
	retainedCommitShas: readonly string[];
	cachedStatisticsByCommitSha: Record<string, CachedTaskCommitLineChangeStatistics>;
}): Promise<{
	history: RuntimeTaskRetainedCommittedLineChangeHistory;
	cachedStatisticsByCommitSha: Record<string, CachedTaskCommitLineChangeStatistics>;
}> {
	const cachedStatisticsByCommitSha = { ...input.cachedStatisticsByCommitSha };
	const retainedCommitShas = [...new Set(input.retainedCommitShas)];
	const missingCommitShas = retainedCommitShas.filter((sha) => !cachedStatisticsByCommitSha[sha]);
	// 每批最多 64 个不可变对象，沿用调用者的全局探针限流；不为每个提交再 spawn 一次 Git。
	for (let offset = 0; offset < missingCommitShas.length; offset += 64) {
		const result = await runGit(input.repoPath, [
			"show",
			"--no-walk=unsorted",
			"--format=%x00KANBAN_COMMIT_LINE_STATISTICS%x00%H%x00%P%x00%ct%x00%s%x00",
			"--numstat",
			"-z",
			"--find-renames",
			"--no-ext-diff",
			"--no-textconv",
			...missingCommitShas.slice(offset, offset + 64),
			"--",
		]);
		if (!result.ok) {
			return {
				history: createUnavailableTaskRetainedCommittedLineChangeHistory("commit_statistics_unavailable"),
				cachedStatisticsByCommitSha,
			};
		}
		for (const commit of parseCommitLineChangeStatistics(result.stdout)) {
			cachedStatisticsByCommitSha[commit.commitSha] = commit;
		}
	}
	if (retainedCommitShas.some((sha) => !cachedStatisticsByCommitSha[sha])) {
		return {
			history: createUnavailableTaskRetainedCommittedLineChangeHistory("commit_statistics_incomplete"),
			cachedStatisticsByCommitSha,
		};
	}
	const commits: RuntimeTaskRetainedCommittedLineChangeCommit[] = retainedCommitShas.flatMap((sha) => {
		const commit = cachedStatisticsByCommitSha[sha];
		if (!commit || commit.isMergeCommit) return [];
		const { isMergeCommit: _isMergeCommit, ...statistics } = commit;
		return [statistics];
	});
	// 同一秒内连续提交也保持历史顺序，不能按 SHA 的随机字典序排列。
	const retainedOrder = new Map(retainedCommitShas.map((sha, index) => [sha, index]));
	commits.sort(
		(left, right) =>
			right.committedAtMs - left.committedAtMs ||
			(retainedOrder.get(right.commitSha) ?? 0) - (retainedOrder.get(left.commitSha) ?? 0),
	);
	return {
		history: {
			summary: {
				status: "complete",
				commitCount: commits.length,
				additions: commits.reduce((sum, commit) => sum + commit.additions, 0),
				deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
				historyVersion: createHash("sha256").update(JSON.stringify(commits)).digest("hex"),
				unavailableReason: null,
			},
			commits,
		},
		cachedStatisticsByCommitSha,
	};
}
