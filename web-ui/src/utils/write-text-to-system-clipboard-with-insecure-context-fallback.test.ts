import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { writeTextToSystemClipboardWithInsecureContextFallback } from "@/utils/write-text-to-system-clipboard-with-insecure-context-fallback";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setNavigatorClipboard(clipboard: Partial<Clipboard> | undefined): void {
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

describe("writeTextToSystemClipboardWithInsecureContextFallback", () => {
	let execCommand: Mock<(command: string) => boolean>;

	beforeEach(() => {
		execCommand = vi.fn<(command: string) => boolean>();
		// jsdom 没有实现 execCommand。
		Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
	});

	afterEach(() => {
		if (originalClipboardDescriptor) {
			Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "clipboard");
		}
		Reflect.deleteProperty(document, "execCommand");
	});

	it("uses the async Clipboard API when the page is a secure context", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		setNavigatorClipboard({ writeText });

		await writeTextToSystemClipboardWithInsecureContextFallback("hello");

		expect(writeText).toHaveBeenCalledWith("hello");
		expect(execCommand).not.toHaveBeenCalled();
	});

	// 模拟浏览器的 execCommand("copy")：在焦点元素上派发可取消的 copy 事件，读出写进 clipboardData 的内容。
	function simulateNativeCopyCommand(): { clipboardText: () => string | null } {
		let clipboardText: string | null = null;
		execCommand.mockImplementation(() => {
			const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
			Object.defineProperty(copyEvent, "clipboardData", {
				value: {
					setData: (_format: string, value: string) => {
						clipboardText = value;
					},
				},
			});
			(document.activeElement ?? document.body).dispatchEvent(copyEvent);
			return true;
		});
		return { clipboardText: () => clipboardText };
	}

	it("falls back to a native copy that writes the text into the copy event when the Clipboard API is missing", async () => {
		setNavigatorClipboard(undefined);
		const focusedButton = document.createElement("button");
		document.body.append(focusedButton);
		focusedButton.focus();
		const nativeCopy = simulateNativeCopyCommand();

		await writeTextToSystemClipboardWithInsecureContextFallback("from http");

		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(nativeCopy.clipboardText()).toBe("from http");
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
		expect(document.activeElement).toBe(focusedButton);
		focusedButton.remove();
	});

	it("places the hidden textarea inside the open dialog so a focus trap cannot pull focus away", async () => {
		setNavigatorClipboard(undefined);
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const copyButton = document.createElement("button");
		dialog.append(copyButton);
		document.body.append(dialog);
		copyButton.focus();
		let textAreaParent: Element | null = null;
		const nativeCopy = simulateNativeCopyCommand();
		const dispatchNativeCopy = execCommand.getMockImplementation();
		execCommand.mockImplementation((command: string) => {
			textAreaParent = document.querySelector("textarea")?.parentElement ?? null;
			return dispatchNativeCopy?.(command) ?? false;
		});

		await writeTextToSystemClipboardWithInsecureContextFallback("inside dialog");

		expect(textAreaParent).toBe(dialog);
		expect(nativeCopy.clipboardText()).toBe("inside dialog");
		dialog.remove();
	});

	it("rejects when the browser refuses the native copy, so callers never show a false success", async () => {
		setNavigatorClipboard(undefined);
		execCommand.mockReturnValue(false);

		await expect(writeTextToSystemClipboardWithInsecureContextFallback("x")).rejects.toThrow(/refused to copy/);
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
	});

	it("propagates a rejection from the async Clipboard API", async () => {
		setNavigatorClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });

		await expect(writeTextToSystemClipboardWithInsecureContextFallback("x")).rejects.toThrow("denied");
	});
});
