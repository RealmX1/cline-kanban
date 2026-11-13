import { expect, type Page, test } from "@playwright/test";
import { LocalStorageKey } from "../src/storage/local-storage-store";

async function openIsolatedSingleProjectHome(page: Page, width: number) {
	await page.setViewportSize({ width, height: 844 });
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/isolated-single-project-mobile-home", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const harness=document.createElement('script');harness.type='module';harness.src='/tests/single-project-mobile-home-browser-harness.tsx';document.body.append(harness);</script></body></html>",
		}),
	);
	await page.goto("/isolated-single-project-mobile-home");
	await expect(page.locator('.kb-board [data-task-id="backlog-0"]')).toBeVisible();
}

test.describe("单项目手机首页", () => {
	test.use({ hasTouch: true });
	test("各手机断点阶段竖排、卡片操作按需展开且置顶分身无本体身份", async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await openIsolatedSingleProjectHome(page, 320);
		const card = page.locator('.kb-board [data-task-id="backlog-0"]');
		const toggle = card.getByRole("button", { name: "展开任务卡详情与操作", exact: true });
		for (const width of [320, 375, 390, 768]) {
			await page.setViewportSize({ width, height: 844 });
			const scroll = page.locator("[data-mobile-single-project-home-scroll-container]");
			await expect(scroll).toBeVisible();
			const stages = page.locator(".kb-board > section");
			await expect(stages).toHaveCount(6);
			const layout = await stages.evaluateAll((elements) =>
				elements.map((element) => {
					const box = element.getBoundingClientRect();
					return { top: box.top, bottom: box.bottom, left: box.left, width: box.width };
				}),
			);
			for (let index = 1; index < layout.length; index++) {
				expect(layout[index]!.top).toBeGreaterThanOrEqual(layout[index - 1]!.bottom);
				expect(layout[index]!.left).toBe(layout[0]!.left);
			}
			expect(layout[0]!.width).toBeLessThanOrEqual(width);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
			const collapsedStage = page.locator('.kb-board > section[data-column-id="validation"]');
			await expect(collapsedStage).toHaveAttribute("data-kanban-board-column-collapsed", "true");
			const collapsedTitle = collapsedStage.getByRole("button", { name: "Expand Validation column", exact: true });
			await expect(collapsedTitle).toHaveCSS("flex-direction", "row");
			await expect(collapsedTitle).toHaveCSS("writing-mode", "horizontal-tb");
			const collapsedBox = (await collapsedStage.boundingBox())!;
			expect(collapsedBox.height).toBeLessThanOrEqual(48);
			expect(collapsedBox.width).toBeGreaterThan(collapsedBox.height);
			await expect(card.locator("[data-task-card-primary-actions]")).toBeHidden();
			await expect(card.locator("[data-task-card-expandable-details]")).toBeHidden();
			const toggleBox = (await toggle.boundingBox())!;
			expect(toggleBox.width).toBeGreaterThanOrEqual(44);
			expect(toggleBox.height).toBeGreaterThanOrEqual(44);
			const pinned = page.locator('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]');
			await expect(pinned).toHaveCount(1);
			await expect(pinned).not.toHaveAttribute("data-task-id");
			await expect(pinned.locator("[data-task-card-primary-actions]")).toBeHidden();
			await page.screenshot({ path: test.info().outputPath(`single-project-mobile-home-${width}.png`) });
		}
		await page.setViewportSize({ width: 320, height: 844 });
		await toggle.tap();
		await expect(card.locator("[data-task-card-primary-actions]")).toBeVisible();
		await expect(card.locator("[data-task-card-expandable-details]")).toBeVisible();
		await expect(page.locator("[data-browser-last-action]")).toHaveText("");
		await card.getByRole("button", { name: "Start task", exact: true }).tap();
		await expect(page.locator("[data-browser-last-action]")).toHaveText("启动:backlog-0");
		await card.getByRole("button", { name: "收起任务卡详情与操作", exact: true }).tap();
		await expect(card.locator("[data-task-card-primary-actions]")).toBeHidden();
		await card.locator("[data-task-card-title]").tap();
		await expect(page.locator("[data-browser-last-action]")).toHaveText("编辑:backlog-0");
		expect(errors).toEqual([]);
	});

	test("整页渐进加载，视口上方卡片展开后打开任务返回仍停在原任务", async ({ page }) => {
		await openIsolatedSingleProjectHome(page, 390);
		const scroll = page.locator("[data-mobile-single-project-home-scroll-container]");
		for (const taskId of ["backlog-0", "backlog-1"]) {
			const card = page.locator(`.kb-board [data-task-id="${taskId}"]`);
			await card.getByRole("button", { name: "展开任务卡详情与操作", exact: true }).tap();
			await expect(card.locator("[data-task-card-expandable-details]")).toBeVisible();
		}
		const lastTask = page.locator('.kb-board [data-task-id="in_progress-23"]');
		for (let step = 0; step < 5; step++) {
			await scroll.evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			if (await lastTask.count()) break;
			await page.waitForTimeout(100);
		}
		await expect(lastTask).toBeVisible();
		await lastTask.scrollIntoViewIfNeeded();
		const scrollTop = await scroll.evaluate((element) => element.scrollTop);
		const topBefore = await lastTask.evaluate((element) => {
			const scrollContainer = element.closest("[data-mobile-single-project-home-scroll-container]");
			return element.getBoundingClientRect().top - (scrollContainer?.getBoundingClientRect().top ?? 0);
		});
		await lastTask.locator("[data-task-card-title]").tap();
		await expect(page.locator("[data-browser-opened-task]")).toHaveAttribute(
			"data-browser-opened-task",
			"in_progress-23",
		);
		await page.getByRole("button", { name: "返回项目首页", exact: true }).tap();
		await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(scrollTop);
		await expect(
			page.locator('.kb-board [data-task-id="backlog-0"] [data-task-card-expandable-details]'),
		).toBeVisible();
		await expect(lastTask).toBeVisible();
		const topAfter = await lastTask.evaluate((element) => {
			const scrollContainer = element.closest("[data-mobile-single-project-home-scroll-container]");
			return element.getBoundingClientRect().top - (scrollContainer?.getBoundingClientRect().top ?? 0);
		});
		expect(Math.abs(topAfter - topBefore)).toBeLessThanOrEqual(1);
	});

	test("Done 与 Shelved 可展开，Done 正文打开任务且没有启动入口，空阶段仍保留创建入口", async ({ page }) => {
		await openIsolatedSingleProjectHome(page, 390);
		const doneStage = page.locator('.kb-board > section[data-column-id="trash"]');
		await doneStage.getByRole("button", { name: "Expand 已结案 column", exact: true }).tap();
		const done = doneStage.locator('[data-task-id="trash-0"]');
		await done.getByRole("button", { name: "展开任务卡详情与操作", exact: true }).tap();
		await expect(done.getByRole("button", { name: "Start task", exact: true })).toHaveCount(0);
		await done.locator("[data-task-card-title]").tap();
		await expect(page.locator("[data-browser-opened-task]")).toHaveAttribute("data-browser-opened-task", "trash-0");
		await page.getByRole("button", { name: "返回项目首页", exact: true }).tap();
		const shelvedStage = page.locator('.kb-board > section[data-column-id="shelved"]');
		await shelvedStage.getByRole("button", { name: "Expand Shelved column", exact: true }).tap();
		await expect(shelvedStage.locator('[data-task-id="review-1"]')).toBeVisible();
		await expect(page.locator('.kb-board > section[data-column-id="review"] [data-task-id="review-1"]')).toHaveCount(
			0,
		);
		await page.evaluate(() => window.singleProjectMobileHomeBrowserFixture.showEmptyBoard());
		await expect(page.getByRole("button", { name: "Create task", exact: true })).toBeVisible();
		await expect(page.locator(".kb-board [data-task-id]")).toHaveCount(0);
	});

	test("真实触屏长按拖动非首张任务跨阶段，保留任务身份与下标", async ({ page }) => {
		await openIsolatedSingleProjectHome(page, 390);
		const source = page.locator('.kb-board [data-task-id="backlog-1"] [data-task-card-title]');
		const target = page.locator('.kb-board [data-task-id="in_progress-0"] [data-task-card-title]');
		const from = (await source.boundingBox())!;
		const to = (await target.boundingBox())!;
		const client = await page.context().newCDPSession(page);
		const touchPoint = { x: from.x + 40, y: from.y + from.height / 2 };
		await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] });
		await page.waitForTimeout(350);
		for (let step = 1; step <= 12; step++) {
			await client.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [
					{
						x: touchPoint.x,
						y: touchPoint.y + ((to.y + to.height / 2 - touchPoint.y) * step) / 12,
					},
				],
			});
			await page.waitForTimeout(20);
		}
		await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect
			.poll(() => page.evaluate(() => window.singleProjectMobileHomeBrowserFixture.readDrops().length))
			.toBe(1);
		const [drop] = await page.evaluate(() => window.singleProjectMobileHomeBrowserFixture.readDrops());
		expect(drop?.draggableId).toBe("backlog-1");
		expect(drop?.source).toEqual({ droppableId: "backlog", index: 1 });
		expect(drop?.destination?.droppableId).toBe("in_progress");
		await expect(
			page.locator('.kb-board > section[data-column-id="backlog"] [data-task-id="backlog-0"]'),
		).toHaveCount(1);
		await expect(
			page.locator('.kb-board > section[data-column-id="in_progress"] [data-task-id="backlog-1"]'),
		).toHaveCount(1);
		await client.detach();
	});

	test("触屏滑动只滚动首页，不误触导航或拖拽", async ({ page }) => {
		await openIsolatedSingleProjectHome(page, 390);
		const scroll = page.locator("[data-mobile-single-project-home-scroll-container]");
		const source = (await page
			.locator('.kb-board [data-task-id="in_progress-0"] [data-task-card-title]')
			.boundingBox())!;
		const client = await page.context().newCDPSession(page);
		await client.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: source.x + 40, y: source.y + 6 }],
		});
		await client.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x: source.x + 40, y: source.y - 100 }],
		});
		await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.singleProjectMobileHomeBrowserFixture.readDrops())).toEqual([]);
		await expect(page.locator("[data-browser-opened-task]")).toHaveCount(0);
		await client.detach();
	});
});

