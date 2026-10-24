import { ClipboardCheck } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import {
	PostDeployVerificationTaskEntryWrappingRealTaskCard,
	type RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries,
} from "@/components/post-deploy-verification/post-deploy-verification-task-entry-wrapping-real-task-card";
import { PostDeployVerificationUncheckedItemsClosureReasonDialog } from "@/components/post-deploy-verification/post-deploy-verification-unchecked-items-closure-reason-dialog";
import { VerificationGuidanceOverlay } from "@/components/post-deploy-verification/verification-guidance-overlay";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { type UsePostDeployVerificationResult, usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import { usePostDeployVerificationReviewBeforeMoveIntoDone } from "@/hooks/use-post-deploy-verification-review-before-move-into-done";
import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
} from "@/runtime/types";
import { getTaskColumnId } from "@/state/board-state";
import type { BoardData } from "@/types";
import type { TaskCardMoveIntoDoneRequestHandler } from "@/types/task-card-move-into-done-request";

export interface PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps {
	workspaceId: string;
	taskId: string;
	board: BoardData;
	refreshAndReadBoardBeforeCompletion?: () => Promise<BoardData>;
	verification: UsePostDeployVerificationResult;
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	isSubmittingClosure: boolean;
	runtimeRejectionRevision?: number;
	onCancel: () => void;
	onConfirmClosureRequestsBySelectedTaskId: (
		requests: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>,
	) => void;
	onSelectTask?: () => void;
	onNavigateToBoard?: () => void | Promise<void>;
	onRequestTaskCommentBeforeMovingIntoDone?: () => void;
}

export function PostDeployVerificationReviewBeforeMoveIntoDoneForWorkspace(
	props: Omit<PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps, "verification"> & {
		verification?: UsePostDeployVerificationResult;
	},
): ReactElement {
	return props.verification ? (
		<PostDeployVerificationReviewBeforeMoveIntoDoneDialog {...props} verification={props.verification} />
	) : (
		<PostDeployVerificationReviewBeforeMoveIntoDoneWithWorkspaceReadModel {...props} />
	);
}

// 按需工作区读模型只在弹窗存活期间存在，不开启第二份常驻轮询或改变顶栏 PDV 项目绑定。
export function PostDeployVerificationReviewBeforeMoveIntoDoneWithWorkspaceReadModel(
	props: Omit<PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps, "verification">,
): ReactElement {
	const verification = usePostDeployVerification(props.workspaceId, {
		pollingEnabled: false,
		showDeploymentNotifications: false,
	});
	return <PostDeployVerificationReviewBeforeMoveIntoDoneDialog {...props} verification={verification} />;
}

