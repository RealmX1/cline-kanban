import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT } from "@/terminal/osc-52-clipboard-provider-tolerating-insecure-browser-context";

const SYSTEM = "c" as ClipboardSelectionType;
const PRIMARY = "p" as ClipboardSelectionType;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setNavigatorClipboard(clipboard: Partial<Clipboard> | undefined): void {
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

describe("OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT", () => {
	afterEach(() => {
		if (originalClipboardDescriptor) {
			Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	it("writes OSC 52 system-clipboard copies through the Clipboard API in a secure context", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		setNavigatorClipboard({ writeText });

		await OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT.writeText(SYSTEM, "selected by agent");

		expect(writeText).toHaveBeenCalledWith("selected by agent");
	});

	it("quietly drops the copy instead of throwing when the page is plain http", async () => {
		setNavigatorClipboard(undefined);

		await expect(
			OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT.writeText(SYSTEM, "x"),
		).resolves.toBeUndefined();
		await expect(OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT.readText(SYSTEM)).resolves.toBe("");
	});

	it("ignores the X11 primary selection, like the addon's default provider", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		setNavigatorClipboard({ writeText });

		await OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT.writeText(PRIMARY, "x");

		expect(writeText).not.toHaveBeenCalled();
	});
});
