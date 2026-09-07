import { ImagePlus, Paperclip } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	applyClineComposerCompletion,
	buildMentionInsertText,
	detectActiveClineComposerToken,
} from "@/components/detail-panels/cline-chat-composer-completion";
import { type InlineCompletionItem, InlineCompletionPicker } from "@/components/inline-completion-picker";
import {
	ACCEPTED_TASK_IMAGE_INPUT_ACCEPT,
	collectImageFilesFromDataTransfer,
	extractImagesFromDataTransfer,
	fileToTaskImage,
} from "@/components/task-image-input-utils";
import { TaskImageStrip } from "@/components/task-image-strip";
import { TaskPromptPseudoHtmlBlockInsertControl } from "@/components/task-prompt-pseudo-html-block-insert-control";
import { buildTaskPromptWithPseudoHtmlBlockInserted } from "@/components/task-prompt-pseudo-html-block-insertion";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { TaskImage } from "@/types";
import { useDebouncedEffect } from "@/utils/react-use";

const FILE_MENTION_LIMIT = 8;
const MENTION_QUERY_DEBOUNCE_MS = 120;
const TEXTAREA_MAX_HEIGHT = 200;

interface TaskPromptComposerProps {
	id?: string;
	value: string;
	onValueChange: (value: string) => void;
	/** 输入框失焦。`TaskEditorDialog` 用它把本地草稿上抛给拥有 board 状态的父层。 */
	onValueBlur?: () => void;
	images?: TaskImage[];
	onImagesChange?: (images: TaskImage[]) => void;
	onSubmit?: () => void;
	onSubmitAndStart?: () => void;
	onEscape?: () => void;
	placeholder?: string;
	disabled?: boolean;
	enabled?: boolean;
	autoFocus?: boolean;
	workspaceId?: string | null;
	showAttachImageButton?: boolean;
	showPseudoHtmlBlockInsertButton?: boolean;
}

