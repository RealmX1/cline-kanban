import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyTaskStickerEntryMutationInWorkspace,
	readTaskCardWithBoardColumnInWorkspace,
} from "@/runtime/task-card-action-query";
import type { RuntimeTaskStickerEntry, RuntimeTaskStickerEntryMutation } from "@/runtime/types";
import type { BoardCard } from "@/types";

let activeTaskStickerOverlay: { close: () => void; canYield: () => boolean } | null = null;

interface TaskStickerEditorDraft {
	taskStickerEntryId: string;
	expectedStickerText: string | null;
	stickerText: string;
}
interface TaskStickerSnapshot {
	entries: RuntimeTaskStickerEntry[];
	deletedEntryIds: string[];
}

type TaskStickerOverlayActivationSource =
	| "pointer_hover"
	| "mouse_or_pen_activation"
	| "keyboard_activation"
	| "touch_activation";

export function resolveTaskStickerOverlayExplicitActivationSource(event: { detail: number; nativeEvent: MouseEvent }) {
	if ("pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "touch") return "touch_activation";
	return event.detail === 0 ? "keyboard_activation" : "mouse_or_pen_activation";
}

function mergeTaskStickerSnapshot(
	previous: TaskStickerSnapshot,
	card: Pick<BoardCard, "taskStickerEntries" | "taskStickerDeletedEntryIds">,
): TaskStickerSnapshot {
	const deletedEntryIds = [...new Set([...previous.deletedEntryIds, ...(card.taskStickerDeletedEntryIds ?? [])])];
	const entries = new Map(previous.entries.map((entry) => [entry.taskStickerEntryId, entry]));
	for (const incoming of card.taskStickerEntries ?? []) {
		const existing = entries.get(incoming.taskStickerEntryId);
		if (!existing || incoming.updatedAt >= existing.updatedAt) entries.set(incoming.taskStickerEntryId, incoming);
	}
	for (const id of deletedEntryIds) entries.delete(id);
	return { entries: [...entries.values()], deletedEntryIds };
}

export function useTaskCardStickers({
	card,
	workspaceId,
	readOnly,
	isDragging,
}: {
	card: BoardCard;
	workspaceId: string | null;
	readOnly: boolean;
	isDragging: boolean;
}) {
	const identityKey = JSON.stringify([workspaceId, card.id, card.createdAt, readOnly]);
	const currentIdentity = useRef(identityKey);
	currentIdentity.current = identityKey;
	const [snapshot, setSnapshot] = useState<TaskStickerSnapshot>(() =>
		mergeTaskStickerSnapshot({ entries: [], deletedEntryIds: [] }, card),
	);
	const [open, setOpen] = useState(false);
	const [editor, setEditor] = useState<TaskStickerEditorDraft | null>(null);
	const [isSaving, setSaving] = useState(false);
	const [isLoading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [failedMutation, setFailedMutation] = useState<RuntimeTaskStickerEntryMutation | null>(null);
	const cardElementRef = useRef<HTMLDivElement | null>(null);
	const overlayElementRef = useRef<HTMLDivElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const explicitOpenerRef = useRef<HTMLElement | null>(null);
	const returnFocusOnClose = useRef(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const readSequence = useRef(0);
	const lifecycleGeneration = useRef(0);
	const isSavingRef = useRef(false);
	const editorRef = useRef(editor);
	editorRef.current = editor;
	const pointerOverCardOrOverlay = useRef(false);
	const keyboardOpened = useRef(false);
	const touchOpened = useRef(false);
	const focusEditorWhenMounted = useRef(false);
	const clearCloseTimer = useCallback(() => {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	}, []);
	const controller = useRef<{ close: () => void; canYield: () => boolean }>({ close: () => {}, canYield: () => true });
	controller.current.canYield = () => !editorRef.current && !isSavingRef.current;
	controller.current.close = () => {
		clearCloseTimer();
		setOpen(false);
		returnFocusOnClose.current = false;
		keyboardOpened.current = false;
		touchOpened.current = false;
		if (activeTaskStickerOverlay === controller.current) activeTaskStickerOverlay = null;
	};
	const close = (restoreOpenerFocus = false) => {
		const shouldReturnFocus = restoreOpenerFocus && keyboardOpened.current;
		controller.current.close();
		returnFocusOnClose.current = shouldReturnFocus;
	};
	useEffect(() => {
		currentIdentity.current = identityKey;
		++lifecycleGeneration.current;
		setSnapshot(mergeTaskStickerSnapshot({ entries: [], deletedEntryIds: [] }, card));
		setEditor(null);
		setError(null);
		setFailedMutation(null);
		setSaving(false);
		setLoading(false);
		isSavingRef.current = false;
		controller.current.close();
		return () => {
			if (currentIdentity.current === identityKey) currentIdentity.current = "";
			++readSequence.current;
			++lifecycleGeneration.current;
			clearCloseTimer();
			if (activeTaskStickerOverlay === controller.current) activeTaskStickerOverlay = null;
		};
		// 身份切换才清理草稿；普通 runtime 广播只合并服务端条目。
	}, [identityKey, clearCloseTimer]);
	useEffect(() => {
		setSnapshot((previous) => mergeTaskStickerSnapshot(previous, card));
	}, [card.taskStickerEntries, card.taskStickerDeletedEntryIds]);
	useEffect(() => {
		if (isDragging) controller.current.close();
	}, [isDragging]);
	useEffect(() => {
		if (!open) return;
		const closeTouchOverlayOnOutsidePointerDown = (event: PointerEvent) => {
			if (!touchOpened.current || !controller.current.canYield() || !(event.target instanceof Node)) return;
			if (cardElementRef.current?.contains(event.target) || overlayElementRef.current?.contains(event.target))
				return;
			controller.current.close();
		};
		// 触屏抬手不结束阅读；捕获真实外部点按，避免浮层内的 stopPropagation 吞掉首次关闭操作。
		document.addEventListener("pointerdown", closeTouchOverlayOnOutsidePointerDown, true);
		return () => document.removeEventListener("pointerdown", closeTouchOverlayOnOutsidePointerDown, true);
	}, [open]);

	const readLatest = async (clearReadErrorOnSuccess = true) => {
		if (!workspaceId || readOnly) return;
		const sequence = ++readSequence.current;
		setLoading(true);
		try {
			const result = await readTaskCardWithBoardColumnInWorkspace(workspaceId, card.id, card.createdAt);
			if (currentIdentity.current !== identityKey || sequence !== readSequence.current) return;
			if (result.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
				throw new Error("任务已不存在，不能修改便签。");
			const loaded = result.taskCardSnapshot.taskCard;
			if (loaded.id !== card.id || loaded.createdAt !== card.createdAt)
				throw new Error("任务身份已变化，请重新打开任务。");
			setSnapshot((previous) => mergeTaskStickerSnapshot(previous, loaded));
			if (clearReadErrorOnSuccess) setError(null);
		} catch (cause) {
			if (currentIdentity.current === identityKey && sequence === readSequence.current)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (currentIdentity.current === identityKey && sequence === readSequence.current) setLoading(false);
		}
	};
	const activate = (activationSource: TaskStickerOverlayActivationSource = "pointer_hover", opener?: HTMLElement) => {
		clearCloseTimer();
		if (isDragging) return false;
		if (activeTaskStickerOverlay && activeTaskStickerOverlay !== controller.current) {
			if (!activeTaskStickerOverlay.canYield()) return false;
			activeTaskStickerOverlay.close();
		}
		activeTaskStickerOverlay = controller.current;
		if (!open || activationSource !== "pointer_hover") {
			keyboardOpened.current = activationSource === "keyboard_activation";
			touchOpened.current = activationSource === "touch_activation";
		}
		if (opener) explicitOpenerRef.current = opener;
		if (!open) {
			setOpen(true);
			void readLatest();
		}
		return true;
	};
	const scheduleClose = () => {
		clearCloseTimer();
		closeTimer.current = setTimeout(() => {
			const keyboardFocusInOverlay =
				keyboardOpened.current && overlayElementRef.current?.contains(document.activeElement);
			if (
				!pointerOverCardOrOverlay.current &&
				!touchOpened.current &&
				!keyboardFocusInOverlay &&
				controller.current.canYield()
			)
				close();
		}, 200);
	};
	const pointerEnter = () => {
		pointerOverCardOrOverlay.current = true;
		clearCloseTimer();
	};
	const pointerLeave = () => {
		pointerOverCardOrOverlay.current = false;
		scheduleClose();
	};
	const startNew = (
		opener?: HTMLElement,
		activationSource: TaskStickerOverlayActivationSource = "mouse_or_pen_activation",
	) => {
		if (readOnly || !workspaceId || isSavingRef.current || !activate(activationSource, opener)) return;
		if (!editorRef.current)
			setEditor({ taskStickerEntryId: crypto.randomUUID(), expectedStickerText: null, stickerText: "" });
		focusEditorWhenMounted.current = true;
	};
	const startEditing = (entry: RuntimeTaskStickerEntry) => {
		if (editorRef.current || isSavingRef.current) return;
		setEditor({
			taskStickerEntryId: entry.taskStickerEntryId,
			expectedStickerText: entry.stickerText,
			stickerText: entry.stickerText,
		});
		focusEditorWhenMounted.current = true;
	};
	const mutate = async (mutation: RuntimeTaskStickerEntryMutation) => {
		if (!workspaceId || readOnly) {
			// 历史卡片可以临时展开阅读，但不会写入同 ID 的活动任务。
			if (mutation.operation === "set_collapsed")
				setSnapshot((previous) => ({
					...previous,
					entries: previous.entries.map((entry) =>
						entry.taskStickerEntryId === mutation.taskStickerEntryId
							? { ...entry, isCollapsed: mutation.isCollapsed }
							: entry,
					),
				}));
			return;
		}
		if (isSavingRef.current) return;
		const generation = lifecycleGeneration.current;
		isSavingRef.current = true;
		setSaving(true);
		setError(null);
		setFailedMutation(null);
		try {
			const response = await applyTaskStickerEntryMutationInWorkspace(workspaceId, {
				taskId: card.id,
				expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
				mutation,
				boardMutationInitiator: "web_ui_user_gesture",
			});
			if (currentIdentity.current !== identityKey || generation !== lifecycleGeneration.current) return;
			const saved = response.taskCardSnapshotAfterAction.taskCard;
			if (saved.id !== card.id || saved.createdAt !== card.createdAt)
				throw new Error("任务身份已变化，草稿已保留。");
			setSnapshot((previous) => mergeTaskStickerSnapshot(previous, saved));
			if (mutation.operation === "create") {
				const created = saved.taskStickerEntries?.find(
					(entry) => entry.taskStickerEntryId === mutation.taskStickerEntryId,
				);
				if (!created) throw new Error("这张便签已被删除，草稿已保留。可取消编辑后添加新便签。");
				if (created.stickerText !== mutation.stickerText)
					throw new Error("这次创建之前已保存了不同正文。请核对最新正文，草稿已保留。");
			}
			if (mutation.operation === "create" || mutation.operation === "update_text") setEditor(null);
		} catch (cause) {
			if (currentIdentity.current !== identityKey || generation !== lifecycleGeneration.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
			setFailedMutation(mutation);
			void readLatest(false);
		} finally {
			if (currentIdentity.current === identityKey && generation === lifecycleGeneration.current) {
				isSavingRef.current = false;
				setSaving(false);
				scheduleClose();
			}
		}
	};
	return {
		open,
		entries: snapshot.entries,
		editor,
		isSaving,
		isLoading,
		error,
		failedMutation,
		cardElementRef,
		overlayElementRef,
		textareaRef,
		explicitOpenerRef,
		keyboardOpened,
		returnFocusOnClose,
		focusEditorWhenMounted,
		readOnly: readOnly || !workspaceId,
		close,
		readLatest,
		pointerEnter,
		pointerLeave,
		scheduleClose,
		beginPointerInteraction: (pointerType: string) => {
			keyboardOpened.current = false;
			touchOpened.current = pointerType === "touch";
			clearCloseTimer();
		},
		beginKeyboardInteraction: () => {
			keyboardOpened.current = true;
			touchOpened.current = false;
			clearCloseTimer();
		},
		activate,
		startNew,
		startEditing,
		mutate,
		setDraftText: (stickerText: string) => setEditor((previous) => (previous ? { ...previous, stickerText } : null)),
		cancelEditing: () => {
			setEditor(null);
			setError(null);
			setFailedMutation(null);
			scheduleClose();
		},
		adoptLatestTextAsEditBaseline: (stickerText: string) =>
			setEditor((previous) => (previous ? { ...previous, expectedStickerText: stickerText } : null)),
		saveDraft: () => {
			if (!editor?.stickerText.trim()) return;
			void mutate(
				editor.expectedStickerText === null
					? {
							operation: "create",
							taskStickerEntryId: editor.taskStickerEntryId,
							stickerText: editor.stickerText.trim(),
						}
					: {
							operation: "update_text",
							taskStickerEntryId: editor.taskStickerEntryId,
							expectedStickerText: editor.expectedStickerText,
							stickerText: editor.stickerText.trim(),
						},
			);
		},
	};
}

export type TaskCardStickersController = ReturnType<typeof useTaskCardStickers>;
