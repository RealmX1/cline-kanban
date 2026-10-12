import { describe, expect, it } from "vitest";

import {
	resolveTerminalClipboardKeyboardShortcutAction,
	type TerminalClipboardKeyboardShortcutEnvironment,
} from "@/terminal/terminal-clipboard-keyboard-shortcut-resolution";

function keydown(
	key: string,
	modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {},
	type = "keydown",
) {
	return { type, key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}

const WINDOWS_REMOTE_WITH_SELECTION: TerminalClipboardKeyboardShortcutEnvironment = {
	isMacPlatform: false,
	isWindowsPlatform: true,
	terminalHasSelection: true,
	browserIsOnDifferentMachineThanAgentRuntimeHost: true,
};
const LINUX_LOCAL_WITH_SELECTION: TerminalClipboardKeyboardShortcutEnvironment = {
	isMacPlatform: false,
	isWindowsPlatform: false,
	terminalHasSelection: true,
	browserIsOnDifferentMachineThanAgentRuntimeHost: false,
};
const MAC_REMOTE_WITH_SELECTION: TerminalClipboardKeyboardShortcutEnvironment = {
	isMacPlatform: true,
	isWindowsPlatform: false,
	terminalHasSelection: true,
	browserIsOnDifferentMachineThanAgentRuntimeHost: true,
};

const COPY = { kind: "copy-terminal-selection-to-system-clipboard", clearSelectionAfterCopy: false };
const COPY_THEN_CLEAR = { kind: "copy-terminal-selection-to-system-clipboard", clearSelectionAfterCopy: true };
const PASTE = { kind: "release-to-browser-native-paste-of-this-device-clipboard" };
const NOT = { kind: "not-a-clipboard-shortcut" };

describe("resolveTerminalClipboardKeyboardShortcutAction", () => {
	describe("Windows", () => {
		it("copies on Ctrl+C when there is a selection, then clears it", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(
					keydown("c", { ctrlKey: true }),
					WINDOWS_REMOTE_WITH_SELECTION,
				),
			).toEqual(COPY_THEN_CLEAR);
		});

		it("leaves Ctrl+C to the agent as ^C when nothing is selected", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(keydown("c", { ctrlKey: true }), {
					...WINDOWS_REMOTE_WITH_SELECTION,
					terminalHasSelection: false,
				}),
			).toEqual(NOT);
		});

		it("copies on Ctrl+Shift+C without clearing the selection", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(
					keydown("C", { ctrlKey: true, shiftKey: true }),
					WINDOWS_REMOTE_WITH_SELECTION,
				),
			).toEqual(COPY);
		});

		it("hands Ctrl+V to the browser paste when the browser is on another machine", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(
					keydown("v", { ctrlKey: true }),
					WINDOWS_REMOTE_WITH_SELECTION,
				),
			).toEqual(PASTE);
		});

		it("keeps Ctrl+V as ^V when the browser shares the machine with the agent", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(keydown("v", { ctrlKey: true }), {
					...WINDOWS_REMOTE_WITH_SELECTION,
					browserIsOnDifferentMachineThanAgentRuntimeHost: false,
				}),
			).toEqual(NOT);
		});
	});

	describe("Linux", () => {
		it("does not treat plain Ctrl+C as copy even with a selection", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(keydown("c", { ctrlKey: true }), LINUX_LOCAL_WITH_SELECTION),
			).toEqual(NOT);
		});

		it("copies on Ctrl+Shift+C", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(
					keydown("C", { ctrlKey: true, shiftKey: true }),
					LINUX_LOCAL_WITH_SELECTION,
				),
			).toEqual(COPY);
		});

		it("always hands Ctrl+Shift+V to the browser paste, even on the same machine", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(
					keydown("V", { ctrlKey: true, shiftKey: true }),
					LINUX_LOCAL_WITH_SELECTION,
				),
			).toEqual(PASTE);
		});
	});

	describe("macOS", () => {
		it("copies on Cmd+C with a selection", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(keydown("c", { metaKey: true }), MAC_REMOTE_WITH_SELECTION),
			).toEqual(COPY);
		});

		it("does not take over Ctrl+C or Ctrl+V, which stay terminal control keys", () => {
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(keydown("c", { ctrlKey: true }), MAC_REMOTE_WITH_SELECTION),
			).toEqual(NOT);
			expect(
				resolveTerminalClipboardKeyboardShortcutAction(keydown("v", { ctrlKey: true }), MAC_REMOTE_WITH_SELECTION),
			).toEqual(NOT);
		});
	});

	it("ignores keyup / keypress and Alt-modified keys", () => {
		expect(
			resolveTerminalClipboardKeyboardShortcutAction(
				keydown("c", { ctrlKey: true }, "keyup"),
				WINDOWS_REMOTE_WITH_SELECTION,
			),
		).toEqual(NOT);
		expect(
			resolveTerminalClipboardKeyboardShortcutAction(
				keydown("v", { ctrlKey: true, altKey: true }),
				WINDOWS_REMOTE_WITH_SELECTION,
			),
		).toEqual(NOT);
	});
});
