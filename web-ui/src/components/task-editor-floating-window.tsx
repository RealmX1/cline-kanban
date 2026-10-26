import * as DialogPrimitive from "@radix-ui/react-dialog";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { GripHorizontal, Maximize2, Minus, PencilLine, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";

export function clampTaskEditorWindowPosition(
	position: { left: number; top: number },
	width: number,
	viewport: { width: number; height: number },
) {
	return {
		left: Math.max(8, Math.min(position.left, Math.max(8, viewport.width - width - 8))),
		top: Math.max(8, Math.min(position.top, Math.max(8, viewport.height - 64))),
	};
}

/** 非模态编辑工作台：背景保留焦点与滚动，收起时仍挂载草稿。 */
export function TaskEditorFloatingWindow({
	open,
	onOpenChange,
	title,
	children,
	onClickCapture,
	onKeyDownCapture,
	onKeyDown,
	onFocusCapture,
	onPasteCapture,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
	onClickCapture: React.ComponentProps<typeof DialogPrimitive.Content>["onClickCapture"];
	onKeyDownCapture: React.ComponentProps<typeof DialogPrimitive.Content>["onKeyDownCapture"];
	onKeyDown: React.ComponentProps<typeof DialogPrimitive.Content>["onKeyDown"];
	onPasteCapture?: React.ComponentProps<typeof DialogPrimitive.Content>["onPasteCapture"];
	onFocusCapture?: React.ComponentProps<typeof DialogPrimitive.Content>["onFocusCapture"];
}) {
	const contentRef = useRef<HTMLDivElement>(null);
	const taskEditorWindowAccessibleTitleElementId = useId();
	const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		if (!open) {
			setCollapsed(false);
			return;
		}
		const keepHeaderVisible = () =>
			setPosition(
				(previous) =>
					previous &&
					clampTaskEditorWindowPosition(previous, contentRef.current?.offsetWidth ?? 0, {
						width: window.innerWidth,
						height: window.innerHeight,
					}),
			);
		window.addEventListener("resize", keepHeaderVisible);
		return () => window.removeEventListener("resize", keepHeaderVisible);
	}, [open]);
	const style: CSSProperties = {
		left: position?.left ?? "max(8px, calc((100vw - min(1100px, 94vw)) / 2))",
		top: position?.top ?? "min(5vh, 40px)",
	};
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<DialogPrimitive.Portal>
				<FocusScope
					asChild
					loop
					onMountAutoFocus={(event) => {
						event.preventDefault();
						contentRef.current?.querySelector<HTMLElement>("textarea, input")?.focus({ preventScroll: true });
					}}
					onUnmountAutoFocus={(event) => event.preventDefault()}
				>
					<div
						ref={contentRef}
						role="dialog"
						tabIndex={-1}
						style={style}
						className="fixed z-40 flex w-[min(1100px,94vw)] max-h-[88dvh] flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-1 focus:outline-none"
						data-verification-anchor="task-editor-floating-window"
						aria-modal={false}
						aria-labelledby={taskEditorWindowAccessibleTitleElementId}
						data-state={open ? "open" : "closed"}
						aria-describedby={undefined}
						onClickCapture={onClickCapture}
						onKeyDownCapture={onKeyDownCapture}
						onKeyDown={(event) => {
							onKeyDown?.(event);
							if (
								event.key !== "Escape" ||
								event.defaultPrevented ||
								!contentRef.current?.contains(document.activeElement)
							)
								return;
							// 非模态浮窗只消费自身焦点的 Esc；子控件已取消的事件继续归子控件。
							event.preventDefault();
							if (!isKeyboardEventEmittedDuringImeComposition(event)) onOpenChange(false);
						}}
						onFocusCapture={onFocusCapture}
						onPasteCapture={onPasteCapture}
					>
						<div
							className="flex shrink-0 touch-none items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 select-none cursor-grab active:cursor-grabbing"
							onPointerDown={(event) => {
								if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
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
								if (!drag || drag.pointerId !== event.pointerId) return;
								setPosition(
									clampTaskEditorWindowPosition(
										{ left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y },
										contentRef.current?.offsetWidth ?? 0,
										{ width: window.innerWidth, height: window.innerHeight },
									),
								);
							}}
							onPointerUp={() => {
								dragRef.current = null;
							}}
							onPointerCancel={() => {
								dragRef.current = null;
							}}
						>
							<GripHorizontal size={16} className="text-text-secondary" aria-hidden />
							<PencilLine size={15} className="text-text-secondary" aria-hidden />
							<DialogPrimitive.Title
								id={taskEditorWindowAccessibleTitleElementId}
								className="mr-auto truncate text-sm font-semibold text-text-primary"
							>
								{title}
							</DialogPrimitive.Title>
							<button
								type="button"
								className="rounded p-2 text-text-secondary hover:bg-surface-3"
								aria-label={collapsed ? "展开任务编辑器" : "收起任务编辑器"}
								onClick={() => setCollapsed((value) => !value)}
							>
								{collapsed ? <Maximize2 size={16} /> : <Minus size={16} />}
							</button>
							<button
								type="button"
								className="rounded p-2 text-text-secondary hover:bg-surface-3"
								aria-label="关闭任务编辑器"
								onClick={() => onOpenChange(false)}
							>
								<X size={16} />
							</button>
						</div>
						<div className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col"}>{children}</div>
					</div>
				</FocusScope>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
