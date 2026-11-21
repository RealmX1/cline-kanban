import * as DialogPrimitive from "@radix-ui/react-dialog";
import { DismissableLayer } from "@radix-ui/react-dismissable-layer";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { GripHorizontal, Maximize2, Minus, MoveDiagonal, X } from "lucide-react";
import {
	type ComponentProps,
	type CSSProperties,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useNonModalFloatingFormWindowSession } from "@/components/non-modal-floating-form-window-host-provider";
import { cn } from "@/components/ui/cn";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";

interface FloatingFormVisualViewport {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface NonModalFloatingFormWindowBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function clampNonModalFloatingFormWindowPosition(
	position: { left: number; top: number },
	width: number,
	height: number,
	viewport: FloatingFormVisualViewport,
) {
	return {
		left: Math.max(viewport.left + 8, Math.min(position.left, viewport.left + viewport.width - width - 8)),
		top: Math.max(viewport.top + 8, Math.min(position.top, viewport.top + viewport.height - height - 8)),
	};
}

function readFloatingFormVisualViewport(): FloatingFormVisualViewport {
	const viewport = window.visualViewport;
	return {
		left: viewport?.offsetLeft ?? 0,
		top: viewport?.offsetTop ?? 0,
		width: viewport?.width ?? window.innerWidth,
		height: viewport?.height ?? window.innerHeight,
	};
}

function hasOpenModalConfirmationAboveFloatingForms() {
	return (
		document.querySelector(
			'[data-state="open"][role="alertdialog"], [data-state="open"][role="dialog"]:not([aria-modal="false"]):not([data-related-tasks-preview-dialog])',
		) !== null
	);
}

type FloatingFormContentEvents = Pick<
	ComponentProps<typeof DialogPrimitive.Content>,
	| "onClickCapture"
	| "onKeyDownCapture"
	| "onKeyDown"
	| "onFocusCapture"
	| "onPasteCapture"
	| "onOpenAutoFocus"
	| "onEscapeKeyDown"
>;

export interface NonModalFloatingFormWindowProps extends FloatingFormContentEvents {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
	contentClassName?: string;
	expandedWidth?: string;
	maximumExpandedViewportHeightRatio?: number;
	contentAriaDescribedBy?: string;
	headerActions?: ReactNode;
	ownershipLabel?: string;
	verificationAnchor?: string;
	collapseControlLabel?: string;
	resizableLayout?: {
		initialBounds?: NonModalFloatingFormWindowBounds;
		onBoundsChange: (bounds: NonModalFloatingFormWindowBounds) => void;
	};
}

/** 正文始终挂载，收起只隐藏正文；焦点、选区、附件和滚动由原节点保留。 */
export function NonModalFloatingFormWindow({
	open,
	onOpenChange,
	title,
	children,
	contentClassName,
	expandedWidth = "min(860px,94vw)",
	contentAriaDescribedBy,
	headerActions,
	ownershipLabel,
	verificationAnchor = "non-modal-floating-form-window",
	maximumExpandedViewportHeightRatio = 0.88,
	collapseControlLabel = "填写窗口",
	resizableLayout,
	onClickCapture,
	onKeyDownCapture,
	onKeyDown,
	onFocusCapture,
	onPasteCapture,
	onOpenAutoFocus,
	onEscapeKeyDown,
}: NonModalFloatingFormWindowProps) {
	const session = useNonModalFloatingFormWindowSession();
	const contentRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const expandButtonRef = useRef<HTMLButtonElement>(null);
	const previousBodyFocus = useRef<HTMLElement | null>(null);
	const previousOutsideFocus = useRef<HTMLElement | null>(null);
	const lastBodyFocus = useRef<HTMLElement | null>(null);
	const lastHandledRevealSequence = useRef(session?.revealSequence ?? 0);
	const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
	const resizeRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null);
	const accessibleTitleId = useId();
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const [preferredBounds, setPreferredBounds] = useState(resizableLayout?.initialBounds);
	const [collapsed, setCollapsed] = useState(false);
	const lastHandledCollapseSequence = useRef(session?.collapseSequence ?? 0);
	const lastReportedRevealSequence = useRef<number | null>(null);
	useLayoutEffect(() => {
		const collapseSequence = session?.collapseSequence;
		if (collapseSequence === undefined || lastHandledCollapseSequence.current === collapseSequence) return;
		lastHandledCollapseSequence.current = collapseSequence;
		setCollapsed(true);
	}, [session?.collapseSequence]);
	useEffect(() => {
		if (!open || collapsed) {
			lastReportedRevealSequence.current = null;
			return;
		}
		const sequence = session?.revealSequence ?? 0;
		if (lastReportedRevealSequence.current === sequence) return;
		lastReportedRevealSequence.current = sequence;
		session?.reportRevealed();
	}, [open, collapsed, session?.revealSequence, session?.reportRevealed]);
	const [viewport, setViewport] = useState(readFloatingFormVisualViewport);
	const ownership = session?.ownership;
	const displayedOwnership =
		ownershipLabel ??
		ownership?.displayLabel ??
		[ownership?.workspaceId, ownership?.taskId, ownership?.conversationSessionId].filter(Boolean).join(" / ");
	useEffect(() => {
		if (!open) {
			setCollapsed(false);
			return;
		}
		const updateViewport = () => setViewport(readFloatingFormVisualViewport());
		updateViewport();
		window.addEventListener("resize", updateViewport);
		window.visualViewport?.addEventListener("resize", updateViewport);
		window.visualViewport?.addEventListener("scroll", updateViewport);
		return () => {
			window.removeEventListener("resize", updateViewport);
			window.visualViewport?.removeEventListener("resize", updateViewport);
			window.visualViewport?.removeEventListener("scroll", updateViewport);
		};
	}, [open]);

