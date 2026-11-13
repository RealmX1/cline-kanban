import { autoUpdate, computePosition, hide, offset, shift } from "@floating-ui/dom";
import { Ellipsis, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useTaskCardPortalWheelScrollForwarding } from "@/hooks/use-task-card-portal-wheel-scroll-forwarding";
import { useMedia } from "@/utils/react-use";

const TASK_CARD_ACTION_TOOLBAR_KEYBOARD_ENTRY_SELECTOR =
	"button:not(:disabled):not([data-task-card-touch-actions-disclosure]), [tabindex='0']";

/** Portal 仍归原卡所有；卸载与形态切换时，焦点接力同时查卡内 DOM 和动作组。 */
export function getTaskCardDomRootsIncludingPortalledActionToolbars(source: HTMLElement): HTMLElement[] {
	return [
		source,
		...[...source.querySelectorAll<HTMLElement>("[data-task-card-action-toolbar-placeholder]")].flatMap(
			(placeholder) => {
				const toolbar = source.ownerDocument.getElementById(placeholder.getAttribute("aria-owns") ?? "");
				return toolbar ? [toolbar] : [];
			},
		),
	];
}

export function focusTaskCardKeyboardEntryIncludingPortalledActionToolbars(
	source: HTMLElement,
	selector: string,
): void {
	for (const root of getTaskCardDomRootsIncludingPortalledActionToolbars(source)) {
		const entry = root.querySelector<HTMLElement>(selector);
		if (!entry) continue;
		const hiddenAncestor = entry.closest("[hidden]");
		if (
			(hiddenAncestor &&
				!(root !== source && hiddenAncestor.hasAttribute("data-task-card-action-toolbar-expanded-actions"))) ||
			(entry.closest("[inert]") && entry.closest("[inert]") !== root)
		)
			continue;
		if (root === source) entry.focus({ preventScroll: true });
		else {
			const placeholder = [
				...source.querySelectorAll<HTMLElement>("[data-task-card-action-toolbar-placeholder]"),
			].find((element) => element.getAttribute("aria-owns") === root.id && !element.closest("[hidden], [inert]"));
			if (!placeholder) continue;
			placeholder.dataset.requestedTaskCardActionKeyboardEntrySelector = selector;
			placeholder.focus({ preventScroll: true });
		}
		return;
	}
}

