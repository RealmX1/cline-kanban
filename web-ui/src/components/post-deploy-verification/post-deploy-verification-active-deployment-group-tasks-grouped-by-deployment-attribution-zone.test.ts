import { describe, expect, it } from "vitest";

import type { RuntimePostDeployVerificationTask } from "@/runtime/types";
import {
	countPostDeployVerificationTasksAwaitingVerification,
	groupActiveDeploymentGroupTasksByDeploymentAttributionZone,
	isPostDeployVerificationTaskAwaitingVerification,
	resolvePanelSectionDeploymentAttributionZoneOfPostDeployVerificationTask,
} from "./post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

function taskInZone(
	taskId: string,
	zone: NonNullable<RuntimePostDeployVerificationTask["taskDeploymentAttribution"]>["taskDeploymentAttributionZone"],
	overrides: Partial<RuntimePostDeployVerificationTask> = {},
): RuntimePostDeployVerificationTask {
	return createPostDeployVerificationTaskReadModelTestFixture({
		taskId,
		taskDeploymentAttribution: {
			taskDeploymentAttributionZone: zone,
			matchedDeployedCommitsInThisDeploymentDelta: [],
			taskDeploymentUnattributableReason: null,
			attributionComputedAtIso: "2026-10-11T00:00:00.000Z",
		},
		...overrides,
	});
}

describe("PDV 活跃组按部署归属分区", () => {
	it("三区各归各位；归属尚未计算（null）的任务先进第三区", () => {
		const grouped = groupActiveDeploymentGroupTasksByDeploymentAttributionZone([
			taskInZone("this-deployment", "task_commits_included_in_this_deployment_delta"),
			taskInZone("earlier-deployment", "task_commits_deployed_only_in_earlier_deployments_awaiting_verification"),
			taskInZone("not-deployed", "task_commits_not_yet_deployed_or_task_unattributable"),
			createPostDeployVerificationTaskReadModelTestFixture({ taskId: "attribution-not-computed" }),
		]);
		const taskIdsOf = (tasks: RuntimePostDeployVerificationTask[]) => tasks.map((task) => task.taskId);
		expect(
			taskIdsOf(grouped.tasksByDeploymentAttributionZone.task_commits_included_in_this_deployment_delta),
		).toEqual(["this-deployment"]);
		expect(
			taskIdsOf(
				grouped.tasksByDeploymentAttributionZone
					.task_commits_deployed_only_in_earlier_deployments_awaiting_verification,
			),
		).toEqual(["earlier-deployment"]);
		expect(
			taskIdsOf(grouped.tasksByDeploymentAttributionZone.task_commits_not_yet_deployed_or_task_unattributable),
		).toEqual(["not-deployed", "attribution-not-computed"]);
	});

	it("记录部署时已在 Done 的只读展示项不进任何分区、不计待核对", () => {
		const readOnlyDoneTask = taskInZone("already-done", "task_commits_included_in_this_deployment_delta", {
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: true,
		});
		const grouped = groupActiveDeploymentGroupTasksByDeploymentAttributionZone([readOnlyDoneTask]);
		expect(grouped.tasksByDeploymentAttributionZone.task_commits_included_in_this_deployment_delta).toEqual([]);
		expect(grouped.tasksAlreadyInDoneColumnIncludedAsReadOnly.map((task) => task.taskId)).toEqual(["already-done"]);
		expect(countPostDeployVerificationTasksAwaitingVerification([readOnlyDoneTask])).toBe(0);
	});

	it("区内待核对在前、已结案其次、已移除垫底，同类保持服务端顺序", () => {
		const zone = "task_commits_included_in_this_deployment_delta" as const;
		const grouped = groupActiveDeploymentGroupTasksByDeploymentAttributionZone([
			taskInZone("dropped", zone, { droppedReason: "task_deleted" }),
			taskInZone("verified", zone, { verifiedAt: "2026-10-11T01:00:00.000Z" }),
			taskInZone("pending-a", zone),
			taskInZone("pending-b", zone),
		]);
		expect(grouped.tasksByDeploymentAttributionZone[zone].map((task) => task.taskId)).toEqual([
			"pending-a",
			"pending-b",
			"verified",
			"dropped",
		]);
	});

	it("带原因结案也算结案：不再计入待核对", () => {
		const reasonedClosureTask = taskInZone("reasoned", "task_commits_included_in_this_deployment_delta", {
			postDeployVerificationClosure: {
				postDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
				closedAtIso: "2026-10-11T02:00:00.000Z",
				postDeployVerificationCompletionPath:
					"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
				uncheckedChecklistItemClosureReasons: [],
				confirmedAcknowledgements: [],
				taskDeploymentAttributionZoneAtClosure: "task_commits_included_in_this_deployment_delta",
				deferredNaturalUsageObservationRecordIds: [],
			},
		});
		expect(isPostDeployVerificationTaskAwaitingVerification(reasonedClosureTask)).toBe(false);
	});

	it("已延续到更新部署组的条目不算待核对（与服务端同一份判据，历史组也不会把它数进去）", () => {
		const carriedForwardTask = taskInZone("carried", "task_commits_included_in_this_deployment_delta", {
			carriedForwardIntoDeploymentId: "deployment-newer",
		});
		expect(isPostDeployVerificationTaskAwaitingVerification(carriedForwardTask)).toBe(false);
		expect(countPostDeployVerificationTasksAwaitingVerification([carriedForwardTask])).toBe(0);
	});

	it("服务端 JSON 缺 2026-10-11 新字段（旧 runtime / 浏览器 fixture）时按默认值读，不抛错", () => {
		const legacyTaskWithoutNewFields = {
			taskId: "legacy",
			columnIdAtMatch: "validation",
			matchedCommits: [],
			inclusionReason: "validation_column",
			checklist: [],
			verifiedAt: null,
			boardMovedToDoneAt: null,
			pendingConfirmation: null,
			droppedReason: null,
		} as unknown as RuntimePostDeployVerificationTask;
		expect(resolvePanelSectionDeploymentAttributionZoneOfPostDeployVerificationTask(legacyTaskWithoutNewFields)).toBe(
			"task_commits_not_yet_deployed_or_task_unattributable",
		);
		expect(countPostDeployVerificationTasksAwaitingVerification([legacyTaskWithoutNewFields])).toBe(1);
	});
});
