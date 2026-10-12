import type { RuntimePostDeployVerificationTask } from "../core/api-contract";
import { startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking } from "./kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import type { PostDeployVerificationCompletionEvidence } from "./post-deploy-verification-passed-observation-recording";

// 族 3「PDV 带原因结案」（2026-10-11）：未全部勾选、但每个未勾项都给了原因就移入 Done。它**不是**「PDV 通过」——
// 完成条件 4 只认 post_deploy_verification_passed_observed（docs/context-inter-work-unit-relation-modeling-overhaul.md）。
// 事件逐项记下未勾项的断言、来源验证定义、原因码与原因文本，以及「转为在自然使用中观察」生成的待观察记录 id，
// 这样即便部署组状态文件被回滚的旧 binary 改写，原因的权威记录仍在只追加的账本里。
// 与「通过」事件同样在状态 JSON 写完之后追加：最坏漏记一条，绝不出现状态里没有的幽灵结案。
export function recordPostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationWithoutBlocking(input: {
	workspaceId: string;
	deploymentId: string;
	deployedSourceCommit: string;
	closedPostDeployVerificationTask: RuntimePostDeployVerificationTask;
	completionEvidence: PostDeployVerificationCompletionEvidence;
}): void {
	const task = input.closedPostDeployVerificationTask;
	const closure = task.postDeployVerificationClosure;
	if (!closure) {
		return;
	}
	const checklistItemById = new Map(task.checklist.map((item) => [item.id, item]));
	startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking({
		backgroundLedgerEventRecordingDescriptionForDiagnostics: `post_deploy_verification_closed_into_done_with_unchecked_items_reasoned_observed for ${task.taskId}`,
		recordIntoLedgerOfBoundLiveCapture: async (boundLiveCapture) => {
			await boundLiveCapture.appendFactObservedByKanbanRuntimeIntoLedgerOfBoundLiveCapture({
				observedFactKind: "post_deploy_verification_closed_into_done_with_unchecked_items_reasoned_observed",
				observingKanbanRuntimeSystemComponentName: "post_deploy_verification_state_closure_funnel",
				subjectWorkspaceId: input.workspaceId,
				subjectTaskId: task.taskId,
				eventPayload: {
					deploymentId: input.deploymentId,
					deployedSourceCommit: input.deployedSourceCommit,
					closedAtIso: closure.closedAtIso,
					inclusionReason: task.inclusionReason,
					columnIdAtMatch: task.columnIdAtMatch,
					taskDeploymentAttributionZoneAtClosure: closure.taskDeploymentAttributionZoneAtClosure,
					firstDeployedInDeploymentId: task.firstDeployedInDeploymentId,
					checkedChecklistItemCount: task.checklist.filter((item) => item.checked).length,
					checklistItemCount: task.checklist.length,
					uncheckedChecklistItemClosureReasons: closure.uncheckedChecklistItemClosureReasons.map((reason) => {
						const item = checklistItemById.get(reason.checklistItemId);
						return {
							checklistItemId: reason.checklistItemId,
							checklistItemLabel: item?.label ?? null,
							checklistItemKind: item?.kind ?? null,
							uncheckedChecklistItemClosureReasonCode: reason.uncheckedChecklistItemClosureReasonCode,
							uncheckedChecklistItemClosureReasonText: reason.uncheckedChecklistItemClosureReasonText ?? null,
						};
					}),
					deferredNaturalUsageObservationRecordIds: closure.deferredNaturalUsageObservationRecordIds,
					postDeployVerificationCompletionPath: input.completionEvidence.postDeployVerificationCompletionPath,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
						input.completionEvidence.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
					confirmedAcknowledgements: input.completionEvidence.confirmedAcknowledgements,
				},
			});
		},
	});
}
