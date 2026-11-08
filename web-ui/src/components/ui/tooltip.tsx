import * as RadixTooltip from "@radix-ui/react-tooltip";
import { isValidElement, type ReactNode, useRef } from "react";
import { useTaskCardPortalWheelScrollForwarding } from "@/hooks/use-task-card-portal-wheel-scroll-forwarding";

export function TooltipProvider({ children }: { children: ReactNode }): React.ReactElement {
	return <RadixTooltip.Provider delayDuration={400}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({
	content,
	children,
	side,
	delayDuration,
}: {
	content: ReactNode;
	children: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	delayDuration?: number;
}): React.ReactElement {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const forwardWheelRef = useTaskCardPortalWheelScrollForwarding<HTMLDivElement>(triggerRef);
	if (!content) {
		return <>{children}</>;
	}

	const trigger =
		isValidElement<{ disabled?: boolean }>(children) && "disabled" in children.props ? (
			<span className="inline-flex" tabIndex={children.props.disabled ? 0 : undefined}>
				{children}
			</span>
		) : (
			children
		);
	return (
		<RadixTooltip.Root delayDuration={delayDuration}>
			<RadixTooltip.Trigger ref={triggerRef} asChild>
				{trigger}
			</RadixTooltip.Trigger>
			<RadixTooltip.Portal>
				<RadixTooltip.Content
					ref={forwardWheelRef}
					side={side}
					className="z-50 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
					sideOffset={5}
				>
					{content}
				</RadixTooltip.Content>
			</RadixTooltip.Portal>
		</RadixTooltip.Root>
	);
}
