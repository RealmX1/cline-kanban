import { ArrowLeft, ChevronDown, ChevronUp, PanelTopClose, PanelTopOpen } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { TaskCardBody, type TaskCardBusinessProps } from "@/components/task-card-body";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import type { MobileFocusViewCollapsibleControls } from "@/hooks/use-mobile-focus-view-collapsible-controls";
import type { MobileFocusViewIdleCollapseController } from "@/hooks/use-mobile-focus-view-idle-collapse-controller";

/** 当前任务的折叠状态独立于页签；外部以 workspace/task 联合 key 隔离不同任务。 */
export function MobileFocusedTaskCardHeader({
	cardBusinessProps,
	stageDisplayName,
	idleCollapseController,
	onBackToBoard,
	navigationAndToolsControls,
}: {
	cardBusinessProps: TaskCardBusinessProps;
	stageDisplayName: string;
	idleCollapseController: MobileFocusViewIdleCollapseController;
	onBackToBoard?: () => void;
	navigationAndToolsControls?: MobileFocusViewCollapsibleControls;
}): React.ReactElement {
	const [isExpanded, setIsExpanded] = useState(false);
	const contentId = useId();
	const lastIdleCollapseRequestSequenceNumber = useRef(idleCollapseController.idleCollapseRequestSequenceNumber);
	useEffect(() => {
		if (lastIdleCollapseRequestSequenceNumber.current === idleCollapseController.idleCollapseRequestSequenceNumber)
			return;
		lastIdleCollapseRequestSequenceNumber.current = idleCollapseController.idleCollapseRequestSequenceNumber;
		setIsExpanded(false);
	}, [idleCollapseController.idleCollapseRequestSequenceNumber]);

	return (
		<section
			aria-label="当前任务信息"
			data-mobile-focused-task-card-header=""
			className="flex min-h-0 max-h-[40%] shrink-0 flex-col overflow-hidden border-b border-divider bg-surface-1"
		>
			<div className="flex shrink-0 items-center">
				{onBackToBoard ? (
					<button
						type="button"
						onClick={onBackToBoard}
						aria-label="返回看板"
						className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary"
					>
						<ArrowLeft size={16} />
					</button>
				) : null}
				<button
					type="button"
					aria-label={isExpanded ? "收起任务卡" : "展开任务卡"}
					aria-expanded={isExpanded}
					aria-controls={isExpanded ? contentId : undefined}
					className={cn(
						MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME,
						"flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs text-text-secondary hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
					)}
					onClick={() => {
						idleCollapseController.recordUserInteraction();
						setIsExpanded((expanded) => !expanded);
					}}
				>
					<span className="min-w-0 flex-1 truncate text-text-primary">
						{isExpanded ? "任务信息" : cardBusinessProps.card.title}
					</span>
					<span className="inline-flex shrink-0 items-center gap-1">
						<ColumnIndicator columnId={cardBusinessProps.columnId} size={12} />
						{stageDisplayName}
					</span>
					{isExpanded ? (
						<ChevronUp size={16} className="shrink-0" />
					) : (
						<ChevronDown size={16} className="shrink-0" />
					)}
				</button>
				{navigationAndToolsControls ? (
					<button
						type="button"
						aria-label={
							navigationAndToolsControls.upperNavigationAndToolsExpanded
								? "收起上方导航与工具"
								: "展开上方导航与工具"
						}
						aria-expanded={navigationAndToolsControls.upperNavigationAndToolsExpanded}
						onClick={navigationAndToolsControls.toggleUpperNavigationAndTools}
						className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary focus-visible:outline-2 focus-visible:outline-accent"
					>
						{navigationAndToolsControls.upperNavigationAndToolsExpanded ? (
							<PanelTopClose size={16} />
						) : (
							<PanelTopOpen size={16} />
						)}
					</button>
				) : null}
			</div>
			{isExpanded ? (
				<div id={contentId} className="min-h-0 overflow-y-auto overscroll-contain px-3 pt-2 pb-3">
					<TaskCardBody {...cardBusinessProps} renderRole="focused_task_card_copy_in_mobile_detail_header" />
				</div>
			) : null}
		</section>
	);
}
