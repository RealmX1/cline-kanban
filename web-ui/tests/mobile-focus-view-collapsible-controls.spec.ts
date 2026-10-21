import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";

test.use({ hasTouch: true });
const upLabel = "向上滚动，长按加速";
const downLabel = "向下滚动，长按加速";
async function openIsolatedMobileFocusView(page: Page, width: number) {
	await page.setViewportSize({ width, height: 812 });
	await page.route("**/api/**", (route) => route.abort());
	const ioSockets = new Map<string, WebSocketRoute>();
	const receivedInputs: string[] = [];
	const receivedInputTimes: number[] = [];
	await page.routeWebSocket("**/*", (socket) => {
		const url = new URL(socket.url());
		if (url.pathname === "/api/terminal/io") {
			ioSockets.set(url.searchParams.get("taskId")!, socket);
			socket.onMessage((message) => {
				receivedInputs.push(String(message));
				receivedInputTimes.push(Date.now());
			});
		} else if (url.pathname === "/api/terminal/control") {
			socket.send(
				JSON.stringify({
					type: "restore",
					cols: 40,
					rows: 20,
					snapshot: `${Array.from({ length: 200 }, (_, index) => `历史输出 ${index} abcdefghijklmnopqrstuvwxyz`).join("\r\n")}\r\n> `,
				}),
			);
		}
	});
	await page.route("**/isolated-mobile-focus-view-controls", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-mobile-focus-view-controls");
	await page.addScriptTag({
		type: "module",
		content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/mobile-focus-view-collapsible-controls-browser-harness.tsx",
	});
	await expect(page.locator(".xterm-screen").first()).toBeVisible();
	await expect.poll(() => ioSockets.size).toBeGreaterThan(0);
	return { ioSockets, receivedInputs, receivedInputTimes };
}

for (const width of [320, 375, 390, 768]) {
	test(`${width}px 三个区域独立展开且滚轮始终可达`, async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await openIsolatedMobileFocusView(page, width);
		const card = page.locator("[data-task-card-render-role='focused_task_card_copy_in_mobile_detail_header']");
		const bar = page.locator("[data-terminal-virtual-key-input-bar]");
		await expect(card).toHaveCount(0);
		await expect(bar).toHaveCount(0);
		await expect(page.locator("[data-mobile-focus-view-global-navigation]")).toBeHidden();
		await page.screenshot({ path: test.info().outputPath(`mobile-default-collapsed-${width}.png`) });
		await expect(page.locator("[data-mobile-terminal-floating-scroll-controls]")).toBeVisible();
		await expect(page.getByRole("button", { name: upLabel })).toBeVisible();
		await expect(page.getByRole("button", { name: downLabel })).toBeVisible();
		await page.getByRole("button", { name: "展开下方按键栏", exact: true }).tap();
		await expect(bar).toBeVisible();
		await expect(card).toHaveCount(0);
		await expect(page.locator("[data-mobile-focus-view-global-navigation]")).toBeHidden();
		await page.getByRole("button", { name: "展开任务卡", exact: true }).tap();
		await expect(card).toBeVisible();
		await expect(page.locator("[data-mobile-focus-view-global-navigation]")).toBeHidden();
		await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).tap();
		await expect(page.getByRole("button", { name: "Commands", exact: true })).toBeVisible();
		const measurements = await page.evaluate(() => {
			const screen = document.querySelector(".kb-terminal-container")!.getBoundingClientRect();
			const wheel = document
				.querySelector("[data-terminal-virtual-key-input-bar] [aria-label='滚轮滚动']")!
				.getBoundingClientRect();
			return {
				documentWidth: document.documentElement.scrollWidth,
				screenHeight: screen.height,
				wheelRight: wheel.right,
			};
		});
		expect(measurements.documentWidth).toBeLessThanOrEqual(width);
		expect(measurements.screenHeight).toBeGreaterThan(40);
		expect(measurements.wheelRight).toBeLessThanOrEqual(width);
		expect(errors).toEqual([]);
		await page.screenshot({ path: test.info().outputPath(`mobile-independent-controls-${width}.png`) });
	});
}

