import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/utils/platform";

export function DesktopSidebarVisibilityButton({
	side,
	label,
	isHidden,
	onToggle,
}: {
	side: "left" | "right" | "bottom";
	label: string;
	isHidden: boolean;
	onToggle: () => void;
}) {
	const actionLabel = `${isHidden ? "显示" : "隐藏"}${label}`;
	const pointsLeft = side === "left" ? !isHidden : isHidden;
	const shortcut =
		side === "left" ? (isMacPlatform ? "Cmd+B" : "Ctrl+B") : isMacPlatform ? "Cmd+Option+B" : "Ctrl+Alt+B";
	const controlSide = side === "left" ? "left" : "right";
	const Icon = side === "bottom" ? (isHidden ? ChevronUp : ChevronDown) : pointsLeft ? ChevronLeft : ChevronRight;
	return (
		<Tooltip side="bottom" content={`${actionLabel} (${shortcut})`}>
			<Button
				size="sm"
				variant={isHidden ? "default" : "ghost"}
				onClick={(event) => {
					const ownerDocument = event.currentTarget.ownerDocument;
					onToggle();
					requestAnimationFrame(() => {
						// 标题栏与悬浮入口分处两棵常驻子树，只在明确点击后交接焦点。
						const visibleButton = Array.from(
							ownerDocument.querySelectorAll<HTMLButtonElement>(
								`[data-verification-anchor="desktop-${controlSide}-sidebar-visibility-control"]`,
							),
						).find(
							(button) =>
								button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible",
						);
						visibleButton?.focus({ preventScroll: true });
					});
				}}
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
				data-verification-anchor={`desktop-${controlSide}-sidebar-visibility-control`}
				icon={<Icon size={14} className="shrink-0" />}
				className={cn(
					"group shrink-0",
					isHidden ? "absolute top-2 z-20 h-8 gap-0! px-2 shadow-sm" : "h-7 w-7 px-0!",
					isHidden && (side === "left" ? "left-2" : "right-2"),
				)}
			>
				{isHidden ? (
					<span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 group-hover:ml-1.5 group-hover:max-w-40 group-hover:opacity-100 group-focus:ml-1.5 group-focus:max-w-40 group-focus:opacity-100">
						{actionLabel}
					</span>
				) : null}
			</Button>
		</Tooltip>
	);
}
