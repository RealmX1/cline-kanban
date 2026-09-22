import { describe, expect, it } from "vitest";

import {
	IME_COMPOSITION_IN_PROGRESS_KEY_CODE,
	isKeyboardEventEmittedDuringImeComposition,
} from "@/utils/keyboard-event-ime-composition-detection";

describe("isKeyboardEventEmittedDuringImeComposition", () => {
	it("treats a plain Enter outside composition as a real key press", () => {
		expect(isKeyboardEventEmittedDuringImeComposition({ isComposing: false, keyCode: 13 })).toBe(false);
	});

	it("detects composition via the standard isComposing flag", () => {
		expect(isKeyboardEventEmittedDuringImeComposition({ isComposing: true, keyCode: 13 })).toBe(true);
	});

	it("detects composition via the legacy 229 keyCode when isComposing is not set", () => {
		// Chromium 在组字期间把 keyCode 钉成 229；这是早于 isComposing 的事实标准，留作兜底。
		expect(
			isKeyboardEventEmittedDuringImeComposition({
				isComposing: false,
				keyCode: IME_COMPOSITION_IN_PROGRESS_KEY_CODE,
			}),
		).toBe(true);
	});

	it("reads the signals off nativeEvent for React synthetic events", () => {
		// React 的合成键盘事件不透出 isComposing，只能经 nativeEvent 读——调用方不该各自记住这件事。
		expect(isKeyboardEventEmittedDuringImeComposition({ nativeEvent: { isComposing: true, keyCode: 229 } })).toBe(
			true,
		);
		expect(isKeyboardEventEmittedDuringImeComposition({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(
			false,
		);
	});

	it("works on a real DOM KeyboardEvent constructed with the composition init fields", () => {
		const composingEnter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true });
		const plainEnter = new KeyboardEvent("keydown", { key: "Enter" });
		expect(isKeyboardEventEmittedDuringImeComposition(composingEnter)).toBe(true);
		expect(isKeyboardEventEmittedDuringImeComposition(plainEnter)).toBe(false);
	});
});
