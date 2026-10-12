import pLimit from "p-limit";
import type {
	RuntimePostDeployVerificationMatchedDeployedCommit,
	RuntimePostDeployVerificationTaskDeploymentAttribution,
	RuntimePostDeployVerificationTaskDeploymentAttributionZone,
	RuntimePostDeployVerificationTaskDeploymentUnattributableReason,
} from "../core/api-contract";
import { computeStablePatchIdsOfNonMergeCommitsInRevisionRange, runGit } from "../workspace/git-utils";
import {
	matchTaskCommitsOneToOneIntoBaseRefCommits,
	type TaskCommitShaWithStablePatchId,
} from "../workspace/shared-task-commit-landing-criterion-against-local-base";
import type { ObservedTaskCommit } from "../workspace/task-commit-integration-provenance";
import { readObservedTaskCommitsAcrossIncarnationsByTaskId } from "../workspace/task-commit-integration-provenance";

// 「这个任务属于哪次部署」：拿任务持久化的提交来历（task-commit-integration-provenance，sha + stable patch-id，
// worktree 删掉后仍在）去一对一匹配部署区间 previousDeployedSourceCommit..deployedSourceCommit 里的提交。
// 匹配器与 dd2db 共享落地判据是同一个（先 exact SHA、再 patch-id，部署侧每个提交最多消费一次）。
//
// 取代了旧的 task-deploy-correlation（2026-10-11 删除）：它取 worktree 的 merge-base(baseRef,HEAD)..HEAD，任务提交一合进 main 这段就是空的，
// 实盘 21 个部署组里按提交关联到的任务一个都没有，于是每次部署都只能把 Validation 列全量塞进来。

const DEPLOYMENT_ATTRIBUTION_GIT_CONCURRENCY_LIMIT = 4;
// 「提交已在已部署 commit 里、但早于保留的部署记录」的兜底判定每个任务最多试这么多个提交（逐个 merge-base --is-ancestor）。
const MAX_TASK_COMMITS_PROBED_FOR_ANCESTRY_OF_DEPLOYED_SOURCE_COMMIT = 20;
const DEPLOYMENT_DELTA_COMMIT_IDENTITIES_CACHE_MAX_ENTRIES = 64;

export interface DeploymentForTaskDeploymentAttribution {
	deploymentId: string;
	deployedSourceCommit: string;
	previousDeployedSourceCommit: string | null;
	deployedAtIso: string;
}

export interface TaskDeploymentAttributionComputation {
	taskDeploymentAttribution: RuntimePostDeployVerificationTaskDeploymentAttribution;
	firstDeployedInDeploymentId: string | null;
	firstDeployedAtIso: string | null;
	firstDeploymentPredatesRetainedDeploymentRecords: boolean;
}

const deploymentDeltaCommitIdentitiesByRangeCacheKey = new Map<
	string,
	Promise<TaskCommitShaWithStablePatchId[] | null>
>();

/**
 * 部署区间里的全部提交（含 merge，merge 没有 patch-id、只走 exact）。按 (repo, range) 缓存：runtime 每 30s 对账都会
 * 用到同一批部署区间，区间内容不可变。
 */
async function loadDeploymentDeltaCommitIdentities(
	repositoryPath: string,
	previousDeployedSourceCommit: string,
	deployedSourceCommit: string,
): Promise<TaskCommitShaWithStablePatchId[] | null> {
	const revisionRange = `${previousDeployedSourceCommit}..${deployedSourceCommit}`;
	const cacheKey = `${repositoryPath}\0${revisionRange}`;
	const cached = deploymentDeltaCommitIdentitiesByRangeCacheKey.get(cacheKey);
	if (cached) {
		return await cached;
	}
	const pending = (async (): Promise<TaskCommitShaWithStablePatchId[] | null> => {
		const revList = await runGit(repositoryPath, ["rev-list", revisionRange]);
		if (!revList.ok) {
			return null;
		}
		const commitShas = revList.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const patchIdByCommitSha = await computeStablePatchIdsOfNonMergeCommitsInRevisionRange(
			repositoryPath,
			revisionRange,
		);
		if (patchIdByCommitSha === null) {
			return null;
		}
		return commitShas.map((commitSha) => ({ commitSha, stablePatchId: patchIdByCommitSha.get(commitSha) ?? null }));
	})();
	deploymentDeltaCommitIdentitiesByRangeCacheKey.set(cacheKey, pending);
	// 失败不缓存：git 暂时不可用（锁、对象还没 fetch 到）时下一轮对账应能重试。
	void pending.then((result) => {
		if (result === null) {
			deploymentDeltaCommitIdentitiesByRangeCacheKey.delete(cacheKey);
		}
	});
	while (deploymentDeltaCommitIdentitiesByRangeCacheKey.size > DEPLOYMENT_DELTA_COMMIT_IDENTITIES_CACHE_MAX_ENTRIES) {
		const oldestCacheKey = deploymentDeltaCommitIdentitiesByRangeCacheKey.keys().next().value;
		if (typeof oldestCacheKey !== "string") {
			break;
		}
		deploymentDeltaCommitIdentitiesByRangeCacheKey.delete(oldestCacheKey);
	}
	return await pending;
}

