import { expect, type Locator, test } from "@playwright/test";

async function visibleBox(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	return box!;
}

for (const width of [1280, 360]) {
	test(`${width}px：两种视图图标提示一致，展开和状态变化不推动标题及元信息横移`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1100 });
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		// 所有请求都与真实运行时隔离；快照不可用场景也只验证真实兜底 UI。
		await page.route("**/api/**", (route) => route.abort());
		await page.routeWebSocket("**/*", () => {});
		await page.route("**/isolated-task-card-layout", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto("/isolated-task-card-layout");
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({
			type: "module",
			url: "/tests/task-card-status-corners-and-metadata-layout-browser-harness.tsx",
		});
		const allProjects = page.locator('[data-layout-host="all-projects"]');
		const row = allProjects.locator("[data-cross-project-task-switcher-task-id]");
		const title = row.locator("[data-cross-project-task-switcher-row-title]:visible, [data-task-card-title]:visible");
		const metadata = row.locator("[data-task-card-secondary-metadata-row]:visible");
		const runningDot = row.locator('[data-task-card-corner-status-indicator="running"]:visible');
		const unreadDot = row.locator('[data-task-card-corner-status-indicator="unread_handoff"]:visible');
		await expect(title).toBeVisible();
		for (const host of [
			allProjects,
			page.locator('[data-layout-host="project-specific"]'),
			page.locator('[data-layout-host="standard-board"]'),
		]) {
			await expect(host.getByRole("button", { name: "部署覆盖：2/5 个已知提交" })).toBeVisible();
		}
		const deploymentIndicator = page
			.locator('[data-layout-host="project-specific"]')
			.getByRole("button", { name: "部署覆盖：2/5 个已知提交" });
		await deploymentIndicator.click();
		const deploymentDetails = page.getByRole("dialog", { name: "当前部署的提交覆盖" });
		await expect(deploymentDetails).toContainText("abcdef123456");
		await expect(page.getByLabel("打开任务次数")).toHaveText("0");
		const deploymentDetailsBox = await visibleBox(deploymentDetails);
		expect(deploymentDetailsBox.x).toBeGreaterThanOrEqual(0);
		expect(deploymentDetailsBox.x + deploymentDetailsBox.width).toBeLessThanOrEqual(width);
		await page.keyboard.press("Escape");
		await expect(deploymentDetails).toBeHidden();
		await expect(runningDot).toHaveCount(1);
		await expect(unreadDot).toHaveCount(1);
		const initialTitle = await visibleBox(title);
		const initialMetadata = await visibleBox(metadata);
		const initialRunningDot = await visibleBox(runningDot);
		const initialUnreadDot = await visibleBox(unreadDot);
		const initialRow = await visibleBox(row);
		expect(Math.abs(initialMetadata.x - initialRow.x - 8)).toBeLessThan(1);
		expect(initialRunningDot.x).toBeLessThan(initialRow.x);
		expect(initialUnreadDot.x + initialUnreadDot.width).toBeGreaterThan(initialRow.x + initialRow.width);

		await row.hover({ position: { x: 45, y: 14 } });
		await expect(row).toHaveAttribute(
			"data-cross-project-task-switcher-row-in-place-expansion-state",
			"expanded_in_place_by_hover",
		);
		for (const [locator, before] of [
			[title, initialTitle],
			[metadata, initialMetadata],
			[runningDot, initialRunningDot],
			[unreadDot, initialUnreadDot],
		] as const) {
			const after = await visibleBox(locator);
			expect(Math.abs(after.x - before.x)).toBeLessThan(1);
			if (locator !== metadata) expect(Math.abs(after.y - before.y)).toBeLessThan(1);
		}
		const sessionActivity = row.locator("[data-task-card-session-activity]");
		expect(Math.abs((await visibleBox(sessionActivity)).x - initialMetadata.x)).toBeLessThan(1);
		await row.getByRole("button", { name: "Keep expanded in list", exact: true }).click();
		await page.mouse.move(width - 5, 5);
		await expect(row).toHaveAttribute(
			"data-cross-project-task-switcher-row-in-place-expansion-state",
			"kept_expanded_in_list",
		);

		await page.screenshot({ path: test.info().outputPath(`task-card-layout-expanded-${width}.png`), fullPage: true });
		for (const mode of ["worktree", "inplace"]) {
			if (mode === "inplace") await page.getByRole("button", { name: "切换工作区类型", exact: true }).click();
			for (const host of [
				allProjects,
				page.locator('[data-layout-host="project-specific"]'),
				page.locator('[data-layout-host="standard-board"]'),
			]) {
				const icon = host.locator(`[data-task-workspace-mode-icon="${mode}"]:visible`);
				// 连续鼠标移动先离开上一个 tooltip 的悬停缓冲区，再进入下一个图标。
				await page.mouse.move(width - 5, 5, { steps: 5 });
				await icon.hover();
				await expect(icon).toHaveAttribute("data-state", /open$/);
				await expect(page.getByRole("tooltip")).toContainText(mode);
				const directory = host
					.locator(
						"[data-task-directory]:visible, [data-cross-project-task-switcher-row-worktree-git-metadata]:visible",
					)
					.first();
				await expect(directory).not.toContainText(/worktree|inplace/);
				await expect(directory).toContainText("+15");
				await expect(directory).toContainText("-4");
			}
		}
		await page.getByRole("button", { name: "切换运行状态", exact: true }).click();
		await expect(runningDot).toHaveCount(0);
		await expect(unreadDot).toHaveCount(1);
		expect(Math.abs((await visibleBox(title)).x - initialTitle.x)).toBeLessThan(1);
		await page.getByRole("button", { name: "切换未读状态", exact: true }).click();
		await expect(page.locator("[data-task-card-corner-status-indicator]:visible")).toHaveCount(0);
		expect(Math.abs((await visibleBox(title)).x - initialTitle.x)).toBeLessThan(1);
		await page.getByRole("button", { name: "切换运行状态", exact: true }).click();
		await page.getByRole("button", { name: "切换未读状态", exact: true }).click();
		await page.getByRole("button", { name: "切换快照可用性", exact: true }).click();
		await expect(row.locator("[data-cross-project-task-switcher-full-task-card-unavailable-fallback]")).toBeVisible();
		await expect(runningDot).toHaveCount(1);
		await expect(unreadDot).toHaveCount(1);
		expect(Math.abs((await visibleBox(title)).x - initialTitle.x)).toBeLessThan(1);
		await page.getByRole("button", { name: "切换快照可用性", exact: true }).click();
		await expect(row.locator("[data-task-card-title]")).toBeVisible();
		await row.hover();
		await row.getByRole("button", { name: "Collapse to compact row", exact: true }).click();
		await expect(row).toHaveAttribute("data-cross-project-task-switcher-row-in-place-expansion-state", "compact_row");
		await row.locator("button").first().click();
		await expect(page.getByLabel("打开任务次数")).toHaveText("1");
		await page.getByRole("button", { name: "模拟部署回滚", exact: true }).click();
		for (const host of [
			allProjects,
			page.locator('[data-layout-host="project-specific"]'),
			page.locator('[data-layout-host="standard-board"]'),
		]) {
			await expect(host.getByRole("button", { name: "部署覆盖：0/5 个已知提交" })).toBeVisible();
		}
		await page.screenshot({ path: test.info().outputPath(`task-card-layout-${width}.png`), fullPage: true });
		expect(pageErrors).toEqual([]);
	});
}
