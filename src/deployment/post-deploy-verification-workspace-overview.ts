import { createHash } from "node:crypto";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationDeploymentGroupOverview,
	RuntimePostDeployVerificationWorkspaceOverview,
} from "../core/api-contract";
import {
	isPostDeployVerificationTaskAwaitingVerification,
	isPostDeployVerificationTaskClosed,
} from "../core/post-deploy-verification-task-closed-and-awaiting-verification-predicates";

export function postDeployVerificationDeploymentGroupContentVersion(
	group: RuntimePostDeployVerificationDeploymentGroup,
): string {
	return createHash("sha256").update(JSON.stringify(group)).digest("hex");
}

export function summarizePostDeployVerificationDeploymentGroup(
	group: RuntimePostDeployVerificationDeploymentGroup,
): RuntimePostDeployVerificationDeploymentGroupOverview {
	const { tasks, ...deployment } = group;
	const requiringVerification = tasks.filter(
		(task) =>
			task.droppedReason === null && !task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded,
	);
	return {
		...deployment,
		contentVersion: postDeployVerificationDeploymentGroupContentVersion(group),
		pendingVerificationTaskCount: tasks.filter(isPostDeployVerificationTaskAwaitingVerification).length,
		closedTaskCount: requiringVerification.filter(isPostDeployVerificationTaskClosed).length,
		taskCountRequiringVerification: requiringVerification.length,
		carriedForwardTaskCount: requiringVerification.filter((task) => task.carriedForwardIntoDeploymentId !== null)
			.length,
	};
}

export function summarizePostDeployVerificationWorkspace(
	groups: RuntimePostDeployVerificationDeploymentGroup[],
	activeDeploymentId: string | null,
): RuntimePostDeployVerificationWorkspaceOverview {
	const deploymentGroups = groups.map(summarizePostDeployVerificationDeploymentGroup);
	return {
		activeDeploymentId,
		deploymentGroups,
		pendingVerificationTaskCount:
			deploymentGroups.find((group) => group.deploymentId === activeDeploymentId)?.pendingVerificationTaskCount ?? 0,
	};
}
