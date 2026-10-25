import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTaskVisualizationArtifacts } from "@/runtime/task-visualization-query";
import type { TaskVisualizationArtifact, TaskVisualizationPreviewRequestedMessage } from "@/runtime/types";
import {
	acknowledgeTaskVisualizationPreview,
	declareTaskVisualizationBrowserContext,
	readTaskVisualizationBrowserPageId,
	subscribeToTaskVisualizationBrowserEvents,
	wasTaskVisualizationPreviewDismissed,
	wasTaskVisualizationPreviewDisplayed,
} from "@/stores/task-visualization-browser-bridge";

export interface TaskVisualizationSelection {
	visualizationArtifactId: string;
	revisionId?: string;
	selectionRequestKey: number;
}

export function useTaskVisualizationArtifacts({
	workspaceId,
	taskId,
	observeBrowser = true,
	onAutomaticPreview,
	isAutomaticPreviewForegroundEligible = true,
}: {
	workspaceId: string | null;
	taskId: string;
	observeBrowser?: boolean;
	onAutomaticPreview?: () => void;
	isAutomaticPreviewForegroundEligible?: boolean;
}) {
	const identity = JSON.stringify([workspaceId, taskId]);
	const activeIdentity = useRef(identity);
	activeIdentity.current = identity;
	const [state, setState] = useState<{
		identity: string;
		artifacts: TaskVisualizationArtifact[];
		isLoading: boolean;
		error: string | null;
	}>({ identity, artifacts: [], isLoading: true, error: null });
	const [selectionState, setSelection] = useState<{ identity: string; selection: TaskVisualizationSelection | null }>({
		identity,
		selection: null,
	});
	const activeQuery = useRef<AbortController | null>(null);
	const automaticPreview = useRef<TaskVisualizationPreviewRequestedMessage | null>(null);
	const observeBrowserRef = useRef(observeBrowser);
	observeBrowserRef.current = observeBrowser;
	const automaticPreviewForegroundEligibleRef = useRef(isAutomaticPreviewForegroundEligible);
	automaticPreviewForegroundEligibleRef.current = isAutomaticPreviewForegroundEligible;
	const selectionRequestSequence = useRef(0);
	const isDefaultSelectionSuppressed = useRef(false);
	const failedDeliveryAttemptIds = useRef(new Set<string>());
	const pendingFailure = useRef<{ message: TaskVisualizationPreviewRequestedMessage; reason: string } | null>(null);
	const [automaticPreviewError, setAutomaticPreviewError] = useState<string | null>(null);
	const failAutomaticPreview = useCallback(
		(selectionRequestKey: number | undefined, reason: string) => {
			const message = automaticPreview.current;
			if (
				activeIdentity.current !== identity ||
				!message ||
				(selectionRequestKey !== undefined && selectionRequestKey !== selectionRequestSequence.current)
			)
				return;
			failedDeliveryAttemptIds.current.add(message.deliveryAttemptId);
			isDefaultSelectionSuppressed.current = true;
			pendingFailure.current = { message, reason };
			automaticPreview.current = null;
			setAutomaticPreviewError(reason);
			setSelection({ identity, selection: null });
		},
		[identity],
	);
	// passive effect 在旧 iframe 从 DOM 移除后才释放接受权，改派不会与旧页面并存。
	useEffect(() => {
		if ((selectionState.identity === identity && selectionState.selection !== null) || !pendingFailure.current)
			return;
		const failure = pendingFailure.current;
		pendingFailure.current = null;
		acknowledgeTaskVisualizationPreview(failure.message, "failed", failure.reason);
	}, [identity, selectionState]);
	const onAutomaticPreviewRef = useRef(onAutomaticPreview);
	onAutomaticPreviewRef.current = onAutomaticPreview;
	useEffect(() => {
		if (!workspaceId || !observeBrowser) return;
		declareTaskVisualizationBrowserContext(
			workspaceId,
			taskId,
			isAutomaticPreviewForegroundEligible && document.visibilityState === "visible" && document.hasFocus(),
		);
		if (!isAutomaticPreviewForegroundEligible && automaticPreview.current)
			failAutomaticPreview(undefined, "已切换到其他前台视图，自动预览已取消。");
	}, [workspaceId, taskId, observeBrowser, isAutomaticPreviewForegroundEligible, failAutomaticPreview]);
	const refreshArtifacts = useCallback(async () => {
		if (activeIdentity.current !== identity) return;
		activeQuery.current?.abort();
		if (!workspaceId) {
			setState({ identity, artifacts: [], isLoading: false, error: null });
			return;
		}
		const query = new AbortController();
		activeQuery.current = query;
		setState((current) => ({
			identity,
			artifacts: current.identity === identity ? current.artifacts : [],
			isLoading: true,
			error: null,
		}));
		try {
			const result = await fetchTaskVisualizationArtifacts(workspaceId, taskId, query.signal);
			if (!query.signal.aborted) {
				setState({ identity, artifacts: result.artifacts, isLoading: false, error: null });
				if (result.latestPreviewRequest?.failedAtMs !== undefined)
					setAutomaticPreviewError(
						result.latestPreviewRequest.deliveryFailureReason ?? "自动预览未完成，请手动选择产物重试。",
					);
			}
		} catch (error) {
			if (!query.signal.aborted)
				setState((current) => ({
					...current,
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				}));
		}
	}, [workspaceId, taskId, identity]);
	useEffect(() => {
		automaticPreview.current = null;
		failedDeliveryAttemptIds.current.clear();
		isDefaultSelectionSuppressed.current = false;
		setAutomaticPreviewError(null);
		setSelection({ identity, selection: null });
	}, [identity]);
	useEffect(() => {
		void refreshArtifacts();
		const unsubscribe = subscribeToTaskVisualizationBrowserEvents((message) => {
			if (message.workspaceId !== workspaceId) return;
			if (message.type === "stream_disconnected") {
				failAutomaticPreview(undefined, "连接中断，已取消自动预览，请手动重试。");
				return;
			}
			if (message.type === "stream_reconnected") {
				void refreshArtifacts();
				return;
			}
			if (message.taskId !== taskId) return;
			if (message.type === "task_visualization_artifacts_updated") {
				void refreshArtifacts();
				return;
			}
			if (!observeBrowser || message.browserPageId !== readTaskVisualizationBrowserPageId()) return;
			const currentDelivery = automaticPreview.current;
			const matchesCurrentDelivery =
				currentDelivery?.deliveryAttemptId === message.deliveryAttemptId &&
				currentDelivery.previewRequest.previewRequestId === message.previewRequest.previewRequestId &&
				currentDelivery.previewRequest.visualizationArtifactId === message.previewRequest.visualizationArtifactId &&
				currentDelivery.previewRequest.revisionId === message.previewRequest.revisionId;
			if (message.deliveryState === "cancelled") {
				if (matchesCurrentDelivery)
					failAutomaticPreview(undefined, message.deliveryFailureReason ?? "自动预览已取消。");
				return;
			}
			if (wasTaskVisualizationPreviewDismissed(message.previewRequest.previewRequestId)) {
				acknowledgeTaskVisualizationPreview(message, "dismissed");
				return;
			}
			if (message.deliveryState === "offered") {
				if (failedDeliveryAttemptIds.current.has(message.deliveryAttemptId)) {
					acknowledgeTaskVisualizationPreview(message, "failed", "该投递已取消并卸载，忽略迟到重放。");
					return;
				}
				if (matchesCurrentDelivery && currentDelivery?.deliveryState === "accepted") {
					acknowledgeTaskVisualizationPreview(currentDelivery, "accepted");
					return;
				}
				if (
					!automaticPreviewForegroundEligibleRef.current ||
					document.visibilityState !== "visible" ||
					!document.hasFocus()
				) {
					acknowledgeTaskVisualizationPreview(message, "declined");
					return;
				}
				if (automaticPreview.current && automaticPreview.current.deliveryAttemptId !== message.deliveryAttemptId)
					acknowledgeTaskVisualizationPreview(automaticPreview.current, "dismissed");
				automaticPreview.current = message;
				acknowledgeTaskVisualizationPreview(message, "accepted");
				return;
			}
			if (
				!matchesCurrentDelivery ||
				currentDelivery?.deliveryState !== "offered" ||
				failedDeliveryAttemptIds.current.has(message.deliveryAttemptId)
			)
				return;
			if (wasTaskVisualizationPreviewDisplayed(message.previewRequest.previewRequestId)) {
				acknowledgeTaskVisualizationPreview(message, "displayed");
				automaticPreview.current = null;
				return;
			}
			automaticPreview.current = message;
			if (document.visibilityState !== "visible" || !document.hasFocus()) {
				failAutomaticPreview(undefined, "页面已转入后台，已取消自动预览。");
				return;
			}
			setAutomaticPreviewError(null);
			isDefaultSelectionSuppressed.current = false;
			setSelection({
				identity,
				selection: {
					visualizationArtifactId: message.previewRequest.visualizationArtifactId,
					revisionId: message.previewRequest.revisionId,
					selectionRequestKey: ++selectionRequestSequence.current,
				},
			});
			void refreshArtifacts();
			onAutomaticPreviewRef.current?.();
		});
		if (!workspaceId || !observeBrowser)
			return () => {
				unsubscribe();
				activeQuery.current?.abort();
			};
		const declare = (hasInteraction = false) =>
			declareTaskVisualizationBrowserContext(
				workspaceId,
				taskId,
				automaticPreviewForegroundEligibleRef.current &&
					document.visibilityState === "visible" &&
					document.hasFocus(),
				hasInteraction,
			);
		const onInteraction = () => declare(true);
		const onVisibility = () => declare(false);
		declare(true);
		document.addEventListener("pointerdown", onInteraction, true);
		document.addEventListener("keydown", onInteraction, true);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("focus", onInteraction);
		window.addEventListener("blur", onVisibility);
		const heartbeat = window.setInterval(onVisibility, 10_000);
		return () => {
			unsubscribe();
			if (automaticPreview.current) {
				if (activeIdentity.current === identity && observeBrowserRef.current !== observeBrowser)
					failAutomaticPreview(undefined, "页面已停止接收自动预览，请手动重试。");
				else {
					acknowledgeTaskVisualizationPreview(
						automaticPreview.current,
						"failed",
						"页面已离开当前任务，已卸载预览。",
					);
					automaticPreview.current = null;
				}
			}
			activeQuery.current?.abort();
			window.clearInterval(heartbeat);
			document.removeEventListener("pointerdown", onInteraction, true);
			document.removeEventListener("keydown", onInteraction, true);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("focus", onInteraction);
			window.removeEventListener("blur", onVisibility);
			declareTaskVisualizationBrowserContext(workspaceId, null, false);
		};
	}, [workspaceId, taskId, identity, observeBrowser, refreshArtifacts, failAutomaticPreview]);
	const selectArtifact = useCallback(
		(artifact: TaskVisualizationArtifact) => {
			if (activeIdentity.current !== identity || artifact.workspaceId !== workspaceId || artifact.taskId !== taskId)
				return;
			if (automaticPreview.current) acknowledgeTaskVisualizationPreview(automaticPreview.current, "dismissed");
			automaticPreview.current = null;
			isDefaultSelectionSuppressed.current = false;
			setAutomaticPreviewError(null);
			setSelection({
				identity,
				selection: {
					visualizationArtifactId: artifact.visualizationArtifactId,
					revisionId: artifact.revisionId,
					selectionRequestKey: ++selectionRequestSequence.current,
				},
			});
		},
		[identity, workspaceId, taskId],
	);
	const ensureDefaultSelection = useCallback(() => {
		if (
			activeIdentity.current !== identity ||
			state.identity !== identity ||
			state.isLoading ||
			state.error ||
			isDefaultSelectionSuppressed.current ||
			automaticPreview.current ||
			pendingFailure.current
		)
			return;
		const newestArtifact = [...state.artifacts].sort(
			(left, right) =>
				right.publishedAtMs - left.publishedAtMs ||
				left.visualizationArtifactId.localeCompare(right.visualizationArtifactId),
		)[0];
		if (!newestArtifact) return;
		setSelection((current) => {
			if (
				current.identity === identity &&
				state.artifacts.some(
					(artifact) => artifact.visualizationArtifactId === current.selection?.visualizationArtifactId,
				)
			)
				return current;
			return {
				identity,
				selection: {
					visualizationArtifactId: newestArtifact.visualizationArtifactId,
					revisionId: newestArtifact.revisionId,
					selectionRequestKey: ++selectionRequestSequence.current,
				},
			};
		});
	}, [identity, state]);
	const retryDefaultSelection = useCallback(() => {
		if (activeIdentity.current !== identity) return;
		isDefaultSelectionSuppressed.current = false;
		setAutomaticPreviewError(null);
		ensureDefaultSelection();
	}, [identity, ensureDefaultSelection]);
	const acknowledgeRenderedPreview = useCallback(
		(artifact: TaskVisualizationArtifact, selectionRequestKey: number) => {
			if (
				!automaticPreview.current ||
				automaticPreview.current.deliveryState !== "accepted" ||
				selectionRequestKey !== selectionRequestSequence.current
			)
				return;
			const request = automaticPreview.current;
			if (
				artifact.workspaceId !== request.workspaceId ||
				artifact.taskId !== request.taskId ||
				artifact.visualizationArtifactId !== request.previewRequest.visualizationArtifactId ||
				artifact.revisionId !== request.previewRequest.revisionId
			)
				return;
			if (
				!automaticPreviewForegroundEligibleRef.current ||
				document.visibilityState !== "visible" ||
				!document.hasFocus()
			) {
				failAutomaticPreview(selectionRequestKey, "页面已转入后台，已取消自动预览。");
				return;
			}
			acknowledgeTaskVisualizationPreview(automaticPreview.current, "displayed");
			automaticPreview.current = null;
		},
		[failAutomaticPreview],
	);
	const dismissAutomaticPreview = useCallback(() => {
		if (!automaticPreview.current) return;
		acknowledgeTaskVisualizationPreview(automaticPreview.current, "dismissed");
		automaticPreview.current = null;
	}, []);
	return {
		artifacts: state.identity === identity ? state.artifacts : [],
		isLoading: state.identity !== identity || state.isLoading,
		error: state.identity === identity ? state.error : null,
		selection: selectionState.identity === identity ? selectionState.selection : null,
		refreshArtifacts,
		selectArtifact,
		ensureDefaultSelection,
		retryDefaultSelection,
		acknowledgeRenderedPreview,
		failAutomaticPreview,
		automaticPreviewError,
		dismissAutomaticPreview,
	};
}
