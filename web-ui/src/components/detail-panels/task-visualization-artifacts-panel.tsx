import { ExternalLink, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import { buildExpandedForegroundViewUrl } from "@/expanded-foreground-view/expanded-foreground-view-navigation";
import { ExpandedForegroundViewSurface } from "@/expanded-foreground-view/expanded-foreground-view-surface";
import { useExpandedForegroundViewSurface } from "@/expanded-foreground-view/use-expanded-foreground-view-surface";
import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
import type { useTaskVisualizationArtifacts } from "@/hooks/use-task-visualization-artifacts";
import { prepareTaskVisualizationPreview } from "@/runtime/task-visualization-query";

export function TaskVisualizationArtifactsPanel({
	workspaceId,
	taskId,
	controller,
	onClosePreview,
	taskIncarnationCreatedAtEpochMs,
	detachedForeground = false,
	initialSelection,
}: {
	workspaceId: string | null;
	taskId: string;
	controller: ReturnType<typeof useTaskVisualizationArtifacts>;
	onClosePreview?: () => void;
	taskIncarnationCreatedAtEpochMs?: number;
	detachedForeground?: boolean;
	initialSelection?: { visualizationArtifactId: string; revisionId?: string };
}) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const activePreparedPreview = useRef<{
		prepared: Awaited<ReturnType<typeof prepareTaskVisualizationPreview>>;
		selectionRequestKey: number;
	} | null>(null);
	const contentLoadTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const selectorRef = useRef<HTMLSelectElement>(null);
	const [isPanelIntersecting, setIsPanelIntersecting] = useState(false);
	const [isDocumentForeground, setIsDocumentForeground] = useState(
		() => document.visibilityState === "visible" && document.hasFocus(),
	);
	const [preparationRequestKey, setPreparationRequestKey] = useState<number | null>(null);
	const [prepared, setPrepared] = useState<
		(Awaited<ReturnType<typeof prepareTaskVisualizationPreview>> & { preparedSelectionRequestKey: number }) | null
	>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [isPreparing, setIsPreparing] = useState(false);
	const navigation = useExpandedForegroundViewNavigation();
	const selection = controller.selection;
	const { visualizationArtifactId, revisionId, selectionRequestKey } = selection ?? {};
	const selectedArtifact = controller.artifacts.find(
		(artifact) => artifact.visualizationArtifactId === visualizationArtifactId,
	);
	const target = useMemo(
		() =>
			workspaceId && taskIncarnationCreatedAtEpochMs !== undefined
				? {
						viewKind: "task_visualization" as const,
						workspaceId,
						taskId,
						taskIncarnationCreatedAtEpochMs,
						visualizationArtifactId,
						revisionId:
							revisionId ??
							(prepared && prepared.artifact.visualizationArtifactId === visualizationArtifactId
								? prepared.artifact.revisionId
								: undefined),
					}
				: null,
		[
			workspaceId,
			taskId,
			taskIncarnationCreatedAtEpochMs,
			visualizationArtifactId,
			revisionId,
			prepared?.artifact.visualizationArtifactId,
			prepared?.artifact.revisionId,
		],
	);
	const surface = useExpandedForegroundViewSurface(target, detachedForeground);
	const panelRef = surface.elementRef;
	const isExpanded = surface.isExpanded;
	const preparedForNavigationRef = useRef(prepared);
	preparedForNavigationRef.current = prepared;
	const collapseForegroundRef = useRef(surface.close);
	collapseForegroundRef.current = () => {
		if (surface.isExpanded) surface.close();
	};
	const [hasAlignedExpandedSelection, setHasAlignedExpandedSelection] = useState(false);
	const [alignedInitialSelectionKey, setAlignedInitialSelectionKey] = useState<string | null>(null);
	const initialSelectionKey = JSON.stringify([workspaceId, taskId, initialSelection]);
	const requestedInitialSelection =
		initialSelection && alignedInitialSelectionKey !== initialSelectionKey
			? initialSelection
			: isExpanded && !hasAlignedExpandedSelection && navigation?.target?.viewKind === "task_visualization"
				? navigation.target
				: null;
	const isActiveForegroundPanel = isPanelIntersecting && isDocumentForeground && (!navigation?.target || isExpanded);
	const needsInitialSelectionAlignment =
		requestedInitialSelection?.visualizationArtifactId !== undefined &&
		(requestedInitialSelection.visualizationArtifactId !== visualizationArtifactId ||
			(requestedInitialSelection.revisionId !== undefined && requestedInitialSelection.revisionId !== revisionId));
	const initialSelectionError =
		requestedInitialSelection?.visualizationArtifactId !== undefined &&
		!controller.isLoading &&
		!controller.error &&
		!controller.artifacts.some(
			(artifact) => artifact.visualizationArtifactId === requestedInitialSelection.visualizationArtifactId,
		)
			? "未找到链接指定的可视化产物。"
			: null;
	const canPrepareSelection =
		selectionRequestKey !== undefined &&
		preparationRequestKey === selectionRequestKey &&
		!needsInitialSelectionAlignment;
	useEffect(() => {
		const receiveNavigation = (event: MessageEvent) => {
			const active = activePreparedPreview.current;
			const current = preparedForNavigationRef.current;
			if (
				current &&
				event.source === iframeRef.current?.contentWindow &&
				event.origin === "null" &&
				event.data?.type === "kanban_visualization_request_collapse_foreground_view" &&
				event.data.contentLoadConfirmationId === current.contentLoadConfirmationId &&
				event.data.workspaceId === current.artifact.workspaceId &&
				event.data.taskId === current.artifact.taskId &&
				event.data.visualizationArtifactId === current.artifact.visualizationArtifactId &&
				event.data.revisionId === current.artifact.revisionId
			)
				collapseForegroundRef.current();
			if (
				active &&
				event.source === iframeRef.current?.contentWindow &&
				event.origin === "null" &&
				event.data?.type === "kanban_visualization_content_loaded" &&
				typeof active.prepared.contentLoadConfirmationId === "string" &&
				event.data.contentLoadConfirmationId === active.prepared.contentLoadConfirmationId &&
				event.data.workspaceId === active.prepared.artifact.workspaceId &&
				event.data.taskId === active.prepared.artifact.taskId &&
				event.data.visualizationArtifactId === active.prepared.artifact.visualizationArtifactId &&
				event.data.revisionId === active.prepared.artifact.revisionId
			) {
				if (contentLoadTimeout.current) clearTimeout(contentLoadTimeout.current);
				contentLoadTimeout.current = null;
				setIsPreparing(false);
				activePreparedPreview.current = null;
				controller.acknowledgeRenderedPreview(active.prepared.artifact, active.selectionRequestKey);
			}
			if (
				event.source === iframeRef.current?.contentWindow &&
				event.origin === "null" &&
				event.data?.type === "kanban_visualization_request_artifact_selector"
			)
				selectorRef.current?.focus();
		};
		window.addEventListener("message", receiveNavigation);
		return () => window.removeEventListener("message", receiveNavigation);
	}, [controller.acknowledgeRenderedPreview]);
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel || typeof IntersectionObserver === "undefined") {
			setIsPanelIntersecting(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			const latestPanelIntersectionEntry = entries.at(-1);
			if (latestPanelIntersectionEntry) setIsPanelIntersecting(latestPanelIntersectionEntry.isIntersecting);
		});
		observer.observe(panel);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const updateForeground = () =>
			setIsDocumentForeground(document.visibilityState === "visible" && document.hasFocus());
		document.addEventListener("visibilitychange", updateForeground);
		window.addEventListener("focus", updateForeground);
		window.addEventListener("blur", updateForeground);
		return () => {
			document.removeEventListener("visibilitychange", updateForeground);
			window.removeEventListener("focus", updateForeground);
			window.removeEventListener("blur", updateForeground);
		};
	}, []);
	useEffect(() => {
		setHasAlignedExpandedSelection(false);
	}, [workspaceId, taskId, isExpanded]);
	useEffect(() => {
		if (!isActiveForegroundPanel) return;
		if (requestedInitialSelection?.visualizationArtifactId !== undefined) {
			if (controller.isLoading || controller.error) return;
			const artifact = controller.artifacts.find(
				(entry) => entry.visualizationArtifactId === requestedInitialSelection.visualizationArtifactId,
			);
			if (!artifact) return;
			setAlignedInitialSelectionKey(initialSelectionKey);
			setHasAlignedExpandedSelection(true);
			if (needsInitialSelectionAlignment)
				controller.selectArtifact({
					...artifact,
					revisionId: requestedInitialSelection.revisionId ?? artifact.revisionId,
				});
			return;
		}
		if (isExpanded) setHasAlignedExpandedSelection(true);
		controller.ensureDefaultSelection();
	}, [
		isActiveForegroundPanel,
		isExpanded,
		requestedInitialSelection,
		needsInitialSelectionAlignment,
		initialSelectionKey,
		controller.artifacts,
		controller.isLoading,
		controller.error,
		controller.selectArtifact,
		controller.ensureDefaultSelection,
	]);
	useEffect(() => {
		if (isActiveForegroundPanel && !needsInitialSelectionAlignment && selection)
			setPreparationRequestKey(selection.selectionRequestKey);
	}, [isActiveForegroundPanel, needsInitialSelectionAlignment, selection]);
	useEffect(() => {
		activePreparedPreview.current = null;
		setPrepared(null);
		setPreviewError(null);
		setIsPreparing(false);
		if (!workspaceId || !visualizationArtifactId || !canPrepareSelection) return;
		const abort = new AbortController();
		setIsPreparing(true);
		const failPreview = (reason: string) => {
			abort.abort();
			activePreparedPreview.current = null;
			setPrepared(null);
			setPreviewError(reason);
			setIsPreparing(false);
			controller.failAutomaticPreview(selectionRequestKey, reason);
		};
		contentLoadTimeout.current = setTimeout(() => failPreview("内容未在 30 秒内确认成功加载，请重试预览。"), 30_000);
		void prepareTaskVisualizationPreview(workspaceId, taskId, visualizationArtifactId, revisionId, abort.signal).then(
			(result) => {
				if (!abort.signal.aborted) {
					activePreparedPreview.current = { prepared: result, selectionRequestKey: selectionRequestKey ?? 0 };
					setPrepared({ ...result, preparedSelectionRequestKey: selectionRequestKey ?? 0 });
				}
			},
			(error: unknown) => {
				if (!abort.signal.aborted) {
					if (contentLoadTimeout.current) clearTimeout(contentLoadTimeout.current);
					contentLoadTimeout.current = null;
					failPreview(error instanceof Error ? error.message : String(error));
				}
			},
		);
		return () => {
			abort.abort();
			activePreparedPreview.current = null;
			if (contentLoadTimeout.current) clearTimeout(contentLoadTimeout.current);
			contentLoadTimeout.current = null;
		};
	}, [
		workspaceId,
		taskId,
		visualizationArtifactId,
		revisionId,
		selectionRequestKey,
		canPrepareSelection,
		controller.failAutomaticPreview,
	]);
	useEffect(() => {
		if (!isExpanded || !hasAlignedExpandedSelection) return;
		if (!target || !navigation || navigation.target?.viewKind !== "task_visualization") return;
		if (!target.visualizationArtifactId) return;
		if (
			navigation.target.visualizationArtifactId !== target.visualizationArtifactId ||
			navigation.target.revisionId !== target.revisionId
		)
			navigation.open(target, navigation.ownerSurfaceId ?? undefined);
	}, [isExpanded, hasAlignedExpandedSelection, target, navigation]);
	const validPrepared =
		prepared?.artifact.workspaceId === workspaceId &&
		prepared.artifact.taskId === taskId &&
		prepared.artifact.visualizationArtifactId === visualizationArtifactId &&
		prepared.preparedSelectionRequestKey === selectionRequestKey
			? prepared
			: null;
	const hasNewRevision =
		validPrepared && selectedArtifact && validPrepared.artifact.revisionId !== selectedArtifact.revisionId;
	const attribution = controller.taskAttribution ?? validPrepared?.taskAttribution;
	const taskTitle =
		attribution?.workspaceId === workspaceId && attribution.taskId === taskId ? attribution.taskTitle : null;
	const selectArtifactFromPanel = (artifact: (typeof controller.artifacts)[number]) => {
		setAlignedInitialSelectionKey(initialSelectionKey);
		setHasAlignedExpandedSelection(isExpanded);
		controller.selectArtifact(artifact);
	};
	return (
		<ExpandedForegroundViewSurface
			controller={surface}
			title="任务可视化"
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-1"
		>
			<div
				role="note"
				aria-label="可视化任务署名"
				data-verification-anchor={`task-visualization-task-attribution:${workspaceId}:${taskId}`}
				className="flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border px-3 py-2 text-xs"
			>
				<span className="shrink-0 text-text-secondary">
					任务 <code className="select-text text-text-primary">{taskId}</code>
				</span>
				<span className="min-w-0 break-words text-text-primary">{taskTitle ?? "任务名暂不可用"}</span>
			</div>
			<div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
				<select
					ref={selectorRef}
					aria-label="选择可视化"
					className="h-7 min-w-0 flex-1 rounded-sm bg-surface-2 px-2 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
					value={visualizationArtifactId ?? ""}
					onChange={(event) => {
						const artifact = controller.artifacts.find(
							(entry) => entry.visualizationArtifactId === event.target.value,
						);
						if (artifact) selectArtifactFromPanel(artifact);
					}}
				>
					<option value="" disabled>
						选择可视化
					</option>
					{controller.artifacts.map((artifact) => (
						<option key={artifact.visualizationArtifactId} value={artifact.visualizationArtifactId}>
							{artifact.title} · 第 {artifact.versionNumber} 版
						</option>
					))}
				</select>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2"
					aria-label={selectedArtifact ? "重新加载可视化" : "刷新可视化清单"}
					onClick={() => {
						void controller.refreshArtifacts();
						if (selectedArtifact) selectArtifactFromPanel(selectedArtifact);
					}}
				>
					<RefreshCw size={14} />
				</Button>
				{validPrepared ? (
					<a
						href={
							target && workspaceId
								? buildExpandedForegroundViewUrl(buildProjectTaskDeepLinkUrl(workspaceId, taskId), {
										...target,
										revisionId: validPrepared.artifact.revisionId,
									})
								: validPrepared.viewerRelativeUrl
						}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex h-7 items-center gap-1 rounded-sm px-2 text-xs text-text-primary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
					>
						<ExternalLink size={14} />
						新标签
					</a>
				) : null}
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2"
					aria-label={isExpanded ? "退出全屏预览" : "全屏预览"}
					onClick={isExpanded ? surface.close : surface.open}
				>
					{isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
				</Button>
				{onClosePreview ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2"
						aria-label="收起可视化预览"
						onClick={() => {
							if (isExpanded) surface.close();
							onClosePreview();
						}}
					>
						<X size={14} />
					</Button>
				) : null}
			</div>
			{controller.error ? (
				<div
					role="alert"
					className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-status-red"
				>
					<span>清单暂不可用：{controller.error}</span>
					<Button variant="ghost" size="sm" onClick={() => void controller.refreshArtifacts()}>
						重试
					</Button>
				</div>
			) : null}
			{hasNewRevision && selectedArtifact ? (
				<div
					role="status"
					className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-1 text-xs"
				>
					<span>
						当前第 {validPrepared?.artifact.versionNumber} 版，第 {selectedArtifact.versionNumber} 版已就绪
					</span>
					<Button variant="ghost" size="sm" onClick={() => selectArtifactFromPanel(selectedArtifact)}>
						加载最新版本
					</Button>
				</div>
			) : null}
			{initialSelectionError || previewError || controller.automaticPreviewError ? (
				<div role="alert" className="p-3 text-sm text-status-red">
					预览暂不可用：{initialSelectionError ?? previewError ?? controller.automaticPreviewError}
					<Button
						variant="ghost"
						size="sm"
						onClick={() =>
							initialSelectionError
								? void controller.refreshArtifacts()
								: selectedArtifact
									? selectArtifactFromPanel(selectedArtifact)
									: controller.retryDefaultSelection()
						}
					>
						重试预览
					</Button>
				</div>
			) : null}
			{isPreparing ? (
				<p role="status" className="p-3 text-sm text-text-secondary">
					正在读取可视化…
				</p>
			) : null}
			{validPrepared ? (
				<iframe
					ref={iframeRef}
					key={`${validPrepared.artifact.revisionId}:${selectionRequestKey}`}
					title={validPrepared.artifact.title}
					src={validPrepared.contentRelativeUrl}
					sandbox="allow-scripts allow-downloads"
					referrerPolicy="no-referrer"
					className="min-h-0 w-full flex-1 border-0 bg-white"
				/>
			) : !isPreparing && !previewError && !initialSelectionError && !controller.automaticPreviewError ? (
				<div className="flex min-h-0 flex-1 flex-col justify-center gap-2 p-4 text-sm text-text-secondary">
					<p>
						{controller.isLoading
							? "正在读取可视化清单…"
							: controller.artifacts.length
								? "选择一个可视化开始查看。"
								: "此任务还没有已发布的可视化。"}
					</p>
					{!controller.isLoading && controller.artifacts.length === 0 ? (
						<p className="text-xs">Agent 生成的 HTML 发布后会显示在这里。</p>
					) : null}
				</div>
			) : null}
		</ExpandedForegroundViewSurface>
	);
}
