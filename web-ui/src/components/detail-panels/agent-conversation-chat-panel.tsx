import { AgentConversationThinkingIndicator } from "@/components/detail-panels/agent-conversation-thinking-indicator";
// 结构化会话的共享聊天面板，状态和操作由 controller hook 提供。

import { getRuntimeAgentCatalogEntry, resolveRuntimeAgentSessionTransportFromSummary } from "@runtime-agent-catalog";
import { canAgentSessionTransportBeSwitched } from "@runtime-agent-session-transport-selection";
import { BookmarkPlus, X } from "lucide-react";
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

import type { ResolveConversationAnchor } from "@/components/conversation-anchor/conversation-anchor-chip";
import {
	buildTurnBoundaryDerivationMemoKey,
	deriveTurnBoundariesFromChatMessages,
} from "@/components/conversation-tree/conversation-tree-model";
import { AgentConversationChatComposer } from "@/components/detail-panels/agent-conversation-chat-composer";
import { AgentConversationChatMessageItem } from "@/components/detail-panels/agent-conversation-chat-message-item";
import { AgentSessionTransportSwitchButton } from "@/components/detail-panels/agent-session-transport-switch-button";
import { TaskTerminalActionsMenu } from "@/components/detail-panels/task-terminal-actions-menu";
import { buildSaveFindingBodyPrefill, resolveSaveFindingTurnAnchor } from "@/components/findings/findings-model";
import { SaveFindingDialog } from "@/components/findings/save-finding-dialog";
import { useAgentConversationChatPanelController } from "@/hooks/use-agent-conversation-chat-panel-controller";
import type { AgentConversationChatActionResult } from "@/hooks/use-agent-conversation-chat-runtime-actions";
import type { AgentConversationChatMessage } from "@/hooks/use-agent-conversation-chat-session";
import { useSharedMobileFocusViewCollapsibleControls } from "@/hooks/use-mobile-focus-view-collapsible-controls";
import { useWindowedAgentChatMessageList } from "@/hooks/use-windowed-agent-chat-message-list";
import type {
	RuntimeAgentId,
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeExploratoryFindingEntry,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";
import type { AgentInputShortcutInsertionFocusHandle } from "@/utils/keyboard-focus-handoff-to-agent-entry";

const BOTTOM_LOCK_THRESHOLD_PX = 24;
export interface AgentConversationChatPanelHandle extends AgentInputShortcutInsertionFocusHandle {
	appendToDraft: (text: string, options?: { preserveInsertedTextBoundaryWhitespace?: boolean }) => void;
	sendText: (text: string) => Promise<void>;
}

export interface AgentConversationChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	// 当前结构化会话所属的 Agent，用于占位文案与通道切换。
	agentId?: RuntimeAgentId;
	taskColumnId?: string;
	defaultMode?: RuntimeTaskSessionMode;
	composerPlaceholder?: string;
	showComposerModeToggle?: boolean;
	workspaceId?: string | null;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: TaskImage[] },
	) => Promise<AgentConversationChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onResolveUserDecision?: (
		taskId: string,
		decisionId: string,
		optionId: string | null,
	) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<AgentConversationChatMessage[] | null>;
	incomingMessages?: AgentConversationChatMessage[] | null;
	incomingMessage?: AgentConversationChatMessage | null;
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
	// 由详情视图递增的「把键盘焦点接过去」请求信号，透传给 composer；key 不变就不重复抢焦。
	agentEntryKeyboardFocusRequestKey?: number;
	// Session Map 聊天内锚（蓝图 §C.2）：按 id 查服务端 map 集合的解析器与 chip 点击回调。
	// 不传则 marker 段不渲 chip（home 侧栏等无 map 集合上下文的面板走这条）。
	resolveConversationAnchor?: ResolveConversationAnchor | null;
	onConversationAnchorClick?: (anchorId: string) => void;
	// Exploratory findings（蓝图 §D.2.1）：workspace 级集合（查重提示用）+ 服务端 turn 投影
	// （锚三元 commit 解析用）。undefined = 无 findings 上下文（home 侧栏等），消息项不出
	// 「存为 finding」affordance；PTY 终端会话没有结构化消息项，本面板本就不渲染。
	exploratoryFindings?: RuntimeExploratoryFindingEntry[] | null;
	turnProjection?: RuntimeConversationSessionTurnProjectionResponse | null;
}

export const AgentConversationChatPanel = React.forwardRef<
	AgentConversationChatPanelHandle,
	AgentConversationChatPanelProps
