import { type RefObject, useCallback, useEffect, useRef } from "react";
import { buildTaskPromptWithPseudoHtmlBlockInserted } from "@/components/task-prompt-pseudo-html-block-insertion";

export function useAgentPromptPseudoHtmlBlockInsertion({
	textareaRef,
	value,
	onValueChange,
}: {
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	value: string;
	onValueChange: (value: string) => void;
}) {
	const selectionRef = useRef({ start: 0, end: 0 });
	const selectionToRestoreRef = useRef<{ start: number; end: number } | null>(null);
	const restoreFocusAfterPopoverRef = useRef(false);
	const rememberSelection = useCallback((textarea: HTMLTextAreaElement) => {
		selectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
	}, []);
	useEffect(() => {
		const selection = selectionToRestoreRef.current;
		if (!selection || !textareaRef.current) return;
		selectionToRestoreRef.current = null;
		textareaRef.current.focus();
		textareaRef.current.setSelectionRange(selection.start, selection.end);
	}, [textareaRef, value]);
	const insertBlock = useCallback(
		(blockName: string) => {
			const inserted = buildTaskPromptWithPseudoHtmlBlockInserted({
				promptValue: value,
				selectionStart: selectionRef.current.start,
				selectionEnd: selectionRef.current.end,
				blockName,
			});
			selectionToRestoreRef.current = { start: inserted.nextSelectionStart, end: inserted.nextSelectionEnd };
			restoreFocusAfterPopoverRef.current = true;
			onValueChange(inserted.nextPromptValue);
		},
		[onValueChange, value],
	);
	const restoreFocusAfterPopover = useCallback(
		(event: Event) => {
			if (!restoreFocusAfterPopoverRef.current) return;
			restoreFocusAfterPopoverRef.current = false;
			event.preventDefault();
			textareaRef.current?.focus();
		},
		[textareaRef],
	);
	return { rememberSelection, insertBlock, restoreFocusAfterPopover };
}
