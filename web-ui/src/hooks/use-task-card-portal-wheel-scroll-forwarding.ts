import { type MutableRefObject, type RefObject, useCallback, useRef } from "react";

const portalScrollOrigins = new WeakMap<HTMLElement, RefObject<HTMLElement | null>>();
const canScrollVertically = (element: HTMLElement, deltaY: number): boolean =>
	deltaY < 0 ? element.scrollTop > 1 : element.scrollTop + element.clientHeight < element.scrollHeight - 1;
const isVerticalScrollContainer = (element: HTMLElement): boolean =>
	["auto", "scroll"].includes(getComputedStyle(element).overflowY);

/** 复用同列的滚轮接续；浮层有可滚内容时仍由浏览器处理。 */
export function forwardWheelToScrollContainer(event: WheelEvent, scrollContainer: HTMLElement): void {
	if (
		event.defaultPrevented ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		event.deltaY === 0 ||
		Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
		(event.target instanceof Node && scrollContainer.contains(event.target))
	)
		return;
	for (const target of event.composedPath()) {
		if (!(target instanceof HTMLElement)) continue;
		if (target.classList.contains("kb-stage-header-rail") && canScrollVertically(scrollContainer, event.deltaY))
			continue;
		if (isVerticalScrollContainer(target) && canScrollVertically(target, event.deltaY)) return;
	}
	const deltaUnitHeight =
		event.deltaMode === WheelEvent.DOM_DELTA_LINE
			? Number.parseFloat(getComputedStyle(scrollContainer).lineHeight) || 16
			: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? scrollContainer.clientHeight
				: 1;
	event.preventDefault();
	if (!canScrollVertically(scrollContainer, event.deltaY)) return;
	scrollContainer.scrollTop += event.deltaY * deltaUnitHeight;
}

function designatedColumnScrollContainer(element: HTMLElement): HTMLElement | null {
	const designated = element.hasAttribute("data-task-card-column-scroll-container")
		? element
		: element.hasAttribute("data-focus-view-column-scroll-boundary")
			? element.querySelector<HTMLElement>("[data-task-card-column-scroll-container]")
			: null;
	if (!designated || designated.classList.contains("kb-stage-header-rail") || !isVerticalScrollContainer(designated))
		return null;
	return designated;
}

function findTaskCardScrollOwner(source: HTMLElement | null, deltaY: number): HTMLElement | null {
	const taskCardSourceAncestors: HTMLElement[] = [];
	let outermostTaskCardOriginIndex = -1;
	let columnBoundary: HTMLElement | null = null;
	const visited = new Set<HTMLElement>();
	for (let element = source; element && !visited.has(element); ) {
		visited.add(element);
		if (element.matches(".kb-board-card-shell, [data-cross-project-task-switcher-task-id]"))
			outermostTaskCardOriginIndex = taskCardSourceAncestors.length;
		taskCardSourceAncestors.push(element);
		if (
			element.hasAttribute("data-task-card-column-scroll-container") ||
			element.hasAttribute("data-focus-view-column-scroll-boundary")
		) {
			columnBoundary = element;
			break;
		}
		// Portal 的原生 DOM 祖先链丢失；沿实际触发控件回到卡片，支持浮层内再开浮层。
		element = portalScrollOrigins.get(element)?.current ?? element.parentElement;
	}
	if (outermostTaskCardOriginIndex < 0) return null;
	let nearestScrollable: HTMLElement | null = null;
	let nearestColumnScrollContainer: HTMLElement | null = null;
	for (const [index, element] of taskCardSourceAncestors.entries()) {
		// 预览卡所在的 Portal 仍可接续；真正来源卡的首个滚动祖先才是列边界。
		if (
			!nearestColumnScrollContainer &&
			!element.classList.contains("kb-stage-header-rail") &&
			isVerticalScrollContainer(element)
		) {
			if (index >= outermostTaskCardOriginIndex) nearestColumnScrollContainer = element;
			if (!nearestScrollable && canScrollVertically(element, deltaY)) nearestScrollable = element;
		}
	}
	return (
		nearestScrollable ??
		(columnBoundary ? designatedColumnScrollContainer(columnBoundary) : null) ??
		nearestColumnScrollContainer
	);
}

/** 只在浮层挂载时监听；React 18 的 callback ref 负责同步解绑与保留原有 DOM ref。 */
export function useTaskCardPortalWheelScrollForwarding<T extends HTMLElement>(
	sourceRef: RefObject<HTMLElement | null>,
	existingElementRef?: RefObject<T>,
): (element: T | null) => void {
	const removeListenerRef = useRef<(() => void) | null>(null);
	return useCallback(
		(element: T | null) => {
			removeListenerRef.current?.();
			removeListenerRef.current = null;
			if (existingElementRef) (existingElementRef as MutableRefObject<T | null>).current = element;
			if (!element) return;
			portalScrollOrigins.set(element, sourceRef);
			const forwardWheel = (event: WheelEvent) => {
				const scrollOwner = findTaskCardScrollOwner(sourceRef.current, event.deltaY);
				if (scrollOwner) forwardWheelToScrollContainer(event, scrollOwner);
			};
			element.addEventListener("wheel", forwardWheel, { passive: false });
			removeListenerRef.current = () => {
				element.removeEventListener("wheel", forwardWheel);
				portalScrollOrigins.delete(element);
			};
		},
		[sourceRef, existingElementRef],
	);
}
