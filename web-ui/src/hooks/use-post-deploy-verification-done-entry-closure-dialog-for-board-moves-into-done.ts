import { useCallback, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { PostDeployVerificationDoneEntryClosureDialogTaskEntry } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";
import {
	buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard,
	resolveTaskTitleForPostDeployVerificationPanel,
} from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-task-entries-from-read-model-and-board";
import type { RuntimePostDeployVerificationDeploymentGroup } from "@/runtime/types";
import type { BoardData } from "@/types";

// 看板入口（卡片按钮 / 详情底栏 / 拖拽进 Done / 服务端拒绝兜底）的「带原因移入 Done」对话框状态。
// 移列本身由 use-board-interactions 执行；这里只持有「哪张卡在等原因」与对话框条目（由读模型 + 看板现算），
// 以及「浏览器端自动化撞上门禁只提示一次」的去重。PDV 面板自己的完成流另有一份对话框（在 controller 里）。

export interface PostDeployVerificationDoneEntryClosureDialogRequestForBoardMoveIntoDone {
	taskId: string;
	// 拖拽进 Done 的落点；按钮入口缺省（列顶）。
	insertAtIndexWithinDoneBoardColumn: number | undefined;
	// 服务端已以 PRECONDITION_FAILED 拒绝过一次（客户端预检数据过期）。
	runtimeRejectedMoveIntoDoneForMissingClosureReasons: boolean;
}

export interface PostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone {
	dialogRequest: PostDeployVerificationDoneEntryClosureDialogRequestForBoardMoveIntoDone;
	taskEntries: PostDeployVerificationDoneEntryClosureDialogTaskEntry[];
}

export interface UsePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDoneResult {
	closureDialogForBoardMoveIntoDone: PostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone | null;
	openClosureDialogForBoardMoveIntoDone: (
		dialogRequest: PostDeployVerificationDoneEntryClosureDialogRequestForBoardMoveIntoDone,
	) => void;
	markClosureDialogTaskRejectedByRuntimeForMissingClosureReasons: (taskId: string) => void;
	closeClosureDialogForBoardMoveIntoDone: () => void;
	isClosureForBoardMoveIntoDoneSubmitting: boolean;
	setIsClosureForBoardMoveIntoDoneSubmitting: (isSubmitting: boolean) => void;
	showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard: (taskId: string) => void;
}

export function usePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDone({
	board,
	postDeployVerificationActiveDeploymentGroup,
}: {
	board: BoardData;
	postDeployVerificationActiveDeploymentGroup: RuntimePostDeployVerificationDeploymentGroup | null;
}): UsePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDoneResult {
	const [dialogRequest, setDialogRequest] =
		useState<PostDeployVerificationDoneEntryClosureDialogRequestForBoardMoveIntoDone | null>(null);
	const [isClosureForBoardMoveIntoDoneSubmitting, setIsClosureForBoardMoveIntoDoneSubmitting] = useState(false);
	// 自动化（自动 review 完成、会话中断流转）撞上门禁的卡：每张卡在本页面生命周期里只提示一次。
	const taskIdsAlreadyNoticedForAutomationSkippingGatedTaskCardRef = useRef(new Set<string>());
	// 提示里带上任务标题：提示函数身份要稳定（自动流转 effect 依赖它），标题从最新 board 现取。
	const latestBoardForNoticeTaskTitleRef = useRef(board);
	latestBoardForNoticeTaskTitleRef.current = board;

	const closureDialogForBoardMoveIntoDone = useMemo(() => {
		if (!dialogRequest) {
			return null;
		}
		const taskEntries = buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard({
			taskIds: [dialogRequest.taskId],
			deploymentGroupContainingTasks: postDeployVerificationActiveDeploymentGroup,
			board,
			taskIdsRejectedByRuntimeForMissingClosureReasons:
				dialogRequest.runtimeRejectedMoveIntoDoneForMissingClosureReasons
					? new Set([dialogRequest.taskId])
					: undefined,
		});
		return { dialogRequest, taskEntries };
	}, [board, dialogRequest, postDeployVerificationActiveDeploymentGroup]);

	const markClosureDialogTaskRejectedByRuntimeForMissingClosureReasons = useCallback((taskId: string) => {
		setDialogRequest((current) =>
			current && current.taskId === taskId
				? { ...current, runtimeRejectedMoveIntoDoneForMissingClosureReasons: true }
				: current,
		);
	}, []);

	const closeClosureDialogForBoardMoveIntoDone = useCallback(() => {
		setDialogRequest(null);
		setIsClosureForBoardMoveIntoDoneSubmitting(false);
	}, []);

	const showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard = useCallback((taskId: string) => {
		const noticedTaskIds = taskIdsAlreadyNoticedForAutomationSkippingGatedTaskCardRef.current;
		if (noticedTaskIds.has(taskId)) {
			return;
		}
		noticedTaskIds.add(taskId);
		showAppToast({
			intent: "warning",
			icon: "warning-sign",
			message: `「${resolveTaskTitleForPostDeployVerificationPanel(latestBoardForNoticeTaskTitleRef.current, taskId)}」的 Post-Deploy Verification 还有未勾项，没有自动移入 Done：请在 PDV 面板或看板上带原因移入 Done。`,
			timeout: 7000,
		});
	}, []);

	return {
		closureDialogForBoardMoveIntoDone,
		openClosureDialogForBoardMoveIntoDone: setDialogRequest,
		markClosureDialogTaskRejectedByRuntimeForMissingClosureReasons,
		closeClosureDialogForBoardMoveIntoDone,
		isClosureForBoardMoveIntoDoneSubmitting,
		setIsClosureForBoardMoveIntoDoneSubmitting,
		showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard,
	};
}
