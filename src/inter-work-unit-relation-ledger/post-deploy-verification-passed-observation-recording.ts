import type { RuntimePostDeployVerificationTask } from "../core/api-contract";
import { readRawTaskCommitLandingSnapshotForRelationLedgerEvent } from "../workspace/task-commit-integration-provenance";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";
import { startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking } from "./kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";

// 完成核对走的是哪条入口：Web 面板的原子确认，或 CLI `kanban deployment` 的完成动词。
export type PostDeployVerificationCompletionPath =
	| "web_ui_post_deploy_verification_panel_atomic_confirmation"
	| "kanban_cli_post_deploy_verification_completion_verb";

export interface PostDeployVerificationCompletionEvidence {
	postDeployVerificationCompletionPath: PostDeployVerificationCompletionPath;
	forcedCompletionWithoutAllVerificationsPassed: boolean;
	confirmedAcknowledgements: string[];
}

// 族 3「PDV 通过」（Y-EVENT-14）：只在 verifiedAt 真正从空变为有值时调用。事件携带纳入原因、匹配提交、
// 是否强制、确认项，以及**原始**落地快照（最后已知 HEAD 与其可达的非 merge 自有提交）；不带「是否已落地」的判定——那是 1c 的事。
// 偏离 Y-EVENT-2 的两阶段：PDV 状态是单独的全局 JSON，没有 board 字节哈希可供结算；这里在 JSON 写完之后追加，
// 最坏情况是进程恰在两步之间崩溃而漏记一条，但绝不会出现「事件说通过了、状态里却没有」的幽灵事件。
export function recordPostDeployVerificationPassedObservationWithoutBlocking(input: {
	workspaceId: string;
	deploymentId: string;
	deployedSourceCommit: string;
	verifiedPostDeployVerificationTask: RuntimePostDeployVerificationTask;
	completionEvidence: PostDeployVerificationCompletionEvidence;
}): void {
	const task = input.verifiedPostDeployVerificationTask;
	// 发起时绑定当时激活的实例：读落地快照是异步的，读完再取全局激活状态会在停机时丢事件、或把它记到随后激活的实例名下。
	// 整段后台工作纳入该实例的停用 drain，worker 关闭前必然落定。
	startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking({
		backgroundLedgerEventRecordingDescriptionForDiagnostics: `post_deploy_verification_passed_observed for ${task.taskId}`,
		recordIntoLedgerOfBoundLiveCapture: async (boundLiveCapture) => {
			const rawTaskCommitLandingSnapshot = await readRawTaskCommitLandingSnapshotForRelationLedgerEvent(
				input.workspaceId,
				task.taskId,
			).catch((error: unknown) => {
				logInterWorkUnitRelationLedgerDiagnosticWarning(
					`could not read raw task commit landing snapshot for ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			});
			await boundLiveCapture.appendFactObservedByKanbanRuntimeIntoLedgerOfBoundLiveCapture({
				observedFactKind: "post_deploy_verification_passed_observed",
				observingKanbanRuntimeSystemComponentName: "post_deploy_verification_state_verified_at_funnel",
				subjectWorkspaceId: input.workspaceId,
				subjectTaskId: task.taskId,
				eventPayload: {
					deploymentId: input.deploymentId,
					deployedSourceCommit: input.deployedSourceCommit,
					verifiedAt: task.verifiedAt,
					inclusionReason: task.inclusionReason,
					matchedCommits: task.matchedCommits,
					columnIdAtMatch: task.columnIdAtMatch,
					postDeployVerificationCompletionPath: input.completionEvidence.postDeployVerificationCompletionPath,
					forcedCompletionWithoutAllVerificationsPassed:
						input.completionEvidence.forcedCompletionWithoutAllVerificationsPassed,
					confirmedAcknowledgements: input.completionEvidence.confirmedAcknowledgements,
					rawTaskCommitLandingSnapshotAtVerification: rawTaskCommitLandingSnapshot,
				},
			});
		},
	});
}
