import { AlertTriangle, ArrowBigUp, Command, Paperclip, Pause, SendHorizontal } from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactElement,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	type ActiveAgentConversationComposerToken,
	type AgentConversationComposerCompletionSuggestion,
	applyAgentConversationComposerCompletion,
	buildMentionInsertText,
	detectActiveAgentConversationComposerToken,
} from "@/components/detail-panels/agent-conversation-chat-composer-completion";
import { type InlineCompletionItem, InlineCompletionPicker } from "@/components/inline-completion-picker";
import {
	ACCEPTED_TASK_IMAGE_INPUT_ACCEPT,
	collectImageFilesFromDataTransfer,
	extractImagesFromDataTransfer,
	fileToTaskImage,
} from "@/components/task-image-input-utils";
import { TaskImageStrip } from "@/components/task-image-strip";
import { TaskPromptPseudoHtmlBlockInsertControl } from "@/components/task-prompt-pseudo-html-block-insert-control";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useAgentPromptPseudoHtmlBlockInsertion } from "@/hooks/use-agent-prompt-pseudo-html-block-insertion";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionMode } from "@/runtime/types";
import type { TaskImage } from "@/types";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import {
	type AgentInputShortcutInsertionFocusHandle,
	shouldHandOffKeyboardFocusToAgentEntryNow,
} from "@/utils/keyboard-focus-handoff-to-agent-entry";
import { isMacPlatform } from "@/utils/platform";
import { useDebouncedEffect } from "@/utils/react-use";

const AGENT_CONVERSATION_CHAT_COMPOSER_MAX_HEIGHT = 160;
const AGENT_CONVERSATION_CHAT_COMPOSER_COMPLETION_DEBOUNCE_MS = 120;
const AGENT_CONVERSATION_CHAT_COMPOSER_FILE_LIMIT = 8;

