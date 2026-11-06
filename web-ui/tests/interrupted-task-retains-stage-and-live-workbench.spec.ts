import { expect, type Page, test } from "@playwright/test";

async function openIsolatedInterruptedTask(page: Page, closed = false) {
	const historyRequests: string[] = [];
	await page.route("**/api/**", (route) => {
		if (route.request().url().includes("getTaskConversationHistoryPage")) historyRequests.push(route.request().url());
		return route.abort();
	});
	await page.routeWebSocket("**/*", (socket) => socket.close());
	await page.route("**/isolated-interrupted-task*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-interrupted-task${closed ? "?closed" : ""}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/interrupted-task-retains-stage-and-live-workbench-browser-harness.tsx",
	});
	await expect(page.getByLabel("任务实际所在列")).toHaveText(closed ? "trash" : "in_progress");
	return historyRequests;
}

for (const width of [1440, 390]) {
	test(`${width}px 中断任务保留原列、标题及可续接工作台`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1000 });
		const historyRequests = await openIsolatedInterruptedTask(page);
		for (const host of ["主看板卡片", "Focus View 卡片"]) {
			const title = page.getByRole("region", { name: host }).locator("[data-task-card-title]");
			await expect(title).not.toHaveClass(/line-through/);
			await expect(
				page.getByRole("region", { name: host }).getByRole("button", { name: "重新打开已结案任务" }),
			).toHaveCount(0);
		}
		await page.getByRole("region", { name: "主看板卡片" }).locator("[data-task-card-title]").click();
		await expect(page.getByText("Done · 只读", { exact: false })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "恢复任务", exact: true })).toHaveCount(0);
		await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toBeAttached();
		expect(historyRequests).toEqual([]);
		await page.screenshot({ path: test.info().outputPath("interrupted-task-live-workbench.png") });
	});
}

test("已结案任务的双宿主恢复提示说明复用原工作树", async ({ page }) => {
	await openIsolatedInterruptedTask(page, true);
	for (const host of ["主看板卡片", "Focus View 卡片"]) {
		const region = page.getByRole("region", { name: host });
		await region.hover();
		await region.getByRole("button", { name: "重新打开已结案任务" }).hover();
		await expect(page.getByRole("tooltip")).toContainText("复用原工作树；已清理时从归档恢复");
		await page.mouse.move(0, 0);
	}
});