test("桌面列宽及折叠偏好在手机往返后保持原值", async ({ page }) => {
	await page.addInitScript(
		({ storageKey }) => localStorage.setItem(storageKey, JSON.stringify({ in_progress: 333 })),
		{
			storageKey: LocalStorageKey.KanbanBoardColumnCustomWidthsPx,
		},
	);
	await openIsolatedSingleProjectHome(page, 1440);
	const inProgress = page.locator('.kb-board > section[data-column-id="in_progress"]');
	await expect(inProgress).toHaveCSS("width", "333px");
	await expect(page.locator("[data-mobile-single-project-home-scroll-container]")).toHaveCount(0);
	await expect(page.locator('.kb-board [data-task-id="backlog-0"] [data-task-card-compact-row-toggle]')).toHaveCount(
		0,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator("[data-mobile-single-project-home-scroll-container]")).toBeVisible();
	await expect(inProgress).toHaveCSS("width", "374px");
	await page.setViewportSize({ width: 1440, height: 844 });
	await expect(inProgress).toHaveCSS("width", "333px");
	await expect(page.locator('.kb-board > section[data-column-id="validation"]')).toHaveAttribute(
		"data-kanban-board-column-collapsed",
		"true",
	);
	expect(
		await page.evaluate(
			(storageKey) => localStorage.getItem(storageKey),
			LocalStorageKey.KanbanBoardColumnCustomWidthsPx,
		),
	).toBe('{"in_progress":333}');
});
