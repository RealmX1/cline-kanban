import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import { WORKSPACE_NOTICE_AUTOMATIC_EXPANSION_DURATION_MS } from "@/hooks/workspace-notice-automatic-expansion-duration";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export function useCodexConfigurationSyncNotice({
	workspaceId,
	isPresentationAvailable = true,
}: {
	workspaceId: string | null;
	isPresentationAvailable?: boolean;
}) {
	const controller = useCodexConfigurationSync(workspaceId);
	const [expansionMode, setExpansionMode] = useState<"collapsed" | "manual" | "automatic">(() => {
		const saved = readLocalStorageItem(LocalStorageKey.CodexConfigurationChangeNoticeCollapsed);
		return saved === "true" ? "collapsed" : saved === "false" ? "manual" : "automatic";
	});
	const summaryButtonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const readingPositionRef = useRef(0);
	const shouldFocusPanelOnExpansionRef = useRef(false);
	const contentId = useId();
	const settingsReminders =
		controller.state?.changes.filter(
			(change) =>
				change.recordKind === "settings_proposal" &&
				change.acknowledgedAt === null &&
				(change.feedbackExpiresAtMs === undefined || change.feedbackExpiresAtMs > Date.now()),
		) ?? [];
	const pendingApprovalCount = settingsReminders.filter((change) => change.approvalStatus === "pending").length;
	const sourceUpdateCount =
		controller.state?.sourceObservations.filter((observation) => observation.acknowledgedAt === null).length ?? 0;
	const hasReminders = settingsReminders.length + sourceUpdateCount > 0;
	const isVisible = hasReminders && isPresentationAvailable && expansionMode !== "collapsed";
	const isOperationPending =
		controller.pendingChangeId !== null ||
		Object.values(controller.sourceOperations).some((operation) => operation.phase !== "unknown");
	const recordReadingPosition = useCallback(() => {
		if (scrollContainerRef.current && !panelRef.current?.hidden)
			readingPositionRef.current = scrollContainerRef.current.scrollTop;
	}, []);
	const collapse = useCallback(
		(restoreSummaryFocus: boolean) => {
			recordReadingPosition();
			shouldFocusPanelOnExpansionRef.current = false;
			setExpansionMode("collapsed");
			writeLocalStorageItem(LocalStorageKey.CodexConfigurationChangeNoticeCollapsed, "true");
			if (restoreSummaryFocus) summaryButtonRef.current?.focus({ preventScroll: true });
		},
		[recordReadingPosition],
	);
	const toggleExpanded = (fromKeyboard: boolean) => {
		if (expansionMode !== "collapsed") {
			collapse(false);
			return;
		}
		shouldFocusPanelOnExpansionRef.current = fromKeyboard;
		setExpansionMode("manual");
		writeLocalStorageItem(LocalStorageKey.CodexConfigurationChangeNoticeCollapsed, "false");
	};
	useLayoutEffect(() => {
		if (!isVisible) return;
		if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = readingPositionRef.current;
		if (shouldFocusPanelOnExpansionRef.current) {
			shouldFocusPanelOnExpansionRef.current = false;
			panelRef.current?.focus({ preventScroll: true });
		}
	}, [isVisible]);
	useEffect(() => {
		const panel = panelRef.current;
		if (!isVisible || expansionMode !== "automatic" || !panel || isOperationPending) return;
		const interactionListenersAbortController = new window.AbortController();
		const listenerOptions = { signal: interactionListenersAbortController.signal, passive: true };
		let timer: number | null = null;
		let pointerIsInside = panel.matches(":hover");
		let touchIsActive = false;
		const isProtected = () => {
			const selection = document.getSelection();
			return (
				document.visibilityState !== "visible" ||
				pointerIsInside ||
				touchIsActive ||
				panel.contains(document.activeElement) ||
				Boolean(selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(panel)) ||
				document.querySelector(
					"[role='dialog']:not([hidden]):not([data-state='closed']), [role='alertdialog']:not([hidden]):not([data-state='closed']), dialog[open]",
				) !== null
			);
		};
		let protectedFromCollapse = isProtected();
		const clearCountdown = () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
		};
		const restartCountdown = () => {
			clearCountdown();
			protectedFromCollapse = isProtected();
			if (protectedFromCollapse) return;
			timer = window.setTimeout(() => {
				timer = null;
				protectedFromCollapse = isProtected();
				if (!protectedFromCollapse) collapse(false);
			}, WORKSPACE_NOTICE_AUTOMATIC_EXPANSION_DURATION_MS);
		};
		const refreshProtection = () => {
			if (isProtected() !== protectedFromCollapse) restartCountdown();
		};
		const onPointerPresenceChange = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			pointerIsInside = event.type === "pointerenter";
			restartCountdown();
		};
		const updateActiveTouchProtection = (event: TouchEvent) => {
			if (event.type !== "touchstart" && !touchIsActive) return;
			touchIsActive = event.type === "touchstart";
			restartCountdown();
		};
		for (const eventName of ["pointerenter", "pointerleave"] as const)
			panel.addEventListener(eventName, onPointerPresenceChange, listenerOptions);
		panel.addEventListener("touchstart", updateActiveTouchProtection, listenerOptions);
		for (const eventName of ["touchend", "touchcancel"] as const)
			document.addEventListener(eventName, updateActiveTouchProtection, listenerOptions);
		for (const eventName of ["scroll", "wheel", "touchmove", "pointerdown", "keydown", "input"] as const)
			panel.addEventListener(eventName, restartCountdown, { ...listenerOptions, capture: true });
		for (const eventName of ["selectionchange", "focusin", "focusout", "visibilitychange"] as const)
			document.addEventListener(eventName, refreshProtection, listenerOptions);
		// 元数据重绘不续期；确认弹窗出现或消失时才重新核对保护状态。
		const confirmationObserver = new MutationObserver(refreshProtection);
		confirmationObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["hidden", "data-state", "role", "open"],
		});
		restartCountdown();
		return () => {
			clearCountdown();
			interactionListenersAbortController.abort();
			confirmationObserver.disconnect();
		};
	}, [isVisible, expansionMode, isOperationPending, collapse]);
	return {
		controller,
		contentId,
		hasReminders,
		pendingApprovalCount,
		sourceUpdateCount,
		isExpanded: expansionMode !== "collapsed",
		isVisible,
		summaryButtonRef,
		panelRef,
		scrollContainerRef,
		recordReadingPosition,
		toggleExpanded,
		closeAndRestoreSummaryFocus: () => collapse(true),
		closeForSettings: () => collapse(false),
	};
}

export type CodexConfigurationSyncNoticePresentation = ReturnType<typeof useCodexConfigurationSyncNotice>;
