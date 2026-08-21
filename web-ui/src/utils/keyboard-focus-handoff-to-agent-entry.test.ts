import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shouldHandOffKeyboardFocusToAgentEntryNow } from "@/utils/keyboard-focus-handoff-to-agent-entry";

function stubViewportWidth(matchesMobile: boolean): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue({
			matches: matchesMobile,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}),
	);
}

function selectTextInside(element: Node): void {
	const range = document.createRange();
	range.selectNodeContents(element);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

describe("shouldHandOffKeyboardFocusToAgentEntryNow", () => {
	beforeEach(() => {
		stubViewportWidth(false);
		document.body.innerHTML = "";
		window.getSelection()?.removeAllRanges();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("allows the hand-off on a clean desktop viewport", () => {
		expect(shouldHandOffKeyboardFocusToAgentEntryNow()).toBe(true);
	});

	it("refuses the hand-off on a mobile viewport", () => {
		stubViewportWidth(true);
		expect(shouldHandOffKeyboardFocusToAgentEntryNow()).toBe(false);
	});

	it("refuses the hand-off while the user holds a non-empty text selection", () => {
		const paragraph = document.createElement("p");
		paragraph.textContent = "task card title text";
		document.body.appendChild(paragraph);
		selectTextInside(paragraph);
		expect(shouldHandOffKeyboardFocusToAgentEntryNow()).toBe(false);
	});

	it("allows the hand-off when the selection is collapsed to a caret", () => {
		const paragraph = document.createElement("p");
		paragraph.textContent = "task card title text";
		document.body.appendChild(paragraph);
		selectTextInside(paragraph);
		window.getSelection()?.collapseToStart();
		expect(shouldHandOffKeyboardFocusToAgentEntryNow()).toBe(true);
	});

	it("refuses the hand-off while focus sits in an editable element", () => {
		const textarea = document.createElement("textarea");
		document.body.appendChild(textarea);
		textarea.focus();
		expect(shouldHandOffKeyboardFocusToAgentEntryNow()).toBe(false);
	});

	it("refuses the hand-off while focus sits inside a dialog", () => {
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const button = document.createElement("button");
		dialog.appendChild(button);
		document.body.appendChild(dialog);
		button.focus();
		expect(shouldHandOffKeyboardFocusToAgentEntryNow()).toBe(false);
	});
});
