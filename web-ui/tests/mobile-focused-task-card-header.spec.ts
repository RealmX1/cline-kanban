import { expect, type Page, test } from "@playwright/test";

test.use({ hasTouch: true });

async function openIsolatedTaskCard(page: Page, width: number) {
	await page.setViewportSize({ width, height: 812 });
	await page.addInitScript(() =>
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async (text: string) => {
					document.body.dataset.copiedTaskDirectory = text;
				},
				write: async (items: ClipboardItem[]) => {
					document.body.dataset.copiedTaskDirectory = await (await items[0].getType("text/plain")).text();
				},
			},
		}),
	);
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-mobile-focused-task-card", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-mobile-focused-task-card");
	await page.addScriptTag({
		type: "module",
		content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
	});
	await page.addScriptTag({ type: "module", url: "/tests/mobile-focused-task-card-header-browser-harness.tsx" });
}

for (const width of [375, 390, 768]) {
	test(`${width}px 完整任务卡可触控、无横向溢出且保留会话空间`, async ({ page }) => {
		await openIsolatedTaskCard(page, width);
		const header = page.locator("[data-mobile-focused-task-card-header]");
		const card = header.locator("[data-task-card-render-role='focused_task_card_copy_in_mobile_detail_header']");
		await expect(card).toBeVisible();
		for (const selector of [
			"[data-agent-badge]",
			"[data-agent-response-generation-stopped-pill]",
			"[data-last-conversation-progress-pill]",
			"[data-task-directory]",
			"[data-task-pinboard-pinned-marker]",
		])
			await expect(card.locator(selector)).toBeVisible();
		await expect(card).not.toHaveAttribute("data-task-id");
		await expect(card).not.toHaveAttribute("data-verification-anchor");
		const measurements = await page.evaluate(() => {
			const root = document.querySelector("[data-focus-view-browser-root]")!.getBoundingClientRect();
			const header = document.querySelector("[data-mobile-focused-task-card-header]")!.getBoundingClientRect();
			const content = document.querySelector("[data-agent-content]")!.getBoundingClientRect();
			return {
				rootHeight: root.height,
				headerHeight: header.height,
				contentHeight: content.height,
				width: innerWidth,
				documentWidth: document.documentElement.scrollWidth,
			};
		});
		expect(measurements.documentWidth).toBeLessThanOrEqual(width);
		expect(measurements.headerHeight).toBeLessThanOrEqual(measurements.rootHeight * 0.4 + 1);
		expect(measurements.contentHeight).toBeGreaterThan(measurements.rootHeight * 0.5);
		const edit = card.getByRole("button", { name: "Edit task title" });
		for (const button of await card.getByRole("button").all()) {
			const box = await button.boundingBox();
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect(box!.width).toBeGreaterThanOrEqual(44);
		}
		await edit.tap();
		await card.locator("textarea").fill("手机修改后的任务标题");
		await card.locator("textarea").press("Enter");
		await expect(card).toContainText("手机修改后的任务标题");
		await page.getByRole("button", { name: "Commands", exact: true }).tap();
		await expect(card).toBeVisible();
		await card.getByRole("button", { name: "Copy directory path" }).tap();
		await expect(page.locator("body")).toHaveAttribute(
			"data-copied-task-directory",
			/very-long-project-directory-name/,
		);
		await card.getByRole("button", { name: "Move task to validation" }).tap();
		await expect(page.getByLabel("动作结果")).toHaveText("validation:mobile-task-1");
		await card.getByRole("button", { name: "View original prompt" }).tap();
		await page.getByRole("menuitem", { name: "查看原始 Prompt", exact: true }).tap();
		await expect(page.getByRole("dialog")).toContainText("手机上的原始任务需求");
		await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().tap();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.getByRole("button", { name: "收起任务卡", exact: true }).tap();
		await expect(card).toHaveCount(0);
		await expect(header).toContainText("手机修改后的任务标题");
		await expect(header).toContainText("Review");
		await page.getByRole("button", { name: "切换任务", exact: true }).tap();
		await expect(card).toBeVisible();
		await expect(card).toContainText("手机修改后的任务标题");
		await page.screenshot({ path: test.info().outputPath(`mobile-task-card-${width}.png`) });
	});
}

test("真实组件共用 30 秒收起通知，编辑和 Portal 弹窗暂停", async ({ page }) => {
	const clockStart = new Date("2030-01-01T00:00:00Z");
	await page.clock.install({ time: clockStart });
	await page.clock.pauseAt(new Date(clockStart.getTime() + 1_000));
	await openIsolatedTaskCard(page, 390);
	const card = page.locator("[data-task-card-render-role='focused_task_card_copy_in_mobile_detail_header']");
	await expect(card).toBeVisible();
	await page.getByLabel("Agent 输入").focus();
	await page.clock.runFor(30_001);
	await expect(card).toHaveCount(0);
	await expect(page.locator("[data-shared-idle-collapse-sequence]")).toHaveText("1");
	await page.getByRole("button", { name: "展开任务卡", exact: true }).tap();
	await card.getByRole("button", { name: "Edit task title" }).tap();
	await page.clock.runFor(60_000);
	await expect(card.locator("textarea")).toBeVisible();
	await card.locator("textarea").press("Escape");
	await card.getByRole("button", { name: "View original prompt" }).tap();
	await page.clock.runFor(60_000);
	await expect(card).toBeVisible();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.getByRole("menuitem", { name: "查看原始 Prompt", exact: true }).tap();
	await page.clock.runFor(60_000);
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().tap();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByLabel("Agent 输入").focus();
	await page.clock.runFor(29_999);
	await expect(card).toBeVisible();
	await page.clock.runFor(2);
	await expect(card).toHaveCount(0);
});

test("桌面断点不展示手机任务卡", async ({ page }) => {
	await openIsolatedTaskCard(page, 1280);
	await expect(page.locator("[data-desktop-layout]")).toBeVisible();
	await expect(page.locator("[data-mobile-focused-task-card-header]")).toHaveCount(0);
});
