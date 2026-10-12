import type {
	RuntimePostDeployVerificationCompletionPath,
	RuntimePostDeployVerificationTask,
} from "../core/api-contract";
import { readRawTaskCommitLandingSnapshotForRelationLedgerEvent } from "../workspace/task-commit-integration-provenance";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";
import { startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking } from "./kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";

// 完成核对走的是哪条入口：Web 面板的原子确认，CLI `kanban deployment` 的完成动词，runtime 对账替 CLI 补写
// （CLI 已授权并移入 Done，补记 verifiedAt 的调用却没成、也没人重跑命令；授权证据是 CLI 移列前写下的在途完成记录），
// 以及 2026-10-11 起任何入口经 taskCardAction 移入 Done 时服务端门禁授权后的结案（及其对账补完）。
export type PostDeployVerificationCompletionPath = RuntimePostDeployVerificationCompletionPath;

export interface PostDeployVerificationCompletionEvidence {
	postDeployVerificationCompletionPath: PostDeployVerificationCompletionPath;
	// CLI `--force` 只跳过 token 握手、从不跳过勾选。2026-10-11 之前事件里同一含义的字段叫
	// forcedCompletionWithoutAllVerificationsPassed（名不副实）；读历史事件时两个字段名都要认。
	confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: boolean;
	confirmedAcknowledgements: string[];
}

// 族 3「PDV 通过」（Y-EVENT-14）：只在 verifiedAt 真正从空变为有值时调用（即全部核对项勾选后结案）。带原因、未全勾的结案
// 记另一个事件（post_deploy_verification_closed_into_done_with_unchecked_items_reasoned_observed），绝不记成「通过」。
// 事件携带纳入原因、匹配提交、结案时的部署归属区、是否跳过 token 握手、确认项，以及**原始**落地快照（最后已知 HEAD 与其可达的
// 非 merge 自有提交）；不带「是否已落地」的判定——那是 1c 的事。归属区是第三区（提交还没随部署上线）时，这条「通过」
// 不能当作「已在部署后验证」的证据（见 docs/context-inter-work-unit-relation-modeling-overhaul.md 完成条件 4）。
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
					taskDeploymentAttributionZoneAtClosure:
						task.taskDeploymentAttribution?.taskDeploymentAttributionZone ?? null,
					firstDeployedInDeploymentId: task.firstDeployedInDeploymentId,
					postDeployVerificationCompletionPath: input.completionEvidence.postDeployVerificationCompletionPath,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
						input.completionEvidence.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
					confirmedAcknowledgements: input.completionEvidence.confirmedAcknowledgements,
					rawTaskCommitLandingSnapshotAtVerification: rawTaskCommitLandingSnapshot,
				},
			});
		},
	});
}
