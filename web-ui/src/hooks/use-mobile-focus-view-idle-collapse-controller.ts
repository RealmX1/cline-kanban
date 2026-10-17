import { createContext, type RefObject, useCallback, useContext, useEffect, useRef, useState } from "react";

export const MOBILE_FOCUS_VIEW_IDLE_COLLAPSE_TIMEOUT_MS = 30_000;

export interface MobileFocusViewIdleCollapseController {
	idleCollapseRequestSequenceNumber: number;
	recordUserInteraction: () => void;
}

const MobileFocusViewIdleCollapseControllerContext = createContext<MobileFocusViewIdleCollapseController | null>(null);
export const MobileFocusViewIdleCollapseControllerProvider = MobileFocusViewIdleCollapseControllerContext.Provider;

/** Focus View 外返回 null；其他手机区域可消费同一倒计时，不自行建立 timer。 */
export function useSharedMobileFocusViewIdleCollapseController(): MobileFocusViewIdleCollapseController | null {
	return useContext(MobileFocusViewIdleCollapseControllerContext);
}

function isIdleCollapseSuspended(focusViewRoot: HTMLElement): boolean {
	const activeElement = document.activeElement;
	if (
		activeElement instanceof HTMLElement &&
		focusViewRoot.contains(activeElement) &&
		activeElement.closest("[data-mobile-focus-view-idle-collapse-suspension]")
	) {
		return true;
	}
	// 弹窗可能通过 Portal 挂到 body；只检查未关闭的语义弹窗，不依赖它的 DOM 归属。
	if (
		document.querySelector(
			"[role='dialog']:not([hidden]):not([data-state='closed']), [role='alertdialog']:not([hidden]):not([data-state='closed']), dialog[open]",
		)
	) {
		return true;
	}
	const selection = document.getSelection();
	return Boolean(
		selection && !selection.isCollapsed && selection.anchorNode && focusViewRoot.contains(selection.anchorNode),
	);
}

/** 单一倒计时只发出收起请求；参与区域自行收起，用户操作不会把已收起的区域重新展开。 */
export function useMobileFocusViewIdleCollapseController({
	enabled,
	focusedTaskIdentity,
	focusViewRootRef,
}: {
	enabled: boolean;
	focusedTaskIdentity: string;
	focusViewRootRef: RefObject<HTMLElement | null>;
}): MobileFocusViewIdleCollapseController {
	const [idleCollapseRequestSequenceNumber, setIdleCollapseRequestSequenceNumber] = useState(0);
	const recordUserInteractionRef = useRef<() => void>(() => {});
	const recordUserInteraction = useCallback(() => recordUserInteractionRef.current(), []);

	useEffect(() => {
		const focusViewRoot = focusViewRootRef.current;
		if (!enabled || !focusViewRoot) return;
		let timeoutId: number | null = null;
		let suspended = isIdleCollapseSuspended(focusViewRoot);
		const clearCountdown = () => {
			if (timeoutId !== null) window.clearTimeout(timeoutId);
			timeoutId = null;
		};
		const restartCountdown = () => {
			clearCountdown();
			suspended = isIdleCollapseSuspended(focusViewRoot);
			if (suspended) return;
			timeoutId = window.setTimeout(() => {
				timeoutId = null;
				suspended = isIdleCollapseSuspended(focusViewRoot);
				if (!suspended) setIdleCollapseRequestSequenceNumber((sequenceNumber) => sequenceNumber + 1);
			}, MOBILE_FOCUS_VIEW_IDLE_COLLAPSE_TIMEOUT_MS);
		};
		const refreshSuspension = () => {
			const nextSuspended = isIdleCollapseSuspended(focusViewRoot);
			if (nextSuspended === suspended) return;
			suspended = nextSuspended;
			if (suspended) clearCountdown();
			else restartCountdown();
		};
		recordUserInteractionRef.current = restartCountdown;
		// scroll 无法区分用户滚动和终端自动跟随输出，只订阅真正的输入手势。
		const interactionEventNames = ["pointerdown", "keydown", "input", "wheel", "touchmove"] as const;
		for (const eventName of interactionEventNames) {
			focusViewRoot.addEventListener(eventName, restartCountdown, { capture: true, passive: true });
		}
		document.addEventListener("selectionchange", refreshSuspension);
		document.addEventListener("focusin", refreshSuspension);
		document.addEventListener("focusout", refreshSuspension);
		// 只在暂停状态真的变化时重启倒计时，正常渲染与 Agent 输出不会续期。
		const modalPresenceObserver = new MutationObserver(refreshSuspension);
		modalPresenceObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["hidden", "data-state", "role", "open"],
		});
		restartCountdown();
		return () => {
			clearCountdown();
			recordUserInteractionRef.current = () => {};
			for (const eventName of interactionEventNames) {
				focusViewRoot.removeEventListener(eventName, restartCountdown, true);
			}
			document.removeEventListener("selectionchange", refreshSuspension);
			document.removeEventListener("focusin", refreshSuspension);
			document.removeEventListener("focusout", refreshSuspension);
			modalPresenceObserver.disconnect();
		};
	}, [enabled, focusedTaskIdentity, focusViewRootRef]);

	return { idleCollapseRequestSequenceNumber, recordUserInteraction };
}
