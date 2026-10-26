import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RelationTaskCardPreviewTarget } from "@/hooks/relation-task-card-preview-target";
import { hasOpenModalDialogOutsideRelatedTaskPreview } from "@/hooks/use-related-task-preview-focus-return-after-modal-dialog";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";

export function useRelationTaskCardPreview(active = true) {
	const layoutRef = useRef<HTMLDivElement>(null);
	const paneRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const skipRestoredTriggerFocusRef = useRef<HTMLElement | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [selection, setSelection] = useState<{ target: RelationTaskCardPreviewTarget; pinned: boolean } | null>(null);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const cancelPendingPreview = useCallback(() => {
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);
	useEffect(() => cancelPendingPreview, [cancelPendingPreview]);
	useEffect(() => {
		if (active) return;
		cancelPendingPreview();
		selectionRef.current = null;
		setSelection(null);
	}, [active, cancelPendingPreview]);
	const select = useCallback(
		(target: RelationTaskCardPreviewTarget, trigger: HTMLElement | null, pinned: boolean) => {
			cancelPendingPreview();
			if (hasOpenModalDialogOutsideRelatedTaskPreview(layoutRef.current)) return;
			if (!pinned && selectionRef.current?.pinned) return;
			triggerRef.current = trigger;
			const next = { target, pinned };
			selectionRef.current = next;
			setSelection(next);
		},
		[cancelPendingPreview],
	);
	const pinCurrentPreview = useCallback(() => {
		cancelPendingPreview();
		const current = selectionRef.current;
		if (!current || current.pinned) return;
		const next = { ...current, pinned: true };
		selectionRef.current = next;
		setSelection(next);
	}, [cancelPendingPreview]);
	const closePreview = useCallback(() => {
		cancelPendingPreview();
		selectionRef.current = null;
		setSelection(null);
		const trigger = triggerRef.current;
		if (trigger?.isConnected && document.activeElement !== trigger) {
			skipRestoredTriggerFocusRef.current = trigger;
			trigger.focus({ preventScroll: true });
			if (document.activeElement !== trigger) {
				// 预览收起后的容器重排可能才会显示原图节点；只补一次，且不能抢走后续预览的焦点。
				requestAnimationFrame(() => {
					if (!layoutRef.current || !trigger.isConnected || triggerRef.current !== trigger || selectionRef.current)
						return;
					skipRestoredTriggerFocusRef.current = trigger;
					trigger.focus({ preventScroll: true });
				});
			}
		}
	}, [cancelPendingPreview]);
	useEffect(() => {
		if (!selection) return;
		// window 捕获先于 Radix 在 document 上的祖先 Dialog 监听；独立模态框及行内编辑仍优先。
		const handleEscape = (event: KeyboardEvent) => {
			const foreground = document.querySelector('[data-expanded-foreground-view="active"]');
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				isKeyboardEventEmittedDuringImeComposition(event) ||
				(foreground && !foreground.contains(layoutRef.current)) ||
				hasOpenModalDialogOutsideRelatedTaskPreview(layoutRef.current) ||
				document.querySelector('[data-state="open"][role="menu"], [data-state="open"][role="listbox"]')
			)
				return;
			if (
				event.target instanceof HTMLElement &&
				paneRef.current?.contains(event.target) &&
				event.target.matches('input, textarea, [contenteditable="true"]')
			) {
				// 先阻止祖先 Dialog 关闭，继续传播以便输入框自己的 React 处理器取消编辑。
				event.preventDefault();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			closePreview();
		};
		window.addEventListener("keydown", handleEscape, true);
		return () => window.removeEventListener("keydown", handleEscape, true);
	}, [Boolean(selection), closePreview]);
	return {
		layoutRef,
		paneRef,
		selection,
		cancelPendingPreview,
		closePreview,
		pinCurrentPreview,
		previewOnHover: (target: RelationTaskCardPreviewTarget, trigger: HTMLElement | null) => {
			cancelPendingPreview();
			if (selectionRef.current?.pinned) return;
			timerRef.current = setTimeout(() => select(target, trigger, false), 200);
		},
		previewOnFocus: (target: RelationTaskCardPreviewTarget, trigger: HTMLElement | null) => {
			if (trigger && skipRestoredTriggerFocusRef.current === trigger) {
				skipRestoredTriggerFocusRef.current = null;
				return;
			}
			select(target, trigger, false);
		},
		pinPreview: (target: RelationTaskCardPreviewTarget, trigger: HTMLElement | null) => select(target, trigger, true),
	};
}

export type RelationTaskCardPreviewController = ReturnType<typeof useRelationTaskCardPreview>;
export const RelationTaskCardPreviewContext = createContext<RelationTaskCardPreviewController | null>(null);
export function useRelationTaskCardPreviewContext() {
	return useContext(RelationTaskCardPreviewContext);
}
