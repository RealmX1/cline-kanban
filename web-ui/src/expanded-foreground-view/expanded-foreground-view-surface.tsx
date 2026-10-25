import { FocusScope } from "@radix-ui/react-focus-scope";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { ExpandedForegroundViewSurfaceController } from "@/expanded-foreground-view/use-expanded-foreground-view-surface";

// 只禁用宿主祖先链外的兄弟；宿主自身及随后打开的 Radix portal 继续可交互。
function suspendBackgroundSiblings(element: HTMLElement): () => void {
	const suspended: { element: HTMLElement; inert: boolean; ariaHidden: string | null }[] = [];
	let current: HTMLElement | null = element;
	while (current?.parentElement && current !== document.body) {
		for (const sibling of current.parentElement.children) {
			if (!(sibling instanceof HTMLElement) || sibling === current) continue;
			if (sibling.closest('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) continue;
			suspended.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") });
			sibling.inert = true;
			sibling.setAttribute("aria-hidden", "true");
		}
		current = current.parentElement;
	}
	return () => {
		for (const entry of suspended) {
			entry.element.inert = entry.inert;
			if (entry.ariaHidden === null) entry.element.removeAttribute("aria-hidden");
			else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
		}
	};
}

export function ExpandedForegroundViewSurface({
	controller,
	title,
	className,
	children,
	as: SurfaceElement = "div",
}: {
	controller: ExpandedForegroundViewSurfaceController;
	title: string;
	className?: string;
	children: ReactNode;
	as?: "div" | "section";
}) {
	const closeRef = useRef(controller.close);
	closeRef.current = controller.close;
	useEffect(() => {
		const element = controller.elementRef.current;
		if (!controller.isExpanded || !element) return;
		const previousFocus = document.activeElement;
		const restoreBackground = suspendBackgroundSiblings(element);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		element.querySelector<HTMLButtonElement>("[data-foreground-view-return]")?.focus({ preventScroll: true });
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (
				document.querySelector(
					'[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]',
				)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			restoreBackground();
			document.body.style.overflow = previousOverflow;
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
				previousFocus.focus({ preventScroll: true });
		};
	}, [controller.isExpanded, controller.elementRef]);
	return (
		<FocusScope
			asChild
			loop={controller.isExpanded}
			trapped={controller.isExpanded}
			onMountAutoFocus={(event) => event.preventDefault()}
			onUnmountAutoFocus={(event) => event.preventDefault()}
		>
			<SurfaceElement
				ref={controller.elementRef}
				className={cn(className, controller.isExpanded && "kb-expanded-foreground-view")}
				role="region"
				aria-label={title}
				data-expanded-foreground-view={controller.isExpanded ? "active" : undefined}
				onKeyDown={(event) => {
					if (
						!controller.isExpanded ||
						!(event.target instanceof Node) ||
						!controller.elementRef.current?.contains(event.target)
					)
						return;
					if (event.key === "Escape") {
						if (
							event.defaultPrevented ||
							document.querySelector(
								'[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]',
							)
						)
							return;
						event.preventDefault();
						controller.close();
					}
					event.stopPropagation();
				}}
			>
				{controller.isExpanded ? (
					<header className="flex shrink-0 items-center gap-3 border-b border-border px-3 pb-1 pt-[max(0.25rem,env(safe-area-inset-top))]">
						<Button
							variant="ghost"
							size="sm"
							className="min-h-11 shrink-0 gap-1"
							data-foreground-view-return=""
							onClick={controller.close}
						>
							<ArrowLeft size={16} />
							返回
						</Button>
						<h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
					</header>
				) : null}
				{children}
			</SurfaceElement>
		</FocusScope>
	);
}
