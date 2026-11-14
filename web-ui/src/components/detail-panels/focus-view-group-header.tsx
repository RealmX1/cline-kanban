import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId } from "react";
import {
	FOCUS_VIEW_COMPACT_GROUP_HEADER_HEIGHT_PX,
	type FocusViewGroupHeaderPresentation,
	STAGE_HEADER_HEIGHT_PX,
} from "@/components/detail-panels/stage-header-rail-geometry";
import { Tooltip } from "@/components/ui/tooltip";

const HEADER_BUTTON_CLASS_NAME =
	"inline-flex h-full shrink-0 items-center justify-center rounded-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50";

/** 行内分组与 sticky 孪生标题共享几何；只有箭头改变展开态。 */
export function FocusViewGroupHeader({
	title,
	count,
	icon,
	isExpanded,
	onToggleExpanded,
	onJumpToSection,
	isExpansionDisabled = false,
	actions,
	presentation = "standard",
}: {
	title: string;
	count: ReactNode;
	icon?: ReactNode;
	isExpanded?: boolean;
	onToggleExpanded?: () => void;
	onJumpToSection?: () => void;
	isExpansionDisabled?: boolean;
	actions?: ReactNode;
	presentation?: FocusViewGroupHeaderPresentation;
}) {
	const countId = useId();
	const isCompact = presentation === "compact";
	const tooltipContent = (
		<>
			{title}（{count}）
		</>
	);
	const label = (
		<>
			<span className="shrink-0" aria-hidden>
				{icon}
			</span>
			<span className={isCompact ? "sr-only" : "min-w-0 truncate font-semibold"}>{title}</span>
			<span id={countId} className="min-w-0 truncate text-[11px] text-text-secondary tabular-nums">
				{count}
			</span>
		</>
	);
	return (
		<div
			data-focus-view-group-header=""
			data-presentation={presentation}
			className="flex min-w-0 shrink-0 items-center gap-1 pr-1 text-[12px] text-text-primary"
			style={{ height: isCompact ? FOCUS_VIEW_COMPACT_GROUP_HEADER_HEIGHT_PX : STAGE_HEADER_HEIGHT_PX }}
		>
			{onToggleExpanded ? (
				<Tooltip content={`${isExpanded ? "收起" : "展开"} ${title}`} side="right">
					<span className="inline-flex h-full shrink-0" tabIndex={isExpansionDisabled ? 0 : undefined}>
						<button
							type="button"
							className={`${HEADER_BUTTON_CLASS_NAME} ${isCompact ? "w-6" : "w-7"}`}
							onClick={onToggleExpanded}
							disabled={isExpansionDisabled}
							aria-expanded={isExpanded}
							aria-label={`${isExpanded ? "收起" : "展开"} ${title}`}
						>
							{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
						</button>
					</span>
				</Tooltip>
			) : null}
			<Tooltip content={tooltipContent} side="right">
				{onJumpToSection ? (
					<button
						type="button"
						aria-label={`跳转到 ${title}`}
						aria-describedby={countId}
						onClick={onJumpToSection}
						className={`${HEADER_BUTTON_CLASS_NAME} min-w-0 flex-1 justify-start gap-1 text-left`}
					>
						{label}
					</button>
				) : (
					<span className="flex min-w-0 flex-1 items-center gap-2" tabIndex={0}>
						{label}
					</span>
				)}
			</Tooltip>
			{actions ? <div className="flex h-full shrink-0 items-center gap-1">{actions}</div> : null}
		</div>
	);
}
