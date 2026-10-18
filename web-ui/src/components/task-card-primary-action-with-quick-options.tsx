import * as RadixPopover from "@radix-ui/react-popover";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";

export function TaskCardPrimaryActionWithQuickOptions({
	open,
	onOpenChange,
	icon,
	primaryLabel,
	primaryAccessibleLabel,
	onPrimaryAction,
	quickOption,
	disabled = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	icon: ReactNode;
	primaryLabel: string;
	primaryAccessibleLabel: string;
	onPrimaryAction: () => void;
	quickOption: { label: string; icon?: ReactNode; onSelect: () => void };
	disabled?: boolean;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const lastPointerTypeRef = useRef("");
	const openingInteractionRef = useRef<"hover" | "touch" | "keyboard">("hover");
	const restoreTriggerFocusAfterEscapeRef = useRef(false);
	const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelScheduledClose = () => {
		if (closeTimeoutRef.current !== null) clearTimeout(closeTimeoutRef.current);
		closeTimeoutRef.current = null;
	};
	useEffect(
		() => () => {
			if (closeTimeoutRef.current !== null) clearTimeout(closeTimeoutRef.current);
		},
		[],
	);
	useEffect(() => {
		if (!disabled || !open) return;
		if (closeTimeoutRef.current !== null) clearTimeout(closeTimeoutRef.current);
		closeTimeoutRef.current = null;
		onOpenChange(false);
	}, [disabled, open, onOpenChange]);
	const scheduleClose = () => {
		cancelScheduledClose();
		closeTimeoutRef.current = setTimeout(() => {
			if (!menuRef.current?.contains(document.activeElement)) onOpenChange(false);
		}, 150);
	};
	const activateOption = (action: () => void) => {
		cancelScheduledClose();
		onOpenChange(false);
		action();
	};
	return (
		<RadixPopover.Root open={open && !disabled} onOpenChange={onOpenChange} modal={false}>
			<RadixPopover.Anchor asChild>
				<Button
					ref={triggerRef}
					icon={icon}
					variant="ghost"
					size="xs"
					disabled={disabled}
					className="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
					aria-label={primaryAccessibleLabel}
					aria-haspopup="menu"
					aria-expanded={open && !disabled}
					aria-controls={open && !disabled ? menuId : undefined}
					onMouseDown={(event) => event.stopPropagation()}
					onPointerDown={(event) => {
						event.stopPropagation();
						lastPointerTypeRef.current = event.pointerType;
					}}
					onPointerEnter={(event) => {
						if (event.pointerType === "touch" || disabled) return;
						cancelScheduledClose();
						if (open) return;
						openingInteractionRef.current = "hover";
						onOpenChange(true);
					}}
					onPointerLeave={(event) => {
						if (event.pointerType !== "touch") scheduleClose();
					}}
					onClick={(event) => {
						event.stopPropagation();
						if (lastPointerTypeRef.current === "touch" && event.detail !== 0) {
							// EXPERIMENT_NODE: 原生端可评估按住后滑动选择附加操作，Web 暂用点按展开。
							if (!open) openingInteractionRef.current = "touch";
							cancelScheduledClose();
							onOpenChange(!open);
							return;
						}
						activateOption(onPrimaryAction);
					}}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							if (!open) openingInteractionRef.current = "keyboard";
							onOpenChange(true);
						}
					}}
				/>
			</RadixPopover.Anchor>
			<RadixPopover.Portal>
				<RadixPopover.Content
					data-mobile-focus-view-idle-collapse-suspension=""
					ref={menuRef}
					id={menuId}
					role="menu"
					aria-label={`${primaryLabel}快捷操作`}
					side={openingInteractionRef.current === "touch" ? "bottom" : "top"}
					align="end"
					sideOffset={4}
					collisionPadding={8}
					className="z-[80] flex min-w-40 max-w-[calc(100vw-16px)] flex-col gap-1 rounded-md border border-border-bright bg-surface-2 p-1 text-text-primary"
					onOpenAutoFocus={(event) => {
						if (openingInteractionRef.current === "hover") event.preventDefault();
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (!restoreTriggerFocusAfterEscapeRef.current) return;
						restoreTriggerFocusAfterEscapeRef.current = false;
						triggerRef.current?.focus();
					}}
					onEscapeKeyDown={() => {
						restoreTriggerFocusAfterEscapeRef.current = true;
					}}
					onPointerEnter={cancelScheduledClose}
					onPointerLeave={(event) => {
						if (event.pointerType !== "touch") scheduleClose();
					}}
					onClick={(event) => event.stopPropagation()}
					onPointerDown={(event) => event.stopPropagation()}
					onMouseDown={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Escape" && !event.defaultPrevented) {
							// Radix 刚挂载时的层级判定可能尚未就绪，已聚焦的菜单项仍须响应 Escape。
							event.preventDefault();
							cancelScheduledClose();
							restoreTriggerFocusAfterEscapeRef.current = true;
							onOpenChange(false);
							return;
						}
						if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
						event.preventDefault();
						const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
						const currentIndex =
							document.activeElement instanceof HTMLElement ? options.indexOf(document.activeElement) : -1;
						options[
							(currentIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
						]?.focus();
					}}
				>
					<Button
						role="menuitem"
						variant="ghost"
						className="min-h-8 justify-start px-3 text-text-primary [@media(pointer:coarse)]:min-h-11"
						onClick={() => activateOption(onPrimaryAction)}
					>
						{primaryLabel}
					</Button>
					<Button
						role="menuitem"
						aria-label={quickOption.label}
						variant="ghost"
						icon={quickOption.icon}
						className="min-h-8 justify-start px-3 text-text-primary [@media(pointer:coarse)]:min-h-11"
						onClick={() => activateOption(quickOption.onSelect)}
					>
						{quickOption.label}
					</Button>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
