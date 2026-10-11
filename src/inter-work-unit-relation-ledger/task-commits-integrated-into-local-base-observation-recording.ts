import { createHash } from "node:crypto";

import type {
	SharedTaskCommitLandingCriterionSatisfiedObservation,
	SharedTaskCommitLandingCriterionSatisfiedObservationSink,
} from "../workspace/shared-task-commit-landing-criterion-satisfied-observation-port";
import type { BackgroundLedgerEventRecordingRequest } from "./kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";

// 判据有版本：将来改判据（例如纳入 squash 识别）时，读侧据此区分旧观测是按哪套规则得出的。
const SHARED_TASK_COMMIT_LANDING_CRITERION_VERSION = 1;

const SHARED_TASK_COMMIT_LANDING_CRITERION_DETECTOR_SYSTEM_COMPONENT_NAME =
	"shared_task_commit_landing_criterion_detector";

// 同一事实 = 同一张卡、同一世、同一个自有提交集合 S 全部落地。S 不变时 HEAD 前移（例如落地后又吸收了 base）
// 不是新事实；S 变了（新提交又落地了）才是。
export function buildIdempotencyKeyOfTaskCommitsIntegratedIntoLocalBaseObservation(
	observation: SharedTaskCommitLandingCriterionSatisfiedObservation,
): string {
	const sortedTaskOwnedCommitShas = observation.taskOwnedNonMergeCommitsIntegratedIntoLocalBase
		.map((match) => match.taskCommitSha)
		.sort();
	const taskOwnedCommitSetSha256 = createHash("sha256").update(sortedTaskOwnedCommitShas.join("\n")).digest("hex");
	return [
		"task_commits_integrated_into_local_base_observed",
		`criterion-v${SHARED_TASK_COMMIT_LANDING_CRITERION_VERSION}`,
		observation.workspaceId,
		observation.taskId,
		observation.taskCommitProvenanceIncarnationId,
		taskOwnedCommitSetSha256,
	].join(":");
}

// 族 3 `task_commits_integrated_into_local_base_observed`（§R3 Y-PHASE-3）。每次落地探测都会上报当时满足判据的状态，
// 所以这里两层去重：本实例内存里记过的直接跳过（不为每次探测往返 worker）；跨实例 / 重启由账本按幂等键原子去重。
// occurredAt 是观测时刻，不是落地时刻——落地发生在两次探测之间的哪一刻，机器不知道。
// 后台记录入口由激活方注入（绑定激活的那个实例，纳入它的停用 drain），本模块因此不在运行时 import 激活模块。
export function createSharedTaskCommitLandingCriterionSatisfiedObservationSinkRecordingIntoLedger(input: {
	startBackgroundLedgerEventRecordingBoundToThisLiveCapture: (request: BackgroundLedgerEventRecordingRequest) => void;
}): SharedTaskCommitLandingCriterionSatisfiedObservationSink {
	const idempotencyKeysRecordedOrInFlightInThisRuntimeInstance = new Set<string>();
	return {
		recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking: (observation) => {
			const idempotencyKey = buildIdempotencyKeyOfTaskCommitsIntegratedIntoLocalBaseObservation(observation);
			if (idempotencyKeysRecordedOrInFlightInThisRuntimeInstance.has(idempotencyKey)) {
				return;
			}
			idempotencyKeysRecordedOrInFlightInThisRuntimeInstance.add(idempotencyKey);
			input.startBackgroundLedgerEventRecordingBoundToThisLiveCapture({
				backgroundLedgerEventRecordingDescriptionForDiagnostics: `task_commits_integrated_into_local_base_observed for ${observation.taskId}`,
				recordIntoLedgerOfBoundLiveCapture: async (boundLiveCapture) => {
					try {
						await boundLiveCapture.appendFactObservedByKanbanRuntimeUnlessIdempotencyKeyAlreadyRecordedIntoLedgerOfBoundLiveCapture(
							{
								observedFactKind: "task_commits_integrated_into_local_base_observed",
								observingKanbanRuntimeSystemComponentName:
									SHARED_TASK_COMMIT_LANDING_CRITERION_DETECTOR_SYSTEM_COMPONENT_NAME,
								subjectWorkspaceId: observation.workspaceId,
								subjectTaskId: observation.taskId,
								idempotencyKey,
								eventPayload: {
									sharedTaskCommitLandingCriterionVersion: SHARED_TASK_COMMIT_LANDING_CRITERION_VERSION,
									taskCommitProvenanceIncarnationId: observation.taskCommitProvenanceIncarnationId,
									localBaseRef: observation.localBaseRef,
									localBaseRefTipCommitAtObservation: observation.localBaseRefTipCommitAtObservation,
									lastKnownTaskHeadCommit: observation.lastKnownTaskHeadCommit,
									lastTaskWorktreeGitSnapshotObservedAt: observation.lastTaskWorktreeGitSnapshotObservedAt,
									lastKnownTaskHeadObservationSource: observation.lastKnownTaskHeadObservationSource,
									taskOwnedNonMergeCommitsIntegratedIntoLocalBase:
										observation.taskOwnedNonMergeCommitsIntegratedIntoLocalBase,
								},
							},
						);
					} catch (error) {
						// 没记上就让下一次探测重试（账本暂不可用、停机中）。
						idempotencyKeysRecordedOrInFlightInThisRuntimeInstance.delete(idempotencyKey);
						throw error;
					}
				},
			});
		},
	};
}
