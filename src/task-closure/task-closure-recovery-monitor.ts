import type { RuntimeBoardCard } from "../core/api-contract";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import {
	reclaimCancelledTaskClosureRestorationWorktrees,
	reconcileTaskClosureCompletedArchiveRestoration,
	reconcileTaskClosureCompletedSourceWorktreeRemoval,
	reconcileTaskClosureVerifiedArchivePublication,
} from "./task-closure-archive";
import {
	completeTaskClosureAutomaticSideEffect,
	getTaskClosureAutomaticRecoveryState,
	isTaskClosureAutomaticRecoveryEligible,
	recordTaskClosureAutomaticFailure,
} from "./task-closure-automatic-recovery-policy";
import { persistTaskClosureProgressAndProjectOntoCurrentCard } from "./task-closure-operation-progress-projection";
import {
	isTaskClosureLifecycleCancellationRequested,
	listTaskClosureOperations,
	logTaskClosureRecoveryFailure,
	readTaskClosureOperation,
	type TaskClosureOperation,
	withTaskClosureLifecycleCancellationGuards,
	withTaskClosureLifecycleLocks,
	writeTaskClosureHistoryRecord,
	writeTaskClosureOperation,
} from "./task-closure-operation-store";
import { reconcileCancelledTaskClosureCandidateReclamation } from "./task-closure-unverified-candidate-reclamation";

const needsOperationRecovery = (operation: TaskClosureOperation) =>
	!!(
		operation.progress.unverifiedCandidateReclamation &&
		operation.progress.unverifiedCandidateReclamation.phase !== "completed"
	) ||
	!!(operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)) ||
	!["completed", "cancelled"].includes(operation.progress.phase);

