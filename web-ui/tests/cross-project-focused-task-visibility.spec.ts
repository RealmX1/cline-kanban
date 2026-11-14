import { expect, type Page, test } from "@playwright/test";
import {
	computeFocusViewCompactHeaderColumnCount,
	computeStageHeaderPinLayoutGeometry,
	STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
} from "../src/components/detail-panels/stage-header-rail-geometry";
import { taskCardActionToolbar } from "./task-card-action-toolbar-browser-locators";

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

test("Pinned 内部溢出时与普通分组按实际滚动条占宽保持卡片等宽", async ({ page }) => {
	await page.addStyleTag({ content: "* { scrollbar-width: auto; } *::-webkit-scrollbar { width: 14px; }" });
	await page.getByRole("button", { name: "加入置顶", exact: true }).click();
	const scrollRoot = page.locator(scrollContainerSelector);
	const pinned = page.getByTestId("cross-project-task-switcher-section-pinned");
	const group = page.getByTestId("cross-project-task-switcher-section-remaining");
	await pinned.getByRole("button", { name: /Show .*more/ }).click();
	await page.mouse.move(1000, 700);
	const pinnedScrollContainer = pinned.locator(":scope > div").last();
	await expect
		.poll(() => pinnedScrollContainer.evaluate((element) => element.scrollHeight - element.clientHeight))
		.toBeGreaterThan(0);
	const taskRowSelector =
		'[data-cross-project-task-switcher-workspace-id="project-a"][data-cross-project-task-switcher-task-id="recent-0"]';
	const pinnedCard = pinned.locator(taskRowSelector);
	const regularCard = group.locator(taskRowSelector);
	for (const scrollbarWidth of ["auto", "none", "auto"]) {
		await scrollRoot.evaluate((element, value) => {
			element.style.scrollbarGutter = "stable";
			element.style.scrollbarWidth = value;
		}, scrollbarWidth);
		// overlay 滚动条实际占宽为 0；补偿必须跟随实测值，不能假定 stable 会强制占宽。
		await expect
			.poll(() =>
				scrollRoot.evaluate((element) => {
					const boundary = element.closest<HTMLElement>("[data-focus-view-column-scroll-boundary]")!;
					const reservedWidth = Number.parseFloat(
						boundary.style.getPropertyValue("--kb-focus-view-column-scrollbar-width"),
					);
					return reservedWidth - (element.offsetWidth - element.clientWidth);
				}),
			)
			.toBe(0);
		if (scrollbarWidth === "none")
			expect(await scrollRoot.evaluate((element) => element.offsetWidth - element.clientWidth)).toBe(0);
		await expect
			.poll(async () => Math.abs((await pinned.boundingBox())!.width - (await group.boundingBox())!.width))
			.toBeLessThan(1);
		expect((await pinned.boundingBox())!.x).toBe((await group.boundingBox())!.x);
		await expect
			.poll(async () => Math.abs((await pinnedCard.boundingBox())!.width - (await regularCard.boundingBox())!.width))
			.toBeLessThan(1);
		expect((await pinnedCard.boundingBox())!.x).toBe((await regularCard.boundingBox())!.x);
	}
	await page.screenshot({ path: test.info().outputPath("all-projects-pinned-width.png") });
});

