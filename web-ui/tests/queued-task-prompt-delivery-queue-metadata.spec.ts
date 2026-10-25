import { expect, type Page, test } from "@playwright/test";

import {
	createQueueBrowserReadResponse,
	QUEUE_BROWSER_ENQUEUED_AT,
	QUEUE_BROWSER_WORKSPACE_ID,
} from "./queued-task-prompt-delivery-queue-browser-fixture";

async function openIsolatedQueue(
	page: Page,
	clipboardMode: "available" | "missing" | "rejected" = "available",
	readMode: "success" | "removed" | "failed" | "pending" = "success",
) {
	await page.addInitScript((mode) => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value:
				mode === "missing"
					? undefined
					: {
							writeText: async (text: string) => {
								if (mode === "rejected") throw new Error("测试浏览器拒绝剪贴板访问");
								document.body.dataset.copiedQueueDebugReference = text;
							},
						},
		});
		document.addEventListener("copy", (event) => {
			document.body.dataset.copiedQueueDebugReference = event.clipboardData?.getData("text/plain") ?? "";
		});
	}, clipboardMode);
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/api/trpc/runtime.getTaskPromptDeliveryQueue?*", async (route) => {
		expect(route.request().headers()["x-kanban-workspace-id"]).toBe(QUEUE_BROWSER_WORKSPACE_ID);
		if (readMode === "failed") return await route.abort();
		if (readMode === "pending") return;
		const response = createQueueBrowserReadResponse();
		if (readMode === "removed") response.queue = { entriesByTaskId: {} };
		await route.fulfill({ contentType: "application/json", body: JSON.stringify([{ result: { data: response } }]) });
	});
	await page.route("**/isolated-queued-prompt-metadata", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-queued-prompt-metadata");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/queued-task-prompt-delivery-queue-browser-harness.tsx" });
	await expect(page.locator("[data-queued-prompt-entry-id]")).toHaveCount(3);
}

for (const width of [320, 390, 900]) {
	test(`${width}px 展示时间摘要、实时更新并复制自动注入引用`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1000 });
		await openIsolatedQueue(page);
		const pending = page.locator('[data-queued-prompt-entry-id="pending-browser-entry"]');
		await expect(pending).toContainText("入队时间");
		await expect(pending).toContainText("尚未尝试");
		await expect(pending.locator("time").first()).toHaveAttribute(
			"datetime",
			new Date(QUEUE_BROWSER_ENQUEUED_AT).toISOString(),
		);
		await page.getByRole("button", { name: "模拟队列推送更新" }).click();
		await expect(pending).toContainText("尝试次数：1");
		await expect(
			pending.locator(`time[datetime="${new Date(QUEUE_BROWSER_ENQUEUED_AT + 120_000).toISOString()}"]`),
		).toBeVisible();
		const expired = page.locator('[data-queued-prompt-entry-id="expired-browser-entry"]');
		await expect(expired).toContainText("过期时间");
		await expect(
			expired.locator(`time[datetime="${new Date(QUEUE_BROWSER_ENQUEUED_AT + 3_600_000).toISOString()}"]`),
		).toBeVisible();
		const automated = page.locator('[data-queued-prompt-entry-id="automated-browser-entry"]');
		await automated.getByRole("button", { name: "调试引用", exact: true }).click();
		await expect(automated.getByRole("textbox", { name: "Prompt Queue 调试引用" })).toHaveValue(
			/browser-automation-key/,
		);
		await automated.getByRole("button", { name: "复制引用与检索指导" }).click();
		await expect(page.locator("body")).toHaveAttribute("data-copied-queue-debug-reference", /automation-origin-task/);
		const reference = await page.locator("body").getAttribute("data-copied-queue-debug-reference");
		for (const value of [
			"owning-board-task",
			"independent-conversation-session",
			"automated-browser-entry",
			"browser-dispatch-key",
			"/isolated-runtime-home/",
			"检索指导",
		])
			expect(reference).toContain(value);
		expect(reference).not.toContain("不应出现在调试引用");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: test.info().outputPath(`queue-metadata-${width}px.png`), fullPage: true });
	});
}

test("缺少 Clipboard API 时真实点击仍可同步复制", async ({ page }) => {
	await openIsolatedQueue(page, "missing");
	const row = page.locator('[data-queued-prompt-entry-id="pending-browser-entry"]');
	await row.getByRole("button", { name: "调试引用", exact: true }).click();
	await row.getByRole("button", { name: "复制引用与检索指导" }).click();
	await expect(page.locator("body")).toHaveAttribute("data-copied-queue-debug-reference", /pending-browser-entry/);
	await expect(row).toContainText("已复制");
});

test("剪贴板被拒绝时保留手动复制入口并提示失败", async ({ page }) => {
	await openIsolatedQueue(page, "rejected");
	const row = page.locator('[data-queued-prompt-entry-id="pending-browser-entry"]');
	await row.getByRole("button", { name: "调试引用", exact: true }).click();
	await row.getByRole("button", { name: "复制引用与检索指导" }).click();
	await expect(row).toContainText("复制失败");
	await expect(row.getByRole("textbox", { name: "Prompt Queue 调试引用" })).toHaveValue(/pending-browser-entry/);
	await expect(row).not.toContainText("已复制");
});

for (const readMode of ["removed", "failed", "pending"] as const) {
	test(`读取 ${readMode} 时仍能复制已知定位字段`, async ({ page }) => {
		await openIsolatedQueue(page, "available", readMode);
		const row = page.locator('[data-queued-prompt-entry-id="pending-browser-entry"]');
		await row.getByRole("button", { name: "调试引用", exact: true }).click();
		await expect(row.getByRole("button", { name: "复制引用与检索指导" })).toBeEnabled({ timeout: 10_000 });
		await row.getByRole("button", { name: "复制引用与检索指导" }).click();
		await expect(page.locator("body")).toHaveAttribute(
			"data-copied-queue-debug-reference",
			/previously_displayed_projection/,
		);
		await expect(row).toContainText(readMode === "removed" ? "已从当前队列移除" : "无法读取当前运行时队列");
	});
}

for (const width of [320, 900]) {
	test(`${width}px 即时注入与启动提示有类型标识、可筛选且不提供重排`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1200 });
		await openIsolatedQueue(page);
		await page.getByRole("button", { name: "模拟即时投递", exact: true }).click();
		await expect(page.locator("[data-queued-prompt-entry-id]")).toHaveCount(5);
		const immediate = page.locator('[data-queued-prompt-entry-id="immediate-browser-injection"]');
		await expect(immediate).toContainText("自动注入");
		await expect(immediate).toContainText("即时");
		await expect(immediate).toContainText("等待提交确认");
		await expect(immediate.getByRole("button", { name: "Move queued prompt up" })).toHaveCount(0);
		await expect(page.locator('[data-queued-prompt-entry-id="startup-browser-unconfirmed"]')).toContainText(
			"未确认送达",
		);
		await expect(page.locator('[data-queued-prompt-entry-id="startup-browser-unconfirmed"]')).toContainText(
			"启动提示",
		);
		await page.getByRole("combobox", { name: "按消息类型筛选" }).selectOption({ label: "自动注入" });
		await expect(page.locator("[data-queued-prompt-entry-id]")).toHaveCount(2);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: test.info().outputPath(`managed-delivery-${width}px.png`), fullPage: true });
	});
}
