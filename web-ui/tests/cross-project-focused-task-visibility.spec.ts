import { expect, type Page, test } from "@playwright/test";

const scrollContainerSelector = '[data-testid="cross-project-recently-active-task-switcher-panel"]';
const anchorSelector = "[data-cross-project-focused-task-scroll-anchor]";
const stickySelector = "[data-cross-project-focused-task-sticky-edge]";
let pageErrors: string[];

test.beforeEach(async ({ page }) => {
	pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		// 所有 API 均截获，绝不转发 Vite 默认代理到真实 runtime；本场景只允许只读请求。
		expect(route.request().method()).toBe("GET");
		const procedures = new URL(route.request().url()).pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const results = procedures.map((procedure) => ({
			result: {
				data:
					procedure === "projects.getAllProjectsTaskSearchIndex"
						? {
								projects: [
									{
										projectId: "project-b",
										projectName: "project-b",
										tasks: [
											{
												taskId: "outside",
												title: "跨项目同号目标任务",
												prompt: "另一个项目的原始需求",
												columnId: "trash",
												createdAt: 1,
												updatedAt: 1,
												agentId: "codex",
												mostRecentlyLaunchedAgentSessionAgentId: "codex",
												agentConversationProgressObservedAt: null,
											},
										],
									},
								],
							}
						: procedure === "taskCardAction.readTaskCardWithBoardColumn"
							? { taskCardLookupOutcome: "task_card_not_found_on_workspace_board" }
							: { tasks: [] },
			},
		}));
		await route.fulfill({ json: results });
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-cross-project-focused-task", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-cross-project-focused-task");
	await page.addScriptTag({
		type: "module",
		content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
	});
	await page.addScriptTag({ type: "module", url: "/tests/cross-project-focused-task-visibility-browser-harness.tsx" });
	await expect(page.getByRole("button", { name: "Search tasks", exact: true })).toBeVisible();
	await expect(page.locator(anchorSelector)).toHaveCount(1);
	await expect.poll(() => pageErrors).toEqual([]);
});

test.afterEach(() => expect(pageErrors).toEqual([]));

async function searchAndOpen(page: Page, title: string, includeOtherProjects = false) {
	await page.getByRole("button", { name: "Search tasks", exact: true }).click();
	const dialog = page.locator("[data-task-spotlight-search-dialog]");
	if (includeOtherProjects) await dialog.getByRole("switch", { name: "All projects", exact: true }).check();
	await page.getByPlaceholder("Search tasks", { exact: true }).fill(title);
	await dialog.getByRole("button").filter({ hasText: title }).click();
	await expect(dialog).toHaveCount(0);
	await page.mouse.move(1000, 700);
}

async function setPanelScroll(page: Page, scrollTop: number | "end") {
	await page.locator(scrollContainerSelector).evaluate((element, value) => {
		element.scrollTop = value === "end" ? element.scrollHeight : value;
		element.dispatchEvent(new Event("scroll"));
	}, scrollTop);
}

test("真实搜索打开分组外任务，Sticky 顶沿保留卡片动作和 Portal，点击卡体返回源位置", async ({ page }) => {
	await searchAndOpen(page, "分组外目标任务");
	const fallback = page.locator("[data-cross-project-focused-task-outside-sections]");
	await expect(fallback).toBeVisible();
	await expect(fallback).toContainText("分组外目标任务");
	await expect(fallback).toContainText("project-a");
	await expect(fallback).toContainText("Review");
	await expect(fallback.locator("[data-task-id], [data-verification-anchor]")).toHaveCount(0);
	await expect(page.locator(stickySelector)).toHaveCount(0);
	await setPanelScroll(page, "end");
	const sticky = page.locator(stickySelector);
	await expect(sticky).toHaveAttribute("data-cross-project-focused-task-sticky-edge", "top");
	await expect(fallback).toHaveCSS("visibility", "hidden");
	const geometry = await fallback.boundingBox();
	const pinnedGeometry = await sticky.boundingBox();
	const viewport = await page.locator(scrollContainerSelector).boundingBox();
	expect(geometry!.height).toBeGreaterThan(0);
	expect(Math.abs(pinnedGeometry!.y - viewport!.y)).toBeLessThan(2);
	await page.screenshot({ path: test.info().outputPath("outside-task-sticky-top.png") });
	await sticky.hover();
	await sticky.getByRole("button", { name: "Move task to validation", exact: true }).click();
	await expect(page.getByLabel("动作结果")).toHaveText("validation:project-a:outside");
	await expect(sticky).toBeVisible();
	await sticky.getByRole("button", { name: "View original prompt", exact: true }).click();
	await expect(page.getByRole("dialog")).toContainText("原始任务需求：分组外目标任务");
	await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
	await expect(sticky).toBeVisible();
	await sticky.getByRole("button", { name: "返回当前任务所在位置", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(sticky).toHaveCount(0);
	await expect(fallback).toBeVisible();
	await expect(page.getByLabel("当前打开任务")).toContainText("project-a:outside");
	await setPanelScroll(page, "end");
	await expect(sticky).toBeVisible();
	await sticky.locator("[data-task-card-title]").click();
	await expect(sticky).toHaveCount(0);
	await expect(fallback).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("outside-task-visible.png") });
});