test("真实 xterm 普通历史滚动、TUI 鼠标滚轮协议及长按停止", async ({ page }) => {
	const fixture = await openIsolatedMobileFocusView(page, 390);
	const latest = page.getByRole("button", { name: "Scroll to latest output", exact: true });
	if (await latest.isVisible()) await latest.click();
	await expect(latest).toBeHidden();
	await page.getByRole("button", { name: upLabel }).tap();
	await expect(latest).toBeVisible();
	// 保留真实 xterm 与生产滚轮入口，只替换 WS 对端，验证 SGR 上下滚轮字节。
	fixture.ioSockets.get("mobile-scroll-task-1")!.send("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H移动端 TUI");
	await page.waitForTimeout(150);
	fixture.receivedInputs.length = 0;
	await page.getByRole("button", { name: downLabel }).tap();
	await expect.poll(() => fixture.receivedInputs.join("")).toContain("\u001b[<65;");
	const up = page.getByRole("button", { name: upLabel });
	await up.hover();
	await page.mouse.down();
	await page.waitForTimeout(800);
	await page.mouse.up();
	const countAfterRelease = fixture.receivedInputs.length;
	expect(fixture.receivedInputs.join("")).toContain("\u001b[<64;");
	expect(countAfterRelease).toBeGreaterThan(3);
	await page.waitForTimeout(200);
	expect(fixture.receivedInputs).toHaveLength(countAfterRelease);
	// 关闭鼠标协议后，alternate buffer 仍走 xterm 的原生方向序列兜底。
	fixture.ioSockets.get("mobile-scroll-task-1")!.send("\x1b[?1000l\x1b[?1006l");
	await page.waitForTimeout(150);
	fixture.receivedInputs.length = 0;
	await page.getByRole("button", { name: upLabel }).tap();
	await page.getByRole("button", { name: downLabel }).tap();
	await expect.poll(() => fixture.receivedInputs.join("")).toContain("\x1b[A");
	await expect.poll(() => fixture.receivedInputs.join("")).toContain("\x1b[B");
	expect(fixture.receivedInputs.join("")).not.toContain("\x1b[<");
	expect(await page.evaluate(() => window.mobileFocusViewTerminalBrowserTest.readViewport().bufferType)).toBe(
		"alternate",
	);
});

test.describe("小数像素行高下的真实终端滚轮步长", () => {
	test.use({ deviceScaleFactor: 1.25 });
	for (const lineHeight of [1, 1.3, 1.7]) {
		test(`真实 xterm 行高 ${lineHeight} 时，每次滚轮按压及长按步骤恰好滚动三行`, async ({ page }) => {
			await openIsolatedMobileFocusView(page, 390);
			const readViewport = () => page.evaluate(() => window.mobileFocusViewTerminalBrowserTest.readViewport());
			await page.evaluate((height) => window.mobileFocusViewTerminalBrowserTest.setLineHeight(height), lineHeight);
			await expect.poll(async () => (await readViewport()).baseY).toBeGreaterThan(100);
			await page.waitForTimeout(150);
			const initialViewport = await readViewport();
			expect(initialViewport.bufferType).toBe("normal");
			const steps: number[] = [];
			for (const direction of [-1, 1]) {
				for (let step = 0; step < 20; step += 1) {
					const before = await readViewport();
					await page.getByRole("button", { name: direction < 0 ? upLabel : downLabel }).tap();
					await expect.poll(async () => (await readViewport()).viewportY).toBe(before.viewportY + direction * 3);
					steps.push((await readViewport()).viewportY - before.viewportY);
				}
			}
			const longPressViewportChanges: number[] = [];
			await page.exposeFunction("recordMobileFocusViewTerminalViewport", (viewportY: number) => {
				longPressViewportChanges.push(viewportY);
			});
			await page.evaluate(() => {
				const screen = document.querySelector(".xterm-screen")!;
				screen.addEventListener("wheel", () => {
					requestAnimationFrame(() => {
						const recorder = window as unknown as {
							recordMobileFocusViewTerminalViewport: (viewportY: number) => void;
						};
						recorder.recordMobileFocusViewTerminalViewport(
							window.mobileFocusViewTerminalBrowserTest.readViewport().viewportY,
						);
					});
				});
			});
			await page.getByRole("button", { name: upLabel }).hover();
			await page.mouse.down();
			await page.waitForTimeout(900);
			await page.mouse.up();
			await page.waitForTimeout(100);
			expect(longPressViewportChanges.length).toBeGreaterThan(3);
			let previousViewportY = initialViewport.viewportY;
			for (const viewportY of longPressViewportChanges) {
				expect(viewportY - previousViewportY).toBe(-3);
				previousViewportY = viewportY;
			}
			await test.info().attach("真实终端逐步行数", {
				body: JSON.stringify({
					lineHeight,
					renderer: initialViewport.renderer,
					rowHeight: initialViewport.rowHeight,
					steps,
					longPressViewportChanges,
				}),
				contentType: "application/json",
			});
		});
	}
});