/** 运行时只检查具体缺口；总次数及修复补试资格由原请求持久保存。 */
export function createTaskClosureRecoveryMonitor(
	execute: (operation: TaskClosureOperation) => Promise<void>,
	publishProgress?: (workspaceId: string, workspacePath: string) => void | Promise<void>,
	hasLiveSessionCreatedForReopening?: (operation: TaskClosureOperation, card: RuntimeBoardCard) => boolean,
) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let running: Promise<void> | null = null;
	let closed = false;
	const sweep = async () => {
		for (const operation of await listTaskClosureOperations()) {
			if (closed || !needsOperationRecovery(operation)) continue;
			try {
				const claimed = await withTaskClosureLifecycleLocks(
					operation.taskIdentity.workspaceId,
					[operation.taskIdentity.taskId],
					async () => {
						const current = await readTaskClosureOperation(
							operation.taskIdentity,
							operation.progress.closureRequestId,
						);
						if (closed || !current || !needsOperationRecovery(current)) return null;
						const board = await loadWorkspaceBoardById(current.taskIdentity.workspaceId);
						const card = board.columns
							.flatMap((column) => column.cards)
							.find((card) => card.id === current.taskIdentity.taskId);
						if (await isTaskClosureLifecycleCancellationRequested(current)) {
							if (current.reopening && !["completed", "cancelled"].includes(current.reopening.phase))
								current.reopening.phase = "cancelled";
							current.progress.phase = "cancelled";
							current.progress.recoveryCondition = null;
							current.progress.nextRetryAtEpochMs = null;
							if (current.schemaVersion === 2)
								current.progress.unverifiedCandidateReclamation ??= {
									phase: "pending",
									automaticAttemptCount: 0,
									lastError: null,
								};
							await persistTaskClosureProgressAndProjectOntoCurrentCard(
								{ workspacePath: current.workspacePath },
								current,
							);
							await publishProgress?.(current.taskIdentity.workspaceId, current.workspacePath);
						}
						if (
							current.progress.phase === "cancelled" &&
							current.progress.unverifiedCandidateReclamation &&
							card?.createdAt === current.taskIdentity.taskIncarnationCreatedAtEpochMs
						) {
							try {
								await reclaimCancelledTaskClosureRestorationWorktrees(current);
							} catch (error) {
								current.progress.unverifiedCandidateReclamation.phase = "waiting_for_recovery";
								current.progress.unverifiedCandidateReclamation.lastError =
									error instanceof Error ? error.message : String(error);
								if (
									await persistTaskClosureProgressAndProjectOntoCurrentCard(
										{ workspacePath: current.workspacePath },
										current,
									)
								)
									await publishProgress?.(current.taskIdentity.workspaceId, current.workspacePath);
								return null;
							}
							await reconcileCancelledTaskClosureCandidateReclamation(current);
							if (
								await persistTaskClosureProgressAndProjectOntoCurrentCard(
									{ workspacePath: current.workspacePath },
									current,
								)
							)
								await publishProgress?.(current.taskIdentity.workspaceId, current.workspacePath);
							return null;
						}
						if (
							current.progress.phase === "cancelled" &&
							(!current.reopening || ["completed", "cancelled"].includes(current.reopening.phase))
						)
							return null;
						if (
							current.reopening &&
							!["completed", "cancelled"].includes(current.reopening.phase) &&
							card?.createdAt === current.taskIdentity.taskIncarnationCreatedAtEpochMs &&
							card.taskClosureSummary?.eventKind === "reopened" &&
							card.taskClosureSummary.taskIdentity.workspaceId === current.taskIdentity.workspaceId &&
							card.taskClosureSummary.taskIdentity.taskId === current.taskIdentity.taskId &&
							card.taskClosureSummary.taskIdentity.taskIncarnationCreatedAtEpochMs ===
								current.taskIdentity.taskIncarnationCreatedAtEpochMs &&
							card.taskClosureSummary.closureRequestId ===
								(current.reopening.reopeningRequestId ?? current.progress.closureRequestId)
						) {
							const completedRecord = card.taskClosureSummary;
							await withTaskClosureLifecycleCancellationGuards([current], async () => {
								await writeTaskClosureHistoryRecord(completedRecord);
								await completeTaskClosureAutomaticSideEffect(current);
								if (current.reopening) {
									current.reopening.phase = "completed";
									current.reopening.lastError = null;
								}
								await writeTaskClosureOperation(current);
							});
							await publishProgress?.(current.taskIdentity.workspaceId, current.workspacePath);
							return null;
						}
						await reconcileTaskClosureVerifiedArchivePublication(current);
						await reconcileTaskClosureCompletedSourceWorktreeRemoval(current);
						if (
							card?.createdAt === current.taskIdentity.taskIncarnationCreatedAtEpochMs &&
							current.reopening?.automaticRecovery?.pendingSideEffect === "restore_archive"
						) {
							const target = await getTaskWorkspacePathInfo({
								cwd: current.workspacePath,
								taskId: card.id,
								baseRef: card.baseRef,
								worktreeMode: card.worktreeMode,
							});
							await reconcileTaskClosureCompletedArchiveRestoration(current, target.path);
						}
						const identityChanged =
							card &&
							(card.createdAt !== current.taskIdentity.taskIncarnationCreatedAtEpochMs ||
								(!current.reopening &&
									card.updatedAt !== current.sourceTaskUpdatedAtEpochMs &&
									!board.columns.find((column) => column.id === "trash")?.cards.includes(card)));
						const beforeProbe = JSON.stringify(current);
						const completedSessionLaunch =
							current.reopening?.automaticRecovery?.pendingSideEffect === "resume_session" &&
							!current.reopening.automaticRecovery.failureClassification &&
							card?.createdAt === current.taskIdentity.taskIncarnationCreatedAtEpochMs &&
							hasLiveSessionCreatedForReopening?.(current, card);
						const eligible =
							identityChanged ||
							completedSessionLaunch ||
							(await isTaskClosureAutomaticRecoveryEligible(current));
						if (JSON.stringify(current) !== beforeProbe) await writeTaskClosureOperation(current);
						if (!eligible) return null;
						getTaskClosureAutomaticRecoveryState(current);
						await writeTaskClosureOperation(current);
						return current;
					},
				);
				if (claimed) {
					try {
						await execute(claimed);
					} catch (error) {
						logTaskClosureRecoveryFailure(claimed.progress.closureRequestId, error);
						await withTaskClosureLifecycleLocks(
							claimed.taskIdentity.workspaceId,
							[claimed.taskIdentity.taskId],
							async () => {
								const failed = await readTaskClosureOperation(
									claimed.taskIdentity,
									claimed.progress.closureRequestId,
								);
								if (!failed || !needsOperationRecovery(failed)) return;
								if (failed.reopening && !["completed", "cancelled"].includes(failed.reopening.phase))
									failed.reopening.lastError = `自动恢复失败：${error instanceof Error ? error.message : String(error)}`;
								else
									failed.progress.lastError = `自动恢复失败：${error instanceof Error ? error.message : String(error)}`;
								// 入口已记录原始原因时，不能被外层 PRECONDITION_FAILED 覆盖。
								if (!getTaskClosureAutomaticRecoveryState(failed).failureClassification)
									await recordTaskClosureAutomaticFailure(failed, error);
								await writeTaskClosureOperation(failed);
							},
						);
					}
				}
			} catch (error) {
				logTaskClosureRecoveryFailure(operation.progress.closureRequestId, error);
			}
		}
	};
	const kick = () => {
		if (!closed && !running)
			running = sweep()
				.catch((error: unknown) => logTaskClosureRecoveryFailure("扫描持久操作", error))
				.finally(() => {
					running = null;
				});
	};
	return {
		start() {
			kick();
			timer ??= setInterval(kick, 15_000);
			timer.unref();
		},
		async close() {
			closed = true;
			if (timer) clearInterval(timer);
			await running;
		},
	};
}