export function TaskPromptComposer({
	id,
	value,
	onValueChange,
	onValueBlur,
	images = [],
	onImagesChange,
	onSubmit,
	onSubmitAndStart,
	onEscape,
	placeholder,
	disabled,
	enabled = true,
	autoFocus = false,
	workspaceId = null,
	showAttachImageButton = true,
	showPseudoHtmlBlockInsertButton = true,
}: TaskPromptComposerProps): ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const mentionSearchRequestIdRef = useRef(0);
	const [cursorIndex, setCursorIndex] = useState(0);
	// `cursorIndex` 就是 selectionStart（mention 补全链路只需要它）；插入伪 HTML 块要包住整个选区，
	// 所以另记一份 selectionEnd，而不是去改 mention 那条链路对 cursorIndex 的既有用法。
	const [selectionEndIndex, setSelectionEndIndex] = useState(0);
	const [mentionItems, setMentionItems] = useState<InlineCompletionItem[]>([]);
	const [mentionInsertTextMap, setMentionInsertTextMap] = useState(new Map<string, string>());
	const [isMentionSearchLoading, setIsMentionSearchLoading] = useState(false);
	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
	const [isSuggestionPickerOpen, setIsSuggestionPickerOpen] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);

	const syncSelectionIndexesFromTextarea = useCallback((textarea: HTMLTextAreaElement) => {
		setCursorIndex(textarea.selectionStart ?? textarea.value.length);
		setSelectionEndIndex(textarea.selectionEnd ?? textarea.value.length);
	}, []);

	const autoResizeTextarea = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
	}, []);

	useEffect(() => {
		autoResizeTextarea();
	}, [autoResizeTextarea, value]);

	const activeToken = useMemo(() => {
		const token = detectActiveClineComposerToken(value, cursorIndex);
		if (token && token.kind !== "mention") {
			return null;
		}
		return token;
	}, [cursorIndex, value]);

	useEffect(() => {
		if (!enabled || !activeToken) {
			mentionSearchRequestIdRef.current += 1;
			setMentionItems([]);
			setMentionInsertTextMap(new Map());
			setIsMentionSearchLoading(false);
		}
	}, [activeToken, enabled, workspaceId]);

	useDebouncedEffect(
		() => {
			if (!enabled || !activeToken || !workspaceId) {
				return;
			}
			const requestId = ++mentionSearchRequestIdRef.current;
			setIsMentionSearchLoading(true);
			void (async () => {
				try {
					const trpcClient = getRuntimeTrpcClient(workspaceId);
					const payload = await trpcClient.workspace.searchFiles.query({
						query: activeToken.query,
						limit: FILE_MENTION_LIMIT,
					});
					if (requestId !== mentionSearchRequestIdRef.current) {
						return;
					}
					const files = Array.isArray(payload.files) ? payload.files : [];
					const insertMap = new Map<string, string>();
					const items: InlineCompletionItem[] = files.map((file) => {
						const insertText = buildMentionInsertText(file.path);
						insertMap.set(file.path, insertText);
						return { id: file.path, label: file.path };
					});
					setMentionItems(items);
					setMentionInsertTextMap(insertMap);
				} catch {
					if (requestId === mentionSearchRequestIdRef.current) {
						setMentionItems([]);
						setMentionInsertTextMap(new Map());
					}
				} finally {
					if (requestId === mentionSearchRequestIdRef.current) {
						setIsMentionSearchLoading(false);
					}
				}
			})();
		},
		MENTION_QUERY_DEBOUNCE_MS,
		[activeToken, enabled, workspaceId],
	);

	const suggestions = useMemo(() => {
		return enabled && activeToken ? mentionItems : [];
	}, [activeToken, enabled, mentionItems]);

	useEffect(() => {
		setSelectedSuggestionIndex(0);
		setIsSuggestionPickerOpen(true);
	}, [activeToken?.kind, activeToken?.query, activeToken?.start]);

	useEffect(() => {
		if (!autoFocus || disabled || !enabled) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (!textareaRef.current) {
				return;
			}
			const cursor = textareaRef.current.value.length;
			textareaRef.current.focus();
			textareaRef.current.setSelectionRange(cursor, cursor);
			setCursorIndex(cursor);
			setSelectionEndIndex(cursor);
		});
	}, [autoFocus, disabled, enabled]);

	const applySuggestion = useCallback(
		(item: InlineCompletionItem) => {
			if (!activeToken) {
				return;
			}
			const insertText = mentionInsertTextMap.get(item.id) ?? `@${item.id}`;
			const next = applyClineComposerCompletion(value, activeToken, insertText);
			onValueChange(next.value);
			window.requestAnimationFrame(() => {
				if (!textareaRef.current) {
					return;
				}
				textareaRef.current.focus();
				textareaRef.current.setSelectionRange(next.cursor, next.cursor);
				setCursorIndex(next.cursor);
				setSelectionEndIndex(next.cursor);
			});
		},
		[activeToken, mentionInsertTextMap, onValueChange, value],
	);

	const handleTextareaKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey) {
					if (onSubmitAndStart) {
						onSubmitAndStart();
						return;
					}
				}
				onSubmit?.();
				return;
			}

			const canShowSuggestions = isSuggestionPickerOpen && suggestions.length > 0;
			if (canShowSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedSuggestionIndex((index) => {
					const nextIndex = index + direction;
					if (nextIndex < 0) {
						return suggestions.length - 1;
					}
					if (nextIndex >= suggestions.length) {
						return 0;
					}
					return nextIndex;
				});
				return;
			}

			if (canShowSuggestions && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
				event.preventDefault();
				const selectedItem = suggestions[selectedSuggestionIndex] ?? suggestions[0];
				if (selectedItem) {
					applySuggestion(selectedItem);
				}
				return;
			}

			if (event.key === "Escape" && canShowSuggestions) {
				event.preventDefault();
				setIsSuggestionPickerOpen(false);
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				onEscape?.();
			}
		},
		[
			applySuggestion,
			isSuggestionPickerOpen,
			onEscape,
			onSubmit,
			onSubmitAndStart,
			selectedSuggestionIndex,
			suggestions,
		],
	);

	const appendImages = useCallback(
		(newImages: TaskImage[]) => {
			if (!onImagesChange || newImages.length === 0) {
				return;
			}
			onImagesChange([...images, ...newImages]);
		},
		[images, onImagesChange],
	);

	const handlePaste = useCallback(
		(event: ClipboardEvent<HTMLTextAreaElement>) => {
			if (!onImagesChange || !event.clipboardData) {
				return;
			}
			const imageFiles = collectImageFilesFromDataTransfer(event.clipboardData);
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const newImages = await extractImagesFromDataTransfer(event.clipboardData);
				appendImages(newImages);
			})();
		},
		[appendImages, onImagesChange],
	);

	const handleDrop = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			setIsDragOver(false);
			if (!onImagesChange || !event.dataTransfer) {
				return;
			}
			const imageFiles = collectImageFilesFromDataTransfer(event.dataTransfer);
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const newImages = await extractImagesFromDataTransfer(event.dataTransfer);
				appendImages(newImages);
			})();
		},
		[appendImages, onImagesChange],
	);

	const handleDragOver = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			if (!onImagesChange) {
				return;
			}
			const hasFiles = event.dataTransfer.types.includes("Files");
			if (!hasFiles) {
				return;
			}
			event.preventDefault();
			setIsDragOver(true);
		},
		[onImagesChange],
	);

	const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
		// Only clear drag state when leaving the drop zone container,
		// not when moving between child elements within it.
		if (event.currentTarget.contains(event.relatedTarget as Node)) {
			return;
		}
		setIsDragOver(false);
	}, []);

	const handleRemoveImage = useCallback(
		(imageId: string) => {
			onImagesChange?.(images.filter((image) => image.id !== imageId));
		},
		[images, onImagesChange],
	);

	const handleAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	// 插完块要把光标还给 textarea，但下拉关闭时 Radix 会把焦点收回触发按钮。两件事各自需要一个不同的
	// 时机，所以用两个独立的一次性标记，谁先跑都不会互相踩：
	//   - 焦点：必须在 Radix 的 onCloseAutoFocus 里**同步**抢回来。晚一帧（rAF）的话，紧跟着的头几个
	//     按键会打到触发按钮上直接丢掉；
	//   - 选区：必须等新文本提交进 DOM 之后再设。在旧的、更短的值上调 setSelectionRange 会被截断，
	//     所以挂在 `value` 变化的 effect 上。
	const shouldStealFocusBackFromPseudoHtmlBlockPopoverRef = useRef(false);
	const pendingSelectionRestoreAfterPseudoHtmlBlockInsertRef = useRef<{ start: number; end: number } | null>(null);

	useEffect(() => {
		const pendingSelectionRestore = pendingSelectionRestoreAfterPseudoHtmlBlockInsertRef.current;
		if (!pendingSelectionRestore) {
			return;
		}
		pendingSelectionRestoreAfterPseudoHtmlBlockInsertRef.current = null;
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.focus();
		textarea.setSelectionRange(pendingSelectionRestore.start, pendingSelectionRestore.end);
	}, [value]);

	const handleInsertPseudoHtmlBlock = useCallback(
		(blockName: string) => {
			// 点按钮那一刻 textarea 已经失焦，现读 DOM 选区只会拿到 0/0；必须用 state 里记下的那份。
			const inserted = buildTaskPromptWithPseudoHtmlBlockInserted({
				promptValue: value,
				selectionStart: cursorIndex,
				selectionEnd: selectionEndIndex,
				blockName,
			});
			onValueChange(inserted.nextPromptValue);
			setCursorIndex(inserted.nextSelectionStart);
			setSelectionEndIndex(inserted.nextSelectionEnd);
			pendingSelectionRestoreAfterPseudoHtmlBlockInsertRef.current = {
				start: inserted.nextSelectionStart,
				end: inserted.nextSelectionEnd,
			};
			shouldStealFocusBackFromPseudoHtmlBlockPopoverRef.current = true;
		},
		[cursorIndex, onValueChange, selectionEndIndex, value],
	);

	const handlePseudoHtmlBlockPopoverCloseAutoFocus = useCallback((event: Event) => {
		if (!shouldStealFocusBackFromPseudoHtmlBlockPopoverRef.current) {
			// 用户按 Esc / 点外面关掉的，什么都没插入：让 Radix 照常把焦点还给触发按钮。
			return;
		}
		shouldStealFocusBackFromPseudoHtmlBlockPopoverRef.current = false;
		event.preventDefault();
		textareaRef.current?.focus();
	}, []);

	const handleFileInputChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			if (!onImagesChange || !event.currentTarget.files) {
				return;
			}
			const files = Array.from(event.currentTarget.files);
			void (async () => {
				const newImages: TaskImage[] = [];
				for (const file of files) {
					const image = await fileToTaskImage(file);
					if (image) {
						newImages.push(image);
					}
				}
				appendImages(newImages);
				event.currentTarget.value = "";
			})();
		},
		[appendImages, onImagesChange],
	);

	const showSuggestions = Boolean(enabled && isSuggestionPickerOpen && activeToken);
	// 图片按钮的前提是调用方接了 onImagesChange（没接就无处安放选中的图）；插入块只受自己那个开关约束。
	const isAttachImageButtonVisible = Boolean(onImagesChange) && showAttachImageButton;
	const isComposerToolbarVisible = isAttachImageButtonVisible || showPseudoHtmlBlockInsertButton;

	return (
		<div>
			<div className="relative" onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
				<InlineCompletionPicker
					open={showSuggestions}
					items={suggestions}
					selectedIndex={selectedSuggestionIndex}
					onSelectItem={applySuggestion}
					onHoverItem={setSelectedSuggestionIndex}
					isLoading={isMentionSearchLoading}
					loadingMessage="Loading files..."
					emptyMessage="No matching files."
				>
					<textarea
						id={id}
						ref={textareaRef}
						value={value}
						onChange={(event) => {
							onValueChange(event.target.value);
							syncSelectionIndexesFromTextarea(event.target);
						}}
						onKeyDown={handleTextareaKeyDown}
						onBlur={onValueBlur}
						onClick={(event) => syncSelectionIndexesFromTextarea(event.currentTarget)}
						onKeyUp={(event) => syncSelectionIndexesFromTextarea(event.currentTarget)}
						// 拖选与 ⌘A 只有 onSelect 一定会报到；click/keyUp 覆盖不全。
						onSelect={(event) => syncSelectionIndexesFromTextarea(event.currentTarget)}
						onPaste={handlePaste}
						placeholder={placeholder ?? "Describe the task"}
						disabled={disabled}
						className={cn(
							"w-full rounded-md border bg-surface-3 p-3 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
							isDragOver ? "border-accent border-dashed" : "border-border-bright",
						)}
						style={{
							minHeight: 80,
							maxHeight: TEXTAREA_MAX_HEIGHT,
							resize: "none",
							overflowY: "auto",
						}}
					/>
				</InlineCompletionPicker>
				{isDragOver ? (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-accent/5">
						<div className="flex items-center gap-1.5 text-[12px] text-accent font-medium">
							<ImagePlus size={14} />
							<span>Drop image here</span>
						</div>
					</div>
				) : null}
			</div>

			{images.length > 0 ? (
				<TaskImageStrip images={images} onRemoveImage={handleRemoveImage} className="mt-1.5" />
			) : null}

			{isAttachImageButtonVisible ? (
				<input
					ref={fileInputRef}
					type="file"
					accept={ACCEPTED_TASK_IMAGE_INPUT_ACCEPT}
					multiple
					className="hidden"
					onChange={handleFileInputChange}
				/>
			) : null}

			{isComposerToolbarVisible ? (
				<div className={cn("flex items-center gap-1", images.length > 0 ? "mt-1" : "mt-1.5")}>
					{showPseudoHtmlBlockInsertButton ? (
						<TaskPromptPseudoHtmlBlockInsertControl
							onInsertPseudoHtmlBlock={handleInsertPseudoHtmlBlock}
							onPopoverCloseAutoFocus={handlePseudoHtmlBlockPopoverCloseAutoFocus}
							disabled={disabled || !enabled}
						/>
					) : null}
					{isAttachImageButtonVisible ? (
						<Button
							variant="ghost"
							size="sm"
							icon={<Paperclip size={14} />}
							onClick={handleAttachClick}
							disabled={disabled || !enabled}
						>
							Attach image
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
