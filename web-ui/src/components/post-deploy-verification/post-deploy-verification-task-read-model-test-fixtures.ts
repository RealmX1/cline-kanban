import type { RuntimePostDeployVerificationTask } from "@/runtime/types";

// 仅供测试：一个「待核对、归属尚未计算」的 PDV 任务读模型，2026-10-11 新增的字段都取服务端 zod default。
// 测试只覆写自己关心的字段，新增字段时只改这里一处。
export function createPostDeployVerificationTaskReadModelTestFixture(
	overrides: Partial<RuntimePostDeployVerificationTask> = {},
): RuntimePostDeployVerificationTask {
	return {
		taskId: "task-1",
		columnIdAtMatch: "review",
		matchedCommits: [],
		inclusionReason: "commit_correlation",
		checklist: [],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: null,
		droppedReason: null,
		taskDeploymentAttribution: null,
		firstDeployedInDeploymentId: null,
		firstDeployedAtIso: null,
		firstDeploymentPredatesRetainedDeploymentRecords: false,
		deploymentIdsRecordedWhileTaskAwaitingVerification: [],
		carriedForwardIntoDeploymentId: null,
		includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		doneEntryClosureAuthorizationInFlight: null,
		postDeployVerificationClosure: null,
		...overrides,
	};
}