function toMatchedDeployedCommits(
	taskCommits: readonly ObservedTaskCommit[],
	deploymentDeltaCommits: readonly TaskCommitShaWithStablePatchId[],
): RuntimePostDeployVerificationMatchedDeployedCommit[] {
	return matchTaskCommitsOneToOneIntoBaseRefCommits({
		taskCommits,
		baseRefCommits: deploymentDeltaCommits,
	}).taskCommitsIntegratedIntoBaseRef.map((match) => ({
		taskCommitSha: match.taskCommitSha,
		deployedCommitSha: match.matchedBaseRefCommitSha,
		taskCommitMatchKind: match.taskCommitIntegrationIntoBaseRefMatchKind,
	}));
}

async function isAnyTaskCommitAncestorOfDeployedSourceCommit(
	repositoryPath: string,
	taskCommits: readonly ObservedTaskCommit[],
	deployedSourceCommit: string,
): Promise<boolean> {
	for (const taskCommit of taskCommits.slice(-MAX_TASK_COMMITS_PROBED_FOR_ANCESTRY_OF_DEPLOYED_SOURCE_COMMIT)) {
		const ancestry = await runGit(repositoryPath, [
			"merge-base",
			"--is-ancestor",
			taskCommit.commitSha,
			deployedSourceCommit,
		]);
		if (ancestry.ok) {
			return true;
		}
	}
	return false;
}

// 更早的保留部署逐个探测「任务提交是否随它上线」的两种方式：有前驱的比对区间提交；没有前驱的（史上首次部署）
// 没有区间可算，按与 target 自身没有前驱时同一语义——任务提交是它 deployedSourceCommit 的祖先，即随它上线。
type EarlierRetainedDeploymentContainmentProbe =
	| {
			kind: "deployment_delta_commits_matched_one_to_one_against_task_commits";
			deployment: DeploymentForTaskDeploymentAttribution;
			deploymentDeltaCommits: TaskCommitShaWithStablePatchId[];
	  }
	| {
			kind: "deployment_without_previous_deployed_source_commit_contains_task_commits_reachable_from_deployed_source_commit";
			deployment: DeploymentForTaskDeploymentAttribution;
	  };

async function findEarliestEarlierRetainedDeploymentContainingTaskCommits(
	repositoryPath: string,
	taskCommits: readonly ObservedTaskCommit[],
	probesInAscendingDeploymentOrder: readonly EarlierRetainedDeploymentContainmentProbe[],
): Promise<DeploymentForTaskDeploymentAttribution | null> {
	for (const probe of probesInAscendingDeploymentOrder) {
		if (probe.kind === "deployment_delta_commits_matched_one_to_one_against_task_commits") {
			if (toMatchedDeployedCommits(taskCommits, probe.deploymentDeltaCommits).length > 0) {
				return probe.deployment;
			}
			continue;
		}
		if (
			await isAnyTaskCommitAncestorOfDeployedSourceCommit(
				repositoryPath,
				taskCommits,
				probe.deployment.deployedSourceCommit,
			)
		) {
			return probe.deployment;
		}
	}
	return null;
}

function buildUnattributableComputation(
	unattributableReason: RuntimePostDeployVerificationTaskDeploymentUnattributableReason,
	nowIso: string,
): TaskDeploymentAttributionComputation {
	return {
		taskDeploymentAttribution: {
			taskDeploymentAttributionZone: "task_commits_not_yet_deployed_or_task_unattributable",
			matchedDeployedCommitsInThisDeploymentDelta: [],
			taskDeploymentUnattributableReason: unattributableReason,
			attributionComputedAtIso: nowIso,
		},
		firstDeployedInDeploymentId: null,
		firstDeployedAtIso: null,
		firstDeploymentPredatesRetainedDeploymentRecords: false,
	};
}

