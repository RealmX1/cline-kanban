import { type ReactElement, useCallback, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { GuidedVerificationDoneConfirmDialog } from "@/components/guided-verification/guided-verification-done-confirm-dialog";
import { GuidedVerificationPanel } from "@/components/guided-verification/guided-verification-panel";
import { InProgressDoneWarningDialog } from "@/components/guided-verification/in-progress-done-warning-dialog";
import type { UseGuidedVerificationResult } from "@/hooks/use-guided-verification";
import type { RuntimeGuidedVerificationAcknowledgement } from "@/runtime/types";
import { findCardSelection, getTaskColumnId } from "@/state/board-state";
import type { BoardColumnId, BoardData } from "@/types";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

export interface GuidedVerificationControllerProps {
	// hook 单实例由 App.tsx 持有并下传：controller 与顶栏 badge 共用同一份轮询/状态，
	// 避免双实例重复轮询与「检测到新部署」重复 toast（原 remount-nonce hack 的根因已消除）。
	verification: UseGuidedVerificationResult;
	board: BoardData;
	// 移列由 useBoardInteractions 提供（awaitable、返回成败）；controller 只在移列成功后才 confirm 标记 state。
	completeGuidedVerificationMoveToDone: (taskId: string, fromColumnId: BoardColumnId) => Promise<{ ok: boolean }>;
	// 点击任务卡片跳转 focus view。
	onSelectTask: (taskId: string) => void;
}

// 入 Done 确认流的进行态：token / 需确认项 / agent 回复 / 发起时的当前列快照。
interface PendingCompletion {
	deploymentId: string;
	taskId: string;
	taskTitle: string;
	// review | in_progress（validation 直接完成不弹窗，不落此态）。
	fromColumnId: BoardColumnId;
	token: string;
	agentResponsePreview: string | undefined;
	requiredAcknowledgements: RuntimeGuidedVerificationAcknowledgement[];
}

function resolveTaskTitle(board: BoardData, taskId: string): string {
	const selection = findCardSelection(board, taskId);
	return selection?.card.title || truncateTaskPromptLabel(selection?.card.prompt ?? "") || `任务 ${taskId}`;
}

export function GuidedVerificationController({
	verification,
	board,
	completeGuidedVerificationMoveToDone,
	onSelectTask,
}: GuidedVerificationControllerProps): ReactElement {
	const { refresh, requestComplete, confirmComplete } = verification;

	// 正在跑完成流的 taskId（发放 token / 弹窗 / 移列 / confirm 全程），用于卡片 spinner 与禁用重入。
	const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
	const [doneConfirm, setDoneConfirm] = useState<PendingCompletion | null>(null);
	const [inProgressWarn, setInProgressWarn] = useState<PendingCompletion | null>(null);
	const [isFinalizing, setIsFinalizing] = useState(false);

	const closeCompletionFlow = useCallback(() => {
		setDoneConfirm(null);
		setInProgressWarn(null);
		setCompletingTaskId(null);
		setIsFinalizing(false);
	}, []);

	// 移列成功 → confirm 标记 state（plan 1d 时序：先移列后 confirm；移列失败则不 confirm、token 保留）。
	const finalizeCompletion = useCallback(
		async (pending: PendingCompletion): Promise<void> => {
			setIsFinalizing(true);
			const moved = await completeGuidedVerificationMoveToDone(pending.taskId, pending.fromColumnId);
			if (!moved.ok) {
				showAppToast({ intent: "danger", message: "移入 Done 失败，核对未标记完成" });
				closeCompletionFlow();
				refresh();
				return;
			}
			const confirmed = await confirmComplete({
				deploymentId: pending.deploymentId,
				taskId: pending.taskId,
				token: pending.token,
				acks: pending.requiredAcknowledgements,
			});
			if (confirmed?.ok) {
				showAppToast({ intent: "success", message: "已完成核对并移入 Done" });
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
		[completeGuidedVerificationMoveToDone, confirmComplete, closeCompletionFlow, refresh],
	);

	const handleRequestComplete = useCallback(
		async (deploymentId: string, taskId: string): Promise<void> => {
			if (completingTaskId) {
				return;
			}
			// 按任务「当前列」分支（非 columnIdAtMatch 快照）：入 Done 时刻实际所在列决定弹几次确认。
			const currentColumnId = getTaskColumnId(board, taskId);
			if (currentColumnId === null) {
				showAppToast({ intent: "danger", message: "任务已不在看板，无法完成核对" });
				return;
			}
			setCompletingTaskId(taskId);
			const response = await requestComplete({ deploymentId, taskId });
			if (!response) {
				setCompletingTaskId(null);
				return;
			}
			if (response.error) {
				showAppToast({ intent: "danger", message: response.error });
				setCompletingTaskId(null);
				refresh();
				return;
			}
			// 所有合法来源列后端都发放了一次性 token；validation 仅是 needsConfirmation=false（不弹确认框），
			// 但同样走「移列成功后再经 confirm 消费 token 标记完成」路径（issue A：移列先于标记，移列失败则不标记）。
			if (!response.confirmationToken) {
				showAppToast({ intent: "danger", message: "未获得确认 token，无法完成核对" });
				setCompletingTaskId(null);
				refresh();
				return;
			}
			const pending: PendingCompletion = {
				deploymentId,
				taskId,
				taskTitle: resolveTaskTitle(board, taskId),
				fromColumnId: currentColumnId,
				token: response.confirmationToken,
				agentResponsePreview: response.agentResponsePreview,
				requiredAcknowledgements: response.requiredAcknowledgements ?? [],
			};
			// validation（免确认框）：直接移列 + confirm 标记；review / in_progress：弹确认框，确认后再 finalize。
			if (!response.needsConfirmation) {
				await finalizeCompletion(pending);
				return;
			}
			setDoneConfirm(pending);
		},
		[board, completingTaskId, requestComplete, finalizeCompletion, refresh],
	);

	// 第一次确认「确认 / 继续」：in_progress 需追加第二次确认，其余直接 finalize。
	const handleDoneConfirmProceed = useCallback(() => {
		if (!doneConfirm || isFinalizing) {
			return;
		}
		if (doneConfirm.requiredAcknowledgements.includes("in_progress_active")) {
			setDoneConfirm(null);
			setInProgressWarn(doneConfirm);
			return;
		}
		void finalizeCompletion(doneConfirm);
	}, [doneConfirm, isFinalizing, finalizeCompletion]);

	const handleInProgressWarnProceed = useCallback(() => {
		if (!inProgressWarn || isFinalizing) {
			return;
		}
		void finalizeCompletion(inProgressWarn);
	}, [inProgressWarn, isFinalizing, finalizeCompletion]);

	// 对话框取消（Cancel / Esc）：finalize 进行中忽略关闭，避免半途中断；否则重置流程（token 留至过期）。
	const handleDoneConfirmOpenChange = useCallback(
		(open: boolean) => {
			if (open || isFinalizing) {
				return;
			}
			setDoneConfirm(null);
			setCompletingTaskId(null);
		},
		[isFinalizing],
	);

	const handleInProgressWarnOpenChange = useCallback(
		(open: boolean) => {
			if (open || isFinalizing) {
				return;
			}
			setInProgressWarn(null);
			setCompletingTaskId(null);
		},
		[isFinalizing],
	);

	return (
		<>
			<GuidedVerificationPanel
				activeGroup={verification.activeGroup}
				historyGroups={verification.historyGroups}
				hasLoadedOnce={verification.hasLoadedOnce}
				loadError={verification.loadError}
				board={board}
				stayInFront={verification.stayInFront}
				collapsed={verification.collapsed}
				loweredForDialog={doneConfirm !== null || inProgressWarn !== null}
				completingTaskId={completingTaskId}
				onToggleStayInFront={() => verification.setStayInFront((current) => !current)}
				onToggleCollapsed={() => verification.setCollapsed((current) => !current)}
				onToggleChecklistItem={verification.toggleChecklistItem}
				onAddCustomChecklistItem={verification.addCustomChecklistItem}
				onRemoveCustomChecklistItem={verification.removeCustomChecklistItem}
				onRequestComplete={handleRequestComplete}
				onSelectTask={onSelectTask}
			/>
			{doneConfirm ? (
				<GuidedVerificationDoneConfirmDialog
					open
					onOpenChange={handleDoneConfirmOpenChange}
					taskTitle={doneConfirm.taskTitle}
					fromColumnId={doneConfirm.fromColumnId}
					agentResponsePreview={doneConfirm.agentResponsePreview}
					requiresSecondConfirmation={doneConfirm.requiredAcknowledgements.includes("in_progress_active")}
					isBusy={isFinalizing}
					onConfirm={handleDoneConfirmProceed}
				/>
			) : null}
			{inProgressWarn ? (
				<InProgressDoneWarningDialog
					open
					onOpenChange={handleInProgressWarnOpenChange}
					taskTitle={inProgressWarn.taskTitle}
					isBusy={isFinalizing}
					onConfirm={handleInProgressWarnProceed}
				/>
			) : null}
		</>
	);
}
