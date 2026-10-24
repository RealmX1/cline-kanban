import { type ReactElement, useCallback, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { resolvePostDeployVerificationStuckDoneRecovery } from "@/components/post-deploy-verification/post-deploy-verification-completion-recovery";
import { buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-task-entries-from-read-model-and-board";
import {
	describePostDeployVerificationDoneEntryGateRejectionForHumans,
	isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate,
	listUncheckedChecklistItemsRequiringClosureReason,
} from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import { PostDeployVerificationPanel } from "@/components/post-deploy-verification/post-deploy-verification-panel";
import { PostDeployVerificationReviewBeforeMoveIntoDoneDialog } from "@/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog";
import type { RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries } from "@/components/post-deploy-verification/post-deploy-verification-task-entry-wrapping-real-task-card";
import { PostDeployVerificationUncheckedItemsClosureReasonDialog } from "@/components/post-deploy-verification/post-deploy-verification-unchecked-items-closure-reason-dialog";
import { TaskCommentBeforeMoveIntoDoneDialog } from "@/components/task-comment-before-move-into-done-dialog";
import type { PostDeployVerificationMoveIntoDoneCompletionResult } from "@/hooks/use-board-interactions";
import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import { useTaskCommentBeforeMoveIntoDone } from "@/hooks/use-task-comment-before-move-into-done";
import type {
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
} from "@/runtime/types";
import { findCardSelection, getTaskColumnId } from "@/state/board-state";
import type { BoardColumnId, BoardData } from "@/types";
import type {
	TaskCardMoveIntoDoneRequestHandler,
	TaskCommentToAppendWhenMovingIntoDone,
} from "@/types/task-card-move-into-done-request";

export interface PostDeployVerificationControllerProps {
	// hook 单实例由 App.tsx 持有并下传：controller 与顶栏 badge 共用同一份轮询/状态，
	// 避免双实例重复轮询与「检测到新部署」重复 toast（原 remount-nonce hack 的根因已消除）。
	verification: UsePostDeployVerificationResult;
	board: BoardData;
	// 移列由 useBoardInteractions 提供（awaitable、返回成败）；controller 只在移列成功后才 confirm 标记 state。
	// closure = 逐项原因 / 确认项，随 moveIntoDone 一起提交，由服务端门禁在移列时结案。
	completePostDeployVerificationMoveToDone: (
		taskId: string,
		fromColumnId: BoardColumnId,
		postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest,
		taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
	) => Promise<PostDeployVerificationMoveIntoDoneCompletionResult>;
	// 点击任务卡片跳转 focus view。
	onSelectTask: (taskId: string) => void;
	// 引导定位 anchor.view==="board" 时导航回看板（App 提供 setSelectedTaskId(null)）。
	onNavigateToBoard: () => void;
	onCreateFollowUpTaskFromChecklistItems?: (
		deploymentId: string,
		taskId: string,
		selectedChecklistItemIds: string[],
	) => void;
	// 条目上半部分渲染真实任务卡体所需的数据与看板动作；缺省（隔离的浏览器 fixture）时退回标题行。
	realTaskCardRenderingInputsForPostDeployVerificationPanelEntries?: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	// 看板级对话框（原因对话框、删除确认、置顶原因等，常由面板里卡体上的动作按钮打开）开着时，面板也要降 z 让它盖住。
	isBoardLevelDialogOpenThatMustCoverPostDeployVerificationPanel?: boolean;
	// All projects 视图下面板不跟随当前项目：标题栏显示所绑定项目的名字。单项目视图不给。
	postDeployVerificationWorkspaceProjectNameShownInPanelHeader?: string | null;
}

// 单任务完成流（面板条目的「完成核对并移入 Done」/「带原因移入 Done」）：token / 需确认项 / agent 回复 / 发起时的列。
interface PostDeployVerificationSingleTaskCompletionAwaitingClosureDialog {
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	deploymentId: string;
	taskId: string;
	// review | in_progress | validation（validation 且全勾时不弹窗、不落此态）。
	fromColumnId: BoardColumnId;
	token: string;
	agentResponsePreview: string | undefined;
	requiredAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
}

// 分区批量带原因结案：候选任务由分区标题传入，用户在对话框里勾选纳入哪些。不走 token 流——服务端门禁在
// moveIntoDone 里直接结案（之后的 confirmVerificationComplete 对已结案任务只是幂等返回）。
interface PostDeployVerificationBatchClosureAwaitingClosureDialog {
	deploymentId: string;
	candidateTaskIds: string[];
}

export function PostDeployVerificationController({
	verification,
	board,
	completePostDeployVerificationMoveToDone,
	onSelectTask,
	onNavigateToBoard,
	onCreateFollowUpTaskFromChecklistItems,
	realTaskCardRenderingInputsForPostDeployVerificationPanelEntries = null,
	isBoardLevelDialogOpenThatMustCoverPostDeployVerificationPanel = false,
	postDeployVerificationWorkspaceProjectNameShownInPanelHeader = null,
}: PostDeployVerificationControllerProps): ReactElement {
	const { refresh, requestComplete, confirmComplete } = verification;
	const taskCommentBeforeMoveIntoDone = useTaskCommentBeforeMoveIntoDone();
	const {
		open: openTaskComment,
		returnToEditing: returnTaskCommentToEditing,
		suspendForConfirmation: suspendTaskCommentForConfirmation,
		complete: completeTaskComment,
	} = taskCommentBeforeMoveIntoDone;
	const deploymentIdForTaskCommentCompletionRef = useRef<string | null>(null);
	// 批量结案逐个移列期间 board 会变：每一步都读最新 board 判列，而不是对话框打开那一刻的快照。
	const latestBoardRef = useRef(board);
	latestBoardRef.current = board;

	// 正在跑完成流的 taskId（发放 token / 弹窗 / 移列 / confirm 全程；批量时是正在处理的那一个），用于条目 spinner 与禁用重入。
	const [taskAwaitingDoneEntryReview, setTaskAwaitingDoneEntryReview] = useState<{
		taskId: string;
		runtimeRejectionRevision: number;
		taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	} | null>(null);
	const commentRequiresDoneEntryReviewRef = useRef(false);
	const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
	const [singleTaskCompletionAwaitingClosureDialog, setSingleTaskCompletionAwaitingClosureDialog] =
		useState<PostDeployVerificationSingleTaskCompletionAwaitingClosureDialog | null>(null);
	const [batchClosureAwaitingClosureDialog, setBatchClosureAwaitingClosureDialog] =
		useState<PostDeployVerificationBatchClosureAwaitingClosureDialog | null>(null);
	const [isSubmittingClosure, setIsSubmittingClosure] = useState(false);

	const closeCompletionFlow = useCallback(() => {
		setSingleTaskCompletionAwaitingClosureDialog(null);
		setBatchClosureAwaitingClosureDialog(null);
		setCompletingTaskId(null);
		setIsSubmittingClosure(false);
	}, []);

	// 移列（带 closure）成功 → confirm 标记 state（plan 1d 时序：先移列后 confirm；移列失败则不 confirm、token 保留）。
	// 服务端已在移列时结案的任务，confirm 幂等返回 ok。
	const finalizeSingleTaskCompletion = useCallback(
		async (
			pending: PostDeployVerificationSingleTaskCompletionAwaitingClosureDialog,
			postDeployVerificationDoneEntryClosure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined,
		): Promise<void> => {
			// A1：移列前复检当前列。token 发放后任务若已漂移到别的列（如 review→in_progress 经 idle_stall 反向放行集，
			// 或用户晾着确认框期间被自动流转），pending 里冻结的 requiredAcknowledgements 已过时；直接 finalize 会用
			// 更弱的 ack 集把它推入 Done、跳过本应弹的更强确认（如 in_progress_active）。列变即中止，让用户按当前列重走——
			// 对齐 CLI confirm 的「列变即失效、按当前列重发 token」语义（deployment.ts:722）。
			const liveColumnId = getTaskColumnId(latestBoardRef.current, pending.taskId);
			if (liveColumnId !== pending.fromColumnId) {
				showAppToast({
					intent: "warning",
					message: liveColumnId === null ? "任务已不在看板，核对未完成" : "任务所在列已变化，请重新点击完成核对",
				});
				if (pending.taskCommentToAppendWhenMovingIntoDone)
					returnTaskCommentToEditing(
						pending.taskId,
						"任务所在列已变化，请重新提交评论。",
						pending.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
					);
				closeCompletionFlow();
				refresh();
				return;
			}
			setIsSubmittingClosure(true);
			const moved = await completePostDeployVerificationMoveToDone(
				pending.taskId,
				pending.fromColumnId,
				postDeployVerificationDoneEntryClosure,
				pending.taskCommentToAppendWhenMovingIntoDone,
			);
			if (!moved.ok) {
				const moveIntoDoneFailureMessage = moved.moveIntoDoneFailureMessage ?? "";
				if (pending.taskCommentToAppendWhenMovingIntoDone)
					returnTaskCommentToEditing(
						pending.taskId,
						moveIntoDoneFailureMessage || "移入 Done 失败，评论尚未提交。",
						pending.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
					);
				showAppToast({
					intent: "danger",
					message: isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(
						moveIntoDoneFailureMessage,
					)
						? `${describePostDeployVerificationDoneEntryGateRejectionForHumans(moveIntoDoneFailureMessage)}（核对清单已刷新，请重新点击）`
						: "移入 Done 失败，核对未标记完成",
				});
				closeCompletionFlow();
				refresh();
				return;
			}
			if (pending.taskCommentToAppendWhenMovingIntoDone)
				completeTaskComment(pending.taskId, pending.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
			const confirmed = await confirmComplete({
				deploymentId: pending.deploymentId,
				taskId: pending.taskId,
				token: pending.token,
				acks: pending.requiredAcknowledgements,
			});
			const closedWithUncheckedItemsReasoned =
				(postDeployVerificationDoneEntryClosure?.uncheckedChecklistItemClosureReasons?.length ?? 0) > 0 ||
				postDeployVerificationDoneEntryClosure?.closureReasonAppliedToRemainingUncheckedChecklistItems !==
					undefined;
			if (confirmed?.ok) {
				showAppToast({
					intent: "success",
					message: closedWithUncheckedItemsReasoned ? "已带原因结案并移入 Done" : "已完成核对并移入 Done",
				});
			} else {
				// 卡片已移入 Done，但 state 标记失败（token 过期 / 校验未过）——如实告知，轮询会对账。
				showAppToast({
					intent: "warning",
					message: confirmed?.error ?? "任务已移入 Done，但核对状态标记失败",
				});
			}
			closeCompletionFlow();
			refresh();
		},
		[
			completePostDeployVerificationMoveToDone,
			confirmComplete,
			closeCompletionFlow,
			refresh,
			returnTaskCommentToEditing,
			completeTaskComment,
		],
	);

	const requestSingleTaskCompletion = useCallback(
		async (
			deploymentId: string,
			taskId: string,
			taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
		): Promise<void> => {
			const returnCommentToEditingAfterFailure = (message: string) => {
				if (taskCommentToAppendWhenMovingIntoDone)
					returnTaskCommentToEditing(taskId, message, taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
			};
			if (completingTaskId || batchClosureAwaitingClosureDialog) {
				returnCommentToEditingAfterFailure("已有完成操作正在进行，请稍后重新提交。");
				return;
			}
			// 按任务「当前列」分支（非 columnIdAtMatch 快照）：入 Done 时刻实际所在列决定要哪些确认。
			const currentColumnId = getTaskColumnId(board, taskId);
			if (currentColumnId === null) {
				showAppToast({ intent: "danger", message: "任务已不在看板，无法完成核对" });
				returnCommentToEditingAfterFailure("任务已不在看板，评论尚未提交。");
				return;
			}
			// M4 恢复：先前「移列成功、confirm 失败」的滞留态——任务已在 Done（trash）但未 verified、盘上仍有有效 token。
			// 直接用该 token 重试 confirm（后端已放行 trash + 有效 token），绕过对 trash 拒发新 token 的 requestComplete
			// （那是原本让该滞留态在产品内无法恢复的死角）。仅对空-acks（validation-origin）token 自动恢复：带非空 acks 的
			// review/in_progress token 若在此直接 confirm，会把冻结的 requiredAcknowledgements 原样当作「用户已确认」回传，
			// 伪造本应弹出的 skip_validation / in_progress_active 安全二次确认（见 resolvePostDeployVerificationStuckDoneRecovery
			// 的安全边界注释），故 helper 对非空 acks 返回 null。token 已过期回收 / 已 dropped / 非空 acks 的子态均返回 null，走常规流程。
			const recoveryGroup =
				verification.activeGroup?.deploymentId === deploymentId
					? verification.activeGroup
					: (verification.historyGroups.find((entry) => entry.deploymentId === deploymentId) ?? null);
			const recoveryTask = recoveryGroup?.tasks.find((entry) => entry.taskId === taskId) ?? null;
			const stuckPending = resolvePostDeployVerificationStuckDoneRecovery(recoveryTask, currentColumnId, Date.now());
			if (stuckPending) {
				setCompletingTaskId(taskId);
				const confirmed = await confirmComplete({
					deploymentId,
					taskId,
					token: stuckPending.token,
					acks: stuckPending.requiredAcknowledgements,
				});
				showAppToast(
					confirmed?.ok
						? { intent: "success", message: "已重试并标记核对完成" }
						: { intent: "warning", message: confirmed?.error ?? "重试标记失败（token 可能已过期），请手动处理" },
				);
				setCompletingTaskId(null);
				refresh();
				return;
			}
			setCompletingTaskId(taskId);
			const response = await requestComplete({ deploymentId, taskId });
			if (!response) {
				returnCommentToEditingAfterFailure("无法申请完成核对，请重新提交。");
				setCompletingTaskId(null);
				return;
			}
			if (response.error) {
				returnCommentToEditingAfterFailure(response.error);
				showAppToast({ intent: "danger", message: response.error });
				setCompletingTaskId(null);
				refresh();
				return;
			}
			// 所有合法来源列后端都发放了一次性 token；validation 仅是 needsConfirmation=false（不弹确认），
			// 但同样走「移列成功后再经 confirm 消费 token 标记完成」路径（issue A：移列先于标记，移列失败则不标记）。
			if (!response.confirmationToken) {
				returnCommentToEditingAfterFailure("未获得确认 token，评论尚未提交。");
				showAppToast({ intent: "danger", message: "未获得确认 token，无法完成核对" });
				setCompletingTaskId(null);
				refresh();
				return;
			}
			const pending: PostDeployVerificationSingleTaskCompletionAwaitingClosureDialog = {
				...(taskCommentToAppendWhenMovingIntoDone ? { taskCommentToAppendWhenMovingIntoDone } : {}),
				deploymentId,
				taskId,
				fromColumnId: currentColumnId,
				token: response.confirmationToken,
				agentResponsePreview: response.agentResponsePreview,
				requiredAcknowledgements: response.requiredAcknowledgements ?? [],
			};
			const taskInReadModel = recoveryTask;
			const hasUncheckedChecklistItems =
				taskInReadModel !== null && listUncheckedChecklistItemsRequiringClosureReason(taskInReadModel).length > 0;
			// validation 且全勾：直接移列 + confirm 标记；有未勾项或要确认（review / in_progress）：打开原因对话框。
			if (!response.needsConfirmation && !hasUncheckedChecklistItems) {
				await finalizeSingleTaskCompletion(pending, undefined);
				return;
			}
			if (taskCommentToAppendWhenMovingIntoDone)
				suspendTaskCommentForConfirmation(taskId, taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
			setSingleTaskCompletionAwaitingClosureDialog(pending);
		},
		[
			batchClosureAwaitingClosureDialog,
			board,
			completingTaskId,
			requestComplete,
			confirmComplete,
			finalizeSingleTaskCompletion,
			refresh,
			verification.activeGroup,
			verification.historyGroups,
			returnTaskCommentToEditing,
			suspendTaskCommentForConfirmation,
		],
	);

	const handleRequestComplete = useCallback(
		(deploymentId: string, taskId: string, options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) => {
			if (completingTaskId || batchClosureAwaitingClosureDialog || taskCommentBeforeMoveIntoDone.request) return;
			if (options?.requestTaskCommentBeforeMovingIntoDone) {
				const selection = findCardSelection(board, taskId);
				if (
					!selection ||
					realTaskCardRenderingInputsForPostDeployVerificationPanelEntries?.realTaskCardRenderingInputsBoardSourceKind !==
						"runtime_board_snapshot_of_workspace_not_hydrated_in_browser"
				)
					return;
				deploymentIdForTaskCommentCompletionRef.current = deploymentId;
				openTaskComment(
					realTaskCardRenderingInputsForPostDeployVerificationPanelEntries.workspaceIdOwningRuntimeBoardSnapshot,
					selection.card,
				);
				return;
			}
			void requestSingleTaskCompletion(deploymentId, taskId);
		},
		[
			board,
			completingTaskId,
			batchClosureAwaitingClosureDialog,
			taskCommentBeforeMoveIntoDone.request,
			realTaskCardRenderingInputsForPostDeployVerificationPanelEntries,
			openTaskComment,
			requestSingleTaskCompletion,
		],
	);

	const handleRequestMoveIntoDoneFromTaskCard = (
		deploymentId: string,
		taskId: string,
		options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1],
	) => {
		if (completingTaskId || taskAwaitingDoneEntryReview || batchClosureAwaitingClosureDialog) return;
		const task = verification.activeGroup?.tasks.find((entry) => entry.taskId === taskId);
		if (options?.requestTaskCommentBeforeMovingIntoDone) {
			commentRequiresDoneEntryReviewRef.current = !!task?.checklist.some((item) => !item.checked);
			handleRequestComplete(deploymentId, taskId, options);
		} else if (task?.checklist.some((item) => !item.checked)) {
			setTaskAwaitingDoneEntryReview({ taskId, runtimeRejectionRevision: 0 });
		} else {
			handleRequestComplete(deploymentId, taskId, options);
		}
	};

	const submitTaskCommentBeforeCompletion = (commentText: string) => {
		const request = taskCommentBeforeMoveIntoDone.request;
		const deploymentId = deploymentIdForTaskCommentCompletionRef.current;
		if (!request || !deploymentId) return;
		if (
			realTaskCardRenderingInputsForPostDeployVerificationPanelEntries?.realTaskCardRenderingInputsBoardSourceKind !==
				"runtime_board_snapshot_of_workspace_not_hydrated_in_browser" ||
			realTaskCardRenderingInputsForPostDeployVerificationPanelEntries.workspaceIdOwningRuntimeBoardSnapshot !==
				request.workspaceId
		) {
			returnTaskCommentToEditing(request.taskId, "当前核对的项目已变化，请关闭评论弹窗后重新操作。");
			return;
		}
		const taskCommentToAppendWhenMovingIntoDone = taskCommentBeforeMoveIntoDone.prepareSubmission(commentText);
		if (!taskCommentToAppendWhenMovingIntoDone) return;
		const currentTaskCardSelection = findCardSelection(latestBoardRef.current, request.taskId);
		if (currentTaskCardSelection?.column.id === "trash") {
			// 响应丢失后只结算已保存的同一评论；PDV 状态仍由原有完成恢复流程处理。
			if (
				currentTaskCardSelection.card.taskCommentEntries?.some(
					(entry) =>
						entry.taskCommentEntryId === taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId &&
						entry.commentText === taskCommentToAppendWhenMovingIntoDone.commentText,
				)
			)
				completeTaskComment(request.taskId, taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
			else
				returnTaskCommentToEditing(
					request.taskId,
					"任务已移入 Done，尚无法确认本次评论已保存，请核对任务评论后取消或重试。",
					taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
				);
			return;
		}
		if (commentRequiresDoneEntryReviewRef.current) {
			suspendTaskCommentForConfirmation(request.taskId, taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
			setTaskAwaitingDoneEntryReview({
				taskId: request.taskId,
				runtimeRejectionRevision: 0,
				taskCommentToAppendWhenMovingIntoDone,
			});
		} else {
			void requestSingleTaskCompletion(deploymentId, request.taskId, taskCommentToAppendWhenMovingIntoDone);
		}
	};

	const handleRequestBatchClosureWithReasonsOfZoneTasks = useCallback(
		(deploymentId: string, candidateTaskIds: string[]) => {
			if (completingTaskId || singleTaskCompletionAwaitingClosureDialog || candidateTaskIds.length === 0) {
				return;
			}
			setBatchClosureAwaitingClosureDialog({ deploymentId, candidateTaskIds });
		},
		[completingTaskId, singleTaskCompletionAwaitingClosureDialog],
	);

	// 对话框条目由读模型 + 看板现算：对话框开着时 30s 轮询带来的新未勾项也会出现。
	const closureDialogTaskEntries = useMemo(() => {
		if (singleTaskCompletionAwaitingClosureDialog) {
			return buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard({
				taskIds: [singleTaskCompletionAwaitingClosureDialog.taskId],
				deploymentGroupContainingTasks: verification.activeGroup,
				board,
				agentResponsePreviewByTaskId: {
					[singleTaskCompletionAwaitingClosureDialog.taskId]:
						singleTaskCompletionAwaitingClosureDialog.agentResponsePreview ?? null,
				},
			});
		}
		if (batchClosureAwaitingClosureDialog) {
			return buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard({
				taskIds: batchClosureAwaitingClosureDialog.candidateTaskIds,
				deploymentGroupContainingTasks: verification.activeGroup,
				board,
			});
		}
		return [];
	}, [batchClosureAwaitingClosureDialog, board, singleTaskCompletionAwaitingClosureDialog, verification.activeGroup]);

	const handleConfirmSingleTaskClosure = useCallback(
		(closureRequestsBySelectedTaskId: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
			const pending = singleTaskCompletionAwaitingClosureDialog;
			if (!pending || isSubmittingClosure) {
				return;
			}
			const closureRequest = closureRequestsBySelectedTaskId[pending.taskId] ?? {};
			// 确认项以服务端按来源列发放的为准（与 confirm 回传的 acks 一致）。
			void finalizeSingleTaskCompletion(pending, {
				...closureRequest,
				...(pending.requiredAcknowledgements.length > 0
					? { confirmedAcknowledgements: pending.requiredAcknowledgements }
					: {}),
			});
		},
		[finalizeSingleTaskCompletion, isSubmittingClosure, singleTaskCompletionAwaitingClosureDialog],
	);

	// 逐个调用 moveIntoDone（带各自的 closure），逐个报告失败；列在对话框确认后变了的任务跳过（确认项已过时）。
	const handleConfirmBatchClosure = useCallback(
		async (
			closureRequestsBySelectedTaskId: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>,
		): Promise<void> => {
			if (!batchClosureAwaitingClosureDialog || isSubmittingClosure) {
				return;
			}
			const boardColumnIdAtConfirmationByTaskId = new Map(
				closureDialogTaskEntries.map((entry) => [entry.taskId, entry.boardColumnIdOfTaskCardBeforeMoveIntoDone]),
			);
			setIsSubmittingClosure(true);
			const failedTaskDescriptions: string[] = [];
			let closedTaskCount = 0;
			for (const [taskId, closureRequest] of Object.entries(closureRequestsBySelectedTaskId)) {
				const liveColumnId = getTaskColumnId(latestBoardRef.current, taskId);
				const taskTitle =
					closureDialogTaskEntries.find((entry) => entry.taskId === taskId)?.taskTitle ?? `任务 ${taskId}`;
				if (liveColumnId === null || liveColumnId === "trash") {
					failedTaskDescriptions.push(`${taskTitle}：已不在看板或已在 Done`);
					continue;
				}
				if (liveColumnId !== boardColumnIdAtConfirmationByTaskId.get(taskId)) {
					failedTaskDescriptions.push(`${taskTitle}：所在列已变化，请重新结案`);
					continue;
				}
				setCompletingTaskId(taskId);
				const moved = await completePostDeployVerificationMoveToDone(taskId, liveColumnId, closureRequest);
				if (moved.ok) {
					closedTaskCount += 1;
					continue;
				}
				const moveIntoDoneFailureMessage = moved.moveIntoDoneFailureMessage ?? "移入 Done 失败";
				failedTaskDescriptions.push(
					`${taskTitle}：${
						isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(moveIntoDoneFailureMessage)
							? describePostDeployVerificationDoneEntryGateRejectionForHumans(moveIntoDoneFailureMessage)
							: moveIntoDoneFailureMessage
					}`,
				);
			}
			if (failedTaskDescriptions.length === 0) {
				showAppToast({ intent: "success", message: `已结案并移入 Done：${closedTaskCount} 个任务` });
			} else {
				showAppToast({
					intent: closedTaskCount > 0 ? "warning" : "danger",
					message: `已结案 ${closedTaskCount} 个，失败 ${failedTaskDescriptions.length} 个——${failedTaskDescriptions.join("；")}`,
					timeout: 12000,
				});
			}
			closeCompletionFlow();
			refresh();
		},
		[
			batchClosureAwaitingClosureDialog,
			closeCompletionFlow,
			closureDialogTaskEntries,
			completePostDeployVerificationMoveToDone,
			isSubmittingClosure,
			refresh,
		],
	);

	// 对话框取消（取消 / Esc）：提交进行中忽略，避免半途中断；否则重置流程（token 留至过期）。
	const handleCancelClosureDialog = useCallback(() => {
		if (isSubmittingClosure) {
			return;
		}
		const pending = singleTaskCompletionAwaitingClosureDialog;
		if (pending?.taskCommentToAppendWhenMovingIntoDone)
			returnTaskCommentToEditing(
				pending.taskId,
				null,
				pending.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
			);
		closeCompletionFlow();
	}, [
		closeCompletionFlow,
		isSubmittingClosure,
		singleTaskCompletionAwaitingClosureDialog,
		returnTaskCommentToEditing,
	]);

	const isClosureDialogOpen =
		singleTaskCompletionAwaitingClosureDialog !== null || batchClosureAwaitingClosureDialog !== null;

	return (
		<>
			{taskAwaitingDoneEntryReview && verification.activeGroup ? (
				<PostDeployVerificationReviewBeforeMoveIntoDoneDialog
					workspaceId={verification.activeGroup.workspaceId}
					taskId={taskAwaitingDoneEntryReview.taskId}
					board={board}
					verification={verification}
					realTaskCardRenderingInputs={realTaskCardRenderingInputsForPostDeployVerificationPanelEntries}
					isSubmittingClosure={isSubmittingClosure}
					runtimeRejectionRevision={taskAwaitingDoneEntryReview.runtimeRejectionRevision}
					onSelectTask={() => onSelectTask(taskAwaitingDoneEntryReview.taskId)}
					onNavigateToBoard={onNavigateToBoard}
					onRequestTaskCommentBeforeMovingIntoDone={() => {
						const taskId = taskAwaitingDoneEntryReview.taskId;
						setTaskAwaitingDoneEntryReview(null);
						commentRequiresDoneEntryReviewRef.current = true;
						if (taskCommentBeforeMoveIntoDone.request) returnTaskCommentToEditing(taskId);
						else
							handleRequestComplete(verification.activeGroup!.deploymentId, taskId, {
								requestTaskCommentBeforeMovingIntoDone: true,
							});
					}}
					onCancel={() => {
						if (taskAwaitingDoneEntryReview.taskCommentToAppendWhenMovingIntoDone)
							returnTaskCommentToEditing(taskAwaitingDoneEntryReview.taskId);
						setTaskAwaitingDoneEntryReview(null);
					}}
					onConfirmClosureRequestsBySelectedTaskId={(requests) => {
						const pending = taskAwaitingDoneEntryReview;
						const column = getTaskColumnId(latestBoardRef.current, pending.taskId);
						const closure = requests[pending.taskId];
						if (!column || column === "trash" || !closure || isSubmittingClosure) return;
						setIsSubmittingClosure(true);
						void completePostDeployVerificationMoveToDone(
							pending.taskId,
							column,
							closure,
							pending.taskCommentToAppendWhenMovingIntoDone,
						)
							.then((result) => {
								if (result.ok) {
									setTaskAwaitingDoneEntryReview(null);
									commentRequiresDoneEntryReviewRef.current = false;
									if (pending.taskCommentToAppendWhenMovingIntoDone)
										completeTaskComment(
											pending.taskId,
											pending.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
										);
								} else {
									setTaskAwaitingDoneEntryReview((current) =>
										current
											? { ...current, runtimeRejectionRevision: current.runtimeRejectionRevision + 1 }
											: null,
									);
									showAppToast({
										intent: "danger",
										message: result.moveIntoDoneFailureMessage ?? "移入 Done 失败，请重试",
									});
								}
								refresh();
							})
							.finally(() => setIsSubmittingClosure(false));
					}}
				/>
			) : null}

			<PostDeployVerificationPanel
				activeGroup={verification.activeGroup}
				historyGroups={verification.historyGroups}
				hasLoadedOnce={verification.hasLoadedOnce}
				loadError={verification.loadError}
				board={board}
				realTaskCardRenderingInputs={realTaskCardRenderingInputsForPostDeployVerificationPanelEntries}
				postDeployVerificationWorkspaceProjectNameShownInPanelHeader={
					postDeployVerificationWorkspaceProjectNameShownInPanelHeader
				}
				stayInFront={verification.stayInFront}
				collapsed={verification.collapsed}
				loweredForDialog={
					isClosureDialogOpen ||
					taskCommentBeforeMoveIntoDone.request !== null ||
					isBoardLevelDialogOpenThatMustCoverPostDeployVerificationPanel ||
					taskAwaitingDoneEntryReview !== null
				}
				completingTaskId={completingTaskId}
				isBatchClosureWithReasonsInFlight={batchClosureAwaitingClosureDialog !== null}
				onToggleStayInFront={() => verification.setStayInFront((current) => !current)}
				onToggleCollapsed={() => verification.setCollapsed((current) => !current)}
				onToggleChecklistItem={verification.toggleChecklistItem}
				onAddCustomChecklistItem={verification.addCustomChecklistItem}
				onRemoveCustomChecklistItem={verification.removeCustomChecklistItem}
				onRunVerificationItem={verification.runVerificationItem}
				onRequestComplete={handleRequestComplete}
				onRequestMoveIntoDoneFromTaskCard={handleRequestMoveIntoDoneFromTaskCard}
				onRequestBatchClosureWithReasonsOfZoneTasks={handleRequestBatchClosureWithReasonsOfZoneTasks}
				onSelectTask={onSelectTask}
				onNavigateToBoard={onNavigateToBoard}
				onCreateFollowUpTaskFromChecklistItems={onCreateFollowUpTaskFromChecklistItems}
			/>
			<TaskCommentBeforeMoveIntoDoneDialog
				controller={taskCommentBeforeMoveIntoDone}
				onSubmit={submitTaskCommentBeforeCompletion}
			/>
			{singleTaskCompletionAwaitingClosureDialog ? (
				<PostDeployVerificationUncheckedItemsClosureReasonDialog
					key={`single:${singleTaskCompletionAwaitingClosureDialog.taskId}:${singleTaskCompletionAwaitingClosureDialog.token}`}
					dialogTitle="完成核对并移入 Done"
					taskEntries={closureDialogTaskEntries}
					taskEntrySelectionMode="single_task_entry_always_included"
					isSubmittingClosure={isSubmittingClosure}
					onCancel={handleCancelClosureDialog}
					onConfirmClosureRequestsBySelectedTaskId={handleConfirmSingleTaskClosure}
				/>
			) : null}
			{batchClosureAwaitingClosureDialog ? (
				<PostDeployVerificationUncheckedItemsClosureReasonDialog
					key={`batch:${batchClosureAwaitingClosureDialog.deploymentId}:${batchClosureAwaitingClosureDialog.candidateTaskIds.join(",")}`}
					dialogTitle="批量带原因结案并移入 Done"
					taskEntries={closureDialogTaskEntries}
					taskEntrySelectionMode="multiple_task_entries_selectable_for_batch_closure"
					isSubmittingClosure={isSubmittingClosure}
					onCancel={handleCancelClosureDialog}
					onConfirmClosureRequestsBySelectedTaskId={(closureRequestsBySelectedTaskId) => {
						void handleConfirmBatchClosure(closureRequestsBySelectedTaskId);
					}}
				/>
			) : null}
		</>
	);
}