test("组内任务上下触边、大幅滚动跳转与回到视口，始终只有一个测量源和一份 Sticky", async ({ page }) => {
	await page.getByRole("button", { name: "打开组内任务", exact: true }).click();
	await setPanelScroll(page, 0);
	await expect(page.locator(stickySelector)).toHaveAttribute("data-cross-project-focused-task-sticky-edge", "bottom");
	const viewport = await page.locator(scrollContainerSelector).boundingBox();
	const bottom = await page.locator(stickySelector).boundingBox();
	expect(Math.abs(bottom!.y + bottom!.height - viewport!.y - viewport!.height)).toBeLessThan(2);
	await page.screenshot({ path: test.info().outputPath("grouped-task-sticky-bottom.png") });
	await setPanelScroll(page, "end");
	await expect(page.locator(stickySelector)).toHaveAttribute("data-cross-project-focused-task-sticky-edge", "top");
	await page.locator(stickySelector).getByRole("button", { name: "返回当前任务所在位置", exact: true }).click();
	await expect(page.locator(stickySelector)).toHaveCount(0);
	await expect(page.locator(anchorSelector)).toBeVisible();
	await page.locator(scrollContainerSelector).evaluate((root) => {
		const anchor = root.querySelector<HTMLElement>("[data-cross-project-focused-task-scroll-anchor]")!;
		root.scrollTop += anchor.getBoundingClientRect().top - root.getBoundingClientRect().top + 1;
		root.dispatchEvent(new Event("scroll"));
	});
	await expect(page.locator(stickySelector)).toHaveAttribute("data-cross-project-focused-task-sticky-edge", "top");
	await expect(page.locator(anchorSelector)).toHaveCount(1);
	await expect(page.locator(stickySelector)).toHaveCount(1);
});

test("动态归组移除独立区、重新挂载保留滚动与焦点副本，收起组仍保留定位行", async ({ page }) => {
	await searchAndOpen(page, "分组外目标任务");
	await page.getByRole("button", { name: "移入 Recent", exact: true }).click();
	await expect(page.locator("[data-cross-project-focused-task-outside-sections]")).toHaveCount(0);
	await expect(page.locator(anchorSelector)).toHaveCount(1);
	await expect(page.locator(anchorSelector)).toHaveAttribute("data-cross-project-task-switcher-section", "remaining");
	await setPanelScroll(page, "end");
	const scrollTopBeforeRemount = await page.locator(scrollContainerSelector).evaluate((element) => element.scrollTop);
	await page.getByRole("button", { name: "重新挂载左栏", exact: true }).click();
	await expect
		.poll(() => page.locator(scrollContainerSelector).evaluate((element) => element.scrollTop))
		.toBe(scrollTopBeforeRemount);
	await expect(page.locator(stickySelector)).toHaveAttribute("data-cross-project-focused-task-sticky-edge", "top");
	await page.getByRole("button", { name: "打开收起任务", exact: true }).click();
	const running = page.getByTestId("cross-project-task-switcher-section-running");
	await expect(running.getByRole("button", { name: /Running/ })).toHaveAttribute("aria-expanded", "false");
	await expect(running.locator(anchorSelector)).toBeVisible();
	await page.getByRole("button", { name: "移除焦点", exact: true }).click();
	await expect(page.locator(stickySelector)).toHaveCount(0);
	await expect(page.locator(anchorSelector)).toHaveCount(0);
});

