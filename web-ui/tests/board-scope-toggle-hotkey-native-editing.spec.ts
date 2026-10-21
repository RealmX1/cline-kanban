import { expect, type Page, test } from "@playwright/test";

async function openIsolatedHotkeyHarness(page: Page, platform: "MacIntel" | "Win32"): Promise<void> {
	await page.addInitScript((navigatorPlatform) => {
		Object.defineProperty(navigator, "platform", { value: navigatorPlatform });
	}, platform);
	// 隔离页面不得通过 Vite 的代理访问真实运行时。
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-board-scope-hotkey", (route) =>
		route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
	);
	await page.goto("/isolated-board-scope-hotkey");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/board-scope-toggle-hotkey-browser-harness.tsx" });
	await expect(page.locator(".xterm-helper-textarea")).toBeAttached();
}

// 分支条件由 hook 单测负责；这里只保留 jsdom 无法证明的浏览器与 xterm 契约。
for (const { platform, shortcut } of [
	{ platform: "MacIntel", shortcut: "Meta+Shift+e" },
	{ platform: "Win32", shortcut: "Control+Shift+e" },
] as const) {
	test(`${platform}：原生行尾编辑与新组合的终端隔离`, async ({ page }) => {
		await openIsolatedHotkeyHarness(page, platform);
		const textarea = page.getByLabel("多行输入框");
		await textarea.focus();
		if (platform === "MacIntel" && process.platform === "darwin") {
			await textarea.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2));
			await page.keyboard.press("Control+e");
			// 第一行末为 10，整段末为 22，避免误把跳到文末也视作通过。
			expect(await textarea.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(10);
			await expect(page.getByTestId("scope-toggle-count")).toHaveText("0");
		}
		await page.keyboard.press(shortcut);
		await expect(page.getByTestId("scope-toggle-count")).toHaveText("1");
		await page.locator(".xterm-helper-textarea").focus();
		await page.keyboard.press("Control+e");
		await expect(page.getByTestId("terminal-outbound-data")).toHaveText(JSON.stringify("\x05"));
		await expect(page.getByTestId("scope-toggle-count")).toHaveText("1");
		await page.keyboard.press(shortcut);
		await expect(page.getByTestId("scope-toggle-count")).toHaveText("2");
		await expect(page.getByTestId("terminal-outbound-data")).toHaveText(JSON.stringify("\x05"));
	});
}
