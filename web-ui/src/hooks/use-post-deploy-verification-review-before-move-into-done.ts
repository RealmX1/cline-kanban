import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";
import { buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-task-entries-from-read-model-and-board";
import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import type { RuntimePostDeployVerificationDoneEntryClosureRequest } from "@/runtime/types";
import { getTaskColumnId } from "@/state/board-state";
import type { BoardData } from "@/types";

export function usePostDeployVerificationReviewBeforeMoveIntoDone(input: {
	workspaceId: string;
	taskId: string;
	board: BoardData;
	refreshAndReadBoardBeforeCompletion?: () => Promise<BoardData>;
	verification: UsePostDeployVerificationResult;
	runtimeRejectionRevision?: number;
	onConfirmClosureRequestsBySelectedTaskId: (
		requests: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>,
	) => void;
}) {
	const { workspaceId, taskId, board, verification, runtimeRejectionRevision = 0 } = input;
	const [phase, setPhase] = useState<"verification" | "closure_reasons">("verification");
	const [hasVisitedClosureReasons, setHasVisitedClosureReasons] = useState(false);
	const [isPreparingCompletion, setIsPreparingCompletion] = useState(false);
	const [completionError, setCompletionError] = useState<string | null>(null);
	const [inProgressSessionStopAcknowledged, setInProgressSessionStopAcknowledged] = useState(false);
	const columnId = getTaskColumnId(board, taskId);
	const contextIdentity = `${workspaceId}:${taskId}:${columnId}`;
	const latestInputRef = useRef(input);
	latestInputRef.current = input;
	const mountedRef = useRef(true);
	const preparationInFlightRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	// 列、部署或服务端拒绝发生变化时，旧确认不能沿用；已经持久保存的核对结果仍在读模型中。
	useEffect(() => {
		setPhase("verification");
		setInProgressSessionStopAcknowledged(false);
		setHasVisitedClosureReasons(false);
	}, [contextIdentity, verification.activeGroup?.deploymentId]);
	useEffect(() => {
		setPhase("verification");
	}, [runtimeRejectionRevision]);

	const taskEntries = buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard({
		taskIds: [taskId],
		deploymentGroupContainingTasks: verification.activeGroup,
		board,
	});

	const prepareCompletion = useCallback(
		async (closureRequests?: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
			if (preparationInFlightRef.current || verification.isVerificationWriteInFlight) return;
			preparationInFlightRef.current = true;
			setIsPreparingCompletion(true);
			setCompletionError(null);
			const initialDeploymentId = verification.activeGroup?.deploymentId;
			try {
				const group = await verification.refreshAndReadActiveGroup();
				if (!mountedRef.current) return;
				const liveBoard = input.refreshAndReadBoardBeforeCompletion
					? await input.refreshAndReadBoardBeforeCompletion()
					: latestInputRef.current.board;
				if (!mountedRef.current) return;
				const latestInput = latestInputRef.current;
				const liveColumnId = getTaskColumnId(liveBoard, taskId);
				if (
					latestInput.workspaceId !== workspaceId ||
					latestInput.taskId !== taskId ||
					liveColumnId !== columnId ||
					liveColumnId === null ||
					liveColumnId === "trash"
				) {
					throw new Error("任务所在项目或列已变化，请重新核对");
				}
				if (!group || group.workspaceId !== workspaceId || !group.tasks.some((task) => task.taskId === taskId)) {
					throw new Error("当前部署中未找到该任务的核对清单，请刷新后重试");
				}
				if (
					group.tasks
						.find((task) => task.taskId === taskId)
						?.checklist.some((item) => item.run?.status === "running")
				) {
					throw new Error("验证脚本仍在运行，请等待结果后继续");
				}
				if (initialDeploymentId && group.deploymentId !== initialDeploymentId) {
					throw new Error("部署已变化，请核对最新清单后继续");
				}
				const liveEntries = buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard({
					taskIds: [taskId],
					deploymentGroupContainingTasks: group,
					board: liveBoard,
				});
				const entry = liveEntries[0];
				if (!entry) throw new Error("任务已不在看板，无法移入 Done");
				if (entry.uncheckedChecklistItemsRequiringClosureReason.length > 0) {
					if (!closureRequests) {
						setHasVisitedClosureReasons(true);
						setPhase("closure_reasons");
						return;
					}
					const closure = closureRequests[taskId];
					if (
						!closure ||
						(entry.uncheckedChecklistItemsRequiringClosureReason.some(
							(item) =>
								!closure.uncheckedChecklistItemClosureReasons?.some(
									(reason) => reason.checklistItemId === item.checklistItemId,
								),
						) &&
							!closure.closureReasonAppliedToRemainingUncheckedChecklistItems)
					) {
						throw new Error("核对清单已变化，请核对新增或未完成的验证项");
					}
					latestInput.onConfirmClosureRequestsBySelectedTaskId(closureRequests);
					return;
				}
				if (
					liveColumnId === "in_progress" &&
					!inProgressSessionStopAcknowledged &&
					!closureRequests?.[taskId]?.confirmedAcknowledgements?.includes("in_progress_active")
				) {
					throw new Error("请确认已了解会话可能仍在运行，再移入 Done");
				}
				const acknowledgements =
					resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn(liveColumnId);
				latestInput.onConfirmClosureRequestsBySelectedTaskId({
					[taskId]: acknowledgements.length > 0 ? { confirmedAcknowledgements: acknowledgements } : {},
				});
			} catch (error) {
				if (mountedRef.current) {
					setPhase("verification");
					setCompletionError(error instanceof Error ? error.message : "读取核对状态失败，请重试");
				}
			} finally {
				preparationInFlightRef.current = false;
				if (mountedRef.current) setIsPreparingCompletion(false);
			}
		},
		[
			input.refreshAndReadBoardBeforeCompletion,
			verification,
			workspaceId,
			taskId,
			columnId,
			inProgressSessionStopAcknowledged,
		],
	);

	return {
		phase,
		hasVisitedClosureReasons,
		taskEntries,
		isPreparingCompletion,
		completionError,
		inProgressSessionStopAcknowledged,
		setInProgressSessionStopAcknowledged,
		returnToVerification: () => setPhase("verification"),
		continueAfterVerification: () => {
			void prepareCompletion();
		},
		confirmClosureRequests: (requests: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
			void prepareCompletion(requests);
		},
	};
}
