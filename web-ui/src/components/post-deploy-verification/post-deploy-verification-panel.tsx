import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ClipboardCheck, Minus, Pin, PinOff } from "lucide-react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";

import { PostDeployVerificationDeploymentGroup } from "@/components/post-deploy-verification/post-deploy-verification-deployment-group";
import {
	formatDeployShaRange,
	formatDeployTimestamp,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";
import type { BoardData } from "@/types";

export interface PostDeployVerificationPanelProps {
	activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
	historyGroups: RuntimePostDeployVerificationDeploymentGroup[];
	hasLoadedOnce: boolean;
	loadError: string | null;
	board: BoardData;
	stayInFront: boolean;
	collapsed: boolean;
	// 确认对话框打开时临时降 z：modal Overlay(z-50) 需盖住面板（plan 确认框方案，z-[80] 不可行）。
	loweredForDialog: boolean;
	completingTaskId: string | null;
	onToggleStayInFront: () => void;
	onToggleCollapsed: () => void;
	onToggleChecklistItem: (deploymentId: string, taskId: string, itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (deploymentId: string, taskId: string, label: string) => void;
	onRemoveCustomChecklistItem: (deploymentId: string, taskId: string, itemId: string) => void;
	onRunVerificationItem: (deploymentId: string, taskId: string, itemId: string) => void;
	onRequestComplete: (deploymentId: string, taskId: string) => void;
	onSelectTask: (taskId: string) => void;
	onNavigateToBoard: () => void;
}

function countPending(group: RuntimePostDeployVerificationDeploymentGroup | null): number {
	if (!group) {
		return 0;
	}
	return group.tasks.filter((task) => task.verifiedAt === null && task.droppedReason === null).length;
}

function summarizeGroupProgress(tasks: RuntimePostDeployVerificationTask[]): { done: number; total: number } {
	const total = tasks.filter((task) => task.droppedReason === null).length;
	const done = tasks.filter((task) => task.droppedReason === null && task.verifiedAt !== null).length;
	return { done, total };
}

export function PostDeployVerificationPanel(props: PostDeployVerificationPanelProps): ReactElement | null {
	const {
		activeGroup,
		historyGroups,
		hasLoadedOnce,
		loadError,
		board,
		stayInFront,
		collapsed,
		loweredForDialog,
		completingTaskId,
		onToggleStayInFront,
		onToggleCollapsed,
		onToggleChecklistItem,
		onAddCustomChecklistItem,
		onRemoveCustomChecklistItem,
		onRunVerificationItem,
		onRequestComplete,
		onSelectTask,
		onNavigateToBoard,
	} = props;

	// 必须在下面那道早返回门控之前取，否则 hook 调用会随门控结果时有时无（违反 hooks 规则）。
	const isMobile = useIsMobile();

	// 门控：数据未到达前不闪现；本 workspace 无任何 deployment 组时不挂载（即工作区维度门控，见 plan）。
	if (typeof document === "undefined" || !hasLoadedOnce || (!activeGroup && historyGroups.length === 0)) {
		return null;
	}

	// stayInFront=ON 且无对话框：z-70（高于 dialog z-50 / FAB z-40）。OFF 或对话框打开：降至 z-30 可被遮挡。
	const zIndexClassName = stayInFront && !loweredForDialog ? "z-[70]" : "z-30";
	const pendingCount = countPending(activeGroup);

	if (collapsed) {
		return createPortal(
			<button
				type="button"
				onClick={onToggleCollapsed}
				aria-label="展开 Post-Deploy Verification 面板"
				className={cn(
					// 移动端只留图标 + 待办计数，并随虚拟按键条整体抬高：带全称的长 pill 停在视口底部时
					// 正好压住方向键，而 agent 提问时用户的拇指恰恰要落在那儿。
					"kb-viewport-bottom-pill-stacked fixed right-4 inline-flex cursor-pointer items-center gap-2 rounded-full border border-border-bright bg-surface-2 text-sm text-text-primary shadow-lg transition-colors hover:bg-surface-3",
					isMobile ? "p-2.5" : "px-3 py-2",
					zIndexClassName,
				)}
			>
				<ClipboardCheck size={16} className="text-accent" />
				{isMobile ? null : <span className="font-medium">Post-Deploy Verification</span>}
				{pendingCount > 0 ? (
					<span className="inline-flex min-w-5 items-center justify-center rounded-full bg-status-orange px-1.5 text-[11px] font-semibold text-black">
						{pendingCount}
					</span>
				) : null}
			</button>,
			document.body,
		);
	}

	// ponytail: 面板位置/尺寸固定在右下角；plan 面板行为表提过的「拖拽/尺寸偏好存 localStorage」按 spike 范围延后，
	// 需要时再引入 drag/resize，勿为此提前加依赖。
	return createPortal(
		<div
			className={cn(
				"kb-viewport-bottom-pill-stacked fixed right-4 flex max-h-[70vh] w-[360px] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border-bright bg-surface-2 shadow-2xl",
				zIndexClassName,
			)}
		>
			{/* 面板标题栏 */}
			<div className="flex shrink-0 items-center justify-between gap-2 rounded-t-lg border-b border-border bg-surface-1 px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<ClipboardCheck size={16} className="shrink-0 text-accent" />
					<span className="truncate text-sm font-semibold text-text-primary">Post-Deploy Verification</span>
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

				{/* 当前 Deployment 组 */}
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
						<PostDeployVerificationDeploymentGroup
							group={activeGroup}
							board={board}
							interactive
							completingTaskId={completingTaskId}
							onToggleChecklistItem={onToggleChecklistItem}
							onAddCustomChecklistItem={onAddCustomChecklistItem}
							onRemoveCustomChecklistItem={onRemoveCustomChecklistItem}
							onRunVerificationItem={onRunVerificationItem}
							onRequestComplete={onRequestComplete}
							onSelectTask={onSelectTask}
							onNavigateToBoard={onNavigateToBoard}
						/>
					</section>
				) : null}

				{/* 历史 Deployment 组（倒序 accordion，只读快照） */}
				{historyGroups.length > 0 ? (
					<section className="space-y-1.5 border-t border-border pt-2">
						<h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">历史部署</h3>
						{historyGroups.map((group) => {
							const progress = summarizeGroupProgress(group.tasks);
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
													{formatDeployTimestamp(group.deployedAtIso)} · {progress.done}/{progress.total}{" "}
													已核对
												</span>
											</span>
											<ChevronDown
												size={14}
												className="shrink-0 text-text-tertiary transition-transform group-data-[state=open]/trigger:rotate-180"
											/>
										</button>
									</RadixCollapsible.Trigger>
									<RadixCollapsible.Content className="border-t border-border px-2 py-2">
										<PostDeployVerificationDeploymentGroup
											group={group}
											board={board}
											interactive={false}
											completingTaskId={completingTaskId}
											onToggleChecklistItem={onToggleChecklistItem}
											onAddCustomChecklistItem={onAddCustomChecklistItem}
											onRemoveCustomChecklistItem={onRemoveCustomChecklistItem}
											onRunVerificationItem={onRunVerificationItem}
											onRequestComplete={onRequestComplete}
											onSelectTask={onSelectTask}
											onNavigateToBoard={onNavigateToBoard}
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
