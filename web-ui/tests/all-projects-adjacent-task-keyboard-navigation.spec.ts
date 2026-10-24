import { expect, type Page, test } from "@playwright/test";

const recentRowSelector =
	'[data-cross-project-task-switcher-section="remaining"][data-cross-project-task-switcher-task-id]';
let terminalInputBytes: string[];
let pageErrors: string[];
test.beforeEach(async ({ page }) => {
	terminalInputBytes = [];
	pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", (socket) => {
		const url = new URL(socket.url());
		if (url.pathname === "/api/terminal/control")
			socket.send(JSON.stringify({ type: "restore", cols: 60, rows: 24, snapshot: "隔离任务导航终端\r\n> " }));
		if (url.pathname === "/api/terminal/io")
			socket.onMessage((message) => {
				if (typeof message === "string") terminalInputBytes.push(message);
			});
	});
	await page.route("**/isolated-all-projects-task-navigation", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-all-projects-task-navigation");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/all-projects-adjacent-task-keyboard-navigation-browser-harness.tsx",
	});
	await expect(page.locator(".kb-terminal-container .xterm-screen")).toBeVisible();
	await expect(page.getByLabel("当前焦点任务")).toHaveText("a:same");
});
test.afterEach(async ({ page }) => {
	await page.keyboard.up("Alt");
	expect(pageErrors).toEqual([]);
});

async function readRecentOrder(page: Page) {
	return page
		.locator(recentRowSelector)
		.evaluateAll((rows) =>
			rows.map(
				(row) =>
					`${row.getAttribute("data-cross-project-task-switcher-workspace-id")}:${row.getAttribute("data-cross-project-task-switcher-task-id")}`,
			),
		);
}

test("真实终端焦点下跨项目同号任务各切换一次，在途连续切换保持正确游标", async ({ page }) => {
	await page.locator(".kb-terminal-container .xterm-helper-textarea").focus();
	await page.keyboard.down("Alt");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByLabel("当前焦点任务")).toHaveText("b:same");
	await expect(page.getByLabel("导航调用", { exact: true })).toHaveText("b:same");
	await expect(page.getByLabel("旧导航调用次数")).toHaveText("0");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByLabel("当前焦点任务")).toHaveText("a:third");
	await expect(page.getByLabel("导航调用", { exact: true })).toHaveText("b:same,a:third");
	expect(terminalInputBytes).toEqual([]);
});

test("输入框连续切换与跨项目重挂载保持显示顺序，松开 Option 后恢复打开时间排序", async ({ page }) => {
	await page.getByLabel("任务切换输入框").focus();
	await page.keyboard.down("Alt");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByLabel("当前焦点任务")).toHaveText("b:same");
	await page.getByRole("button", { name: "完成项目快照", exact: true }).click();
	await expect(page.locator(".kb-terminal-container .xterm-screen")).toBeVisible();
	await expect.poll(() => readRecentOrder(page)).toEqual(["a:same", "b:same", "a:third"]);
	await expect(page.locator(`${recentRowSelector}:has([aria-current="true"])`)).toHaveAttribute(
		"data-cross-project-task-switcher-workspace-id",
		"b",
	);
	await page.keyboard.press("ArrowDown");
	await expect(page.getByLabel("当前焦点任务")).toHaveText("a:third");
	await page.getByRole("button", { name: "完成项目快照", exact: true }).click();
	await expect(page.locator(".kb-terminal-container .xterm-screen")).toBeVisible();
	await expect.poll(() => readRecentOrder(page)).toEqual(["a:same", "b:same", "a:third"]);
	await page.keyboard.up("Alt");
	await expect.poll(() => readRecentOrder(page)).toEqual(["a:third", "b:same", "a:same"]);
	const focusedRow = await page.locator(`${recentRowSelector}:has([aria-current="true"])`).boundingBox();
	const panel = await page.getByTestId("cross-project-recently-active-task-switcher-panel").boundingBox();
	expect(focusedRow!.y).toBeGreaterThanOrEqual(panel!.y);
	expect(focusedRow!.y + focusedRow!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
	await page.screenshot({ path: test.info().outputPath("all-projects-task-navigation.png") });
});

test("切回单项目后仍使用原阶段列顺序与单一热键所有者", async ({ page }) => {
	await page.getByRole("button", { name: "切换项目范围", exact: true }).click();
	await page.locator(".kb-terminal-container .xterm-helper-textarea").focus();
	await page.keyboard.press("Alt+ArrowDown");
	await expect(page.getByLabel("当前焦点任务")).toHaveText("a:third");
	await expect(page.getByLabel("旧导航调用次数")).toHaveText("1");
	await expect(page.getByLabel("导航调用", { exact: true })).toBeEmpty();
	expect(terminalInputBytes).toEqual([]);
});
