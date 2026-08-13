// Layout component for the native Cline chat panel.
// Rendering lives here, while session state and action wiring come from the
// controller hook so multiple surfaces can share the same behavior.

import {
	getRuntimeAgentCatalogEntry,
	isRuntimeAgentModelSelectedThroughClineProviderSettings,
	resolveRuntimeAgentSessionTransportFromSummary,
} from "@runtime-agent-catalog";
import { canAgentSessionTransportBeSwitched } from "@runtime-agent-session-transport-selection";
import { AlertTriangle } from "lucide-react";
import React, {
	type ReactElement,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

// 距顶多少像素以内算「滚到顶了」，触发回填。留一点余量：滚动惯性与子像素误差常让 scrollTop 停在 0 之上。
const OLDER_MESSAGE_BACKFILL_SCROLL_TOP_THRESHOLD_PX = 48;

import { AgentSessionTransportSwitchButton } from "@/components/detail-panels/agent-session-transport-switch-button";
import { ClineChatComposer } from "@/components/detail-panels/cline-chat-composer";
import { ClineChatMessageItem } from "@/components/detail-panels/cline-chat-message-item";
import {
	buildClineAgentModelPickerOptions,
	buildClineSelectedModelButtonText,
	getClineReasoningEnabledModelIds,
} from "@/components/detail-panels/cline-model-picker-options";
import { ClineThinkingIndicator } from "@/components/detail-panels/cline-thinking-indicator";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Spinner } from "@/components/ui/spinner";
import { useClineChatPanelController } from "@/hooks/use-cline-chat-panel-controller";
import type { ClineChatActionResult } from "@/hooks/use-cline-chat-runtime-actions";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";
import { useRuntimeSettingsClineController } from "@/hooks/use-runtime-settings-cline-controller";
import { useWindowedAgentChatMessageList } from "@/hooks/use-windowed-agent-chat-message-list";
import type {
	RuntimeAgentId,
	RuntimeClineReasoningEffort,
	RuntimeConfigResponse,
	RuntimeTaskClineSettings,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

const BOTTOM_LOCK_THRESHOLD_PX = 24;
const CLINE_BUY_CREDITS_URL = "https://app.cline.bot/";
const NATIVE_CLINE_SESSION_COMPOSER_PLACEHOLDER = "Ask Cline to add, edit, start, or link tasks";

const ClineCreditLimitNotice = React.memo(function ClineCreditLimitNotice() {
	return (
		<div className="mx-1 flex items-start gap-2 rounded-md border border-status-orange/40 bg-status-orange/10 px-3 py-2 text-xs text-status-orange">
			<AlertTriangle size={14} className="mt-0.5 shrink-0" />
			<p className="m-0 min-w-0">
				Out of Cline credits.{" "}
				<Link href={CLINE_BUY_CREDITS_URL} external>
					Buy more credits
				</Link>{" "}
				to continue.
			</p>
		</div>
	);
});

export interface ClineAgentChatPanelHandle {
	appendToDraft: (text: string) => void;
	sendText: (text: string) => Promise<void>;
}

export interface ClineAgentChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	// 该会话真正跑的 agent。这个面板服务所有「结构化消息」传输形态（进程内 Cline SDK 与
	// ACP 子进程），只有原生 Cline SDK 会话才该显示并保存 Cline provider / 模型设置。
	agentId?: RuntimeAgentId;
	taskColumnId?: string;
	defaultMode?: RuntimeTaskSessionMode;
	composerPlaceholder?: string;
	showComposerModeToggle?: boolean;
	workspaceId?: string | null;
	runtimeConfig?: RuntimeConfigResponse | null;
	taskClineSettings?: RuntimeTaskClineSettings;
	taskHasExplicitClineSettings?: boolean;
	onClineSettingsSaved?: () => void;
	onTaskClineSettingsChanged?: (settings: {
		providerId: string;
		modelId: string;
		reasoningEffort: RuntimeClineReasoningEffort | "";
	}) => void;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: TaskImage[] },
	) => Promise<ClineChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onResolveUserDecision?: (
		taskId: string,
		decisionId: string,
		optionId: string | null,
	) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessages?: ClineChatMessage[] | null;
	incomingMessage?: ClineChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onMoveToValidation?: () => void;
	isMoveToValidationLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
	showMoveToValidation?: boolean;
}

