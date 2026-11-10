import { describe, expect, it } from "vitest";
import { runtimePostDeployVerificationDeploymentGroupSchema } from "../../../src/core/api-contract";
import {
	postDeployVerificationDeploymentGroupContentVersion,
	summarizePostDeployVerificationWorkspace,
} from "../../../src/deployment/post-deploy-verification-workspace-overview";

describe("PDV 工作区概览", () => {
	it("保留历史标题与进度，概览不携带核对正文且版本反映内容变化", () => {
		const group = runtimePostDeployVerificationDeploymentGroupSchema.parse({
			deploymentId: "00000000-0000-4000-8000-000000000001",
			workspaceId: "isolated-workspace",
			deployedSourceCommit: "abc",
			previousDeployedSourceCommit: null,
			deployedAtIso: "2026-11-08T00:00:00.000Z",
			foldedAtIso: null,
			tasks: Array.from({ length: 4 }, (_, index) => ({
				taskId: `task-${index}`,
				columnIdAtMatch: "validation",
				matchedCommits: [],
				inclusionReason: "validation_column",
				checklist: [],
				verifiedAt: index === 0 ? "2026-11-08" : null,
				boardMovedToDoneAt: null,
				pendingConfirmation: null,
				droppedReason: null,
				carriedForwardIntoDeploymentId: index === 1 ? "another-deployment" : null,
				includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: index === 2,
			})),
		});
		const overview = summarizePostDeployVerificationWorkspace([group], group.deploymentId);
		expect(overview.pendingVerificationTaskCount).toBe(1);
		expect(overview.deploymentGroups[0]).toMatchObject({
			closedTaskCount: 1,
			taskCountRequiringVerification: 3,
			carriedForwardTaskCount: 1,
		});
		expect(overview.deploymentGroups[0]).not.toHaveProperty("tasks");
		const changed = { ...group, tasks: group.tasks.slice(0, 1) };
		expect(postDeployVerificationDeploymentGroupContentVersion(changed)).not.toBe(
			overview.deploymentGroups[0]!.contentVersion,
		);
	});
});