test("真实视图共用闲置收起，长按超过30秒不收起，换任务复位", async ({ page }) => {
	const start = new Date("2030-01-01T00:00:00Z");
	await page.clock.install({ time: start });
	await page.clock.pauseAt(new Date(start.getTime() + 1000));
	await openIsolatedMobileFocusView(page, 390);
	await page.getByRole("button", { name: "展开任务卡", exact: true }).tap();
	await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).tap();
	await page.getByRole("button", { name: "展开下方按键栏", exact: true }).tap();
	await page.clock.runFor(30_001);
	await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toHaveCount(0);
	await expect(
		page.locator("[data-task-card-render-role='focused_task_card_copy_in_mobile_detail_header']"),
	).toHaveCount(0);
	await expect(page.locator("[data-mobile-focus-view-global-navigation]")).toBeHidden();
	await page.getByRole("button", { name: "展开下方按键栏", exact: true }).tap();
	await page.getByRole("button", { name: downLabel }).hover();
	await page.mouse.down();
	await page.clock.runFor(31_000);
	await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toBeVisible();
	await page.mouse.up();
	await page.clock.runFor(30_001);
	await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toHaveCount(0);
	await page.locator("[data-switch-browser-test-task]").evaluate((element) => (element as HTMLButtonElement).click());
	await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toHaveCount(0);
	await expect(page.locator("[data-mobile-focus-view-global-navigation]")).toBeHidden();
	await expect(page.getByRole("button", { name: "展开任务卡", exact: true })).toBeVisible();
});

test("桌面保持原视图且无手机滚轮悬浮栏", async ({ page }) => {
	await openIsolatedMobileFocusView(page, 1280);
	await expect(page.locator("[data-mobile-focused-task-card-header]")).toHaveCount(0);
	await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toHaveCount(0);
	await expect(page.locator("[data-mobile-terminal-floating-scroll-controls]")).toHaveCount(0);
});

test("阅读视图滚动当前文档，不向隐藏 TUI 发送输入", async ({ page }) => {
	const fixture = await openIsolatedMobileFocusView(page, 390);
	await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).tap();
	await page.getByRole("button", { name: "Read the transcript as a document", exact: true }).tap();
	const documentScroller = page.locator(".kb-terminal-transcript-reader-scroll-area");
	await expect.poll(() => documentScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await page.getByRole("button", { name: "收起上方导航与工具", exact: true }).tap();
	await expect(page.getByRole("textbox", { name: "Filter transcript lines" })).toBeHidden();
	const original = await documentScroller.evaluate((element) => element.scrollTop);
	const inputCount = fixture.receivedInputs.length;
	await page.getByRole("button", { name: upLabel }).tap();
	await expect.poll(() => documentScroller.evaluate((element) => element.scrollTop)).toBeLessThan(original);
	expect(fixture.receivedInputs).toHaveLength(inputCount);
});