	useLayoutEffect(() => {
		const revealSequence = session?.revealSequence ?? 0;
		if (lastHandledRevealSequence.current === revealSequence) return;
		if (collapsed) {
			setCollapsed(false);
			return;
		}
		lastHandledRevealSequence.current = revealSequence;
		const target =
			previousBodyFocus.current ??
			lastBodyFocus.current ??
			contentRef.current?.querySelector<HTMLElement>("textarea:not(:disabled), input:not(:disabled)") ??
			contentRef.current;
		target?.focus({ preventScroll: true });
	}, [session?.revealSequence, collapsed]);
	const toggleCollapsed = () => {
		if (!collapsed) {
			if (bodyRef.current?.contains(document.activeElement))
				previousBodyFocus.current = document.activeElement as HTMLElement;
			expandButtonRef.current?.focus({ preventScroll: true });
		}
		setCollapsed((value) => !value);
	};
	useLayoutEffect(() => {
		if (!collapsed && previousBodyFocus.current?.isConnected) {
			previousBodyFocus.current.focus({ preventScroll: true });
			previousBodyFocus.current = null;
		}
	}, [collapsed]);
	const expandedLayoutWidth = Math.min(preferredBounds?.width ?? 620, Math.max(0, viewport.width - 16));
	const expandedLayoutHeight = Math.min(preferredBounds?.height ?? 520, Math.max(0, viewport.height - 16));
	const collapsedWidth = Math.min(320, viewport.width * 0.94, viewport.width - 16);
	const resizableWindowPosition = clampNonModalFloatingFormWindowPosition(
		preferredBounds ?? {
			left: viewport.left + (viewport.width - expandedLayoutWidth) / 2,
			top: viewport.top + Math.min(viewport.height * 0.05, 40) + (session?.initialCascadeOffsetPx ?? 0),
		},
		collapsed ? collapsedWidth : expandedLayoutWidth,
		collapsed ? 58 : expandedLayoutHeight,
		viewport,
	);
	const changePreferredBounds = (bounds: NonModalFloatingFormWindowBounds) => {
		setPreferredBounds(bounds);
		resizableLayout?.onBoundsChange(bounds);
	};
	const resizeExpandedWindow = (width: number, height: number) => {
		const availableWidth = viewport.left + viewport.width - resizableWindowPosition.left - 8;
		const availableHeight = viewport.top + viewport.height - resizableWindowPosition.top - 8;
		changePreferredBounds({
			...resizableWindowPosition,
			width: Math.min(availableWidth, Math.max(300, width)),
			height: Math.min(availableHeight, Math.max(240, height)),
		});
	};
	const style: CSSProperties = {
		left: position?.left ?? Math.max(8, viewport.left + (viewport.width - Math.min(860, viewport.width * 0.94)) / 2),
		top: position?.top ?? viewport.top + Math.min(viewport.height * 0.05, 40),
		width: collapsed ? collapsedWidth : `min(${expandedWidth}, ${Math.max(0, viewport.width - 16)}px)`,
		maxHeight: Math.max(0, Math.min(viewport.height - 16, window.innerHeight * maximumExpandedViewportHeightRatio)),
		...(resizableLayout && {
			...resizableWindowPosition,
			width: collapsed ? collapsedWidth : expandedLayoutWidth,
			height: collapsed ? undefined : expandedLayoutHeight,
			maxHeight: Math.max(0, viewport.height - 16),
		}),
	};
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<DialogPrimitive.Portal>
				<FocusScope
					asChild
					onMountAutoFocus={(event) => {
						previousOutsideFocus.current =
							document.activeElement instanceof HTMLElement ? document.activeElement : null;
						onOpenAutoFocus?.(event);
						if (event.defaultPrevented) return;
						event.preventDefault();
						contentRef.current
							?.querySelector<HTMLElement>("textarea:not(:disabled), input:not(:disabled)")
							?.focus({ preventScroll: true });
						if (!contentRef.current?.contains(document.activeElement))
							contentRef.current?.focus({ preventScroll: true });
					}}
					onUnmountAutoFocus={(event) => {
						event.preventDefault();
						if (
							previousOutsideFocus.current?.isConnected &&
							(document.activeElement === document.body || contentRef.current?.contains(document.activeElement))
						)
							previousOutsideFocus.current.focus({ preventScroll: true });
					}}
				>
					<DismissableLayer
						ref={contentRef}
						role="dialog"
						tabIndex={-1}
						style={style}
						className={cn(
							"fixed z-[44] flex flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-1 focus:outline-none",
							contentClassName ?? "w-[min(860px,94vw)]",
							session?.isActive && "z-[45]",
						)}
						data-non-modal-floating-form-window=""
						data-floating-form-instance-id={session ? String(session.instanceId) : undefined}
						data-collapsed={collapsed}
						data-state={open ? "open" : "closed"}
						data-verification-anchor={verificationAnchor}
						aria-modal={false}
						aria-labelledby={accessibleTitleId}
						aria-describedby={contentAriaDescribedBy}
						onPointerDownCapture={() => session?.activate()}
						onClickCapture={onClickCapture}
						onFocusCapture={(event) => {
							session?.activate();
							if (bodyRef.current?.contains(event.target as Node))
								lastBodyFocus.current = event.target as HTMLElement;
							onFocusCapture?.(event);
						}}
						onPasteCapture={onPasteCapture}
						onKeyDownCapture={(event) => {
							if (!contentRef.current?.contains(event.target as Node)) return;
							if (hasOpenModalConfirmationAboveFloatingForms()) {
								if (event.key === "Enter") {
									event.preventDefault();
									event.stopPropagation();
								}
								return;
							}
							if (collapsed && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							onKeyDownCapture?.(event);
						}}
						onKeyDown={(event) => {
							if (
								!contentRef.current?.contains(event.target as Node) ||
								hasOpenModalConfirmationAboveFloatingForms()
							)
								return;
							if (!collapsed) onKeyDown?.(event);
							if (
								event.key !== "Escape" ||
								event.defaultPrevented ||
								!contentRef.current.contains(document.activeElement)
							)
								return;
							if (isKeyboardEventEmittedDuringImeComposition(event)) {
								event.stopPropagation();
								return;
							}
							onEscapeKeyDown?.(event.nativeEvent);
							if (event.defaultPrevented || event.nativeEvent.defaultPrevented) return;
							event.preventDefault();
							event.stopPropagation();
							onOpenChange(false);
						}}
					>
						{!resizableLayout && (
							<NonModalFloatingFormViewportPositionConstraint
								viewport={viewport}
								collapsed={collapsed}
								initialCascadeOffsetPx={session?.initialCascadeOffsetPx ?? 0}
								setPosition={setPosition}
							/>
						)}
						<div
							className="flex shrink-0 touch-none items-center gap-1 border-b border-border bg-surface-2 px-2 py-1 select-none cursor-grab active:cursor-grabbing"
							onPointerDown={(event) => {
								if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, a"))
									return;
								const rect = contentRef.current?.getBoundingClientRect();
								if (!rect) return;
								dragRef.current = {
									pointerId: event.pointerId,
									x: event.clientX,
									y: event.clientY,
									left: rect.left,
									top: rect.top,
								};
								event.currentTarget.setPointerCapture(event.pointerId);
							}}
							onPointerMove={(event) => {
								const drag = dragRef.current;
								const rect = contentRef.current?.getBoundingClientRect();
								if (!drag || drag.pointerId !== event.pointerId || !rect) return;
								const nextPosition = clampNonModalFloatingFormWindowPosition(
									{ left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y },
									rect.width,
									rect.height,
									viewport,
								);
								if (resizableLayout) {
									changePreferredBounds({
										...nextPosition,
										width: preferredBounds?.width ?? 620,
										height: preferredBounds?.height ?? 520,
									});
								} else setPosition(nextPosition);
							}}
							onPointerUp={() => {
								dragRef.current = null;
							}}
							onPointerCancel={() => {
								dragRef.current = null;
							}}
						>
							<GripHorizontal size={16} className="shrink-0 text-text-secondary" aria-hidden />
							<div className="mr-auto min-w-0 flex-1">
								<DialogPrimitive.Title
									id={accessibleTitleId}
									className="truncate text-sm font-semibold text-text-primary"
								>
									{title}
								</DialogPrimitive.Title>
								{displayedOwnership && (
									<p className="truncate text-xs text-text-secondary" title={displayedOwnership}>
										{displayedOwnership}
									</p>
								)}
							</div>
							{!collapsed && headerActions}
							<button
								ref={expandButtonRef}
								type="button"
								className="flex min-h-11 shrink-0 items-center gap-1 rounded px-2 text-xs text-text-secondary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
								aria-label={`${collapsed ? "展开" : "收起"}${collapseControlLabel}`}
								aria-expanded={!collapsed}
								onPointerDown={() => {
									if (bodyRef.current?.contains(document.activeElement))
										previousBodyFocus.current = document.activeElement as HTMLElement;
								}}
								onClick={toggleCollapsed}
							>
								{collapsed ? <Maximize2 size={15} /> : <Minus size={15} />}
								{collapsed ? "展开" : "收起"}
							</button>
							<button
								type="button"
								className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
								aria-label={`关闭${collapseControlLabel}`}
								onClick={() => onOpenChange(false)}
							>
								<X size={16} />
							</button>
						</div>
						<div
							ref={bodyRef}
							hidden={collapsed}
							className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col"}
						>
							{children}
						</div>
						{resizableLayout && !collapsed && (
							<button
								type="button"
								aria-label={`调整${collapseControlLabel}大小`}
								title="拖动或使用方向键调整大小"
								className="absolute right-0 bottom-0 z-10 flex size-8 cursor-nwse-resize touch-none items-center justify-center rounded-tl bg-surface-2 text-text-secondary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
								onPointerDown={(event) => {
									if (event.button !== 0) return;
									resizeRef.current = {
										pointerId: event.pointerId,
										x: event.clientX,
										y: event.clientY,
										width: expandedLayoutWidth,
										height: expandedLayoutHeight,
									};
									event.currentTarget.setPointerCapture(event.pointerId);
								}}
								onPointerMove={(event) => {
									const resize = resizeRef.current;
									if (!resize || resize.pointerId !== event.pointerId) return;
									resizeExpandedWindow(
										resize.width + event.clientX - resize.x,
										resize.height + event.clientY - resize.y,
									);
								}}
								onLostPointerCapture={() => {
									resizeRef.current = null;
								}}
								onKeyDown={(event) => {
									const horizontal = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
									const vertical = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
									if (!horizontal && !vertical) return;
									event.preventDefault();
									resizeExpandedWindow(
										expandedLayoutWidth + horizontal * 16,
										expandedLayoutHeight + vertical * 16,
									);
								}}
							>
								<MoveDiagonal size={16} aria-hidden />
							</button>
						)}
					</DismissableLayer>
				</FocusScope>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

/** 在 portal 内实际挂载后测量；不在 Radix 合成 ref 回调中发布布局状态。 */
function NonModalFloatingFormViewportPositionConstraint({
	viewport,
	collapsed,
	initialCascadeOffsetPx,
	setPosition,
}: {
	viewport: FloatingFormVisualViewport;
	collapsed: boolean;
	initialCascadeOffsetPx: number;
	setPosition: Dispatch<SetStateAction<{ left: number; top: number } | null>>;
}) {
	const viewportConstraintAnchorRef = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const element = viewportConstraintAnchorRef.current?.parentElement;
		if (!element) return;
		const constrainWindow = () => {
			const rect = element.getBoundingClientRect();
			setPosition((previous) => {
				const next = clampNonModalFloatingFormWindowPosition(
					previous ?? {
						left: viewport.left + (viewport.width - rect.width) / 2 + initialCascadeOffsetPx,
						top: viewport.top + Math.min(viewport.height * 0.05, 40) + initialCascadeOffsetPx,
					},
					rect.width,
					rect.height,
					viewport,
				);
				return previous?.left === next.left && previous.top === next.top ? previous : next;
			});
		};
		constrainWindow();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(constrainWindow);
		observer?.observe(element);
		return () => observer?.disconnect();
	}, [viewport, collapsed, initialCascadeOffsetPx, setPosition]);
	return <span ref={viewportConstraintAnchorRef} hidden />;
}
