import {
	isPostDeployVerificationTaskAwaitingVerification,
	isPostDeployVerificationTaskClosed,
} from "@runtime-post-deploy-verification-task-closed-and-awaiting-verification-predicates";

import type {
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationTaskDeploymentAttribution,
	RuntimePostDeployVerificationTaskDeploymentAttributionZone,
} from "@/runtime/types";

// 「已结案 / 待核对」判据与服务端是同一份（src/core，容忍旧 runtime JSON 缺字段）；这里转出，面板与门禁预检照旧从本模块引用。
export { isPostDeployVerificationTaskAwaitingVerification, isPostDeployVerificationTaskClosed };

// ---- 读模型字段读取：容忍字段缺失 ----
// 读模型是服务端 JSON。2026-10-11 新增的字段在服务端靠 zod default 补齐，但旧 runtime（回滚 / 版本错位）与
// 浏览器测试 fixture 返回的 JSON 根本没有这些键——直接点字段会读到 undefined。面板与门禁预检一律经下面这组函数读，
// 缺失按默认值处理，不在各处散写 `?? null`。

export function readTaskDeploymentAttributionOrNullWhenNotYetComputed(
	task: RuntimePostDeployVerificationTask,
): RuntimePostDeployVerificationTaskDeploymentAttribution | null {
	return task.taskDeploymentAttribution ?? null;
}

export function isPostDeployVerificationTaskIncludedAsReadOnlyBecauseAlreadyInDoneColumn(
	task: RuntimePostDeployVerificationTask,
): boolean {
	return task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded === true;
}

// 顶栏 badge、面板标题与分区计数都只数「待核对」（判据见 isPostDeployVerificationTaskAwaitingVerification）。
export function countPostDeployVerificationTasksAwaitingVerification(
	tasks: readonly RuntimePostDeployVerificationTask[],
): number {
	return tasks.filter(isPostDeployVerificationTaskAwaitingVerification).length;
}

export function readDeploymentsRecordedWhileTaskAwaitingVerificationCount(
	task: RuntimePostDeployVerificationTask,
): number {
	return (task.deploymentIdsRecordedWhileTaskAwaitingVerification ?? []).length;
}

export function readCarriedForwardIntoDeploymentIdOrNull(task: RuntimePostDeployVerificationTask): string | null {
	return task.carriedForwardIntoDeploymentId ?? null;
}

// ---- 按部署归属分区 ----

// 面板自上而下的分区顺序：只有第一区默认展开（见 post-deploy-verification-deployment-group.tsx）。
export const POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONES_IN_PANEL_ORDER: readonly RuntimePostDeployVerificationTaskDeploymentAttributionZone[] =
	[
		"task_commits_included_in_this_deployment_delta",
		"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
		"task_commits_not_yet_deployed_or_task_unattributable",
	];

export const POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONE_SECTION_TITLE: Record<
	RuntimePostDeployVerificationTaskDeploymentAttributionZone,
	string
> = {
	task_commits_included_in_this_deployment_delta: "本次部署上线",
	task_commits_deployed_only_in_earlier_deployments_awaiting_verification: "早先部署已上线、尚未核对",
	task_commits_not_yet_deployed_or_task_unattributable: "尚未随部署上线或无法归属",
};

// 归属尚未计算（null）的任务先归第三区，徽标显示「归属计算中」；runtime 对账补算后自然换区。
export function resolvePanelSectionDeploymentAttributionZoneOfPostDeployVerificationTask(
	task: RuntimePostDeployVerificationTask,
): RuntimePostDeployVerificationTaskDeploymentAttributionZone {
	return (
		readTaskDeploymentAttributionOrNullWhenNotYetComputed(task)?.taskDeploymentAttributionZone ??
		"task_commits_not_yet_deployed_or_task_unattributable"
	);
}

export interface PostDeployVerificationActiveDeploymentGroupTasksGroupedByDeploymentAttributionZone {
	// 每区内部：待核对在前，已结案其次，已移除垫底；同类保持服务端顺序。
	tasksByDeploymentAttributionZone: Record<
		RuntimePostDeployVerificationTaskDeploymentAttributionZone,
		RuntimePostDeployVerificationTask[]
	>;
	// 记录部署时已在 Done 的任务：只作「本次部署还包含（已在 Done）」的只读精简行，不进任何分区、不计数。
	tasksAlreadyInDoneColumnIncludedAsReadOnly: RuntimePostDeployVerificationTask[];
}

function rankPostDeployVerificationTaskForOrderingWithinZone(task: RuntimePostDeployVerificationTask): number {
	if (isPostDeployVerificationTaskAwaitingVerification(task)) {
		return 0;
	}
	return task.droppedReason === null ? 1 : 2;
}

export function groupActiveDeploymentGroupTasksByDeploymentAttributionZone(
	tasks: readonly RuntimePostDeployVerificationTask[],
): PostDeployVerificationActiveDeploymentGroupTasksGroupedByDeploymentAttributionZone {
	const tasksByDeploymentAttributionZone: Record<
		RuntimePostDeployVerificationTaskDeploymentAttributionZone,
		RuntimePostDeployVerificationTask[]
	> = {
		task_commits_included_in_this_deployment_delta: [],
		task_commits_deployed_only_in_earlier_deployments_awaiting_verification: [],
		task_commits_not_yet_deployed_or_task_unattributable: [],
	};
	const tasksAlreadyInDoneColumnIncludedAsReadOnly: RuntimePostDeployVerificationTask[] = [];
	for (const task of tasks) {
		if (isPostDeployVerificationTaskIncludedAsReadOnlyBecauseAlreadyInDoneColumn(task)) {
			tasksAlreadyInDoneColumnIncludedAsReadOnly.push(task);
			continue;
		}
		tasksByDeploymentAttributionZone[
			resolvePanelSectionDeploymentAttributionZoneOfPostDeployVerificationTask(task)
		].push(task);
	}
	for (const zone of POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONES_IN_PANEL_ORDER) {
		// Array.prototype.sort 稳定：同 rank 保持服务端顺序。
		tasksByDeploymentAttributionZone[zone].sort(
			(left, right) =>
				rankPostDeployVerificationTaskForOrderingWithinZone(left) -
				rankPostDeployVerificationTaskForOrderingWithinZone(right),
		);
	}
	return { tasksByDeploymentAttributionZone, tasksAlreadyInDoneColumnIncludedAsReadOnly };
}