export function AgentConversationChatComposer({
	taskId,
	agentEntryKeyboardFocusRequestKey,
	shortcutInputFocusHandleRef,
	draft,
	onDraftChange,
	images = [],
	onImagesChange,
	placeholder,
	mode,
	onModeChange,
	showModeToggle = true,
	canSend,
	canCancel,
	onSend,
	onCancel,
	isSending = false,
	warningMessage = null,
	attachmentWarningMessage = null,
	workspaceId = null,
}: {
	taskId: string;
	// 递增即表示「请把键盘焦点接过去」。key 不变就不重跑，所以不会重复抢焦；
	// 请求到达时输入框可能还禁用着（`canSend` 尚未翻 true），此时请求保持挂起、待其可用再兑现。
	agentEntryKeyboardFocusRequestKey?: number;
	shortcutInputFocusHandleRef?: Ref<AgentInputShortcutInsertionFocusHandle>;
	draft: string;
	onDraftChange: (draft: string) => void;
	images?: TaskImage[];
	onImagesChange?: (images: TaskImage[]) => void;
	placeholder: string;
	mode: RuntimeTaskSessionMode;
	onModeChange: (mode: RuntimeTaskSessionMode) => void;
	showModeToggle?: boolean;
	canSend: boolean;
	canCancel: boolean;
	onSend: () => void | Promise<void>;
	onCancel: () => void;
	isSending?: boolean;
	warningMessage?: string | null;
	attachmentWarningMessage?: string | null;
	workspaceId?: string | null;
}): ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const latestImagesRef = useRef(images);
	latestImagesRef.current = images;
	const imageFileInputRef = useRef<HTMLInputElement | null>(null);
	const blockInsertion = useAgentPromptPseudoHtmlBlockInsertion({
		textareaRef,
		value: draft,
		onValueChange: onDraftChange,
	});
	const handledAgentEntryKeyboardFocusRequestKeyRef = useRef(agentEntryKeyboardFocusRequestKey);
	const mentionSearchRequestIdRef = useRef(0);
	const [isDragOver, setIsDragOver] = useState(false);
	const [cursorIndex, setCursorIndex] = useState(() => draft.length);
	const [isCompletionPickerOpen, setIsCompletionPickerOpen] = useState(true);
	const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
	const [mentionSuggestions, setMentionSuggestions] = useState<AgentConversationComposerCompletionSuggestion[]>([]);
	const [isMentionSearchLoading, setIsMentionSearchLoading] = useState(false);
	const canSubmit = canSend && (draft.trim().length > 0 || images.length > 0);
	useImperativeHandle(
		shortcutInputFocusHandleRef,
		() => ({
			focusAgentInputAfterShortcutInsertion: () => {
				const textarea = textareaRef.current;
				if (!canSend || !textarea?.isConnected || textarea.disabled) return false;
				// 用户已明确选择填入，手机端也在点击调用栈内聚焦，以保留唤起软键盘的机会。
				textarea.focus();
				textarea.setSelectionRange(textarea.value.length, textarea.value.length);
				setCursorIndex(textarea.value.length);
				blockInsertion.rememberSelection(textarea);
				return textarea.ownerDocument.activeElement === textarea;
			},
		}),
		[canSend, blockInsertion.rememberSelection],
	);

	const activeToken = useMemo(() => {
		const detectedToken = detectActiveAgentConversationComposerToken(draft, cursorIndex);
		// `@` 补全引用当前工作区文件。
		if (detectedToken?.kind === "slash") {
			return null;
		}
		return detectedToken;
	}, [cursorIndex, draft]);
	const completionSuggestions = useMemo(() => {
		if (!activeToken) {
			return [] as AgentConversationComposerCompletionSuggestion[];
		}
		return mentionSuggestions;
	}, [activeToken, mentionSuggestions]);
	const completionItems: InlineCompletionItem[] = useMemo(
		() => completionSuggestions.map((s) => ({ id: s.id, label: s.label, detail: s.detail })),
		[completionSuggestions],
	);
	const isCompletionLoading = isMentionSearchLoading;
	const showCompletionPicker = Boolean(activeToken && isCompletionPickerOpen);
	const completionLoadingMessage = activeToken?.kind === "mention" ? "Loading files..." : "Loading commands...";
	const completionEmptyMessage = useMemo(() => {
		if (!activeToken) {
			return null;
		}
		if (activeToken.kind === "mention" && !workspaceId) {
			return "Select a workspace to mention files.";
		}
		if (activeToken.kind === "mention") {
			return "No matching files.";
		}
		return "No matching commands.";
	}, [activeToken, workspaceId]);

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, AGENT_CONVERSATION_CHAT_COMPOSER_MAX_HEIGHT)}px`;
		textarea.style.overflowY =
			textarea.scrollHeight > AGENT_CONVERSATION_CHAT_COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
	}, [draft]);

	useEffect(() => {
		if (!canSend) {
			return;
		}
		if (!shouldHandOffKeyboardFocusToAgentEntryNow()) {
			return;
		}
		textareaRef.current?.focus();
	}, [canSend, taskId]);

	// 详情视图切卡后的显式聚焦请求。与上面那条 `[canSend, taskId]` 的区别在于它也覆盖
	// 「taskId 没变、但用户重新选中了同一张卡」以及切换子会话的情形。
	useEffect(() => {
		if (agentEntryKeyboardFocusRequestKey === undefined) {
			return;
		}
		if (agentEntryKeyboardFocusRequestKey === handledAgentEntryKeyboardFocusRequestKeyRef.current) {
			return;
		}
		// 输入框在 `!canSend` 时是 disabled 的，disabled 元素聚焦不了。此时不认领这次请求，
		// 等 canSend 翻 true 后本 effect 会因依赖它而重跑，把挂起的请求补上。
		if (!canSend) {
			return;
		}
		handledAgentEntryKeyboardFocusRequestKeyRef.current = agentEntryKeyboardFocusRequestKey;
		// 请求发出到此刻之间用户可能已经开始拖选文字或点进了别处，兑现前再查一次守卫。
		if (!shouldHandOffKeyboardFocusToAgentEntryNow()) {
			return;
		}
		textareaRef.current?.focus();
	}, [agentEntryKeyboardFocusRequestKey, canSend]);

	useEffect(() => {
		setCursorIndex((currentValue) => Math.min(currentValue, draft.length));
	}, [draft.length]);

	useEffect(() => {
		setSelectedCompletionIndex(0);
		setIsCompletionPickerOpen(true);
	}, [activeToken?.kind, activeToken?.query, activeToken?.start]);

	useEffect(() => {
		if (!activeToken || activeToken.kind !== "mention") {
			mentionSearchRequestIdRef.current += 1;
			setMentionSuggestions([]);
			setIsMentionSearchLoading(false);
		}
	}, [activeToken]);

	const appendImages = useCallback(
		(newImages: TaskImage[]) => {
			if (!onImagesChange || newImages.length === 0) {
				return;
			}
			latestImagesRef.current = [...latestImagesRef.current, ...newImages];
			onImagesChange(latestImagesRef.current);
		},
		[onImagesChange],
	);

	const handleRemoveImage = useCallback(
		(imageId: string) => {
			latestImagesRef.current = latestImagesRef.current.filter((image) => image.id !== imageId);
			onImagesChange?.(latestImagesRef.current);
		},
		[onImagesChange],
	);

	const handlePaste = useCallback(
		(event: ClipboardEvent<HTMLTextAreaElement>) => {
			if (!event.clipboardData) {
				return;
			}
			const imageFiles = collectImageFilesFromDataTransfer(event.clipboardData);
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const nextImages = await extractImagesFromDataTransfer(event.clipboardData);
				appendImages(nextImages);
			})();
		},
		[appendImages],
	);

	useDebouncedEffect(
		() => {
			if (!activeToken || activeToken.kind !== "mention" || !workspaceId) {
				return;
			}
			const requestId = ++mentionSearchRequestIdRef.current;
			setIsMentionSearchLoading(true);
			void (async () => {
				try {
					const payload = await getRuntimeTrpcClient(workspaceId).workspace.searchFiles.query({
						query: activeToken.query,
						limit: AGENT_CONVERSATION_CHAT_COMPOSER_FILE_LIMIT,
					});
					if (requestId !== mentionSearchRequestIdRef.current) {
						return;
					}
					setMentionSuggestions(
						payload.files.map((file) => ({
							id: file.path,
							kind: "mention",
							label: file.name,
							detail: file.path,
							insertText: buildMentionInsertText(file.path),
						})),
					);
				} catch {
					if (requestId === mentionSearchRequestIdRef.current) {
						setMentionSuggestions([]);
					}
				} finally {
					if (requestId === mentionSearchRequestIdRef.current) {
						setIsMentionSearchLoading(false);
					}
				}
			})();
		},
		AGENT_CONVERSATION_CHAT_COMPOSER_COMPLETION_DEBOUNCE_MS,
		[activeToken, workspaceId],
	);

	const applySuggestion = useCallback(
		(suggestion: AgentConversationComposerCompletionSuggestion, token: ActiveAgentConversationComposerToken) => {
			const next = applyAgentConversationComposerCompletion(draft, token, suggestion.insertText);
			onDraftChange(next.value);
			window.requestAnimationFrame(() => {
				const textarea = textareaRef.current;
				if (!textarea) {
					return;
				}
				textarea.focus();
				textarea.setSelectionRange(next.cursor, next.cursor);
				setCursorIndex(next.cursor);
			});
		},
		[draft, onDraftChange],
	);

	const handleCompletionSelect = useCallback(
		(item: InlineCompletionItem) => {
			const suggestion = completionSuggestions.find((s) => s.id === item.id);
			if (suggestion && activeToken) {
				applySuggestion(suggestion, activeToken);
			}
		},
		[activeToken, applySuggestion, completionSuggestions],
	);

	const handleTextareaKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (isKeyboardEventEmittedDuringImeComposition(event)) {
				return;
			}
			const canNavigateCompletions = showCompletionPicker && completionSuggestions.length > 0;
			// alt+↑/↓ 是详情视图的切卡热键，补全列表开着时也不能被这里的补全导航吞掉。
			if (canNavigateCompletions && !event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedCompletionIndex((currentValue) => {
					const nextIndex = currentValue + direction;
					if (nextIndex < 0) {
						return completionSuggestions.length - 1;
					}
					if (nextIndex >= completionSuggestions.length) {
						return 0;
					}
					return nextIndex;
				});
				return;
			}
			if (canNavigateCompletions && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
				event.preventDefault();
				const selectedSuggestion = completionSuggestions[selectedCompletionIndex] ?? completionSuggestions[0];
				if (selectedSuggestion && activeToken) {
					applySuggestion(selectedSuggestion, activeToken);
				}
				return;
			}
			if (event.key === "Escape" && showCompletionPicker) {
				event.preventDefault();
				setIsCompletionPickerOpen(false);
				return;
			}
			if (
				showModeToggle &&
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "a"
			) {
				event.preventDefault();
				onModeChange(mode === "plan" ? "act" : "plan");
				return;
			}
			if (event.key === "Escape") {
				if (!canCancel) {
					return;
				}
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			if (!canSubmit) {
				return;
			}
			event.preventDefault();
			void onSend();
		},
		[
			activeToken,
			applySuggestion,
			canCancel,
			canSubmit,
			completionSuggestions,
			onCancel,
			onModeChange,
			onSend,
			mode,
			selectedCompletionIndex,
			showCompletionPicker,
			showModeToggle,
		],
	);

	const handleDrop = useCallback(
		async (event: DragEvent<HTMLDivElement>) => {
			event.preventDefault();
			setIsDragOver(false);
			const nextImages = await extractImagesFromDataTransfer(event.dataTransfer);
			appendImages(nextImages);
		},
		[appendImages],
	);

	return (
		<div
			className={cn(
				"rounded-xl border border-border bg-surface-2 px-3 py-2 focus-within:border-border-focus",
				isDragOver && "border-border-focus bg-surface-3/50",
			)}
			onDragEnter={(event) => {
				event.preventDefault();
				setIsDragOver(true);
			}}
			onDragOver={(event) => {
				event.preventDefault();
				setIsDragOver(true);
			}}
			onDragLeave={(event) => {
				if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
					return;
				}
				setIsDragOver(false);
			}}
			onDrop={handleDrop}
		>
			<InlineCompletionPicker
				open={showCompletionPicker}
				items={completionItems}
				selectedIndex={selectedCompletionIndex}
				onSelectItem={handleCompletionSelect}
				onHoverItem={setSelectedCompletionIndex}
				isLoading={isCompletionLoading}
				loadingMessage={completionLoadingMessage}
				emptyMessage={completionEmptyMessage}
				side="top"
			>
				<textarea
					ref={textareaRef}
					onSelect={(event) => blockInsertion.rememberSelection(event.currentTarget)}
					value={draft}
					onChange={(event) => {
						onDraftChange(event.target.value);
						setCursorIndex(event.target.selectionStart ?? event.target.value.length);
					}}
					onPaste={handlePaste}
					onKeyDown={handleTextareaKeyDown}
					onClick={(event) =>
						setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
					}
					onKeyUp={(event) =>
						setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
					}
					placeholder={placeholder}
					disabled={!canSend}
					rows={1}
					className="w-full min-h-6 resize-none bg-transparent p-0 text-sm leading-5 text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
					style={{ maxHeight: AGENT_CONVERSATION_CHAT_COMPOSER_MAX_HEIGHT }}
				/>
			</InlineCompletionPicker>
			{images.length > 0 ? (
				<TaskImageStrip images={images} onRemoveImage={handleRemoveImage} className="mt-2" />
			) : null}
			<div className="mt-1 flex flex-wrap items-center gap-1">
				<TaskPromptPseudoHtmlBlockInsertControl
					disabled={!canSend}
					onInsertPseudoHtmlBlock={blockInsertion.insertBlock}
					onPopoverCloseAutoFocus={blockInsertion.restoreFocusAfterPopover}
				/>
				{onImagesChange ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={!canSend}
							icon={<Paperclip size={14} />}
							onClick={() => imageFileInputRef.current?.click()}
						>
							Attach image
						</Button>
						<input
							ref={imageFileInputRef}
							type="file"
							className="hidden"
							multiple
							accept={ACCEPTED_TASK_IMAGE_INPUT_ACCEPT}
							onChange={(event) => {
								const input = event.currentTarget;
								const files = Array.from(input.files ?? []);
								void Promise.all(files.map(fileToTaskImage)).then((selected) => {
									appendImages(selected.filter((image): image is TaskImage => image !== null));
									input.value = "";
								});
							}}
						/>
					</>
				) : null}
			</div>
			<div className="mt-2 flex min-w-0 items-center gap-2">
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{showModeToggle ? (
						<Tooltip
							side="top"
							content={
								<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
									<span>Toggle</span>
									<span className="inline-flex items-center gap-0.5 whitespace-nowrap">
										<span>(</span>
										{isMacPlatform ? <Command size={11} /> : <span>Ctrl</span>}
										<span>+</span>
										<ArrowBigUp size={11} />
										<span>+ A)</span>
									</span>
								</span>
							}
						>
							<div
								className="inline-flex h-7 shrink-0 items-center rounded-md border border-border-bright bg-surface-3 p-0.5"
								role="tablist"
								aria-label="Agent 会话模式"
							>
								<button
									type="button"
									role="tab"
									aria-selected={mode === "plan"}
									className={cn(
										"h-5 rounded-sm px-2 text-[11px] font-medium hover:cursor-pointer",
										mode === "plan"
											? "bg-surface-1 text-text-primary"
											: "text-text-secondary hover:bg-surface-4 hover:text-text-primary",
									)}
									onClick={() => onModeChange("plan")}
								>
									Plan
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={mode === "act"}
									className={cn(
										"h-5 rounded-sm px-2 text-[11px] font-medium hover:cursor-pointer",
										mode === "act"
											? "bg-surface-1 text-text-primary"
											: "text-text-secondary hover:bg-surface-4 hover:text-text-primary",
									)}
									onClick={() => onModeChange("act")}
								>
									Act
								</button>
							</div>
						</Tooltip>
					) : null}
					<Button
						variant="default"
						size="sm"
						className="h-7 w-7 rounded-full border-border-bright bg-surface-4 p-0 text-text-primary hover:bg-surface-3"
						aria-label={canCancel ? "Cancel request" : "Send message"}
						disabled={canCancel ? false : !canSubmit}
						onClick={() => {
							if (canCancel) {
								onCancel();
								return;
							}
							void onSend();
						}}
						icon={
							isSending ? <Spinner size={12} /> : canCancel ? <Pause size={14} /> : <SendHorizontal size={14} />
						}
					/>
				</div>
			</div>
			{warningMessage ? (
				<div className="mt-2 flex items-start gap-1.5 text-xs text-status-orange" title={warningMessage}>
					<AlertTriangle size={14} className="mt-0.5 shrink-0" />
					<p
						className="m-0 min-w-0"
						style={{
							display: "-webkit-box",
							WebkitBoxOrient: "vertical",
							WebkitLineClamp: 2,
							overflow: "hidden",
						}}
					>
						{warningMessage}
					</p>
				</div>
			) : null}
			{attachmentWarningMessage ? (
				<div className="mt-2 flex items-start gap-1.5 text-xs text-status-orange" title={attachmentWarningMessage}>
					<AlertTriangle size={14} className="mt-0.5 shrink-0" />
					<p className="m-0 min-w-0">{attachmentWarningMessage}</p>
				</div>
			) : null}
		</div>
	);
}
