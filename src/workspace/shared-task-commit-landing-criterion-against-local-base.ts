// dd2db 1c 共享落地判据（§R3 Y-PHASE-3，即 d-gate 条件 3）：
// 取 task 最新一世里、从最后已知 HEAD 可达的非 merge 自有提交集合 S；|S| ≥ 1，且 S 中每个提交都按
// exact SHA → stable patch-id 一对一匹配进了本地 base，才算「task 的提交已落地到本地 base」。
// 门条件 3/4、义务 M17、覆盖核对都只经这里求值——不许再出现第二套「算不算落地」的判据。
// 部署归属（src/deployment/task-deployment-attribution-from-commit-integration-provenance.ts）复用本文件的匹配器，
// 回答的是「哪些 task 随这次部署上线」，不是落地判据。
// 不读拓扑 ahead：吸收 base 产生的 merge 与被 rebase 丢掉的旧 SHA 都不在 S 里，ahead 计数会被它们卡死。

export interface TaskCommitShaWithStablePatchId {
	commitSha: string;
	// merge / 空提交没有 patch-id，只能走 exact SHA。
	stablePatchId: string | null;
}

export type TaskCommitIntegrationIntoBaseRefMatchKind = "exact_commit_sha" | "stable_patch_id_equivalent";

export interface TaskCommitIntegratedIntoBaseRefMatch {
	taskCommitSha: string;
	taskCommitStablePatchId: string | null;
	taskCommitIntegrationIntoBaseRefMatchKind: TaskCommitIntegrationIntoBaseRefMatchKind;
	// base 侧被消费掉的那个提交：exact 时与 taskCommitSha 相同，patch-id 等价时是 cherry-pick / rebase 后的新 SHA。
	matchedBaseRefCommitSha: string;
}

export interface TaskCommitsOneToOneMatchIntoBaseRefCommits {
	taskCommitsIntegratedIntoBaseRef: TaskCommitIntegratedIntoBaseRefMatch[];
	taskCommitsNotIntegratedIntoBaseRef: TaskCommitShaWithStablePatchId[];
}

/**
 * 一对一关联 task 提交与 base 提交：先消费 exact SHA，再消费 stable patch-id；base 侧每个提交最多消费一次，
 * 防止重复 patch 被虚高计数。结果里两组都保持 task 提交的输入顺序。
 */
export function matchTaskCommitsOneToOneIntoBaseRefCommits(input: {
	taskCommits: readonly TaskCommitShaWithStablePatchId[];
	baseRefCommits: readonly TaskCommitShaWithStablePatchId[];
}): TaskCommitsOneToOneMatchIntoBaseRefCommits {
	const unconsumedBaseCommitIndexes = new Set(input.baseRefCommits.map((_commit, index) => index));
	const matchByTaskCommitIndex = new Map<number, TaskCommitIntegratedIntoBaseRefMatch>();

	input.taskCommits.forEach((taskCommit, taskCommitIndex) => {
		const exactBaseCommitIndex = input.baseRefCommits.findIndex(
			(baseCommit, index) => unconsumedBaseCommitIndexes.has(index) && baseCommit.commitSha === taskCommit.commitSha,
		);
		if (exactBaseCommitIndex >= 0) {
			unconsumedBaseCommitIndexes.delete(exactBaseCommitIndex);
			matchByTaskCommitIndex.set(taskCommitIndex, {
				taskCommitSha: taskCommit.commitSha,
				taskCommitStablePatchId: taskCommit.stablePatchId,
				taskCommitIntegrationIntoBaseRefMatchKind: "exact_commit_sha",
				matchedBaseRefCommitSha: taskCommit.commitSha,
			});
		}
	});

	input.taskCommits.forEach((taskCommit, taskCommitIndex) => {
		if (matchByTaskCommitIndex.has(taskCommitIndex) || taskCommit.stablePatchId === null) {
			return;
		}
		const patchEquivalentBaseCommitIndex = input.baseRefCommits.findIndex(
			(baseCommit, index) =>
				unconsumedBaseCommitIndexes.has(index) && baseCommit.stablePatchId === taskCommit.stablePatchId,
		);
		if (patchEquivalentBaseCommitIndex >= 0) {
			unconsumedBaseCommitIndexes.delete(patchEquivalentBaseCommitIndex);
			matchByTaskCommitIndex.set(taskCommitIndex, {
				taskCommitSha: taskCommit.commitSha,
				taskCommitStablePatchId: taskCommit.stablePatchId,
				taskCommitIntegrationIntoBaseRefMatchKind: "stable_patch_id_equivalent",
				matchedBaseRefCommitSha: input.baseRefCommits[patchEquivalentBaseCommitIndex]?.commitSha ?? "",
			});
		}
	});

	const taskCommitsIntegratedIntoBaseRef: TaskCommitIntegratedIntoBaseRefMatch[] = [];
	const taskCommitsNotIntegratedIntoBaseRef: TaskCommitShaWithStablePatchId[] = [];
	input.taskCommits.forEach((taskCommit, taskCommitIndex) => {
		const match = matchByTaskCommitIndex.get(taskCommitIndex);
		if (match) {
			taskCommitsIntegratedIntoBaseRef.push(match);
		} else {
			taskCommitsNotIntegratedIntoBaseRef.push({
				commitSha: taskCommit.commitSha,
				stablePatchId: taskCommit.stablePatchId,
			});
		}
	});
	return { taskCommitsIntegratedIntoBaseRef, taskCommitsNotIntegratedIntoBaseRef };
}