test("吸顶标题与当前任务卡上的滚轮接续整列滚动", async ({ page }) => {
	const scrollRoot = page.locator(scrollContainerSelector);
	for (const edge of ["top", "bottom"] as const) {
		for (const targetSelector of ["[data-focus-view-group-header]", stickySelector]) {
			await setPanelScroll(page, edge === "top" ? "end" : 0);
			const rail = page.locator(`.kb-stage-header-rail[data-edge="${edge}"]`);
			const target = rail.locator(targetSelector).first();
			await expect(target).toBeVisible();
			await target.evaluate((element, direction) => {
				element.scrollTop = direction === "top" ? 0 : element.scrollHeight;
			}, edge);
			await target.hover();
			const before = await scrollRoot.evaluate((element) => element.scrollTop);
			await page.mouse.wheel(0, edge === "top" ? -100 : 100);
			await expect
				.poll(() => scrollRoot.evaluate((element) => element.scrollTop))
				[edge === "top" ? "toBeLessThan" : "toBeGreaterThan"](before);
		}
	}
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("Pinned 固定在列表上方且内部限高滚动，重复任务只有真实分组定位源，空收起组没有 body", async ({ page }) => {
	await page.getByRole("button", { name: "加入置顶", exact: true }).click();
	const pinned = page.getByTestId("cross-project-task-switcher-section-pinned");
	await expect(pinned).toBeVisible();
	expect(
		await page
			.locator(scrollContainerSelector)
			.evaluate((root) =>
				root.contains(document.querySelector('[data-testid="cross-project-task-switcher-section-pinned"]')),
			),
	).toBe(false);
	const before = await pinned.boundingBox();
	await setPanelScroll(page, "end");
	expect(await pinned.boundingBox()).toEqual(before);
	await expect(pinned.locator(anchorSelector)).toHaveCount(0);
	await expect(page.locator(anchorSelector)).toHaveCount(1);
	const expandAll = pinned.getByRole("button", { name: /Show .*more/ });
	await expandAll.click();
	const panel = page.locator("[data-cross-project-focused-task-visibility-panel]");
	expect((await pinned.boundingBox())!.height).toBeLessThanOrEqual((await panel.boundingBox())!.height * 0.5 + 1);
	const content = pinned.locator(":scope > div").last();
	await expect(content).toHaveCSS("overflow-y", "auto");
	expect(await content.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
		await content.evaluate((element) => element.clientHeight),
	);
	await pinned.getByRole("button", { name: "收起 Pinned", exact: true }).click();
	expect((await pinned.boundingBox())!.height).toBe(30);
	await expect(pinned.locator(":scope > div")).toHaveCount(1);
	const running = page.getByTestId("cross-project-task-switcher-section-running");
	expect((await running.boundingBox())!.height).toBe(30);
	await expect(running.locator(":scope > div")).toHaveCount(1);
});

test("分组标题跳到上方 rail 下沿，吸顶与行内箭头共用折叠状态", async ({ page }) => {
	await setPanelScroll(page, 0);
	const bottomRecent = page
		.locator('.kb-stage-header-rail[data-edge="bottom"]')
		.getByRole("button", { name: "跳转到 Recent", exact: true });
	await bottomRecent.click();
	const source = page.getByTestId("cross-project-task-switcher-section-remaining");
	const root = (await page.locator(scrollContainerSelector).boundingBox())!;
	const header = (await source.locator("[data-focus-view-group-header]").boundingBox())!;
	const topRail = (await page.locator('.kb-stage-header-rail[data-edge="top"]').boundingBox())!;
	expect(header.y).toBeGreaterThanOrEqual(root.y);
	expect(header.y).toBeGreaterThanOrEqual(topRail.y + topRail.height - 1);
	await setPanelScroll(page, "end");
	const rail = page.locator(
		'.kb-stage-header-rail[data-edge="top"] [data-focus-view-group-header-rail-entry="remaining"]',
	);
	const collapseButton = rail.getByRole("button", { name: "收起 Recent", exact: true });
	await collapseButton.focus();
	await expect(page.getByRole("tooltip")).toContainText("收起 Recent");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await collapseButton.click();
	await expect(source.getByRole("button", { name: "展开 Recent", exact: true })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(source.locator(anchorSelector)).toHaveCount(1);
	await expect(page.locator(anchorSelector)).toHaveCount(1);
});

test("搜索命中的分组外任务固定保留完整卡片与操作，滚动不遮挡当前归属", async ({ page }) => {
	await searchAndOpen(page, "分组外目标任务");
	const fallback = page.locator("[data-cross-project-focused-task-outside-sections]");
	await expect(fallback).toContainText("分组外目标任务");
	await expect(fallback).toContainText("project-a");
	const initialBounds = await fallback.boundingBox();
	await setPanelScroll(page, "end");
	await expect(fallback).toBeVisible();
	expect(await fallback.boundingBox()).toEqual(initialBounds);
	await expect(page.locator(stickySelector)).toHaveCount(0);
	await fallback.hover();
	await (await taskCardActionToolbar(fallback))
		.getByRole("button", { name: "Move task to validation", exact: true })
		.click();
	await expect(page.getByLabel("动作结果")).toHaveText("validation:project-a:outside");
	await (await taskCardActionToolbar(fallback))
		.getByRole("button", { name: "View original prompt", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toContainText("原始任务需求：分组外目标任务");
	await page.keyboard.press("Escape");
	await expect(fallback).toBeVisible();
	await expect(page.locator(anchorSelector)).toHaveCount(1);
});

test("组内任务上下触边、大幅滚动跳转与回到视口，始终只有一个测量源和一份 Sticky", async ({ page }) => {
	await page.getByRole("button", { name: "打开组内任务", exact: true }).click();
	await setPanelScroll(page, 0);
	await expect(page.locator(stickySelector)).toHaveAttribute("data-cross-project-focused-task-sticky-edge", "bottom");
	const viewport = await page.locator(scrollContainerSelector).boundingBox();
	const bottom = await page.locator('.kb-stage-header-rail[data-edge="bottom"]').boundingBox();
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
	await expect(running.getByRole("button", { name: "展开 Running", exact: true })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
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
	await expect(target).toContainText("已结案");
	await expect(target).not.toContainText("分组外目标任务");
	await target.hover();
	await (await taskCardActionToolbar(target)).getByRole("button", { name: "重新打开已结案任务", exact: true }).click();
	await expect(page.getByLabel("动作结果")).toHaveText("restore:project-b:outside");
	await expect(page.locator(anchorSelector)).toHaveCount(1);
});

for (const interaction of ["hover_wait", "prompt_action"] as const) {
	test(`焦点源行贴近底沿悬浮展开，向上避让且不因占位增高触发 Sticky：${interaction}`, async ({ page }) => {
		await page.mouse.move(1000, 700);
		await page.locator(scrollContainerSelector).evaluate((root) => {
			const anchor = root.querySelector<HTMLElement>("[data-cross-project-focused-task-scroll-anchor]")!;
			const bottomRail = root.parentElement?.querySelector('[data-testid="stage-header-rail"][data-edge="bottom"]');
			const bottomRailHeight = bottomRail?.getBoundingClientRect().height ?? 0;
			root.scrollTop +=
				anchor.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom + bottomRailHeight + 3;
			root.dispatchEvent(new Event("scroll"));
		});
		const source = page.locator(anchorSelector);
		await expect(page.locator(stickySelector)).toHaveCount(0);
		const sourceBeforeHover = await source.boundingBox();
		const viewport = await page.locator(scrollContainerSelector).boundingBox();
		const bottomRailHeight =
			(await page.locator('.kb-stage-header-rail[data-edge="bottom"]').boundingBox())?.height ?? 0;
		expect(
			viewport!.y + viewport!.height - bottomRailHeight - sourceBeforeHover!.y - sourceBeforeHover!.height,
		).toBeGreaterThanOrEqual(2);
		expect(
			viewport!.y + viewport!.height - bottomRailHeight - sourceBeforeHover!.y - sourceBeforeHover!.height,
		).toBeLessThanOrEqual(5);
		await page.mouse.move(sourceBeforeHover!.x + 80, sourceBeforeHover!.y + sourceBeforeHover!.height / 2);
		await expect(source).toHaveAttribute(
			"data-cross-project-task-switcher-row-in-place-expansion-state",
			"expanded_in_place_by_hover",
		);
		await expect(page.locator(stickySelector)).toHaveCount(0);
		const sticky = source.locator("[data-cross-project-task-switcher-hover-floating-card]");
		const stickyGeometry = await sticky.boundingBox();
		expect(stickyGeometry!.y + stickyGeometry!.height).toBeLessThanOrEqual(
			viewport!.y + viewport!.height - bottomRailHeight + 1,
		);
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
			await (await taskCardActionToolbar(sticky))
				.getByRole("button", { name: "View original prompt", exact: true })
				.click();
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

for (const edge of ["top", "bottom"] as const) {
	test(`Pinned 占据半高时，${edge} 焦点副本限高并可内部滚动`, async ({ page }) => {
		await page.getByRole("button", { name: "加入置顶", exact: true }).click();
		const pinned = page.getByTestId("cross-project-task-switcher-section-pinned");
		await pinned.getByRole("button", { name: /Show .*more/ }).click();
		await page.locator("[data-isolated-focus-view-left-panel]").evaluate((element) => {
			element.style.height = "420px";
		});
		await setPanelScroll(page, edge === "top" ? "end" : 0);
		const sticky = page.locator(`${stickySelector}[data-cross-project-focused-task-sticky-edge="${edge}"]`);
		await expect(sticky).toBeVisible();
		const scrollRoot = page.locator(scrollContainerSelector);
		const measured = await scrollRoot.evaluate((element) => ({
			viewportTop: element.getBoundingClientRect().top,
			viewportHeight: element.clientHeight,
			width: element.clientWidth,
			sections: [...element.querySelectorAll<HTMLElement>("[data-focus-view-group-section-id]")].map((section) => ({
				id: section.dataset.focusViewGroupSectionId!,
				top: section.getBoundingClientRect().top,
				bottom: section.getBoundingClientRect().bottom,
			})),
		}));
		const expectedStickyMaximumHeight =
			computeStageHeaderPinLayoutGeometry({
				...measured,
				columnCount: computeFocusViewCompactHeaderColumnCount(measured.width),
				compactHeadersEnabled: true,
				focusedColumnId: "remaining",
				focusedCardTop: 0,
				focusedCardBottom: 0,
				focusedCardHeight: 0,
				focusedCardPinState: "hidden",
			}).focusedCardContentMaximumHeight + STAGE_RAIL_FOCUSED_CARD_PADDING_PX;
		// 面板刚缩小时副本已可见，但 ResizeObserver 的新预算尚未提交。
		await expect(sticky).toHaveCSS("max-height", `${expectedStickyMaximumHeight}px`);
		const rootBox = await page.locator(scrollContainerSelector).boundingBox();
		const stickyBox = await sticky.boundingBox();
		expect(stickyBox!.y).toBeGreaterThanOrEqual(rootBox!.y);
		expect(stickyBox!.y + stickyBox!.height).toBeLessThanOrEqual(rootBox!.y + rootBox!.height + 1);
		expect(await sticky.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
		expect(await sticky.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
		const naturalCard = sticky.getByRole("region", { name: "当前聚焦任务", exact: true });
		const naturalCardHeight = (await naturalCard.boundingBox())!.height;
		expect(naturalCardHeight).toBeGreaterThan(stickyBox!.height);
		const columnScrollTop = await scrollRoot.evaluate((element) => element.scrollTop);
		await sticky.hover();
		await page.mouse.wheel(0, 60);
		await expect.poll(() => sticky.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		expect(await scrollRoot.evaluate((element) => element.scrollTop)).toBe(columnScrollTop);
		await sticky.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		expect(await sticky.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		// 内部滚动不改变自然高度或限高预算，避免受限盒测量驱动标题反复分类。
		await expect.poll(async () => (await naturalCard.boundingBox())!.height).toBe(naturalCardHeight);
		expect((await sticky.boundingBox())!.height).toBe(stickyBox!.height);
		await expect(page.locator(anchorSelector)).toHaveCount(1);
		await sticky.evaluate((element, direction) => {
			element.scrollTop = direction === "top" ? 0 : element.scrollHeight;
		}, edge);

		await page.mouse.wheel(0, edge === "top" ? -100 : 100);
		await expect
			.poll(() => scrollRoot.evaluate((element) => element.scrollTop))
			[edge === "top" ? "toBeLessThan" : "toBeGreaterThan"](columnScrollTop);
	});
}
