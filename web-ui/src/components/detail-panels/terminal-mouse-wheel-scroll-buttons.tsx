import { ChevronsDown, ChevronsUp } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { useAcceleratingMouseWheelScrollPress } from "@/hooks/use-accelerating-mouse-wheel-scroll-press";
import { useSharedMobileFocusViewIdleCollapseController } from "@/hooks/use-mobile-focus-view-idle-collapse-controller";

export interface TerminalMouseWheelScrollButtonsProps {
	interactionIdentity: string;
	onScrollByMouseWheelLines: (lineDelta: number) => void;
	className?: string;
	isFloating?: boolean;
}
export function TerminalMouseWheelScrollButtons(props: TerminalMouseWheelScrollButtonsProps) {
	return (
		<div className={cn("flex shrink-0 flex-col gap-0.5", props.className)} role="group" aria-label="滚轮滚动">
			<MouseWheelScrollButton {...props} direction="up" />
			<MouseWheelScrollButton {...props} direction="down" />
		</div>
	);
}
function MouseWheelScrollButton({
	interactionIdentity,
	onScrollByMouseWheelLines,
	direction,
	isFloating,
}: TerminalMouseWheelScrollButtonsProps & { direction: "up" | "down" }) {
	const idleController = useSharedMobileFocusViewIdleCollapseController();
	const bindings = useAcceleratingMouseWheelScrollPress({
		interactionIdentity,
		onScrollStep: () => onScrollByMouseWheelLines(direction === "up" ? -3 : 3),
		onUserInteraction: idleController?.recordUserInteraction,
	});
	return (
		<button
			type="button"
			aria-label={direction === "up" ? "向上滚动，长按加速" : "向下滚动，长按加速"}
			className={cn(
				"inline-flex touch-none select-none items-center justify-center rounded-md border border-border-bright bg-surface-2 text-text-primary active:bg-surface-4 focus-visible:outline-2 focus-visible:outline-accent",
				isFloating ? "h-11 w-11" : "h-9 w-9",
			)}
			{...bindings}
		>
			{direction === "up" ? <ChevronsUp size={16} /> : <ChevronsDown size={16} />}
		</button>
	);
}
