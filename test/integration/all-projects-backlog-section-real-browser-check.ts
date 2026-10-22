import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Page } from "../../web-ui/node_modules/playwright-core";

export async function runAllProjectsBacklogSectionRealBrowserCheck(input: {
	page: Page;
	webUiOrigin: string;
	alphaWorkspaceId: string;
	betaWorkspaceId: string;
	alphaBacklogTaskId: string;
	betaBacklogTaskId: string;
	alphaFocusTaskId: string;
	betaFocusTaskId: string;
	evidenceOutputDirectory: string;
	readBetaBacklogTask: () => Promise<{ columnId: string; prompt: string }>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
}): Promise<void> {
	const { page, webUiOrigin, alphaWorkspaceId, betaWorkspaceId, evidenceOutputDirectory, observeUntil } = input;
	const checks: string[] = [];
	const section = (suffix: string) => page.getByTestId(`cross-project-task-switcher-section-${suffix}`);
	const backlog = section("backlog");
	const backlogRow = (taskId: string) => backlog.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
	const assertCollapsed = async () => {
		await backlog.getByRole("button", { name: "Expand Backlog", exact: true }).waitFor();
		expect(await backlog.locator("[data-cross-project-task-switcher-task-id]").count()).toBe(0);
	};
	const assertOrder = async (targetPage: Page) => {
		expect(
			await targetPage
				.locator('section[data-testid^="cross-project-task-switcher-section-"]')
				.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid"))),
		).toEqual(
			["pinned", "backlog", "running", "prompt-cache-warm", "remaining"].map(
				(suffix) => `cross-project-task-switcher-section-${suffix}`,
			),
		);
	};
	await page.evaluate(() => {
		localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
		sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
	});
	await page.goto(`${webUiOrigin}/${alphaWorkspaceId}`);
	await assertCollapsed();
	await assertOrder(page);
	expect((await backlog.boundingBox())?.width).toBe(40);
	await page.screenshot({ path: join(evidenceOutputDirectory, "backlog-board-collapsed.png") });
	const toggle = backlog.getByRole("button", { name: "Expand Backlog", exact: true });
	await toggle.focus();
	await toggle.press("Enter");
	expect(
		await backlog
			.getByRole("button", { name: "Collapse Backlog", exact: true })
			.evaluate((element) => element === element.ownerDocument.activeElement),
	).toBe(true);
	await backlogRow(input.alphaBacklogTaskId).waitFor();
	await backlogRow(input.betaBacklogTaskId).waitFor();
	expect(
		await section("pinned")
			.locator(`[data-cross-project-task-switcher-task-id="${input.alphaBacklogTaskId}"]`)
			.count(),
	).toBe(1);
	expect((await backlog.boundingBox())?.width).toBeGreaterThanOrEqual(260);
	expect(await backlogRow(input.betaBacklogTaskId).innerText()).toContain("e2e-project-beta");
	await page.screenshot({ path: join(evidenceOutputDirectory, "backlog-board-expanded.png") });
	checks.push("看板分组顺序、40px 默认折叠、键盘展开保留焦点、跨项目旧待办与置顶副本");

	const initialUrl = page.url();
	await backlogRow(input.betaBacklogTaskId).locator("button").first().click();
	const editor = page.getByRole("dialog").filter({ hasText: "Edit backlog task" });
	await editor.waitFor();
	expect(page.url()).toBe(initialUrl);
	await editor.getByPlaceholder("Describe the task...").fill("跨项目 Backlog 原地编辑已保存");
	await editor.getByRole("button", { name: "Save changes", exact: true }).click();
	await editor.waitFor({ state: "detached" });
	await observeUntil(
		async () => (await input.readBetaBacklogTask()).prompt === "跨项目 Backlog 原地编辑已保存",
		"跨项目编辑保存",
	);
	await backlog.getByRole("button", { name: "Collapse Backlog", exact: true }).waitFor();
	expect(page.url()).toBe(initialUrl);
	checks.push("原地编辑保存后不切项目、不收起 Backlog");

	await section("remaining")
		.locator(`[data-cross-project-task-switcher-task-id="${input.alphaFocusTaskId}"]`)
		.locator("button")
		.first()
		.click();
	await page.getByRole("button", { name: "Back to board", exact: true }).waitFor();
	await assertCollapsed();
	await assertOrder(page);
	await backlog.getByRole("button", { name: "Expand Backlog", exact: true }).click();
	await backlogRow(input.betaBacklogTaskId).waitFor();
	await page.screenshot({ path: join(evidenceOutputDirectory, "backlog-task-focus-expanded.png") });
	// 跨项目导航会经过过渡壳并重挂载面板，这仍然属于同一次 Focus View 访问。
	await section("remaining")
		.locator(`[data-cross-project-task-switcher-task-id="${input.betaFocusTaskId}"]`)
		.locator("button")
		.first()
		.click();
	await observeUntil(
		async () => page.url().includes(`/${betaWorkspaceId}?task=${input.betaFocusTaskId}`),
		"跨项目 Focus 导航",
	);
	await backlog.getByRole("button", { name: "Collapse Backlog", exact: true }).waitFor();
	await backlogRow(input.alphaBacklogTaskId).waitFor();
	await page.getByRole("button", { name: "Back to board", exact: true }).click();
	await assertCollapsed();
	await backlog.getByRole("button", { name: "Expand Backlog", exact: true }).click();
	await page.reload();
	await assertCollapsed();
	checks.push("进入 Focus 和返回看板折叠；同一次 Focus 跨项目导航保留展开；刷新折叠");

	const browser = page.context().browser();
	if (!browser) throw new Error("缺少隔离浏览器");
	const mobileContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		storageState: await page.context().storageState(),
	});
	try {
		const mobilePage = await mobileContext.newPage();
		await mobilePage.goto(`${webUiOrigin}/${alphaWorkspaceId}`);
		await mobilePage.getByTestId("board-scope-all-projects-home-page-stacked-panel-on-mobile").waitFor();
		await assertOrder(mobilePage);
		const mobileBacklog = mobilePage.getByTestId("cross-project-task-switcher-section-backlog");
		await mobileBacklog.getByRole("button", { name: "Expand Backlog", exact: true }).tap();
		await mobileBacklog.locator(`[data-cross-project-task-switcher-task-id="${input.alphaBacklogTaskId}"]`).waitFor();
		const bounds = await mobileBacklog.boundingBox();
		expect(bounds?.x).toBeGreaterThanOrEqual(0);
		expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(391);
		await mobilePage.screenshot({ path: join(evidenceOutputDirectory, "backlog-mobile-expanded.png") });
		await mobilePage.reload();
		await mobileBacklog.getByRole("button", { name: "Expand Backlog", exact: true }).waitFor();
		checks.push("手机竖排同序、触屏展开、无横向溢出、刷新折叠");
	} finally {
		await mobileContext.close();
	}

	await backlog.getByRole("button", { name: "Expand Backlog", exact: true }).click();
	await backlogRow(input.betaBacklogTaskId).locator("button").first().click();
	await editor
		.getByRole("button", { name: /^Save.*start/ })
		.first()
		.click();
	await editor.waitFor({ state: "detached" });
	await observeUntil(async () => (await input.readBetaBacklogTask()).columnId === "in_progress", "Backlog 保存并启动");
	await page.goto(`${webUiOrigin}/${betaWorkspaceId}`);
	await assertCollapsed();
	await backlog.getByRole("button", { name: "Expand Backlog", exact: true }).click();
	expect(await backlogRow(input.betaBacklogTaskId).count()).toBe(0);
	await section("running")
		.locator(`[data-cross-project-task-switcher-task-id="${input.betaBacklogTaskId}"]`)
		.waitFor();
	checks.push("通过编辑器启动任务后推流移出 Backlog 并进入 Running");
	writeFileSync(join(evidenceOutputDirectory, "backlog-browser-results.json"), JSON.stringify({ checks }, null, 2));
}