export const ClineAgentChatPanel = React.forwardRef<ClineAgentChatPanelHandle, ClineAgentChatPanelProps>(
	function ClineAgentChatPanel(
		{
			taskId,
			summary,
			agentId = "cline",
			taskColumnId = "in_progress",
			defaultMode = "act",
			composerPlaceholder,
			showComposerModeToggle = true,
			workspaceId = null,
			runtimeConfig = null,
			taskClineSettings,
			taskHasExplicitClineSettings = false,
			onClineSettingsSaved,
			onTaskClineSettingsChanged,
			onSendMessage,
			onCancelTurn,
			onResolveUserDecision,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			isCommitLoading = false,
			isOpenPrLoading = false,
			onMoveToTrash,
			isMoveToTrashLoading = false,
			onMoveToValidation,
			isMoveToValidationLoading = false,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash = false,
			showMoveToValidation = false,
		},
		ref,
	): ReactElement {
		const {
			draft,
			setDraft,
			messages,
			error,
			isSending,
			canSend,
			canCancel,
			showReviewActions,
			showAgentProgressIndicator,
			showActionFooter,
			showCancelAutomaticAction,
			handleSendText,
			handleSendDraft,
			handleCancelTurn,
		} = useClineChatPanelController({
			taskId,
			summary,
			taskColumnId,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			onMoveToTrash,
			onMoveToValidation,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash,
			showMoveToValidation,
		});
		const scrollContainerRef = useRef<HTMLDivElement | null>(null);
		// 只渲染最近一屏消息；滚到顶再回填。回填期间存住回填前的 scrollHeight 用于补偿滚动位置。
		const { visibleMessages, hiddenOlderMessageCount, revealOlderMessages } = useWindowedAgentChatMessageList({
			messages,
			resetWindowKey: taskId,
		});
		const pendingOlderMessageBackfillScrollHeightRef = useRef<number | null>(null);
		// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
		const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
		const [composerError, setComposerError] = useState<string | null>(null);
		const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
		const [isSavingModel, setIsSavingModel] = useState(false);
		const isCreditLimitNoticeVisible = summary?.latestHookActivity?.notificationType === "credit_limit";
		const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			return persistedMode ?? summary?.mode ?? defaultMode;
		});
		const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
		// ACP agent（omp）复用这套会话布局，但它的模型由 agent 自己管：对它显示 Cline provider 模型
		// 选择器不仅无效，选中还会把全局 Cline provider 设置改掉。故 Cline 专属控件按会话传输形态开关，
		// 关闭时连 provider catalog / 模型列表都不去拉。
		const isClineProviderModelSelectionApplicable = isRuntimeAgentModelSelectedThroughClineProviderSettings(agentId);
		const clineSettings = useRuntimeSettingsClineController({
			open: isClineProviderModelSelectionApplicable,
			workspaceId,
			selectedAgentId: agentId,
			config: runtimeConfig,
			taskClineSettings,
		});
		const composerPlaceholderText =
			composerPlaceholder ??
			(isClineProviderModelSelectionApplicable
				? NATIVE_CLINE_SESSION_COMPOSER_PLACEHOLDER
				: `Ask ${getRuntimeAgentCatalogEntry(agentId)?.label ?? "the agent"} to work on this task`);

		const modelPickerOptions = useMemo(
			() => buildClineAgentModelPickerOptions(clineSettings.providerId, clineSettings.providerModels),
			[clineSettings.providerId, clineSettings.providerModels],
		);
		const modelOptions = modelPickerOptions.options;

		const selectedModel = useMemo(
			() => clineSettings.providerModels.find((model) => model.id === clineSettings.modelId) ?? null,
			[clineSettings.modelId, clineSettings.providerModels],
		);
		const reasoningEnabledModelIds = useMemo(
			() => getClineReasoningEnabledModelIds(clineSettings.providerModels),
			[clineSettings.providerModels],
		);

		const selectedModelButtonText = useMemo(
			() =>
				buildClineSelectedModelButtonText({
					modelOptions,
					selectedModelId: clineSettings.modelId,
					reasoningEffort: clineSettings.reasoningEffort,
					showReasoningEffort: clineSettings.selectedModelSupportsReasoningEffort,
					isModelLoading: clineSettings.isLoadingProviderModels,
					isModelSaving: isSavingModel,
				}),
			[
				clineSettings.isLoadingProviderModels,
				clineSettings.modelId,
				clineSettings.reasoningEffort,
				clineSettings.selectedModelSupportsReasoningEffort,
				isSavingModel,
				modelOptions,
			],
		);

		const panelError = composerError ?? error;
		const attachmentWarningMessage =
			draftImages.length > 0 && selectedModel?.supportsVision === false
				? "The selected Cline model may not accept image input. Choose a vision-capable model to use these images."
				: null;

		const isPinnedToBottom = useCallback((container: HTMLDivElement): boolean => {
			const remainingDistance = container.scrollHeight - container.scrollTop - container.clientHeight;
			return remainingDistance <= BOTTOM_LOCK_THRESHOLD_PX;
		}, []);

		const handleMessageListScroll = useCallback(() => {
			const container = scrollContainerRef.current;
			if (!container) {
				return;
			}
			const nextIsAutoScrollEnabled = isPinnedToBottom(container);
			setIsAutoScrollEnabled((currentValue) =>
				currentValue === nextIsAutoScrollEnabled ? currentValue : nextIsAutoScrollEnabled,
			);
			// 滚到顶部即回填一屏更早的消息。记下回填前的 scrollHeight，下一次布局里按增量把 scrollTop 顶回去，
			// 否则新插入的内容会把用户正在看的那段推走（视觉上是「自己往下跳了一屏」）。
			if (
				hiddenOlderMessageCount > 0 &&
				container.scrollTop <= OLDER_MESSAGE_BACKFILL_SCROLL_TOP_THRESHOLD_PX &&
				pendingOlderMessageBackfillScrollHeightRef.current === null
			) {
				pendingOlderMessageBackfillScrollHeightRef.current = container.scrollHeight;
				revealOlderMessages();
			}
		}, [hiddenOlderMessageCount, isPinnedToBottom, revealOlderMessages]);

		// 回填后按 scrollHeight 增量补偿滚动位置。放在 layout effect 里，用户看不到中间帧。
		useLayoutEffect(() => {
			const container = scrollContainerRef.current;
			const scrollHeightBeforeBackfill = pendingOlderMessageBackfillScrollHeightRef.current;
			if (!container || scrollHeightBeforeBackfill === null) {
				return;
			}
			pendingOlderMessageBackfillScrollHeightRef.current = null;
			container.scrollTop += container.scrollHeight - scrollHeightBeforeBackfill;
		}, [visibleMessages]);

		useLayoutEffect(() => {
			const container = scrollContainerRef.current;
			if (!container || !isAutoScrollEnabled) {
				return;
			}
			container.scrollTop = container.scrollHeight;
		}, [
			isAutoScrollEnabled,
			visibleMessages,
			showAgentProgressIndicator,
			showActionFooter,
			showReviewActions,
			showCancelAutomaticAction,
		]);

		useEffect(() => {
			setComposerError(null);
		}, [taskId]);

		useEffect(() => {
			setIsAutoScrollEnabled(true);
		}, [taskId]);

		useEffect(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			const nextMode = persistedMode ?? summary?.mode ?? defaultMode;
			modeByTaskIdRef.current.set(taskId, nextMode);
			setMode(nextMode);
			setDraftImages([]);
		}, [defaultMode, summary?.mode, taskId]);

		const handleModeChange = useCallback(
			(nextMode: RuntimeTaskSessionMode) => {
				modeByTaskIdRef.current.set(taskId, nextMode);
				setMode(nextMode);
			},
			[taskId],
		);

		type PersistClineModelSettingsOverrides = {
			modelId?: string;
			reasoningEffort?: RuntimeClineReasoningEffort | "";
		};

		const persistClineModelSettings = useCallback(
			async (overrides?: PersistClineModelSettingsOverrides): Promise<boolean> => {
				// 非原生 Cline SDK 会话（ACP agent）没有可保存的 Cline 模型设置：这里必须直接放行，
				// 既不写全局 Cline provider 配置，也不能因为「有未保存改动」把发送流程堵住。
				if (!isClineProviderModelSelectionApplicable) {
					return true;
				}
				if (!workspaceId) {
					setComposerError("Select a workspace before choosing a Cline model.");
					return false;
				}
				if (clineSettings.providerId.trim().length === 0) {
					setComposerError("Choose a Cline provider in Settings before selecting a model.");
					return false;
				}
				setComposerError(null);
				setIsSavingModel(true);
				try {
					const nextModelId = overrides?.modelId ?? clineSettings.modelId;
					const nextReasoningEffort =
						overrides && "reasoningEffort" in overrides
							? overrides.reasoningEffort || ""
							: clineSettings.reasoningEffort;
					if (taskHasExplicitClineSettings) {
						onTaskClineSettingsChanged?.({
							providerId: clineSettings.providerId,
							modelId: nextModelId,
							reasoningEffort: nextReasoningEffort,
						});
						return true;
					}
					const result = await clineSettings.saveProviderSettings({
						modelId: nextModelId,
						reasoningEffort: nextReasoningEffort || null,
					});
					if (!result.ok) {
						setComposerError(result.message ?? "Could not save Cline model settings.");
						return false;
					}
					onClineSettingsSaved?.();
					return true;
				} finally {
					setIsSavingModel(false);
				}
			},
			[
				clineSettings,
				isClineProviderModelSelectionApplicable,
				onClineSettingsSaved,
				onTaskClineSettingsChanged,
				taskHasExplicitClineSettings,
				workspaceId,
			],
		);

		const handleSelectModel = useCallback(
			(nextModelId: string) => {
				if (nextModelId.trim() === clineSettings.modelId.trim()) {
					return;
				}
				clineSettings.setModelId(nextModelId);
				void persistClineModelSettings({ modelId: nextModelId });
			},
			[clineSettings.modelId, clineSettings.setModelId, persistClineModelSettings],
		);

		const handleSelectReasoningEffort = useCallback(
			(nextReasoningEffort: RuntimeClineReasoningEffort | "") => {
				if (nextReasoningEffort === clineSettings.reasoningEffort) {
					return;
				}
				clineSettings.setReasoningEffort(nextReasoningEffort);
				void persistClineModelSettings({ reasoningEffort: nextReasoningEffort });
			},
			[clineSettings.reasoningEffort, clineSettings.setReasoningEffort, persistClineModelSettings],
		);

		const handleAppendToDraft = useCallback(
			(text: string) => {
				const trimmed = text.trim();
				if (trimmed.length === 0) {
					return;
				}
				if (draft.trim().length === 0) {
					setDraft(trimmed);
					return;
				}
				setDraft(`${draft.trimEnd()}\n\n${trimmed}`);
			},
			[draft, setDraft],
		);

		const handleSendComposerText = useCallback(
			async (text: string): Promise<void> => {
				if (isSavingModel) {
					return;
				}
				if (clineSettings.hasUnsavedChanges) {
					const saved = await persistClineModelSettings();
					if (!saved) {
						return;
					}
				}
				await handleSendText(text, mode);
			},
			[clineSettings.hasUnsavedChanges, handleSendText, isSavingModel, mode, persistClineModelSettings],
		);

		useImperativeHandle(
			ref,
			() => ({
				appendToDraft: handleAppendToDraft,
				sendText: handleSendComposerText,
			}),
			[handleAppendToDraft, handleSendComposerText],
		);

		const handleComposerSend = useCallback(async () => {
			if (isSavingModel) {
				return;
			}
			if (clineSettings.hasUnsavedChanges) {
				const saved = await persistClineModelSettings();
				if (!saved) {
					return;
				}
			}
			const sent = await handleSendDraft(mode, draftImages);
			if (sent) {
				setDraftImages([]);
			}
		}, [
			clineSettings.hasUnsavedChanges,
			draftImages,
			handleSendDraft,
			isSavingModel,
			mode,
			persistClineModelSettings,
		]);

		return (
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* 会话级工具条。目前只承载「换通话通道」一个动作，故仅当该会话真能切换时才占一行高度
				    （Cline SDK 会话上整行不渲染）。切过去看到的是 xterm 面板，所以那边也挂了同一个按钮。 */}
				{summary && canAgentSessionTransportBeSwitched(agentId ?? null) ? (
					<div className="flex items-center justify-end gap-1 px-2 pt-2">
						<AgentSessionTransportSwitchButton
							workspaceId={workspaceId}
							taskId={taskId}
							agentId={agentId ?? null}
							currentSessionTransport={resolveRuntimeAgentSessionTransportFromSummary(summary)}
							iconSize={12}
							variant="ghost"
						/>
					</div>
				) : null}
				<div
					ref={scrollContainerRef}
					className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-3"
					onScroll={handleMessageListScroll}
				>
					{hiddenOlderMessageCount > 0 ? (
						<button
							type="button"
							onClick={() => {
								const container = scrollContainerRef.current;
								if (container && pendingOlderMessageBackfillScrollHeightRef.current === null) {
									pendingOlderMessageBackfillScrollHeightRef.current = container.scrollHeight;
								}
								revealOlderMessages();
							}}
							className="mx-auto rounded px-2 py-1 text-center text-xs text-fg-muted hover:text-fg-default"
						>
							{`Show ${hiddenOlderMessageCount} earlier message${hiddenOlderMessageCount === 1 ? "" : "s"}`}
						</button>
					) : null}
					{visibleMessages.map((message) => (
						<ClineChatMessageItem
							key={message.id}
							message={message}
							taskId={taskId}
							onResolveUserDecision={onResolveUserDecision}
						/>
					))}
					{showAgentProgressIndicator ? <ClineThinkingIndicator /> : null}
					{isCreditLimitNoticeVisible ? <ClineCreditLimitNotice /> : null}
				</div>
				{panelError ? (
					<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
						{panelError}
					</div>
				) : null}
				<div className="px-2 py-3">
					<ClineChatComposer
						taskId={taskId}
						draft={draft}
						onDraftChange={setDraft}
						images={draftImages}
						onImagesChange={setDraftImages}
						placeholder={composerPlaceholderText}
						showClineProviderControls={isClineProviderModelSelectionApplicable}
						mode={mode}
						onModeChange={handleModeChange}
						showModeToggle={showComposerModeToggle}
						canSend={canSend}
						canCancel={canCancel}
						onSend={handleComposerSend}
						onCancel={handleCancelTurn}
						modelOptions={modelOptions}
						recommendedModelIds={modelPickerOptions.recommendedModelIds}
						pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
						selectedModelId={clineSettings.modelId}
						selectedModelButtonText={selectedModelButtonText}
						onSelectModel={handleSelectModel}
						reasoningEnabledModelIds={reasoningEnabledModelIds}
						selectedReasoningEffort={clineSettings.reasoningEffort}
						onSelectReasoningEffort={handleSelectReasoningEffort}
						isModelLoading={clineSettings.isLoadingProviderModels}
						isModelSaving={isSavingModel}
						modelPickerDisabled={isSavingModel || clineSettings.providerId.trim().length === 0}
						isSending={isSavingModel || isSending}
						warningMessage={summary?.warningMessage ?? null}
						attachmentWarningMessage={attachmentWarningMessage}
						workspaceId={workspaceId}
					/>
				</div>
				{showActionFooter ? (
					<div className="flex flex-col gap-2 px-3 pb-3">
						{showReviewActions ? (
							<div className="flex gap-2">
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onCommit}
								>
									{isCommitLoading ? "..." : "Commit"}
								</Button>
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onOpenPr}
								>
									{isOpenPrLoading ? "..." : "Open PR"}
								</Button>
							</div>
						) : null}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<Button variant="default" fill onClick={onCancelAutomaticAction}>
								{cancelAutomaticActionLabel}
							</Button>
						) : null}
						{showMoveToValidation && onMoveToValidation ? (
							<Button variant="primary" fill disabled={isMoveToValidationLoading} onClick={onMoveToValidation}>
								{isMoveToValidationLoading ? <Spinner size={14} /> : "Move Card To Validation"}
							</Button>
						) : null}
						{showMoveToTrash && onMoveToTrash ? (
							<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
								{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
							</Button>
						) : null}
					</div>
				) : null}
			</div>
		);
	},
);

ClineAgentChatPanel.displayName = "ClineAgentChatPanel";
