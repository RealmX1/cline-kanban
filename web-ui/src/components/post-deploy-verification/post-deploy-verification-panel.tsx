import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ClipboardCheck, Minus, Pin, PinOff } from "lucide-react";
import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { showAppToast } from "@/components/app-toaster";
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
import type { PostDeployVerificationEntryNavigationRequest } from "@/components/post-deploy-verification/post-deploy-verification-entry-navigation-host-context";
import {
	formatDeployShaRange,
	formatDeployTimestamp,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import { PostDeployVerificationPanelExpansionStateContext } from "@/components/post-deploy-verification/post-deploy-verification-panel-expansion-state-context";
import type { RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries } from "@/components/post-deploy-verification/post-deploy-verification-task-entry-wrapping-real-task-card";
import { spotlightElement } from "@/components/post-deploy-verification/verification-anchor-registry";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	PostDeployVerificationEntryNavigationReadModelRequest,
	UsePostDeployVerificationResult,
} from "@/hooks/use-post-deploy-verification";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";
import type { BoardData } from "@/types";

export interface PostDeployVerificationPanelProps extends PostDeployVerificationDeploymentGroupTaskEntryActions {
	entryNavigationRequest?: PostDeployVerificationEntryNavigationRequest | null;
	entryNavigationReadModelRequest?: PostDeployVerificationEntryNavigationReadModelRequest | null;
	onRefreshEntryNavigationReadModel?: UsePostDeployVerificationResult["refreshAndReadActiveGroup"];
	isVerificationWriteInFlight?: boolean;
	onEntryNavigationFinished?: (requestId: number) => void;
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
		entryNavigationRequest = null,
		entryNavigationReadModelRequest = null,
		onRefreshEntryNavigationReadModel,
		isVerificationWriteInFlight = false,
		onEntryNavigationFinished,
	} = props;
	const [expandedHistoryDeploymentIds, setExpandedHistoryDeploymentIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const rememberedExpansionStateByKey = useMemo(() => new Map<string, unknown>(), []);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const rememberedScrollTopRef = useRef(0);
	const hasRenderableVerificationGroups = activeGroup !== null || historyGroups.length > 0;
	useLayoutEffect(() => {
		const scrollContainer = scrollContainerRef.current;
		if (collapsed || !hasLoadedOnce || !hasRenderableVerificationGroups || !scrollContainer) return;
		// 子组件在首次渲染就恢复展开状态，正文高度已确定；普通数据刷新不重放阅读位置。
		scrollContainer.scrollTop = Math.max(
			0,
			Math.min(rememberedScrollTopRef.current, scrollContainer.scrollHeight - scrollContainer.clientHeight),
		);
		rememberedScrollTopRef.current = scrollContainer.scrollTop;
	}, [collapsed, hasLoadedOnce, hasRenderableVerificationGroups]);
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
	// 每次显式定位先发起读取。短暂失败最多尝试三次；之后保留请求，既有轮询或写入结束再补证。
	useEffect(() => {
		if (!entryNavigationRequest || collapsed || !onRefreshEntryNavigationReadModel || isVerificationWriteInFlight)
			return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const refreshForNavigation = async (attempt: number) => {
			try {
				await onRefreshEntryNavigationReadModel({
					workspaceId: entryNavigationRequest.target.entry.workspaceId,
					requestId: entryNavigationRequest.requestId,
				});
			} catch {
				if (cancelled) return;
				if (attempt < 3) retryTimer = setTimeout(() => void refreshForNavigation(attempt + 1), attempt * 500);
				else
					showAppToast({
						intent: "warning",
						message: "读取验证条目失败，已保留定位请求；后续刷新成功后将自动定位，也可再次点击 PDV 重试。",
					});
			}
		};
		void refreshForNavigation(1);
		return () => {
			cancelled = true;
			clearTimeout(retryTimer);
		};
	}, [entryNavigationRequest, collapsed, onRefreshEntryNavigationReadModel, isVerificationWriteInFlight]);
	useEffect(() => {
		if (
			!entryNavigationRequest ||
			collapsed ||
			!hasLoadedOnce ||
			loadError ||
			entryNavigationReadModelRequest?.requestId !== entryNavigationRequest.requestId ||
			entryNavigationReadModelRequest.workspaceId !== entryNavigationRequest.target.entry.workspaceId
		)
			return;
		const entry = entryNavigationRequest.target.entry;
		const groups = [...(activeGroup ? [activeGroup] : []), ...historyGroups];
		if (groups.some((group) => group.workspaceId !== entry.workspaceId)) return;
		const group = groups.find(
			(group) => group.deploymentId === entry.deploymentId && group.workspaceId === entry.workspaceId,
		);
		if (!group?.tasks.some((task) => task.taskId === entry.taskId)) {
			showAppToast({ intent: "warning", message: "该部署后验证条目已不在保留记录中，请重新读取定位目标。" });
			onEntryNavigationFinished?.(entryNavigationRequest.requestId);
			return;
		}
		if (historyGroups.some((history) => history.deploymentId === entry.deploymentId)) {
			setExpandedHistoryDeploymentIds((previous) => new Set([...previous, entry.deploymentId]));
		}
		let attempts = 0;
		let frame = 0;
		const key = JSON.stringify([entry.workspaceId, entry.deploymentId, entry.taskId]);
		const locate = () => {
			const target = Array.from(
				document.querySelectorAll<HTMLElement>("[data-post-deploy-verification-entry-navigation-key]"),
			).find((element) => element.getAttribute("data-post-deploy-verification-entry-navigation-key") === key);
			if (target) {
				spotlightElement(target);
				target.focus({ preventScroll: true });
				onEntryNavigationFinished?.(entryNavigationRequest.requestId);
			} else if (++attempts < 20) frame = window.requestAnimationFrame(locate);
			else showAppToast({ intent: "warning", message: "验证条目暂未完成展开，可再次点击 PDV 重试。" });
		};
		frame = window.requestAnimationFrame(locate);
		return () => window.cancelAnimationFrame(frame);
	}, [
		entryNavigationRequest,
		entryNavigationReadModelRequest,
		collapsed,
		hasLoadedOnce,
		loadError,
		activeGroup,
		historyGroups,
		onEntryNavigationFinished,
	]);

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
							onClick={() => {
								if (scrollContainerRef.current)
									rememberedScrollTopRef.current = scrollContainerRef.current.scrollTop;
								onToggleCollapsed();
							}}
							aria-label="折叠 Post-Deploy Verification 面板"
							className="cursor-pointer rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
						>
							<Minus size={14} />
						</button>
					</Tooltip>
				</div>
			</div>

			{/* 面板正文（滚动区） */}
			<div
				ref={scrollContainerRef}
				onScroll={(event) => {
					rememberedScrollTopRef.current = event.currentTarget.scrollTop;
				}}
				className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3"
			>
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
						<PostDeployVerificationPanelExpansionStateContext.Provider value={rememberedExpansionStateByKey}>
							<PostDeployVerificationActiveDeploymentGroupZoneSections
								key={JSON.stringify([activeGroup.workspaceId, activeGroup.deploymentId])}
								group={activeGroup}
								board={board}
								realTaskCardRenderingInputs={realTaskCardRenderingInputs}
								retainedDeploymentGroupsByDeploymentId={retainedDeploymentGroupsByDeploymentId}
								taskEntryActions={taskEntryActions}
								onRequestBatchClosureWithReasonsOfZoneTasks={onRequestBatchClosureWithReasonsOfZoneTasks}
								isBatchClosureWithReasonsInFlight={isBatchClosureWithReasonsInFlight}
								entryNavigationRequest={entryNavigationRequest}
							/>
						</PostDeployVerificationPanelExpansionStateContext.Provider>
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
									open={expandedHistoryDeploymentIds.has(group.deploymentId)}
									onOpenChange={(open) =>
										setExpandedHistoryDeploymentIds((previous) => {
											const next = new Set(previous);
											if (open) next.add(group.deploymentId);
											else next.delete(group.deploymentId);
											return next;
										})
									}
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
										<PostDeployVerificationPanelExpansionStateContext.Provider
											value={rememberedExpansionStateByKey}
										>
											<PostDeployVerificationHistoryDeploymentGroupTaskEntries
												group={group}
												board={board}
												realTaskCardRenderingInputs={realTaskCardRenderingInputs}
												retainedDeploymentGroupsByDeploymentId={retainedDeploymentGroupsByDeploymentId}
												taskEntryActions={taskEntryActions}
												entryNavigationRequest={entryNavigationRequest}
											/>
										</PostDeployVerificationPanelExpansionStateContext.Provider>
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
