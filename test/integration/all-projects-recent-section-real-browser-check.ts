import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Page } from "../../web-ui/node_modules/playwright-core";

export async function runAllProjectsRecentSectionRealBrowserCheck(input: {
	page: Page;
	webUiOrigin: string;
	alphaWorkspaceId: string;
	betaWorkspaceId: string;
	alphaBacklogTaskId: string;
	betaBacklogTaskId: string;
	olderBacklogTaskId: string;
	expiredBacklogTaskId: string;
	validationTaskId: string;
	doneTaskId: string;
	alphaFocusTaskId: string;
	betaFocusTaskId: string;
	evidenceOutputDirectory: string;
	readBetaBacklogTask: () => Promise<{ columnId: string; prompt: string }>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
}): Promise<void> {
	const { page, webUiOrigin, alphaWorkspaceId, betaWorkspaceId, evidenceOutputDirectory, observeUntil } = input;
	const checks: string[] = [];
	const section = (suffix: string) => page.getByTestId(`cross-project-task-switcher-section-${suffix}`);
	const recent = section("remaining");
	const recentRow = (taskId: string) => recent.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
	const stageFilters = recent.getByRole("group", { name: "Filter recent tasks by stage" });
	const filter = (name: string) => stageFilters.getByRole("button", { name, exact: true });
	const recentTaskIds = () =>
		recent
			.locator("[data-cross-project-task-switcher-task-id]")
			.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-cross-project-task-switcher-task-id")).sort(),
			);
	// 保留真实 DOM 顺序；上面的集合断言会 sort，无法发现排序退化成项目 / Task ID。
	const backlogOrderingFixtureTaskIdsInDisplayOrder = async () =>
		(
			await recent
				.locator("[data-cross-project-task-switcher-task-id]")
				.evaluateAll((elements) =>
					elements.map((element) => element.getAttribute("data-cross-project-task-switcher-task-id")),
				)
		).filter((taskId) =>
			[input.alphaBacklogTaskId, input.betaBacklogTaskId, input.olderBacklogTaskId].some((id) => id === taskId),
		);
	const assertOrder = async (targetPage: Page) => {
		expect(
			await targetPage
				.locator('section[data-testid^="cross-project-task-switcher-section-"]')
				.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid"))),
		).toEqual(
			["pinned", "running", "prompt-cache-warm", "remaining"].map(
				(suffix) => `cross-project-task-switcher-section-${suffix}`,
			),
		);
	};
	await page.evaluate(() => {
		localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
		sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
	});
	await page.goto(`${webUiOrigin}/${alphaWorkspaceId}`);
	await recent.getByRole("button", { name: "Collapse Recent", exact: true }).waitFor();
	await assertOrder(page);
	expect(await filter("In progress / Review").getAttribute("aria-pressed")).toBe("true");
	expect(await filter("All").getAttribute("aria-pressed")).toBe("false");
	expect(await recentRow(input.alphaBacklogTaskId).count()).toBe(0);
	await filter("All").click();
	for (const taskId of [input.alphaBacklogTaskId, input.betaBacklogTaskId, input.validationTaskId, input.doneTaskId]) {
		await recentRow(taskId).waitFor();
	}
	expect(await recentRow(input.olderBacklogTaskId).count()).toBe(0);
	expect(await recentRow(input.expiredBacklogTaskId).count()).toBe(0);
	const initialTaskIds = await recentTaskIds();
	await recent.getByLabel("Order recent tasks by").selectOption("most_recent_conversation_progress_only");
	expect(await recentTaskIds()).toEqual(initialTaskIds);
	await recent
		.getByLabel("Order recent tasks by")
		.selectOption("most_recently_touched_by_conversation_progress_or_user_open_or_description_edit");
	checks.push("四组同序；All 包含近期各阶段；排序切换保留没有对话进展的任务");

	await filter("Backlog").click();
	await recentRow(input.betaBacklogTaskId).waitFor();
	expect(await recentRow(input.validationTaskId).count()).toBe(0);
	expect(await recentRow(input.doneTaskId).count()).toBe(0);
	await recent.getByLabel("Order recent tasks by").selectOption("most_recent_conversation_progress_only");
	expect(await backlogOrderingFixtureTaskIdsInDisplayOrder()).toEqual([
		input.alphaBacklogTaskId,
		input.betaBacklogTaskId,
	]);
	expect(await recent.getByLabel("Order recent tasks by").getAttribute("title")).toContain("Description 更新时间倒序");
	await filter("Done").click();
	await recentRow(input.doneTaskId).waitFor();
	expect(await filter("Backlog").getAttribute("aria-pressed")).toBe("true");
	expect(await filter("Done").getAttribute("aria-pressed")).toBe("true");
	await filter("In progress / Review").click();
	await recentRow(input.alphaFocusTaskId).waitFor();
	await filter("All").click();
	expect(await filter("Backlog").getAttribute("aria-pressed")).toBe("false");
	expect(await filter("All").getAttribute("aria-pressed")).toBe("true");
	await filter("Validation").click();
	expect(await recentTaskIds()).toEqual([input.validationTaskId]);
	await filter("Validation").click();
	expect(await filter("All").getAttribute("aria-pressed")).toBe("true");
	checks.push("阶段多选取并集，In progress / Review 可组合，All 和取消最后一项均重置为全部");

	const projectFilterTrigger = recent.getByRole("button", { name: "Filter recent tasks by project", exact: true });
	await projectFilterTrigger.click();
	const projectChoices = page.getByRole("dialog", { name: "Choose projects for recent tasks" });
	const alphaProjectCheckbox = projectChoices.getByRole("checkbox", { name: /^e2e-project-alpha/ });
	const betaProjectCheckbox = projectChoices.getByRole("checkbox", { name: /^e2e-project-beta/ });
	expect(await projectChoices.getByRole("checkbox", { name: "All projects", exact: true }).isChecked()).toBe(true);
	await alphaProjectCheckbox.check();
	expect(await recentRow(input.betaBacklogTaskId).count()).toBe(0);
	await betaProjectCheckbox.check();
	await recentRow(input.betaBacklogTaskId).waitFor();
	await alphaProjectCheckbox.uncheck();
	expect(await recentRow(input.alphaBacklogTaskId).count()).toBe(0);
	await projectChoices.getByRole("searchbox", { name: "Search projects for recent tasks" }).fill("e2e-project-beta");
	expect(await projectChoices.getByRole("checkbox").count()).toBe(2);
	await page.keyboard.press("Escape");
	await filter("Validation").click();
	expect(await recentTaskIds()).toEqual([]);
	await projectFilterTrigger.click();
	await projectChoices.getByRole("checkbox", { name: "All projects", exact: true }).check();
	await page.keyboard.press("Escape");
	await recentRow(input.validationTaskId).waitFor();
	await filter("All").click();
	checks.push("项目默认全选，可搜索并多选；项目并集与阶段并集取交集，清空项目选择恢复所有项目");

	await recent.getByRole("button", { name: "Show older (last 30 days)", exact: true }).click();
	await recentRow(input.olderBacklogTaskId).waitFor();
	expect(await recentRow(input.expiredBacklogTaskId).count()).toBe(0);
	expect(await backlogOrderingFixtureTaskIdsInDisplayOrder()).toEqual([
		input.alphaBacklogTaskId,
		input.betaBacklogTaskId,
		input.olderBacklogTaskId,
	]);
	for (const [suffix, title] of [
		["remaining", "Recent"],
		["prompt-cache-warm", "Cache warm · your turn"],
	]) {
		const group = section(suffix);
		const toggle = group.getByRole("button", { name: `Collapse ${title}`, exact: true });
		await toggle.focus();
		await toggle.press("Enter");
		expect((await group.boundingBox())?.width).toBe(40);
		const expand = group.getByRole("button", { name: `Expand ${title}`, exact: true });
		expect(await expand.evaluate((element) => element === element.ownerDocument.activeElement)).toBe(true);
		await page.screenshot({ path: join(evidenceOutputDirectory, `${suffix}-board-collapsed.png`) });
		await expand.press("Enter");
		expect((await group.boundingBox())?.width).toBeGreaterThanOrEqual(260);
	}
	await page.screenshot({ path: join(evidenceOutputDirectory, "recent-board-expanded.png") });
	checks.push("统一 7 / 30 天窗口；Recent 与 Cache warm 可收为 40px 窄列，键盘切换保留焦点");

	const initialUrl = page.url();
	await filter("Backlog").click();
	await recentRow(input.betaBacklogTaskId).locator("button").first().click();
	const editor = page.getByRole("dialog").filter({ hasText: "Edit backlog task" });
	await editor.waitFor();
	expect(page.url()).toBe(initialUrl);
	await editor.getByRole("button", { name: "Close", exact: true }).click();
	await editor.waitFor({ state: "detached" });
	expect(await backlogOrderingFixtureTaskIdsInDisplayOrder()).toEqual([
		input.alphaBacklogTaskId,
		input.betaBacklogTaskId,
		input.olderBacklogTaskId,
	]);
	await recentRow(input.betaBacklogTaskId).locator("button").first().click();
	await editor.waitFor();
	await editor.getByPlaceholder("Describe the task...").fill("跨项目 Backlog 原地编辑已保存");
	await editor.getByRole("button", { name: "Save changes", exact: true }).click();
	await editor.waitFor({ state: "detached" });
	await observeUntil(
		async () => (await input.readBetaBacklogTask()).prompt === "跨项目 Backlog 原地编辑已保存",
		"跨项目编辑保存",
	);
	expect(page.url()).toBe(initialUrl);
	const backlogTaskIdsAfterDescriptionEdit = [
		input.betaBacklogTaskId,
		input.alphaBacklogTaskId,
		input.olderBacklogTaskId,
	];
	await observeUntil(
		async () =>
			JSON.stringify(await backlogOrderingFixtureTaskIdsInDisplayOrder()) ===
			JSON.stringify(backlogTaskIdsAfterDescriptionEdit),
		"跨项目 Description 编辑后实时更新排序",
	);
	await page.screenshot({ path: join(evidenceOutputDirectory, "recent-board-backlog-description-order.png") });
	checks.push(
		"Backlog 的 Conversation progress 按 Description 兜底；只打开不重排，编辑保存后实时重排，Show older 沿用顺序",
	);

	await filter("All").click();
	// 点首行标题区域，避开元数据行中独立可交互的工具提示。
	await recentRow(input.alphaFocusTaskId)
		.locator("button")
		.first()
		.click({ position: { x: 12, y: 12 } });
	await page.getByRole("button", { name: "Back to board", exact: true }).waitFor();
	await assertOrder(page);
	await filter("Backlog").click();
	expect(await backlogOrderingFixtureTaskIdsInDisplayOrder()).toEqual(backlogTaskIdsAfterDescriptionEdit);
	await page.screenshot({ path: join(evidenceOutputDirectory, "recent-focus-backlog-description-order.png") });
	await filter("All").click();
	await filter("Done").click();
	await recentRow(input.doneTaskId).waitFor();
	await page.locator("[data-cross-project-focused-task-outside-sections]").waitFor();
	await recent.getByRole("button", { name: "Collapse Recent", exact: true }).click();
	await section("prompt-cache-warm")
		.getByRole("button", { name: "Collapse Cache warm · your turn", exact: true })
		.click();
	await page.screenshot({ path: join(evidenceOutputDirectory, "recent-focus-collapsed-with-focused-task.png") });
	await page.getByRole("button", { name: "Back to board", exact: true }).click();
	await recent.getByRole("button", { name: "Expand Recent", exact: true }).click();
	expect(await filter("Done").getAttribute("aria-pressed")).toBe("true");
	await filter("All").click();
	await recentRow(input.betaFocusTaskId)
		.locator("button")
		.first()
		.click({ position: { x: 12, y: 12 } });
	await observeUntil(
		async () => page.url().includes(`/${betaWorkspaceId}?task=${input.betaFocusTaskId}`),
		"跨项目 Focus 导航",
	);
	await section("prompt-cache-warm")
		.getByRole("button", { name: "Expand Cache warm · your turn", exact: true })
		.waitFor();
	await page.reload();
	await recent.getByRole("button", { name: "Collapse Recent", exact: true }).waitFor();
	expect(await filter("In progress / Review").getAttribute("aria-pressed")).toBe("true");
	await section("prompt-cache-warm")
		.getByRole("button", { name: "Collapse Cache warm · your turn", exact: true })
		.waitFor();
	expect(await recent.getByLabel("Order recent tasks by").inputValue()).toBe("most_recent_conversation_progress_only");
	await filter("All").click();
	await filter("Backlog").click();
	await recentRow(input.betaBacklogTaskId).waitFor();
	await recentRow(input.alphaBacklogTaskId).waitFor();
	expect(await backlogOrderingFixtureTaskIdsInDisplayOrder()).toEqual(backlogTaskIdsAfterDescriptionEdit.slice(0, 2));
	await filter("All").click();
	await filter("In progress / Review").click();
	checks.push("Focus 筛选外任务保留独立焦点卡；跨视图与跨项目保留筛选和折叠，刷新恢复默认");

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
		const mobileRecent = mobilePage.getByTestId("cross-project-task-switcher-section-remaining");
		const mobileFilters = mobileRecent.getByRole("group", { name: "Filter recent tasks by stage" });
		expect(
			await mobileFilters
				.getByRole("button", { name: "In progress / Review", exact: true })
				.getAttribute("aria-pressed"),
		).toBe("true");
		await mobileFilters.getByRole("button", { name: "All", exact: true }).tap();
		await mobileFilters.getByRole("button", { name: "Backlog", exact: true }).tap();
		await mobileFilters.getByRole("button", { name: "Done", exact: true }).tap();
		await mobileRecent.locator(`[data-cross-project-task-switcher-task-id="${input.doneTaskId}"]`).waitFor();
		const bounds = await mobileRecent.boundingBox();
		expect(bounds?.x).toBeGreaterThanOrEqual(0);
		expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(391);
		await mobilePage.screenshot({ path: join(evidenceOutputDirectory, "recent-mobile-stage-combination.png") });
		await mobileRecent.getByRole("button", { name: "Collapse Recent", exact: true }).tap();
		await mobileRecent.getByRole("button", { name: "Expand Recent", exact: true }).tap();
		await mobilePage.reload();
		expect(
			await mobileFilters
				.getByRole("button", { name: "In progress / Review", exact: true })
				.getAttribute("aria-pressed"),
		).toBe("true");
		checks.push("手机触屏阶段多选、展开收起与刷新默认，无横向溢出");
	} finally {
		await mobileContext.close();
	}

	writeFileSync(join(evidenceOutputDirectory, "recent-browser-results.json"), JSON.stringify({ checks }, null, 2));
}
