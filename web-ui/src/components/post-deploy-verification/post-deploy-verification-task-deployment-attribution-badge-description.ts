import {
	readDeploymentsRecordedWhileTaskAwaitingVerificationCount,
	readTaskDeploymentAttributionOrNullWhenNotYetComputed,
} from "@/components/post-deploy-verification/post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import {
	formatDeployTimestamp,
	shortenCommitSha,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationTaskDeploymentUnattributableReason,
} from "@/runtime/types";

// entry wrapper 下部的「部署归属」徽标文案（纯函数）。三区各自要回答的问题不同：
//   第一区：这次部署带上了任务的哪些提交；
//   第二区：任务最早随哪次部署上线、之后又过了几次部署还没核对；
//   第三区：为什么还归属不上（尚未上线 / 没有提交来历 / git 检查失败），或归属还没算出来。

export const POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_UNATTRIBUTABLE_REASON_LABEL: Record<
	RuntimePostDeployVerificationTaskDeploymentUnattributableReason,
	string
> = {
	no_task_commit_integration_provenance_entry: "无提交来历（老任务）",
	task_commit_integration_provenance_has_no_observed_task_commits: "来历里没有提交",
	task_commits_not_contained_in_deployed_source_commit: "提交尚未随部署上线",
	git_inspection_failed: "git 检查失败（稍后重算）",
};

export type PostDeployVerificationTaskDeploymentAttributionBadgeTone =
	| "deployed_in_this_deployment"
	| "deployed_in_earlier_deployment"
	| "not_yet_deployed_or_unattributable"
	| "attribution_not_yet_computed";

export interface PostDeployVerificationTaskDeploymentAttributionBadgeDescription {
	deploymentAttributionBadgeTone: PostDeployVerificationTaskDeploymentAttributionBadgeTone;
	deploymentAttributionPrimaryLabel: string;
	// 第一区：本次部署区间里消费掉的提交（短 SHA）；其余区为空。
	matchedDeployedCommitShortShasInThisDeployment: string[];
	// 未结案期间历经的部署数 > 1 时给出「已历经 N 次部署」；否则 null（第一次上线不必强调）。
	deploymentsElapsedWhileAwaitingVerificationLabel: string | null;
}

export function describePostDeployVerificationTaskDeploymentAttributionForPanelEntry(input: {
	postDeployVerificationTask: RuntimePostDeployVerificationTask;
	// 当前 workspace 保留的全部部署组（活跃 + 历史），用于把 firstDeployedInDeploymentId 解析成短 SHA。
	retainedDeploymentGroupsByDeploymentId: ReadonlyMap<string, RuntimePostDeployVerificationDeploymentGroup>;
}): PostDeployVerificationTaskDeploymentAttributionBadgeDescription {
	const { postDeployVerificationTask: task, retainedDeploymentGroupsByDeploymentId } = input;
	const deploymentsElapsedCount = readDeploymentsRecordedWhileTaskAwaitingVerificationCount(task);
	const deploymentsElapsedWhileAwaitingVerificationLabel =
		deploymentsElapsedCount > 1 ? `已历经 ${deploymentsElapsedCount} 次部署` : null;
	const attribution = readTaskDeploymentAttributionOrNullWhenNotYetComputed(task);
	if (!attribution) {
		return {
			deploymentAttributionBadgeTone: "attribution_not_yet_computed",
			deploymentAttributionPrimaryLabel: "归属计算中",
			matchedDeployedCommitShortShasInThisDeployment: [],
			deploymentsElapsedWhileAwaitingVerificationLabel,
		};
	}
	switch (attribution.taskDeploymentAttributionZone) {
		case "task_commits_included_in_this_deployment_delta":
			return {
				deploymentAttributionBadgeTone: "deployed_in_this_deployment",
				deploymentAttributionPrimaryLabel: "本次上线",
				matchedDeployedCommitShortShasInThisDeployment: attribution.matchedDeployedCommitsInThisDeploymentDelta.map(
					(matchedCommit) => shortenCommitSha(matchedCommit.deployedCommitSha),
				),
				deploymentsElapsedWhileAwaitingVerificationLabel,
			};
		case "task_commits_deployed_only_in_earlier_deployments_awaiting_verification":
			return {
				deploymentAttributionBadgeTone: "deployed_in_earlier_deployment",
				deploymentAttributionPrimaryLabel: describeFirstDeploymentOfTask(
					task,
					retainedDeploymentGroupsByDeploymentId,
				),
				matchedDeployedCommitShortShasInThisDeployment: [],
				deploymentsElapsedWhileAwaitingVerificationLabel,
			};
		case "task_commits_not_yet_deployed_or_task_unattributable":
			return {
				deploymentAttributionBadgeTone: "not_yet_deployed_or_unattributable",
				deploymentAttributionPrimaryLabel: attribution.taskDeploymentUnattributableReason
					? POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_UNATTRIBUTABLE_REASON_LABEL[
							attribution.taskDeploymentUnattributableReason
						]
					: "尚未随部署上线",
				matchedDeployedCommitShortShasInThisDeployment: [],
				deploymentsElapsedWhileAwaitingVerificationLabel,
			};
	}
}

function describeFirstDeploymentOfTask(
	task: RuntimePostDeployVerificationTask,
	retainedDeploymentGroupsByDeploymentId: ReadonlyMap<string, RuntimePostDeployVerificationDeploymentGroup>,
): string {
	if (task.firstDeploymentPredatesRetainedDeploymentRecords === true) {
		return "首次上线早于保留的部署记录";
	}
	const firstDeployedInDeploymentId = task.firstDeployedInDeploymentId ?? null;
	const firstDeploymentGroup = firstDeployedInDeploymentId
		? retainedDeploymentGroupsByDeploymentId.get(firstDeployedInDeploymentId)
		: undefined;
	const firstDeployedAtIso = task.firstDeployedAtIso ?? firstDeploymentGroup?.deployedAtIso ?? null;
	const firstDeploymentParts = [
		firstDeploymentGroup ? shortenCommitSha(firstDeploymentGroup.deployedSourceCommit) : null,
		firstDeployedAtIso ? formatDeployTimestamp(firstDeployedAtIso) : null,
	].filter((part): part is string => part !== null);
	return firstDeploymentParts.length > 0 ? `首次上线于 ${firstDeploymentParts.join(" · ")}` : "早先部署已上线";
}
