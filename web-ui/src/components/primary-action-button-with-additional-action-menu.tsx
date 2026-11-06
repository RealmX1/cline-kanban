import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

export function PrimaryActionButtonWithAdditionalActionMenu({
	open,
	onOpenChange,
	icon,
	primaryLabel,
	primaryAccessibleLabel,
	onPrimaryAction,
	additionalAction,
	disabled = false,
	variant = "ghost",
	size = "xs",
	touchAdditionalActionTrigger = "separate_menu_button",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	icon: ReactNode;
	primaryLabel: string;
	primaryAccessibleLabel: string;
	onPrimaryAction: () => void;
	additionalAction: { label: string; icon?: ReactNode; onSelect: () => void };
	disabled?: boolean;
	variant?: ButtonVariant;
	size?: ButtonSize;
	touchAdditionalActionTrigger?: "separate_menu_button" | "long_press_primary_button";
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const openingInteractionRef = useRef<"hover" | "touch" | "keyboard">("hover");
	const restoreTriggerFocusAfterEscapeRef = useRef(false);
	const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const touchLongPressRef = useRef<{
		timeoutId: ReturnType<typeof setTimeout>;
		removeScrollCancellationListener: () => void;
		pointerId: number;
		startX: number;
		startY: number;
	} | null>(null);
	const suppressReleasedLongPressClickRef = useRef(false);
	const cancelTouchLongPress = () => {
		if (touchLongPressRef.current) {
			clearTimeout(touchLongPressRef.current.timeoutId);
			touchLongPressRef.current.removeScrollCancellationListener();
		}
		touchLongPressRef.current = null;
	};
	const cancelScheduledClose = () => {
		if (closeTimeoutRef.current !== null) clearTimeout(closeTimeoutRef.current);
		closeTimeoutRef.current = null;
	};
	useEffect(
		() => () => {
			if (closeTimeoutRef.current !== null) clearTimeout(closeTimeoutRef.current);
			cancelTouchLongPress();
		},
		[],
	);

	useEffect(() => {
		if (disabled) cancelTouchLongPress();
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
					variant={variant}
					size={size}
					disabled={disabled}
					className="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
					aria-label={primaryAccessibleLabel}
					aria-haspopup="menu"
					aria-expanded={open && !disabled}
					aria-controls={open && !disabled ? menuId : undefined}
					onMouseDown={(event) => event.stopPropagation()}
					onPointerDown={(event) => {
						event.stopPropagation();
						cancelTouchLongPress();
						suppressReleasedLongPressClickRef.current = false;
						if (
							disabled ||
							event.pointerType !== "touch" ||
							touchAdditionalActionTrigger !== "long_press_primary_button"
						)
							return;
						const { pointerId, clientX, clientY } = event;
						const cancelForScroll = () => cancelTouchLongPress();
						window.addEventListener("scroll", cancelForScroll, true);
						touchLongPressRef.current = {
							pointerId,
							removeScrollCancellationListener: () =>
								window.removeEventListener("scroll", cancelForScroll, true),
							startX: clientX,
							startY: clientY,
							timeoutId: setTimeout(() => {
								cancelTouchLongPress();
								suppressReleasedLongPressClickRef.current = true;
								cancelScheduledClose();
								openingInteractionRef.current = "touch";
								onOpenChange(true);
							}, 500),
						};
					}}
					onPointerMove={(event) => {
						const pendingTouchLongPress = touchLongPressRef.current;
						if (
							pendingTouchLongPress?.pointerId === event.pointerId &&
							Math.hypot(
								event.clientX - pendingTouchLongPress.startX,
								event.clientY - pendingTouchLongPress.startY,
							) > 8
						)
							cancelTouchLongPress();
					}}
					onPointerUp={cancelTouchLongPress}
					onPointerCancel={() => {
						cancelTouchLongPress();
						suppressReleasedLongPressClickRef.current = false;
					}}
					onContextMenu={(event) => {
						if (touchLongPressRef.current || suppressReleasedLongPressClickRef.current) event.preventDefault();
					}}
					onPointerEnter={(event) => {
						if (event.pointerType === "touch" || disabled) return;
						cancelScheduledClose();
						if (open) return;
						openingInteractionRef.current = "hover";
						onOpenChange(true);
					}}
					onPointerLeave={(event) => {
						if (event.pointerType === "touch") return;
						cancelTouchLongPress();
						scheduleClose();
					}}
					onClick={(event) => {
						event.stopPropagation();
						if (suppressReleasedLongPressClickRef.current && event.detail !== 0) {
							suppressReleasedLongPressClickRef.current = false;
							event.preventDefault();
							return;
						}
						suppressReleasedLongPressClickRef.current = false;
						activateOption(onPrimaryAction);
					}}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							openingInteractionRef.current = "keyboard";
							if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
							onOpenChange(true);
						}
					}}
				/>
			</RadixPopover.Anchor>
			{touchAdditionalActionTrigger === "separate_menu_button" ? (
				<Button
					icon={<ChevronDown size={12} />}
					variant={variant}
					size={size}
					disabled={disabled}
					className="hidden [@media(any-pointer:coarse)]:inline-flex [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-8"
					aria-label={`展开${primaryLabel}附加操作`}
					aria-haspopup="menu"
					aria-expanded={open && !disabled}
					aria-controls={open && !disabled ? menuId : undefined}
					onMouseDown={(event) => event.stopPropagation()}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						cancelScheduledClose();
						openingInteractionRef.current = "touch";
						onOpenChange(!open);
					}}
				/>
			) : null}
			<RadixPopover.Portal>
				<RadixPopover.Content
					data-mobile-focus-view-idle-collapse-suspension=""
					ref={menuRef}
					id={menuId}
					role="menu"
					aria-label={`${primaryLabel}附加操作`}
					side="bottom"
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
					onInteractOutside={(event) => {
						// 长按抬手会把原生焦点交回主按钮；该手势的释放不能关闭刚打开的菜单。
						if (
							suppressReleasedLongPressClickRef.current &&
							event.target instanceof Node &&
							triggerRef.current?.contains(event.target)
						)
							event.preventDefault();
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
						aria-label={additionalAction.label}
						variant="ghost"
						icon={additionalAction.icon}
						className="min-h-8 justify-start px-3 text-text-primary [@media(pointer:coarse)]:min-h-11"
						onClick={() => activateOption(additionalAction.onSelect)}
					>
						{additionalAction.label}
					</Button>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