export const SHARED_TASK_COMMIT_LANDING_CRITERION_OUTCOMES = [
	// 判据满足：|S| ≥ 1 且全部一对一进了本地 base。
	"all_task_owned_non_merge_commits_integrated_into_local_base",
	// 部分进了：可能是 squash 落地（机器判不了，门的关注通知交给用户裁决），也可能是还有提交没交回。
	"task_owned_non_merge_commits_partially_integrated_into_local_base",
	"no_task_owned_non_merge_commit_integrated_into_local_base",
	// S 为空：这一世没产出自有提交（或全部被 rebase 丢掉）。不是「已落地」。
	"no_task_owned_non_merge_commit_reachable_from_last_known_task_head",
] as const;
export type SharedTaskCommitLandingCriterionOutcome = (typeof SHARED_TASK_COMMIT_LANDING_CRITERION_OUTCOMES)[number];

export interface SharedTaskCommitLandingCriterionEvaluation extends TaskCommitsOneToOneMatchIntoBaseRefCommits {
	sharedTaskCommitLandingCriterionOutcome: SharedTaskCommitLandingCriterionOutcome;
}

export function evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits(input: {
	taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: readonly TaskCommitShaWithStablePatchId[];
	// 本地 base 上「provenance 起点之后」的提交（含 patch-id），与 task 提交集合的覆盖面一致。
	localBaseRefCommits: readonly TaskCommitShaWithStablePatchId[];
}): SharedTaskCommitLandingCriterionEvaluation {
	const match = matchTaskCommitsOneToOneIntoBaseRefCommits({
		taskCommits: input.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
		baseRefCommits: input.localBaseRefCommits,
	});
	return { ...match, sharedTaskCommitLandingCriterionOutcome: classifySharedTaskCommitLandingCriterionOutcome(match) };
}

function classifySharedTaskCommitLandingCriterionOutcome(
	match: TaskCommitsOneToOneMatchIntoBaseRefCommits,
): SharedTaskCommitLandingCriterionOutcome {
	const integratedCount = match.taskCommitsIntegratedIntoBaseRef.length;
	const notIntegratedCount = match.taskCommitsNotIntegratedIntoBaseRef.length;
	if (integratedCount === 0 && notIntegratedCount === 0) {
		return "no_task_owned_non_merge_commit_reachable_from_last_known_task_head";
	}
	if (notIntegratedCount === 0) {
		return "all_task_owned_non_merge_commits_integrated_into_local_base";
	}
	return integratedCount === 0
		? "no_task_owned_non_merge_commit_integrated_into_local_base"
		: "task_owned_non_merge_commits_partially_integrated_into_local_base";
}