function buildDeployedComputation(input: {
	zone: Exclude<
		RuntimePostDeployVerificationTaskDeploymentAttributionZone,
		"task_commits_not_yet_deployed_or_task_unattributable"
	>;
	matchedDeployedCommitsInThisDeploymentDelta: RuntimePostDeployVerificationMatchedDeployedCommit[];
	firstDeployment: DeploymentForTaskDeploymentAttribution | null;
	nowIso: string;
}): TaskDeploymentAttributionComputation {
	return {
		taskDeploymentAttribution: {
			taskDeploymentAttributionZone: input.zone,
			matchedDeployedCommitsInThisDeploymentDelta: input.matchedDeployedCommitsInThisDeploymentDelta,
			taskDeploymentUnattributableReason: null,
			attributionComputedAtIso: input.nowIso,
		},
		firstDeployedInDeploymentId: input.firstDeployment?.deploymentId ?? null,
		firstDeployedAtIso: input.firstDeployment?.deployedAtIso ?? null,
		firstDeploymentPredatesRetainedDeploymentRecords: input.firstDeployment === null,
	};
}

/**
 * 只看「提交是否命中本次部署区间」的廉价筛选（纯内存匹配，不做祖先探测）：record 用它从 Validation 列以外的
 * 全部卡片里挑出随本次部署上线的任务（review / in_progress 纳入核对，Done 只读展示），不必对几百张卡逐个跑完整归属。
 * 返回命中的 taskId → 匹配到的部署提交；区间读不出时返回 null。
 */
export async function findTaskIdsWhoseCommitsAreIncludedInDeploymentDelta(input: {
	workspaceId: string;
	repositoryPath: string;
	targetDeployment: DeploymentForTaskDeploymentAttribution;
	taskIds: readonly string[];
}): Promise<Map<string, RuntimePostDeployVerificationMatchedDeployedCommit[]> | null> {
	if (input.targetDeployment.previousDeployedSourceCommit === null) {
		return new Map();
	}
	const targetDelta = await loadDeploymentDeltaCommitIdentities(
		input.repositoryPath,
		input.targetDeployment.previousDeployedSourceCommit,
		input.targetDeployment.deployedSourceCommit,
	);
	if (targetDelta === null) {
		return null;
	}
	const observedTaskCommitsByTaskId = await readObservedTaskCommitsAcrossIncarnationsByTaskId(input.workspaceId);
	const matchedByTaskId = new Map<string, RuntimePostDeployVerificationMatchedDeployedCommit[]>();
	for (const taskId of input.taskIds) {
		const taskCommits = observedTaskCommitsByTaskId.get(taskId);
		if (!taskCommits || taskCommits.length === 0) {
			continue;
		}
		const matched = toMatchedDeployedCommits(taskCommits, targetDelta);
		if (matched.length > 0) {
			matchedByTaskId.set(taskId, matched);
		}
	}
	return matchedByTaskId;
}

/**
 * 对一次部署（targetDeployment）计算一批任务的归属：
 *  - 第一区：任务提交命中本次部署区间；
 *  - 第二区：没命中本次、但命中某个更早的保留部署区间，或提交是已部署 commit 的祖先（早于保留记录）；
 *  - 第三区：两者都不是（提交还没随部署上线），或没有提交来历可依（原因见 taskDeploymentUnattributableReason）。
 * 首次上线取命中的最早一次部署（retainedEarlierDeploymentsInAscendingOrder 按部署时间升序，不含 target）。
 * 没有前驱的部署（史上首次部署）没有区间可算，一律按「提交是其已部署 commit 的祖先即随它上线」判定：
 * target 自身如此即第一区；更早的保留部署如此即以它为首次上线（它仍在保留记录里，不算「早于保留记录」）。
 * 任何 git 失败都只降级该任务为第三区（git_inspection_failed），不抛错——对账下一轮会重算。
 */
