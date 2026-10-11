import { describe, expect, it } from "vitest";

import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";
import { formatDeployTimestamp } from "./post-deploy-verification-format";
import { describePostDeployVerificationTaskDeploymentAttributionForPanelEntry } from "./post-deploy-verification-task-deployment-attribution-badge-description";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

const EARLIER_DEPLOYMENT: RuntimePostDeployVerificationDeploymentGroup = {
	deploymentId: "deployment-earlier",
	workspaceId: "workspace-1",
	deployedSourceCommit: "5b7e94321234",
	previousDeployedSourceCommit: null,
	deployedAtIso: "2026-10-01T08:00:00.000Z",
	foldedAtIso: "2026-10-11T00:00:00.000Z",
	tasks: [],
};

function describeFor(task: RuntimePostDeployVerificationTask) {
	return describePostDeployVerificationTaskDeploymentAttributionForPanelEntry({
		postDeployVerificationTask: task,
		retainedDeploymentGroupsByDeploymentId: new Map([[EARLIER_DEPLOYMENT.deploymentId, EARLIER_DEPLOYMENT]]),
	});
}

function attribution(
	zone: NonNullable<RuntimePostDeployVerificationTask["taskDeploymentAttribution"]>["taskDeploymentAttributionZone"],
	extra: Partial<NonNullable<RuntimePostDeployVerificationTask["taskDeploymentAttribution"]>> = {},
): RuntimePostDeployVerificationTask["taskDeploymentAttribution"] {
	return {
		taskDeploymentAttributionZone: zone,
		matchedDeployedCommitsInThisDeploymentDelta: [],
		taskDeploymentUnattributableReason: null,
		attributionComputedAtIso: "2026-10-11T00:00:00.000Z",
		...extra,
	};
}

describe("PDV 条目的部署归属徽标", () => {
	it("第一区：本次上线 + 本次区间里匹配到的提交短 SHA", () => {
		const description = describeFor(
			createPostDeployVerificationTaskReadModelTestFixture({
				taskDeploymentAttribution: attribution("task_commits_included_in_this_deployment_delta", {
					matchedDeployedCommitsInThisDeploymentDelta: [
						{
							taskCommitSha: "1111111aaaa",
							deployedCommitSha: "2222222bbbb",
							taskCommitMatchKind: "stable_patch_id_equivalent",
						},
					],
				}),
			}),
		);
		expect(description.deploymentAttributionPrimaryLabel).toBe("本次上线");
		expect(description.matchedDeployedCommitShortShasInThisDeployment).toEqual(["2222222"]);
		expect(description.deploymentsElapsedWhileAwaitingVerificationLabel).toBeNull();
	});

	it("第二区：首次上线于 <短 SHA · 时间>，并给出已历经部署数", () => {
		const description = describeFor(
			createPostDeployVerificationTaskReadModelTestFixture({
				taskDeploymentAttribution: attribution(
					"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
				),
				firstDeployedInDeploymentId: "deployment-earlier",
				firstDeployedAtIso: "2026-10-01T08:00:00.000Z",
				deploymentIdsRecordedWhileTaskAwaitingVerification: ["deployment-earlier", "d2", "d3"],
			}),
		);
		expect(description.deploymentAttributionPrimaryLabel).toBe(
			`首次上线于 5b7e943 · ${formatDeployTimestamp("2026-10-01T08:00:00.000Z")}`,
		);
		expect(description.deploymentsElapsedWhileAwaitingVerificationLabel).toBe("已历经 3 次部署");
	});

	it("第二区：首次上线早于保留的部署记录", () => {
		expect(
			describeFor(
				createPostDeployVerificationTaskReadModelTestFixture({
					taskDeploymentAttribution: attribution(
						"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
					),
					firstDeploymentPredatesRetainedDeploymentRecords: true,
				}),
			).deploymentAttributionPrimaryLabel,
		).toBe("首次上线早于保留的部署记录");
	});

	it.each([
		["no_task_commit_integration_provenance_entry", "无提交来历（老任务）"],
		["task_commit_integration_provenance_has_no_observed_task_commits", "来历里没有提交"],
		["task_commits_not_contained_in_deployed_source_commit", "提交尚未随部署上线"],
		["git_inspection_failed", "git 检查失败（稍后重算）"],
	] as const)("第三区：%s → %s", (taskDeploymentUnattributableReason, expectedLabel) => {
		expect(
			describeFor(
				createPostDeployVerificationTaskReadModelTestFixture({
					taskDeploymentAttribution: attribution("task_commits_not_yet_deployed_or_task_unattributable", {
						taskDeploymentUnattributableReason,
					}),
				}),
			).deploymentAttributionPrimaryLabel,
		).toBe(expectedLabel);
	});

	it("归属尚未计算：显示「归属计算中」", () => {
		const description = describeFor(createPostDeployVerificationTaskReadModelTestFixture());
		expect(description.deploymentAttributionBadgeTone).toBe("attribution_not_yet_computed");
		expect(description.deploymentAttributionPrimaryLabel).toBe("归属计算中");
	});
});
