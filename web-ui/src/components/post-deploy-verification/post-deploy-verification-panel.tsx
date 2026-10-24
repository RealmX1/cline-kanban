import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ClipboardCheck, Minus, Pin, PinOff } from "lucide-react";
import { type ReactElement, useMemo } from "react";
import { createPortal } from "react-dom";

import {
	countPostDeployVerificationTasksAwaitingVerification,
	isPostDeployVerificationTaskClosed,
	isPostDeployVerificationTaskIncludedAsReadOnlyBecauseAlreadyInDoneColumn,
	readCarriedForwardIntoDeploymentIdOrNull,
} from "@/components/post-deploy-verification/post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import {
	PostDeployVerificationActiveDeploymentGroupZoneSections,
	type PostDeployVerificationDeploymentGroupTaskEntryActions,
	PostDeployVerificationHistoryDeploymentGroupTaskEntries,
} from "@/components/post-deploy-verification/post-deploy-verification-deployment-group";
import {
	formatDeployShaRange,
	formatDeployTimestamp,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import type { RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries } from "@/components/post-deploy-verification/post-deploy-verification-task-entry-wrapping-real-task-card";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";
import type { BoardData } from "@/types";

export interface PostDeployVerificationPanelProps extends PostDeployVerificationDeploymentGroupTaskEntryActions {
	activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
	historyGroups: RuntimePostDeployVerificationDeploymentGroup[];
	hasLoadedOnce: boolean;
	loadError: string | null;
	board: BoardData;
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	// 非 null（All projects 视图）时在标题旁显示面板所绑定项目的名字：此时面板内容不跟随当前项目。
	postDeployVerificationWorkspaceProjectNameShownInPanelHeader: string | null;
	stayInFront: boolean;
	collapsed: boolean;
	// 对话框打开时临时降 z：modal Overlay(z-50) 需盖住面板（plan 确认框方案，z-[80] 不可行）。
	loweredForDialog: boolean;
	isBatchClosureWithReasonsInFlight: boolean;
	onToggleStayInFront: () => void;
	onToggleCollapsed: () => void;
	onRequestBatchClosureWithReasonsOfZoneTasks: (deploymentId: string, taskIds: string[]) => void;
}

// 历史组标题的进度：已结案（通过或带原因）/ 需核对（不含已移除与只读展示项）；已延续到新组的单独计数。
function summarizeHistoryGroupProgress(tasks: RuntimePostDeployVerificationTask[]): {
	closedTaskCount: number;
	taskCountRequiringVerification: number;
	carriedForwardTaskCount: number;
} {
	const tasksRequiringVerification = tasks.filter(
		(task) =>
			task.droppedReason === null && !isPostDeployVerificationTaskIncludedAsReadOnlyBecauseAlreadyInDoneColumn(task),
	);
	return {
		closedTaskCount: tasksRequiringVerification.filter(isPostDeployVerificationTaskClosed).length,
		taskCountRequiringVerification: tasksRequiringVerification.length,
		carriedForwardTaskCount: tasksRequiringVerification.filter(
			(task) => readCarriedForwardIntoDeploymentIdOrNull(task) !== null,
		).length,
	};
}

export function PostDeployVerificationPanel(props: PostDeployVerificationPanelProps): ReactElement | null {
	const {
		activeGroup,
		historyGroups,
		hasLoadedOnce,
		loadError,
		board,
		realTaskCardRenderingInputs,
		postDeployVerificationWorkspaceProjectNameShownInPanelHeader,
		stayInFront,
		collapsed,
		loweredForDialog,
		isBatchClosureWithReasonsInFlight,
		onToggleStayInFront,
		onToggleCollapsed,
		onRequestBatchClosureWithReasonsOfZoneTasks,
		completingTaskId,
		onToggleChecklistItem,
		onAddCustomChecklistItem,
		onRemoveCustomChecklistItem,
		onRunVerificationItem,
		onRequestComplete,
		onRequestMoveIntoDoneFromTaskCard,
		onSelectTask,
		onNavigateToBoard,
		onCreateFollowUpTaskFromChecklistItems,
	} = props;
	const taskEntryActions: PostDeployVerificationDeploymentGroupTaskEntryActions = {
		completingTaskId,
		onToggleChecklistItem,
		onAddCustomChecklistItem,
		onRemoveCustomChecklistItem,
		onRunVerificationItem,
		onRequestComplete,
		onRequestMoveIntoDoneFromTaskCard,
		onSelectTask,
		onNavigateToBoard,
		onCreateFollowUpTaskFromChecklistItems,
	};
	// 第二区徽标「首次上线于 <短 SHA>」要把 firstDeployedInDeploymentId 解析成部署组。
	const retainedDeploymentGroupsByDeploymentId = useMemo(
		() =>
			new Map(
				[...(activeGroup ? [activeGroup] : []), ...historyGroups].map(
					(group) => [group.deploymentId, group] as const,
				),
			),
		[activeGroup, historyGroups],
	);

	// 门控：数据未到达前不闪现；本 workspace 无任何 deployment 组时不挂载（即工作区维度门控，见 plan）。
	if (typeof document === "undefined" || !hasLoadedOnce || (!activeGroup && historyGroups.length === 0)) {
		return null;
	}

	// stayInFront=ON 且无对话框：z-70（高于 dialog z-50）。OFF 或对话框打开：降至 z-30 可被遮挡。
	const zIndexClassName = stayInFront && !loweredForDialog ? "z-[70]" : "z-30";
	const pendingCount = activeGroup ? countPostDeployVerificationTasksAwaitingVerification(activeGroup.tasks) : 0;

	if (collapsed) {
		return null;
	}

	// ponytail: 面板位置/尺寸固定在右下角；plan 面板行为表提过的「拖拽/尺寸偏好存 localStorage」按 spike 范围延后，
	// 需要时再引入 drag/resize，勿为此提前加依赖。
	// 宽 420px：条目上半部分是真实任务卡体（紧凑密度），360px 时标题与药丸行挤得太窄。
	return createPortal(
		<div
			className={cn(
				"kb-viewport-bottom-verification-floating-panel fixed right-4 flex max-h-[70vh] w-[420px] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border-bright bg-surface-2 shadow-2xl",
				zIndexClassName,
			)}
		>
			{/* 面板标题栏 */}
			<div className="flex shrink-0 items-center justify-between gap-2 rounded-t-lg border-b border-border bg-surface-1 px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<ClipboardCheck size={16} className="shrink-0 text-accent" />
					<span className="truncate text-sm font-semibold text-text-primary">Post-Deploy Verification</span>
					{postDeployVerificationWorkspaceProjectNameShownInPanelHeader ? (
						<span
							data-testid="post-deploy-verification-panel-workspace-project-name"
							title={postDeployVerificationWorkspaceProjectNameShownInPanelHeader}
							className="min-w-0 max-w-[140px] shrink truncate rounded-sm bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-secondary"
						>
							{postDeployVerificationWorkspaceProjectNameShownInPanelHeader}
						</span>
					) : null}
					{pendingCount > 0 ? (
						<span className="inline-flex min-w-5 items-center justify-center rounded-full bg-status-orange px-1.5 text-[11px] font-semibold text-black">
							{pendingCount}
						</span>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Tooltip content={stayInFront ? "保持最前：开（点击关闭）" : "保持最前：关（点击开启）"}>
						<button
							type="button"
							onClick={onToggleStayInFront}
							aria-label={stayInFront ? "关闭保持最前" : "开启保持最前"}
							aria-pressed={stayInFront}
							className={cn(
								"cursor-pointer rounded-md p-1 transition-colors hover:bg-surface-3",
								stayInFront ? "text-accent" : "text-text-tertiary",
							)}
						>
							{stayInFront ? <Pin size={14} /> : <PinOff size={14} />}
						</button>
					</Tooltip>
					<Tooltip content="折叠面板">
						<button
							type="button"
							onClick={onToggleCollapsed}
							aria-label="折叠 Post-Deploy Verification 面板"
							className="cursor-pointer rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
						>
							<Minus size={14} />
						</button>
					</Tooltip>
				</div>
			</div>

			{/* 面板正文（滚动区） */}
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
				{loadError ? (
					<p className="m-0 rounded-md border border-status-red/30 bg-status-red/10 px-2 py-1.5 text-[12px] text-status-red">
						{loadError}
					</p>
				) : null}

				{/* 当前 Deployment 组：按部署归属分三区 */}
				{activeGroup ? (
					<section>
						<div className="mb-2">
							<div className="flex items-baseline justify-between gap-2">
								<span className="font-mono text-[12px] text-text-primary">
									{formatDeployShaRange(
										activeGroup.previousDeployedSourceCommit,
										activeGroup.deployedSourceCommit,
									)}
								</span>
								<span className="text-[11px] text-text-tertiary">
									{formatDeployTimestamp(activeGroup.deployedAtIso)}
								</span>
							</div>
							<p className="m-0 mt-0.5 text-[11px] text-text-secondary">当前部署 · 待核对 {pendingCount}</p>
						</div>
						<PostDeployVerificationActiveDeploymentGroupZoneSections
							group={activeGroup}
							board={board}
							realTaskCardRenderingInputs={realTaskCardRenderingInputs}
							retainedDeploymentGroupsByDeploymentId={retainedDeploymentGroupsByDeploymentId}
							taskEntryActions={taskEntryActions}
							onRequestBatchClosureWithReasonsOfZoneTasks={onRequestBatchClosureWithReasonsOfZoneTasks}
							isBatchClosureWithReasonsInFlight={isBatchClosureWithReasonsInFlight}
						/>
					</section>
				) : null}

				{/* 历史 Deployment 组（倒序 accordion，只读快照；收起时不挂载内容） */}
				{historyGroups.length > 0 ? (
					<section className="space-y-1.5 border-t border-border pt-2">
						<h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">历史部署</h3>
						{historyGroups.map((group) => {
							const progress = summarizeHistoryGroupProgress(group.tasks);
							return (
								<RadixCollapsible.Root
									key={group.deploymentId}
									className="rounded-md border border-border bg-surface-1"
								>
									<RadixCollapsible.Trigger asChild>
										<button
											type="button"
											className="group/trigger flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left"
										>
											<span className="min-w-0 flex-1">
												<span className="block truncate font-mono text-[12px] text-text-primary">
													{formatDeployShaRange(
														group.previousDeployedSourceCommit,
														group.deployedSourceCommit,
													)}
												</span>
												<span className="block text-[11px] text-text-tertiary">
													{formatDeployTimestamp(group.deployedAtIso)} · {progress.closedTaskCount}/
													{progress.taskCountRequiringVerification} 已结案
													{progress.carriedForwardTaskCount > 0
														? ` · ${progress.carriedForwardTaskCount} 个已延续`
														: null}
												</span>
											</span>
											<ChevronDown
												size={14}
												className="shrink-0 text-text-tertiary transition-transform group-data-[state=open]/trigger:rotate-180"
											/>
										</button>
									</RadixCollapsible.Trigger>
									<RadixCollapsible.Content className="border-t border-border px-2 py-2">
										<PostDeployVerificationHistoryDeploymentGroupTaskEntries
											group={group}
											board={board}
											realTaskCardRenderingInputs={realTaskCardRenderingInputs}
											retainedDeploymentGroupsByDeploymentId={retainedDeploymentGroupsByDeploymentId}
											taskEntryActions={taskEntryActions}
										/>
									</RadixCollapsible.Content>
								</RadixCollapsible.Root>
							);
						})}
					</section>
				) : null}
			</div>
		</div>,
		document.body,
	);
}