/** 浮动动作只覆盖内容，不进入卡片或滚动容器的几何；行内触屏卡头沿用原布局。 */
export function TaskCardActionToolbar({
	sourceCardAnchorElementRef,
	isSourceCardInteractionActive = false,
	isCompactTaskRow = false,
	actionToolbarRightInsetPx = 0,
	usesDocumentFlowActionToolbar = false,
	hidden = false,
	children,
}: {
	sourceCardAnchorElementRef: RefObject<HTMLElement | null>;
	isSourceCardInteractionActive?: boolean;
	isCompactTaskRow?: boolean;
	actionToolbarRightInsetPx?: number;
	usesDocumentFlowActionToolbar?: boolean;
	hidden?: boolean;
	children: ReactNode;
}) {
	const taskCardActionToolbarDomId = useId();
	const inlineKeyboardEntryPlaceholderElementRef = useRef<HTMLSpanElement>(null);
	const taskCardActionToolbarElementRef = useRef<HTMLDivElement>(null);
	const touchActionToolbarDisclosureButtonRef = useRef<HTMLButtonElement>(null);
	const [actionToolbarPortalContainer, setActionToolbarPortalContainer] = useState<HTMLElement>(document.body);
	const forwardTaskCardActionToolbarWheelScrollRef = useTaskCardPortalWheelScrollForwarding(
		sourceCardAnchorElementRef,
		taskCardActionToolbarElementRef,
	);
	const [isPointerOverSourceCard, setIsPointerOverSourceCard] = useState(false);
	const [isPointerOverActionToolbar, setIsPointerOverActionToolbar] = useState(false);
	const [hasActionToolbarKeyboardFocus, setHasActionToolbarKeyboardFocus] = useState(false);
	const requestedActionToolbarKeyboardEntryRef = useRef<{
		selector: string;
		enterFromLastAction: boolean;
	} | null>(null);
	const isReturningFocusToInlineTabOrderRef = useRef(false);
	const usesTouchActionToolbar = useMedia("(hover: none), (pointer: coarse)", false);
	// 未显式切换时沿用长按展开等宿主交互；收起后不被同一次交互重新撑开。
	const [explicitTouchActionToolbarExpansion, setExplicitTouchActionToolbarExpansion] = useState<boolean | null>(null);
	const areActionToolbarActionsExpanded =
		usesDocumentFlowActionToolbar ||
		!usesTouchActionToolbar ||
		hasActionToolbarKeyboardFocus ||
		(explicitTouchActionToolbarExpansion ?? isSourceCardInteractionActive);
	const isTaskCardActionToolbarVisible =
		isSourceCardInteractionActive ||
		isPointerOverSourceCard ||
		isPointerOverActionToolbar ||
		hasActionToolbarKeyboardFocus ||
		usesTouchActionToolbar;

	useEffect(() => {
		if (usesDocumentFlowActionToolbar || !usesTouchActionToolbar || !areActionToolbarActionsExpanded) return;
		const dismissTouchActions = (event: PointerEvent) => {
			const toolbar = taskCardActionToolbarElementRef.current;
			if (isSourceCardInteractionActive || !(event.target instanceof Node) || toolbar?.contains(event.target))
				return;
			// 先让子浮层处理关闭和回焦；编辑器内点按不算返回列表。
			const overlaySelector = '[role="dialog"], [role="alertdialog"], [role="menu"]';
			if (
				(event.target instanceof Element && event.target.closest(overlaySelector)) ||
				document.activeElement?.closest(overlaySelector)
			)
				return;
			setExplicitTouchActionToolbarExpansion(false);
			setHasActionToolbarKeyboardFocus(false);
			if (document.activeElement instanceof HTMLElement && toolbar?.contains(document.activeElement)) {
				document.activeElement.blur();
			}
		};
		document.addEventListener("pointerdown", dismissTouchActions);
		return () => document.removeEventListener("pointerdown", dismissTouchActions);
	}, [
		usesDocumentFlowActionToolbar,
		usesTouchActionToolbar,
		areActionToolbarActionsExpanded,
		isSourceCardInteractionActive,
	]);

	useEffect(() => {
		const anchor = sourceCardAnchorElementRef.current;
		if (usesDocumentFlowActionToolbar || !anchor) return;
		// PDV 保持最前时沿用其堆叠上下文，菜单和对话框仍由原有面板降层机制处理。
		setActionToolbarPortalContainer(
			anchor.closest<HTMLElement>(".kb-viewport-bottom-verification-floating-panel") ?? document.body,
		);
		const enter = () => setIsPointerOverSourceCard(true);
		const leave = () => setIsPointerOverSourceCard(false);
		anchor.addEventListener("pointerenter", enter);
		anchor.addEventListener("pointerleave", leave);
		return () => {
			anchor.removeEventListener("pointerenter", enter);
			anchor.removeEventListener("pointerleave", leave);
		};
	}, [sourceCardAnchorElementRef, usesDocumentFlowActionToolbar]);

	useEffect(() => {
		const anchor = sourceCardAnchorElementRef.current;
		const toolbar = taskCardActionToolbarElementRef.current;
		if (usesDocumentFlowActionToolbar || !isTaskCardActionToolbarVisible || !anchor || !toolbar) return;
		let isPositionObservationDisposed = false;
		const stopObservingActionToolbarPosition = autoUpdate(anchor, toolbar, () => {
			void computePosition(anchor, toolbar, {
				strategy: "fixed",
				placement: "top-end",
				middleware: [
					offset(({ rects }) => ({
						mainAxis: (isCompactTaskRow ? 12 : 6) - rects.floating.height,
						crossAxis: -actionToolbarRightInsetPx,
					})),
					shift({ boundary: [], padding: 4, crossAxis: true }),
					hide({ strategy: "referenceHidden" }),
				],
			}).then(({ x, y, middlewareData }) => {
				if (isPositionObservationDisposed) return;
				const isSourceCardAnchorHidden =
					middlewareData.hide?.referenceHidden ||
					getComputedStyle(anchor).visibility === "hidden" ||
					anchor.closest("[hidden], [inert]") !== null;
				Object.assign(toolbar.style, {
					left: `${x}px`,
					top: `${y}px`,
					visibility: isSourceCardAnchorHidden ? "hidden" : "visible",
				});
				const requestedActionToolbarKeyboardEntry = requestedActionToolbarKeyboardEntryRef.current;
				if (
					!isSourceCardAnchorHidden &&
					requestedActionToolbarKeyboardEntry &&
					document.activeElement === inlineKeyboardEntryPlaceholderElementRef.current
				) {
					requestedActionToolbarKeyboardEntryRef.current = null;
					[...toolbar.querySelectorAll<HTMLElement>(requestedActionToolbarKeyboardEntry.selector)]
						.at(requestedActionToolbarKeyboardEntry.enterFromLastAction ? -1 : 0)
						?.focus({ preventScroll: true });
				}
			});
		});
		return () => {
			isPositionObservationDisposed = true;
			stopObservingActionToolbarPosition();
		};
	}, [
		sourceCardAnchorElementRef,
		isTaskCardActionToolbarVisible,
		usesDocumentFlowActionToolbar,
		isCompactTaskRow,
		actionToolbarRightInsetPx,
		actionToolbarPortalContainer,
		areActionToolbarActionsExpanded,
	]);

	const toolbar = (
		<div
			id={taskCardActionToolbarDomId}
			ref={forwardTaskCardActionToolbarWheelScrollRef}
			data-task-card-primary-actions=""
			hidden={hidden}
			data-task-card-action-toolbar-disclosure-state={areActionToolbarActionsExpanded ? "expanded" : "collapsed"}
			data-task-card-action-toolbar-state={
				!hidden && (usesDocumentFlowActionToolbar || isTaskCardActionToolbarVisible) ? "visible" : "hidden"
			}
			style={usesDocumentFlowActionToolbar ? undefined : { left: 0, top: 0, visibility: "hidden" }}
			{...{ inert: !usesDocumentFlowActionToolbar && !isTaskCardActionToolbarVisible ? "" : undefined }}
			onPointerEnter={() => setIsPointerOverActionToolbar(true)}
			onPointerLeave={() => setIsPointerOverActionToolbar(false)}
			onFocusCapture={(event) => {
				const isActionFocused = !touchActionToolbarDisclosureButtonRef.current?.contains(event.target);
				setHasActionToolbarKeyboardFocus(isActionFocused);
				if (usesTouchActionToolbar && isActionFocused) setExplicitTouchActionToolbarExpansion(true);
			}}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setHasActionToolbarKeyboardFocus(false);
			}}
			onKeyDown={(event) => {
				if (
					usesTouchActionToolbar &&
					!usesDocumentFlowActionToolbar &&
					event.key === "Escape" &&
					!event.defaultPrevented &&
					event.currentTarget.contains(event.target as Node)
				) {
					event.preventDefault();
					event.stopPropagation();
					setExplicitTouchActionToolbarExpansion(false);
					setHasActionToolbarKeyboardFocus(false);
					touchActionToolbarDisclosureButtonRef.current?.focus({ preventScroll: true });
					return;
				}
				if (
					usesDocumentFlowActionToolbar ||
					event.key !== "Tab" ||
					!event.currentTarget.contains(event.target as Node)
				)
					return;
				const actionToolbarKeyboardEntryElements = [
					...event.currentTarget.querySelectorAll<HTMLElement>(TASK_CARD_ACTION_TOOLBAR_KEYBOARD_ENTRY_SELECTOR),
				];
				if (
					event.target !== touchActionToolbarDisclosureButtonRef.current &&
					event.target !==
						(event.shiftKey ? actionToolbarKeyboardEntryElements[0] : actionToolbarKeyboardEntryElements.at(-1))
				)
					return;
				// 让浏览器从原位置继续 Tab，而不是跳往 body 尾部的下一份 Portal。
				isReturningFocusToInlineTabOrderRef.current = true;
				inlineKeyboardEntryPlaceholderElementRef.current?.focus({ preventScroll: true });
				isReturningFocusToInlineTabOrderRef.current = false;
			}}
			className={
				hidden
					? undefined
					: cn(
							"kb-task-card-primary-actions",
							usesDocumentFlowActionToolbar
								? "order-last mt-2 flex flex-wrap items-center gap-0.5"
								: "kb-task-card-floating-actions fixed z-40 flex max-w-[calc(100vw-8px)] flex-wrap items-center gap-0.5 rounded-md bg-surface-3 px-0.5 shadow-sm transition-opacity motion-reduce:transition-none",
							!usesDocumentFlowActionToolbar &&
								!isTaskCardActionToolbarVisible &&
								"pointer-events-none opacity-0",
						)
			}
		>
			<div
				id={`${taskCardActionToolbarDomId}-expanded-actions`}
				data-task-card-action-toolbar-expanded-actions=""
				hidden={!areActionToolbarActionsExpanded}
				className={areActionToolbarActionsExpanded ? "contents" : "hidden"}
			>
				{children}
			</div>
			{usesTouchActionToolbar && !usesDocumentFlowActionToolbar ? (
				<Button
					ref={touchActionToolbarDisclosureButtonRef}
					data-task-card-touch-actions-disclosure=""
					aria-label={areActionToolbarActionsExpanded ? "收起任务操作" : "显示任务操作"}
					aria-expanded={areActionToolbarActionsExpanded}
					aria-controls={`${taskCardActionToolbarDomId}-expanded-actions`}
					tabIndex={-1}
					variant="ghost"
					size="xs"
					icon={areActionToolbarActionsExpanded ? <X size={16} /> : <Ellipsis size={16} />}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						setHasActionToolbarKeyboardFocus(false);
						setExplicitTouchActionToolbarExpansion(!areActionToolbarActionsExpanded);
					}}
				/>
			) : null}
		</div>
	);
	return usesDocumentFlowActionToolbar ? (
		toolbar
	) : (
		<>
			<span
				ref={inlineKeyboardEntryPlaceholderElementRef}
				data-task-card-action-toolbar-placeholder=""
				aria-owns={taskCardActionToolbarDomId}
				tabIndex={0}
				className="sr-only"
				onBlur={(event) => {
					if (!taskCardActionToolbarElementRef.current?.contains(event.relatedTarget)) {
						requestedActionToolbarKeyboardEntryRef.current = null;
						setHasActionToolbarKeyboardFocus(false);
					}
				}}
				onFocus={(event) => {
					if (isReturningFocusToInlineTabOrderRef.current) return;
					const explicitSelector = event.currentTarget.dataset.requestedTaskCardActionKeyboardEntrySelector;
					const selector = explicitSelector ?? TASK_CARD_ACTION_TOOLBAR_KEYBOARD_ENTRY_SELECTOR;
					// 来源位于行内入口之后时，从末项接回反向 Tab；显式交接仍按指定按钮进入。
					const enterFromLastAction =
						!explicitSelector &&
						event.relatedTarget instanceof Node &&
						(event.currentTarget.compareDocumentPosition(event.relatedTarget) &
							Node.DOCUMENT_POSITION_FOLLOWING) !==
							0;
					delete event.currentTarget.dataset.requestedTaskCardActionKeyboardEntrySelector;
					requestedActionToolbarKeyboardEntryRef.current = { selector, enterFromLastAction };
					setHasActionToolbarKeyboardFocus(true);
					if (usesTouchActionToolbar) setExplicitTouchActionToolbarExpansion(true);
					if (
						areActionToolbarActionsExpanded &&
						isTaskCardActionToolbarVisible &&
						taskCardActionToolbarElementRef.current?.style.visibility === "visible"
					) {
						requestedActionToolbarKeyboardEntryRef.current = null;
						[...taskCardActionToolbarElementRef.current.querySelectorAll<HTMLElement>(selector)]
							.at(enterFromLastAction ? -1 : 0)
							?.focus({ preventScroll: true });
					}
				}}
			/>
			{createPortal(toolbar, actionToolbarPortalContainer)}
		</>
	);
}
