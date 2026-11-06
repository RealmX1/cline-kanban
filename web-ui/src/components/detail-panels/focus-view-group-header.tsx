import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { STAGE_HEADER_HEIGHT_PX } from "@/components/detail-panels/stage-header-rail-geometry";

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
}: {
	title: string;
	count: ReactNode;
	icon?: ReactNode;
	isExpanded?: boolean;
	onToggleExpanded?: () => void;
	onJumpToSection?: () => void;
	isExpansionDisabled?: boolean;
	actions?: ReactNode;
}) {
	const label = (
		<>
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 truncate font-semibold">{title}</span>
			<span className="shrink-0 text-[11px] text-text-secondary tabular-nums">{count}</span>
		</>
	);
	return (
		<div
			data-focus-view-group-header=""
			className="flex min-w-0 shrink-0 items-center gap-1 pr-1 text-[13px] text-text-primary"
			style={{ height: STAGE_HEADER_HEIGHT_PX }}
		>
			{onToggleExpanded ? (
				<button
					type="button"
					className={`${HEADER_BUTTON_CLASS_NAME} w-8`}
					onClick={onToggleExpanded}
					disabled={isExpansionDisabled}
					aria-expanded={isExpanded}
					aria-label={`${isExpanded ? "收起" : "展开"} ${title}`}
				>
					{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</button>
			) : null}
			{onJumpToSection ? (
				<button
					type="button"
					aria-label={`跳转到 ${title}`}
					onClick={onJumpToSection}
					className={`${HEADER_BUTTON_CLASS_NAME} min-w-0 flex-1 justify-start gap-2 text-left`}
				>
					{label}
				</button>
			) : (
				<span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
			)}
			{actions ? <div className="flex h-full shrink-0 items-center gap-1">{actions}</div> : null}
		</div>
	);
}
