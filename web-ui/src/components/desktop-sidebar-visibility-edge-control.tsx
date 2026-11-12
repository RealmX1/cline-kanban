import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/utils/platform";

export function DesktopSidebarVisibilityEdgeControl({
	side,
	label,
	isHidden,
	onToggle,
}: {
	side: "left" | "right";
	label: string;
	isHidden: boolean;
	onToggle: () => void;
}) {
	const actionLabel = `${isHidden ? "显示" : "隐藏"}${label}`;
	const pointsLeft = side === "left" ? !isHidden : isHidden;
	const shortcut =
		side === "left" ? (isMacPlatform ? "Cmd+B" : "Ctrl+B") : isMacPlatform ? "Cmd+Option+B" : "Ctrl+Alt+B";
	return (
		<div
			className={cn(
				"pointer-events-none absolute inset-y-0 z-20 flex w-6 items-center justify-center border-border bg-surface-1",
				side === "left" ? "left-0 border-r" : "right-0 border-l",
			)}
		>
			<Tooltip side={side === "left" ? "right" : "left"} content={`${actionLabel} (${shortcut})`}>
				<Button
					size="sm"
					variant="default"
					onClick={onToggle}
					aria-label={actionLabel}
					aria-pressed={!isHidden}
					aria-keyshortcuts={
						side === "left"
							? isMacPlatform
								? "Meta+B"
								: "Control+B"
							: isMacPlatform
								? "Meta+Alt+B"
								: "Control+Alt+B"
					}
					data-verification-anchor={`desktop-${side}-sidebar-visibility-control`}
					icon={pointsLeft ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
					className={cn(
						"pointer-events-auto h-12 w-6 px-0",
						side === "left" ? "rounded-l-none" : "rounded-r-none",
					)}
				/>
			</Tooltip>
		</div>
	);
}
