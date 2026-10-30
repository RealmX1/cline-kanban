import { type KeyboardEvent, useRef } from "react";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";

export const FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS = {
	title: `${modifierKeyLabel}+Enter`,
	"aria-keyshortcuts": isMacPlatform ? "Meta+Enter" : "Control+Enter",
};

export function useFormPrimaryActionSubmitKeyboardShortcut({
	onSubmit,
	disabled = false,
}: {
	// biome-ignore lint/suspicious/noConfusingVoidType: 保留现有同步提交的 void 与异步提交的完成信号。
	onSubmit: (event: KeyboardEvent<HTMLElement>) => void | Promise<unknown>;
	disabled?: boolean;
}) {
	const submissionInFlight = useRef(false);
	return (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
		// 组字保留浏览器默认行为，但不能让外层快捷键接手。
		event.stopPropagation();
		if (isKeyboardEventEmittedDuringImeComposition(event)) return;
		const alreadyHandled = event.defaultPrevented;
		event.preventDefault();
		// React Portal 会沿组件树冒泡，但选择器并不属于宿主表单的 DOM。
		if (
			alreadyHandled ||
			!event.currentTarget.contains(event.target as Node) ||
			event.repeat ||
			disabled ||
			event.currentTarget.closest("fieldset[disabled]") ||
			submissionInFlight.current
		)
			return;
		submissionInFlight.current = true;
		try {
			const submission = onSubmit(event);
			if (submission) {
				void submission.finally(() => {
					submissionInFlight.current = false;
				});
			} else submissionInFlight.current = false;
		} catch (error) {
			submissionInFlight.current = false;
			throw error;
		}
	};
}