export function PostDeployVerificationReviewBeforeMoveIntoDoneDialog(
	props: PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps,
): ReactElement {
	const {
		workspaceId,
		taskId,
		board,
		verification,
		realTaskCardRenderingInputs,
		onCancel,
		onSelectTask,
		onNavigateToBoard,
	} = props;
	const review = usePostDeployVerificationReviewBeforeMoveIntoDone(props);
	const [guidedManualItem, setGuidedManualItem] = useState<RuntimePostDeployVerificationChecklistItem | null>(null);
	const task =
		verification.activeGroup?.workspaceId === workspaceId
			? verification.activeGroup.tasks.find((entry) => entry.taskId === taskId)
			: null;
	const [guidanceNavigationError, setGuidanceNavigationError] = useState<string | null>(null);
	const [isGuidanceNavigationPending, setIsGuidanceNavigationPending] = useState(false);
	const deploymentId = verification.activeGroup?.deploymentId;
	useEffect(() => {
		setGuidedManualItem(null);
	}, [workspaceId, taskId, deploymentId]);
	const isVerificationScriptRunning = !!task?.checklist.some((item) => item.run?.status === "running");
	const isBusy =
		isGuidanceNavigationPending ||
		props.isSubmittingClosure ||
		review.isPreparingCompletion ||
		verification.isVerificationWriteInFlight ||
		isVerificationScriptRunning;
	const returnToTask = () => {
		onSelectTask?.();
	};
	const requestReviewedMoveIntoDone = (options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) => {
		if (isBusy) return;
		if (options?.requestTaskCommentBeforeMovingIntoDone) {
			props.onRequestTaskCommentBeforeMovingIntoDone?.();
			return;
		}
		review.continueAfterVerification();
	};
	// Done 只继续当前流程，不能再次调用主看板的入口，避免递归打开核对弹窗。
	const taskCardRenderingInputs =
		realTaskCardRenderingInputs?.realTaskCardRenderingInputsBoardSourceKind ===
		"current_project_board_hydrated_in_browser"
			? {
					...realTaskCardRenderingInputs,
					currentProjectTaskCardActionHandlers: {
						...realTaskCardRenderingInputs.currentProjectTaskCardActionHandlers,
						onMoveToTrashTask: (_taskId: string, options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) =>
							requestReviewedMoveIntoDone(options),
						moveToTrashLoadingById: { [taskId]: isBusy },
					},
				}
			: realTaskCardRenderingInputs;
	return (
		<>
			<Dialog
				open={review.phase === "verification" && guidedManualItem === null}
				onOpenChange={(open) => {
					if (!open && !isBusy) onCancel();
				}}
				contentClassName="!max-w-2xl"
			>
				<DialogHeader title="移入 Done 前核对" icon={<ClipboardCheck size={16} />} />
				<DialogBody className="space-y-3">
					{task && deploymentId ? (
						<PostDeployVerificationTaskEntryWrappingRealTaskCard
							postDeployVerificationTask={task}
							board={board}
							realTaskCardRenderingInputs={taskCardRenderingInputs}
							retainedDeploymentGroupsByDeploymentId={
								new Map(verification.historyGroups.map((group) => [group.deploymentId, group]))
							}
							interactive
							checklistInitiallyExpanded
							isCompleting={isBusy}
							completionActionRendering="review_before_move_into_done"
							onToggleChecklistItem={(itemId, checked) => {
								void verification.toggleChecklistItem(deploymentId, taskId, itemId, checked);
							}}
							onAddCustomChecklistItem={(label) => {
								void verification.addCustomChecklistItem(deploymentId, taskId, label);
							}}
							onRemoveCustomChecklistItem={(itemId) => {
								void verification.removeCustomChecklistItem(deploymentId, taskId, itemId);
							}}
							onRunVerificationItem={(itemId) => {
								void verification.runVerificationItem(deploymentId, taskId, itemId);
							}}
							onRequestComplete={requestReviewedMoveIntoDone}
							onSelectTask={returnToTask}
							onNavigateToBoard={() => onNavigateToBoard?.()}
							onRequestGuidedManualVerification={(item, locate) => {
								setGuidanceNavigationError(null);
								setIsGuidanceNavigationPending(true);
								void Promise.resolve()
									.then(locate)
									.then(() => setGuidedManualItem(item))
									.catch((error: unknown) => {
										setGuidanceNavigationError(
											error instanceof Error ? error.message : "导航到核对目标失败，请重试",
										);
									})
									.finally(() => setIsGuidanceNavigationPending(false));
							}}
						/>
					) : (
						<p role="status" className="text-sm text-text-secondary">
							{verification.hasLoadedOnce ? "尚未读到该任务的核对清单，请刷新后重试。" : "正在加载核对清单…"}
						</p>
					)}
					{getTaskColumnId(board, taskId) === "review" || getTaskColumnId(board, taskId) === "in_progress" ? (
						<p className="text-xs text-status-orange">
							该任务不在 Validation 列；移入 Done 将跳过 Validation 列，同时停止会话、清理 worktree。
						</p>
					) : null}
					{getTaskColumnId(board, taskId) === "in_progress" ? (
						<label className="flex items-start gap-2 text-xs text-text-primary">
							<input
								type="checkbox"
								checked={review.inProgressSessionStopAcknowledged}
								disabled={isBusy}
								onChange={(event) => review.setInProgressSessionStopAcknowledged(event.target.checked)}
							/>
							我已了解 In Progress 任务的会话可能仍在运行，移入 Done 会停止会话并清理 worktree。
						</label>
					) : null}
					{guidanceNavigationError || review.completionError || verification.loadError ? (
						<p role="alert" className="text-sm text-status-red">
							{guidanceNavigationError ?? review.completionError ?? verification.loadError}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					{!task || verification.loadError || isVerificationScriptRunning ? (
						<Button
							disabled={
								props.isSubmittingClosure ||
								review.isPreparingCompletion ||
								verification.isVerificationWriteInFlight
							}
							onClick={verification.refresh}
						>
							刷新核对清单
						</Button>
					) : null}
					<Button disabled={props.isSubmittingClosure || review.isPreparingCompletion} onClick={onCancel}>
						取消
					</Button>
				</DialogFooter>
			</Dialog>
			{review.hasVisitedClosureReasons ? (
				<PostDeployVerificationUncheckedItemsClosureReasonDialog
					open={review.phase === "closure_reasons"}
					dialogTitle="带原因移入 Done"
					taskEntries={review.taskEntries}
					taskEntrySelectionMode="single_task_entry_always_included"
					isSubmittingClosure={isBusy}
					onReturnToVerification={review.returnToVerification}
					onCancel={onCancel}
					onConfirmClosureRequestsBySelectedTaskId={review.confirmClosureRequests}
				/>
			) : null}
			{guidedManualItem?.guidance ? (
				<VerificationGuidanceOverlay
					label={guidedManualItem.label}
					guidance={guidedManualItem.guidance}
					onConfirmObserved={() => {
						if (deploymentId)
							void verification.toggleChecklistItem(deploymentId, taskId, guidedManualItem.id, true);
						setGuidedManualItem(null);
					}}
					onReportFailed={() => setGuidedManualItem(null)}
					onClose={() => setGuidedManualItem(null)}
				/>
			) : null}
		</>
	);
}