export async function computeTaskDeploymentAttributionsAgainstDeployment(input: {
	workspaceId: string;
	repositoryPath: string;
	targetDeployment: DeploymentForTaskDeploymentAttribution;
	retainedEarlierDeploymentsInAscendingOrder: readonly DeploymentForTaskDeploymentAttribution[];
	taskIds: readonly string[];
	nowIso: string;
}): Promise<Map<string, TaskDeploymentAttributionComputation>> {
	const computations = new Map<string, TaskDeploymentAttributionComputation>();
	if (input.taskIds.length === 0) {
		return computations;
	}
	let observedTaskCommitsByTaskId: Map<string, ObservedTaskCommit[]>;
	try {
		observedTaskCommitsByTaskId = await readObservedTaskCommitsAcrossIncarnationsByTaskId(input.workspaceId);
	} catch {
		for (const taskId of input.taskIds) {
			computations.set(taskId, buildUnattributableComputation("git_inspection_failed", input.nowIso));
		}
		return computations;
	}

	const targetDelta =
		input.targetDeployment.previousDeployedSourceCommit === null
			? []
			: await loadDeploymentDeltaCommitIdentities(
					input.repositoryPath,
					input.targetDeployment.previousDeployedSourceCommit,
					input.targetDeployment.deployedSourceCommit,
				);
	const earlierRetainedDeploymentContainmentProbes: EarlierRetainedDeploymentContainmentProbe[] = [];
	for (const deployment of input.retainedEarlierDeploymentsInAscendingOrder) {
		if (deployment.previousDeployedSourceCommit === null) {
			earlierRetainedDeploymentContainmentProbes.push({
				kind: "deployment_without_previous_deployed_source_commit_contains_task_commits_reachable_from_deployed_source_commit",
				deployment,
			});
			continue;
		}
		const deploymentDeltaCommits = await loadDeploymentDeltaCommitIdentities(
			input.repositoryPath,
			deployment.previousDeployedSourceCommit,
			deployment.deployedSourceCommit,
		);
		if (deploymentDeltaCommits !== null) {
			earlierRetainedDeploymentContainmentProbes.push({
				kind: "deployment_delta_commits_matched_one_to_one_against_task_commits",
				deployment,
				deploymentDeltaCommits,
			});
		}
	}

	const limitGitConcurrency = pLimit(DEPLOYMENT_ATTRIBUTION_GIT_CONCURRENCY_LIMIT);
	await Promise.all(
		input.taskIds.map((taskId) =>
			limitGitConcurrency(async () => {
				const taskCommits = observedTaskCommitsByTaskId.get(taskId);
				if (taskCommits === undefined) {
					computations.set(
						taskId,
						buildUnattributableComputation("no_task_commit_integration_provenance_entry", input.nowIso),
					);
					return;
				}
				if (taskCommits.length === 0) {
					computations.set(
						taskId,
						buildUnattributableComputation(
							"task_commit_integration_provenance_has_no_observed_task_commits",
							input.nowIso,
						),
					);
					return;
				}
				if (targetDelta === null) {
					computations.set(taskId, buildUnattributableComputation("git_inspection_failed", input.nowIso));
					return;
				}
				const earliestEarlierDeploymentContainingTaskCommits =
					await findEarliestEarlierRetainedDeploymentContainingTaskCommits(
						input.repositoryPath,
						taskCommits,
						earlierRetainedDeploymentContainmentProbes,
					);
				const matchedInTargetDelta = toMatchedDeployedCommits(taskCommits, targetDelta);
				if (matchedInTargetDelta.length > 0) {
					computations.set(
						taskId,
						buildDeployedComputation({
							zone: "task_commits_included_in_this_deployment_delta",
							matchedDeployedCommitsInThisDeploymentDelta: matchedInTargetDelta,
							firstDeployment: earliestEarlierDeploymentContainingTaskCommits ?? input.targetDeployment,
							nowIso: input.nowIso,
						}),
					);
					return;
				}
				if (earliestEarlierDeploymentContainingTaskCommits !== null) {
					computations.set(
						taskId,
						buildDeployedComputation({
							zone: "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
							matchedDeployedCommitsInThisDeploymentDelta: [],
							firstDeployment: earliestEarlierDeploymentContainingTaskCommits,
							nowIso: input.nowIso,
						}),
					);
					return;
				}
				const containedInDeployedSourceCommit = await isAnyTaskCommitAncestorOfDeployedSourceCommit(
					input.repositoryPath,
					taskCommits,
					input.targetDeployment.deployedSourceCommit,
				);
				if (!containedInDeployedSourceCommit) {
					computations.set(
						taskId,
						buildUnattributableComputation("task_commits_not_contained_in_deployed_source_commit", input.nowIso),
					);
					return;
				}
				// 没有前驱的首次部署：提交在已部署 commit 里，就是随这次部署上线的。
				if (input.targetDeployment.previousDeployedSourceCommit === null) {
					computations.set(
						taskId,
						buildDeployedComputation({
							zone: "task_commits_included_in_this_deployment_delta",
							matchedDeployedCommitsInThisDeploymentDelta: [],
							firstDeployment: input.targetDeployment,
							nowIso: input.nowIso,
						}),
					);
					return;
				}
				computations.set(
					taskId,
					buildDeployedComputation({
						zone: "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
						matchedDeployedCommitsInThisDeploymentDelta: [],
						firstDeployment: null,
						nowIso: input.nowIso,
					}),
				);
			}),
		),
	);
	return computations;
}
