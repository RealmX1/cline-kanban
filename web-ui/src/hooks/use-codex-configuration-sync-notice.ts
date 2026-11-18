import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { groupCodexConfigurationFeedbackSuggestions } from "@/hooks/codex-configuration-feedback-suggestion-groups";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationChange } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export function useCodexConfigurationSyncNotice({
	workspaceId,
	isPresentationAvailable = true,
}: {
	workspaceId: string | null;
	isPresentationAvailable?: boolean;
}) {
	const controller = useCodexConfigurationSync(workspaceId);
	const [expansionMode, setExpansionMode] = useState<"collapsed" | "manual" | "automatic">("collapsed");
	const [displayedChanges, setDisplayedChanges] = useState<CodexConfigurationChange[]>([]);
	const [presentationEnvironmentAvailable, setPresentationEnvironmentAvailable] = useState(true);
	const [, recheckTime] = useState(0);
	const presentationReceipts = useRef<Record<string, number>>({});
	const receiptStorageKey = LocalStorageKey.CodexConfigurationFeedbackNoticePresentationReceipts;
	const scopeIdentity = controller.state?.storageIdentity ?? workspaceId;
	useEffect(() => {
		try {
			presentationReceipts.current = JSON.parse(readLocalStorageItem(receiptStorageKey) ?? "{}");
		} catch {
			presentationReceipts.current = {};
		}
		setExpansionMode("collapsed");
		setDisplayedChanges([]);
		recheckTime((value) => value + 1);
	}, [receiptStorageKey, scopeIdentity]);
	const summaryButtonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const [mountedPanel, setMountedPanel] = useState<HTMLDivElement | null>(null);
	const bindPanelRef = useCallback((node: HTMLDivElement | null) => {
		panelRef.current = node;
		if (node) setMountedPanel((current) => (current === node ? current : node));
	}, []);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const readingPositionRef = useRef(0);
	const shouldFocusPanelOnExpansionRef = useRef(false);
	const contentId = useId();
	const candidateIdentity = (change: CodexConfigurationChange) =>
		JSON.stringify([
			scopeIdentity,
			change.changeId,
			change.completeCandidateValueDigest ?? change.valueSummary,
			change.observedAt,
		]);
	const nowMs = Date.now();
	const settingsReminders = (controller.state?.changes ?? [])
		.filter(
			(change) =>
				((change.recordKind === "settings_proposal" && change.approvalStatus === "pending") ||
					(change.changeSharingScope !== undefined && change.noticePresentedAtMs === undefined)) &&
				change.settingsIsolationArchivedAtMs === undefined &&
				(change.feedbackExpiresAtMs === undefined || change.feedbackExpiresAtMs > nowMs),
		)
		.sort((left, right) => right.observedAt - left.observedAt || right.changeId.localeCompare(left.changeId));
	const latestChanges = useRef(settingsReminders);
	latestChanges.current = settingsReminders;
	const pendingApprovalCount =
		groupCodexConfigurationFeedbackSuggestions(settingsReminders).length +
		settingsReminders.filter((change) => change.changeSharingScope && change.approvalStatus !== "pending").length;
	const sourceUpdateCount =
		controller.state?.sourceObservations.filter((observation) => observation.acknowledgedAt === null).length ?? 0;
	const hasReminders = Boolean(controller.state || controller.error);
	const isVisible = isPresentationAvailable && presentationEnvironmentAvailable && expansionMode !== "collapsed";
	const isOperationPending = controller.pendingChangeId !== null;
	const batchIdentity = JSON.stringify(settingsReminders.map(candidateIdentity).sort());
	const displayedBatchIdentity = JSON.stringify(displayedChanges.map(candidateIdentity).sort());
	const hasNewSuggestions =
		batchIdentity !== displayedBatchIdentity &&
		settingsReminders.some(
			(change) => !displayedChanges.some((shown) => candidateIdentity(shown) === candidateIdentity(change)),
		);
	const acknowledgePresentation = useCallback(
		(changes: CodexConfigurationChange[]) => {
			const receipts = Object.fromEntries(
				Object.entries(presentationReceipts.current).filter(
					([, expiry]) => typeof expiry === "number" && expiry > Date.now(),
				),
			);
			for (const change of changes)
				receipts[
					JSON.stringify([
						scopeIdentity,
						change.changeId,
						change.completeCandidateValueDigest ?? change.valueSummary,
						change.observedAt,
					])
				] = change.feedbackExpiresAtMs ?? change.observedAt + 600_000;
			presentationReceipts.current = receipts;
			writeLocalStorageItem(receiptStorageKey, JSON.stringify(receipts));
			void controller.markNoticePresented?.(changes);
		},
		[scopeIdentity, receiptStorageKey, controller.markNoticePresented],
	);
	useEffect(() => {
		const check = () =>
			setPresentationEnvironmentAvailable(
				document.visibilityState === "visible" &&
					document.querySelector(
						"[role='dialog']:not([data-codex-configuration-feedback-popover]):not([hidden]):not([data-state='closed']), [role='alertdialog']:not([hidden]):not([data-state='closed']), dialog[open]",
					) === null,
			);
		check();
		document.addEventListener("visibilitychange", check);
		const observer = new MutationObserver(check);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["hidden", "data-state", "role", "open"],
		});
		return () => {
			document.removeEventListener("visibilitychange", check);
			observer.disconnect();
		};
	}, []);
	useEffect(() => {
		const deadlines = latestChanges.current.flatMap((change) =>
			change.feedbackExpiresAtMs === undefined ? [] : [change.feedbackExpiresAtMs],
		);
		if (!deadlines.length) return;
		const timer = window.setTimeout(
			() => recheckTime((value) => value + 1),
			Math.max(1, Math.min(...deadlines) - Date.now() + 1),
		);
		return () => window.clearTimeout(timer);
	}, [batchIdentity]);
	useEffect(() => {
		if (expansionMode !== "collapsed" || !isPresentationAvailable || !presentationEnvironmentAvailable) return;
		const candidates = latestChanges.current.filter(
			(change) =>
				(change.changeSharingScope || change.acknowledgedAt === null) &&
				!presentationReceipts.current[candidateIdentity(change)],
		);
		if (!candidates.length) return;
		const stableAtMs = Math.max(...latestChanges.current.map((change) => change.observedAt)) + 10_000;
		const open = () => {
			const changes = latestChanges.current.filter(
				(change) => change.feedbackExpiresAtMs === undefined || change.feedbackExpiresAtMs > Date.now(),
			);
			if (!changes.length) return;
			setDisplayedChanges(changes);
			setExpansionMode("automatic");
		};
		if (stableAtMs <= Date.now()) {
			open();
			return;
		}
		const timer = window.setTimeout(open, stableAtMs - Date.now());
		return () => window.clearTimeout(timer);
	}, [
		batchIdentity,
		scopeIdentity,
		expansionMode,
		isPresentationAvailable,
		presentationEnvironmentAvailable,
		acknowledgePresentation,
		nowMs,
	]);
	const recordReadingPosition = useCallback(() => {
		if (scrollContainerRef.current && !panelRef.current?.hidden)
			readingPositionRef.current = scrollContainerRef.current.scrollTop;
	}, []);
	const collapse = useCallback(
		(restoreSummaryFocus: boolean) => {
			recordReadingPosition();
			shouldFocusPanelOnExpansionRef.current = false;
			setExpansionMode("collapsed");
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
		setDisplayedChanges(latestChanges.current);
		setExpansionMode("manual");
	};
	useLayoutEffect(() => {
		if (!isVisible) return;
		if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = readingPositionRef.current;
		const panel = mountedPanel ?? panelRef.current;
		if (shouldFocusPanelOnExpansionRef.current && panel) {
			shouldFocusPanelOnExpansionRef.current = false;
			panel.focus({ preventScroll: true });
		}
	}, [isVisible, mountedPanel]);
	useEffect(() => {
		const panel = mountedPanel ?? panelRef.current;
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
					"[role='dialog']:not([data-codex-configuration-feedback-popover]):not([hidden]):not([data-state='closed']), [role='alertdialog']:not([hidden]):not([data-state='closed']), dialog[open]",
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
			}, 30_000);
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
	}, [isVisible, expansionMode, isOperationPending, collapse, mountedPanel]);
	return {
		controller,
		displayedChanges,
		hasNewSuggestions,
		showLatestSuggestions: () => {
			setDisplayedChanges(latestChanges.current);
		},
		acknowledgeRenderedChanges: acknowledgePresentation,
		contentId,
		hasReminders,
		pendingApprovalCount,
		sourceUpdateCount,
		isExpanded: expansionMode !== "collapsed",
		isVisible,
		summaryButtonRef,
		panelRef,
		bindPanelRef,
		scrollContainerRef,
		recordReadingPosition,
		toggleExpanded,
		closeAndRestoreSummaryFocus: () => collapse(true),
		closeForSettings: () => collapse(false),
	};
}

export type CodexConfigurationSyncNoticePresentation = ReturnType<typeof useCodexConfigurationSyncNotice>;