>(function AgentConversationChatPanel(
	{
		taskId,
		summary,
		agentId = "omp",
		taskColumnId = "in_progress",
		defaultMode = "act",
		composerPlaceholder,
		showComposerModeToggle = true,
		agentEntryKeyboardFocusRequestKey,
		workspaceId = null,
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
		resolveConversationAnchor = null,
		onConversationAnchorClick,
		exploratoryFindings,
		turnProjection = null,
	},
	ref,
): ReactElement {
	const composerShortcutInputFocusHandleRef = useRef<AgentInputShortcutInsertionFocusHandle>(null);
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
	} = useAgentConversationChatPanelController({
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
	const mobileControls = useSharedMobileFocusViewCollapsibleControls();
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	// 只渲染最近一屏消息；滚到顶再回填。回填期间存住回填前的 scrollHeight 用于补偿滚动位置。
	const { visibleMessages, hiddenOlderMessageCount, revealOlderMessages } = useWindowedAgentChatMessageList({
		messages,
		resetWindowKey: taskId,
	});
	// turn → 消息的位置性定位锚（姊妹蓝图 §5.5 / exploratory 蓝图 §C.3）：每条消息所属的
	// 服务端投影 turn 号，渲染时挂成 DOM 锚 data-turn-anchor="T{n}"，供 map 面板远期
	// reveal-to-index 滚动定位。编号权威在服务端投影层，这里只做位置性映射；绝不用消息
	// id 做锚（id 重启即变），id 只在当次渲染期内查表。memo 键是粗粒度的（消息数,
	// 末条 id, 末条 content 长度）——reducer 每次 upsert 都换数组引用，不能按引用 memo。
	const turnBoundaryMemoKey = buildTurnBoundaryDerivationMemoKey(messages);
	const turnNumberByMessageId = useMemo(() => deriveTurnBoundariesFromChatMessages(messages), [turnBoundaryMemoKey]);
	// 「存为 finding」（蓝图 §D.2.1）：affordance 只出现在有 findings 上下文的宿主
	// （detail 视图传 exploratoryFindings；home 侧栏不传）。选区在 mousedown 时捕获
	// ——click 时浏览器已把选区坍缩掉；只有选区落在该消息元素内才作预填来源。
	const canSaveMessageAsFinding = Boolean(workspaceId) && exploratoryFindings !== undefined;
	const [saveFindingDraft, setSaveFindingDraft] = useState<{
		bodyMarkdown: string;
		turnNumber: number | undefined;
	} | null>(null);
	const pendingFindingSelectionTextRef = useRef<string | null>(null);
	const handleSaveFindingButtonMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
		const wrapperElement = event.currentTarget.parentElement;
		const selection = window.getSelection();
		const selectionText = selection && !selection.isCollapsed ? selection.toString() : "";
		const isSelectionInsideMessage =
			selection !== null &&
			wrapperElement !== null &&
			selection.anchorNode !== null &&
			selection.focusNode !== null &&
			wrapperElement.contains(selection.anchorNode) &&
			wrapperElement.contains(selection.focusNode);
		pendingFindingSelectionTextRef.current = isSelectionInsideMessage ? selectionText : null;
	};
	const handleOpenSaveFinding = (message: AgentConversationChatMessage, turnNumber: number | undefined) => {
		const bodyMarkdown = buildSaveFindingBodyPrefill({
			selectedText: pendingFindingSelectionTextRef.current,
			messageContent: message.content,
		});
		pendingFindingSelectionTextRef.current = null;
		if (bodyMarkdown.length === 0) {
			return;
		}
		setSaveFindingDraft({ bodyMarkdown, turnNumber });
	};
	const pendingOlderMessageBackfillScrollHeightRef = useRef<number | null>(null);
	// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
	const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
	const [composerError, setComposerError] = useState<string | null>(null);
	const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
	const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
		const persistedMode = modeByTaskIdRef.current.get(taskId);
		return persistedMode ?? summary?.mode ?? defaultMode;
	});
	const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
	const composerPlaceholderText =
		composerPlaceholder ?? `向 ${getRuntimeAgentCatalogEntry(agentId)?.label ?? "Agent"} 发送消息`;
	const panelError = composerError ?? error;
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

	const handleAppendToDraft = useCallback(
		(text: string, options?: { preserveInsertedTextBoundaryWhitespace?: boolean }) => {
			// Prompts 已补好前后换行，逐字追加才能保留边界和已有草稿。
			if (options?.preserveInsertedTextBoundaryWhitespace) {
				setDraft(`${draft}${text}`);
				return;
			}
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
			await handleSendText(text, mode);
		},
		[handleSendText, mode],
	);

	useImperativeHandle(
		ref,
		() => ({
			appendToDraft: handleAppendToDraft,
			sendText: handleSendComposerText,
			focusAgentInputAfterShortcutInsertion: () =>
				composerShortcutInputFocusHandleRef.current?.focusAgentInputAfterShortcutInsertion() ?? false,
		}),
		[handleAppendToDraft, handleSendComposerText],
	);

	const handleComposerSend = useCallback(async () => {
		const sent = await handleSendDraft(mode, draftImages);
		if (sent) {
			setDraftImages([]);
		}
	}, [draftImages, handleSendDraft, mode]);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{/* 会话级工具条。目前只承载「换通话通道」一个动作，故仅当该会话真能切换时才占一行高度
				    切换到 PTY 后显示 xterm 面板，该面板也提供相同的切换入口。 */}
			{summary &&
			canAgentSessionTransportBeSwitched(agentId ?? null) &&
			(!mobileControls?.isEnabled || mobileControls.upperNavigationAndToolsExpanded) ? (
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
			<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
					{visibleMessages.map((message) => {
						const turnNumber = turnNumberByMessageId.get(message.id);
						// 包装 div 承载 per-message DOM 锚（首个 turn 边界之前的旁白消息无 turn 不挂）。
						// user 消息的 ml-auto 右对齐在 block 级包装内照常生效（margin auto 不依赖 flex 上下文）。
						const isSaveableMessage =
							(message.role === "assistant" || message.role === "user") && message.content.trim().length > 0;
						return (
							<div
								key={message.id}
								data-turn-anchor={turnNumber !== undefined ? `T${turnNumber}` : undefined}
								className="group relative"
							>
								<AgentConversationChatMessageItem
									message={message}
									taskId={taskId}
									onResolveUserDecision={onResolveUserDecision}
									resolveConversationAnchor={resolveConversationAnchor}
									onConversationAnchorClick={onConversationAnchorClick}
								/>
								{canSaveMessageAsFinding && isSaveableMessage ? (
									<button
										type="button"
										title="Save as finding"
										aria-label="Save as finding"
										onMouseDown={handleSaveFindingButtonMouseDown}
										onClick={() => handleOpenSaveFinding(message, turnNumber)}
										className="absolute top-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface-2 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100 max-md:opacity-100"
									>
										<BookmarkPlus size={13} />
									</button>
								) : null}
							</div>
						);
					})}
					{showAgentProgressIndicator ? <AgentConversationThinkingIndicator /> : null}
				</div>
				{showActionFooter || showCancelAutomaticAction ? (
					<div className="absolute bottom-[max(0.5rem,env(safe-area-inset-bottom))] right-[max(0.5rem,env(safe-area-inset-right))] z-20 flex flex-col items-end gap-1">
						{showCancelAutomaticAction ? (
							<button
								type="button"
								aria-label={cancelAutomaticActionLabel ?? undefined}
								title={cancelAutomaticActionLabel ?? undefined}
								onClick={onCancelAutomaticAction}
								className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-bright bg-surface-2/80 px-2 text-xs text-text-primary hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent max-[769px]:h-11 max-[769px]:w-11 max-[769px]:px-0"
							>
								<X size={16} />
								<span className="max-[769px]:hidden">{cancelAutomaticActionLabel}</span>
							</button>
						) : null}
						<TaskTerminalActionsMenu
							key={JSON.stringify([workspaceId, taskId, taskColumnId, summary?.runtimeSessionIncarnationId])}
							taskId={taskId}
							taskColumnId={taskColumnId}
							onCommit={showReviewActions ? onCommit : undefined}
							onOpenPr={showReviewActions ? onOpenPr : undefined}
							isCommitLoading={isCommitLoading}
							isOpenPrLoading={isOpenPrLoading}
							onMoveToTrash={showMoveToTrash ? onMoveToTrash : undefined}
							onMoveToValidation={showMoveToValidation ? onMoveToValidation : undefined}
							isMoveToTrashLoading={isMoveToTrashLoading}
							isMoveToValidationLoading={isMoveToValidationLoading}
						/>
					</div>
				) : null}
			</div>
			{panelError ? (
				<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
					{panelError}
				</div>
			) : null}
			<div className="px-2 py-3">
				<AgentConversationChatComposer
					taskId={taskId}
					shortcutInputFocusHandleRef={composerShortcutInputFocusHandleRef}
					agentEntryKeyboardFocusRequestKey={agentEntryKeyboardFocusRequestKey}
					draft={draft}
					onDraftChange={setDraft}
					images={draftImages}
					onImagesChange={setDraftImages}
					placeholder={composerPlaceholderText}
					mode={mode}
					onModeChange={handleModeChange}
					showModeToggle={showComposerModeToggle}
					canSend={canSend}
					canCancel={canCancel}
					onSend={handleComposerSend}
					onCancel={handleCancelTurn}
					isSending={isSending}
					warningMessage={summary?.warningMessage ?? null}
					workspaceId={workspaceId}
				/>
			</div>
			{saveFindingDraft && workspaceId ? (
				<SaveFindingDialog
					openingRequestIdentity={saveFindingDraft}
					workspaceId={workspaceId}
					conversationSessionTaskId={taskId}
					// 锚三元在打开那一刻解析：turn 号来自位置性映射，commit 查投影 entries；
					// 映射不到 turn / 投影不可用 → null → 对话框按 freeform 降级（绝不伪造锚）。
					anchor={resolveSaveFindingTurnAnchor({
						turnNumber: saveFindingDraft.turnNumber,
						projection: turnProjection,
					})}
					initialBodyMarkdown={saveFindingDraft.bodyMarkdown}
					existingFindings={exploratoryFindings ?? []}
					onClose={() => setSaveFindingDraft(null)}
				/>
			) : null}
		</div>
	);
});

AgentConversationChatPanel.displayName = "AgentConversationChatPanel";
