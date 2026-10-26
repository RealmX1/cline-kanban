import { type RefObject, useCallback, useEffect, useRef } from "react";

export function hasOpenModalDialogOutsideRelatedTaskPreview(previewElement?: HTMLElement | null): boolean {
	return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
		(dialog) =>
			!dialog.hasAttribute("data-related-tasks-preview-dialog") &&
			dialog.getAttribute("aria-modal") !== "false" &&
			dialog.getAttribute("data-state") !== "closed" &&
			!(previewElement && dialog.contains(previewElement)),
	);
}

// 卡片操作的确认框属于 App，Portal 不在预览 DOM 内；返回焦点不能依赖 Dialog.Trigger 的父子关系。
export function useRelatedTaskPreviewFocusReturnAfterModalDialog(
	isOpen: boolean,
	popoverContentRef: RefObject<HTMLElement | null>,
) {
	const lastInteractionTarget = useRef<HTMLElement | null>(null);
	const rememberInteractionTarget = useCallback(
		(target: EventTarget | null) => {
			if (!(target instanceof Element) || !popoverContentRef.current?.contains(target)) return;
			const control = target.closest<HTMLElement>("button, input, textarea, a, [tabindex]");
			if (control) lastInteractionTarget.current = control;
		},
		[popoverContentRef],
	);
	useEffect(() => {
		if (!isOpen) return;
		let observedModalDialog = false;
		let focusReturnTimer: ReturnType<typeof setTimeout> | null = null;
		let focusReturnFrame: number | null = null;
		const observeDialogOwnership = () => {
			if (hasOpenModalDialogOutsideRelatedTaskPreview(popoverContentRef.current)) {
				observedModalDialog = true;
				return;
			}
			if (!observedModalDialog) return;
			observedModalDialog = false;
			// 等 Dialog 自己的 FocusScope 完成卸载，再恢复到实际发起这次操作的按钮。
			focusReturnTimer = setTimeout(() => {
				focusReturnFrame = requestAnimationFrame(() => {
					const content = popoverContentRef.current;
					if (
						!content ||
						hasOpenModalDialogOutsideRelatedTaskPreview(content) ||
						content.contains(document.activeElement)
					)
						return;
					const previous = lastInteractionTarget.current;
					const target =
						previous?.isConnected && content.contains(previous) && !previous.matches(":disabled")
							? previous
							: content;
					target.focus({ preventScroll: true });
				});
			}, 0);
		};
		// Radix 的模态 Portal 直接挂在 body；只观察顶层增删，不订阅整块看板的高频 DOM 更新。
		const observer = new MutationObserver(observeDialogOwnership);
		observer.observe(document.body, { childList: true });
		return () => {
			observer.disconnect();
			if (focusReturnTimer !== null) clearTimeout(focusReturnTimer);
			if (focusReturnFrame !== null) cancelAnimationFrame(focusReturnFrame);
		};
	}, [isOpen, popoverContentRef]);
	return rememberInteractionTarget;
}