test("软键盘缩小可视窗口后，常驻滚动与展开按钮仍可见", async ({ page }) => {
	await openIsolatedMobileFocusView(page, 390);
	await page.evaluate(() => {
		Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 420 });
		window.visualViewport!.dispatchEvent(new Event("resize"));
	});
	await expect
		.poll(async () => (await page.getByRole("button", { name: "展开下方按键栏", exact: true }).boundingBox())!.y)
		.toBeLessThan(376);
	await expect(page.getByRole("button", { name: upLabel })).toBeVisible();
});

test("手机虚拟双 ESC 一次点按经真实 xterm 形成两次独立投递", async ({ page }) => {
	const fixture = await openIsolatedMobileFocusView(page, 390);
	await page.getByRole("button", { name: "展开下方按键栏", exact: true }).tap();
	fixture.receivedInputs.length = 0;
	fixture.receivedInputTimes.length = 0;
	await page.getByRole("button", { name: "Open the rewind history view (double escape)", exact: true }).tap();
	await expect.poll(() => fixture.receivedInputs).toEqual(["\u001b", "\u001b"]);
	expect(fixture.receivedInputTimes[1]! - fixture.receivedInputTimes[0]!).toBeGreaterThanOrEqual(75);
	await page.waitForTimeout(200);
	expect(fixture.receivedInputs).toHaveLength(2);
});

for (const wheelInput of ["物理滚轮", "虚拟滚轮触屏", "虚拟滚轮读屏"] as const) {
	test(`${wheelInput}的真实 xterm SGR 输入取消双 ESC 的第二步`, async ({ page }) => {
		const fixture = await openIsolatedMobileFocusView(page, 390);
		await page.getByRole("button", { name: "展开下方按键栏", exact: true }).tap();
		fixture.ioSockets.get("mobile-scroll-task-1")!.send("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H滚轮取消双 ESC");
		await expect
			.poll(() => page.evaluate(() => window.mobileFocusViewTerminalBrowserTest.readScreenText()))
			.toContain("滚轮取消双 ESC");
		// 固定浏览器计时，保证滚轮在两次 ESC 的 100ms 间隔内介入。
		const start = new Date("2030-01-01T00:00:00Z");
		await page.clock.install({ time: start });
		await page.clock.pauseAt(new Date(start.getTime() + 1000));
		fixture.receivedInputs.length = 0;
		await page.getByRole("button", { name: "Open the rewind history view (double escape)", exact: true }).tap();
		await expect.poll(() => fixture.receivedInputs).toEqual(["\x1b"]);
		await page.clock.runFor(50);
		if (wheelInput === "物理滚轮") {
			await page.locator(".xterm-screen").first().hover();
			await page.mouse.wheel(0, 120);
		} else if (wheelInput === "虚拟滚轮触屏") {
			await page.getByRole("button", { name: downLabel }).tap();
		} else {
			// 读屏激活没有 keydown 或 pointerdown；必须由真实滚轮事件取消。
			await page.getByRole("button", { name: downLabel }).evaluate((button: HTMLButtonElement) => button.click());
		}
		await expect.poll(() => fixture.receivedInputs.join("")).toContain("\x1b[<65;");
		const inputsAfterWheel = [...fixture.receivedInputs];
		expect(inputsAfterWheel[0]).toBe("\x1b");
		await page.clock.runFor(1000);
		expect(fixture.receivedInputs).toEqual(inputsAfterWheel);
		expect(fixture.receivedInputs.filter((input) => input === "\x1b")).toEqual(["\x1b"]);
	});
}