test("跨项目同号任务搜索在途只显示目标占位，取消可回原卡，水合后显示新项目 Done 卡及正确动作", async ({ page }) => {
	await searchAndOpen(page, "分组外目标任务");
	await searchAndOpen(page, "跨项目同号目标任务", true);
	await expect(page.locator("[data-cross-project-focused-task-outside-sections]")).toContainText("正在加载目标任务");
	await expect(
		page.locator('[data-task-card-render-role="focused_task_card_copy_in_cross_project_task_switcher"]'),
	).toHaveCount(0);
	await page.getByRole("button", { name: "取消跨项目跳转", exact: true }).click();
	await expect(page.locator("[data-cross-project-focused-task-outside-sections]")).toContainText("分组外目标任务");
	await searchAndOpen(page, "跨项目同号目标任务", true);
	await page.getByRole("button", { name: "完成跨项目加载", exact: true }).click();
	const target = page.locator("[data-cross-project-focused-task-outside-sections]");
	await expect(target).toContainText("跨项目同号目标任务");
	await expect(target).toContainText("project-b");
	await expect(target).toContainText("Done");
	await expect(target).not.toContainText("分组外目标任务");
	await target.hover();
	await target.getByRole("button", { name: "Restore task from done", exact: true }).click();
	await expect(page.getByLabel("动作结果")).toHaveText("restore:project-b:outside");
	await expect(page.locator(anchorSelector)).toHaveCount(1);
});

for (const interaction of ["hover_wait", "prompt_action"] as const) {
	test(`焦点源行贴近底沿悬浮展开，向上避让且不因占位增高触发 Sticky：${interaction}`, async ({ page }) => {
		await page.mouse.move(1000, 700);
		await page.locator(scrollContainerSelector).evaluate((root) => {
			const anchor = root.querySelector<HTMLElement>("[data-cross-project-focused-task-scroll-anchor]")!;
			root.scrollTop += anchor.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom + 3;
			root.dispatchEvent(new Event("scroll"));
		});
		const source = page.locator(anchorSelector);
		await expect(page.locator(stickySelector)).toHaveCount(0);
		const sourceBeforeHover = await source.boundingBox();
		const viewport = await page.locator(scrollContainerSelector).boundingBox();
		expect(viewport!.y + viewport!.height - sourceBeforeHover!.y - sourceBeforeHover!.height).toBeGreaterThanOrEqual(
			2,
		);
		expect(viewport!.y + viewport!.height - sourceBeforeHover!.y - sourceBeforeHover!.height).toBeLessThanOrEqual(5);
		await page.mouse.move(sourceBeforeHover!.x + 80, sourceBeforeHover!.y + sourceBeforeHover!.height / 2);
		await expect(source).toHaveAttribute(
			"data-cross-project-task-switcher-row-in-place-expansion-state",
			"expanded_in_place_by_hover",
		);
		await expect(page.locator(stickySelector)).toHaveCount(0);
		const sticky = source.locator("[data-cross-project-task-switcher-hover-floating-card]");
		const stickyGeometry = await sticky.boundingBox();
		expect(stickyGeometry!.y + stickyGeometry!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1);
		expect(stickyGeometry!.y + 16).toBeLessThan(sourceBeforeHover!.y);
		expect(await source.boundingBox()).toEqual(sourceBeforeHover);
		await sticky.hover();
		if (interaction === "hover_wait") {
			// 超过离开面板后的 300ms 收起期限，副本内停留仍属于面板交互。
			await page.waitForTimeout(450);
			await expect(sticky).toBeVisible();
			await expect(source).toHaveAttribute(
				"data-cross-project-task-switcher-row-in-place-expansion-state",
				"expanded_in_place_by_hover",
			);
		} else {
			await sticky.getByRole("button", { name: "View original prompt", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText("原始任务需求：列表任务 20：底沿 hover 完整卡片自然换行的长标题");
			await dialog.click();
			await expect(dialog).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(sticky).toBeVisible();
		}
	});
}
