import { expect, test, type WebSocketRoute } from "@playwright/test";

interface TerminalTabLifecycleSnapshot {
	geometry: { cols: number; rows: number } | null;
	userOpenSignalCount: number;
}

declare global {
	interface Window {
		readMobileFocusViewTerminalTabLifecycleSnapshot: () => TerminalTabLifecycleSnapshot;
	}
}

test.use({ hasTouch: true, viewport: { width: 390, height: 812 } });

test("手机切换页签保留终端尺寸和挂载，不重复发出用户打开信号，隐藏后停止滚轮长按", async ({ page }) => {
	const terminalInputs: string[] = [];
	const terminalIoSockets = new Map<string, WebSocketRoute>();
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", (socket) => {
		const url = new URL(socket.url());
		if (url.pathname === "/api/terminal/io") {
			terminalIoSockets.set(url.searchParams.get("taskId")!, socket);
			socket.onMessage((message) => terminalInputs.push(String(message)));
		} else if (url.pathname === "/api/terminal/control") {
			socket.send(JSON.stringify({ type: "restore", cols: 40, rows: 20, snapshot: "隔离终端历史\r\n> " }));
		}
	});
	await page.route("**/isolated-mobile-terminal-tab-lifecycle", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-mobile-terminal-tab-lifecycle");
	await page.addScriptTag({
		type: "module",
		content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
	});
	await page.addScriptTag({
		type: "module",
		content: `
			import { getTerminalGeometry } from '/src/terminal/terminal-geometry-registry.ts';
			import { StaleAgentTerminalSessionAutomaticResumeScheduler } from '/src/terminal/stale-agent-terminal-session-automatic-resume-scheduler.ts';
			let userOpenSignalCount = 0;
			const originalEvaluateOnUserOpenSignal = StaleAgentTerminalSessionAutomaticResumeScheduler.prototype.evaluateOnUserOpenSignal;
			StaleAgentTerminalSessionAutomaticResumeScheduler.prototype.evaluateOnUserOpenSignal = function () {
				userOpenSignalCount += 1;
				return originalEvaluateOnUserOpenSignal.call(this);
			};
			window.readMobileFocusViewTerminalTabLifecycleSnapshot = () => ({
				geometry: getTerminalGeometry('mobile-scroll-task-1'),
				userOpenSignalCount,
			});
		`,
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/mobile-focus-view-collapsible-controls-browser-harness.tsx",
	});
	const terminalContainer = page.locator(".kb-terminal-container").first();
	await expect(terminalContainer).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.readMobileFocusViewTerminalTabLifecycleSnapshot().geometry))
		.not.toBeNull();
	await expect.poll(() => terminalIoSockets.size).toBeGreaterThan(0);
	terminalIoSockets.get("mobile-scroll-task-1")!.send("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H隔离终端 TUI");
	await page.waitForTimeout(150);

	const down = page.getByRole("button", { name: "向下滚动，长按加速", exact: true });
	await down.hover();
	await page.mouse.down();
	await page.waitForTimeout(650);
	expect(terminalInputs.join("")).toContain("\u001b[<65;");
	const beforeTabChange = await page.evaluate(() => window.readMobileFocusViewTerminalTabLifecycleSnapshot());
	// 按压仍有效时程序化切页签，确保停止来自交互目标变化，而不是 pointerup。
	await page
		.getByRole("button", { name: "Commands", exact: true })
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(terminalContainer).toBeHidden();
	const inputCountAfterHiding = terminalInputs.length;
	await page.waitForTimeout(550);
	expect(terminalInputs).toHaveLength(inputCountAfterHiding);
	expect(await page.evaluate(() => window.readMobileFocusViewTerminalTabLifecycleSnapshot().geometry)).toEqual(
		beforeTabChange.geometry,
	);
	await page.mouse.up();

	await page.getByRole("button", { name: "Chat", exact: true }).tap();
	await expect(terminalContainer).toBeVisible();
	await page.waitForTimeout(150);
	expect(await page.evaluate(() => window.readMobileFocusViewTerminalTabLifecycleSnapshot().userOpenSignalCount)).toBe(
		beforeTabChange.userOpenSignalCount,
	);
	await down.tap();
	await expect.poll(() => terminalInputs.length).toBeGreaterThan(inputCountAfterHiding);
});
