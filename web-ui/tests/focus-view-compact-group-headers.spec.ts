import { expect, type Page, test } from "@playwright/test";
import {
	openIsolatedFocusViewCompactGroupHeadersBrowserHarness,
	setFocusViewTaskListScrollFractionAndWaitForLayout,
} from "./focus-view-group-header-browser-test-helpers";

const railSelector = '[data-testid="stage-header-rail"]';
const scrollRootSelector = "[data-task-card-column-scroll-container]";
const compactHeaderSelector = '[data-focus-view-group-header][data-presentation="compact"]';

async function expectRowsMatchRenderedGeometry(page: Page) {
	const errors = await page.locator(railSelector).evaluateAll((rails) => {
		const errors: string[] = [];
		for (const rail of rails) {
			const rowEntries = new Map<string, HTMLElement[]>();
			for (const entry of rail.querySelectorAll<HTMLElement>("[data-focus-view-header-rail-row]")) {
				const rowIndex = entry.dataset.focusViewHeaderRailRow!;
				rowEntries.set(rowIndex, [...(rowEntries.get(rowIndex) ?? []), entry]);
			}
			const rows = [...rowEntries.values()].map((entries) => ({
				top: Math.min(...entries.map((entry) => entry.getBoundingClientRect().top)),
				bottom: Math.max(...entries.map((entry) => entry.getBoundingClientRect().bottom)),
			}));
			for (const entries of rowEntries.values()) {
				if (entries.length === 1 && Math.abs(entries[0]!.getBoundingClientRect().width - rail.clientWidth + 4) > 1)
					errors.push("单标题行未铺满可用宽度");
			}
			for (const header of rail.querySelectorAll<HTMLElement>("[data-focus-view-group-header]")) {
				const expectedHeight = header.dataset.presentation === "compact" ? 24 : 28;
				if (header.dataset.presentation === "compact" && header.parentElement!.getBoundingClientRect().width < 96)
					errors.push("紧凑项宽度小于 96px");
				if (getComputedStyle(header).fontSize !== "13px") errors.push("标题字号不符");
				if (header.getBoundingClientRect().height !== expectedHeight) errors.push("标题高度不符");
			}
			for (const [index, row] of rows.entries()) {
				const previousRow = rows[index - 1];
				if (previousRow && Math.abs(row.top - previousRow.bottom - 4) > 1) errors.push("行间距不符");
			}
			const rect = rail.getBoundingClientRect();
			const expectedHeight =
				rows.reduce((height, row) => height + row.bottom - row.top, 0) + Math.max(0, rows.length - 1) * 4;
			if (Math.abs(rect.height - expectedHeight) > 1) errors.push("轨道高度与行数不符");
		}
		return errors;
	});
	expect(errors).toEqual([]);
}

for (const scope of ["current", "all"] as const) {
	test(`${scope} Pinned 收起后并入共享顶轨，展开后独立滚动，跳转保留首卡`, async ({ page }) => {
		const errors = await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, scope, {
			usesPinnedFixtures: true,
		});
		const pinnedSection = page.locator(
			scope === "current"
				? '[data-task-pinboard-container="focus-view-section"]'
				: '[data-testid="cross-project-task-switcher-section-pinned"]',
		);
		await expect(pinnedSection).toBeVisible();
		await pinnedSection.getByRole("button", { name: "Show 2 more", exact: true }).click();
		const pinnedScroll = pinnedSection.locator(".overflow-y-auto");
		await expect(pinnedScroll).toBeVisible();
		const scrollRoot = page.locator(scrollRootSelector);
		const beforeScroll = await scrollRoot.evaluate((root) => root.scrollTop);
		await pinnedScroll.evaluate((root) => {
			root.scrollTop = root.scrollHeight;
		});
		expect(await pinnedScroll.evaluate((root) => root.scrollTop)).toBeGreaterThan(0);
		expect(await scrollRoot.evaluate((root) => root.scrollTop)).toBe(beforeScroll);
		await pinnedSection.getByRole("button", { name: "收起 Pinned", exact: true }).click();
		await expect(pinnedSection).toHaveCount(0);
		const pinnedHeader = page.locator(
			`${railSelector}[data-edge="top"] [data-focus-view-group-header-rail-entry="pinned"]`,
		);
		await expect(pinnedHeader).toBeVisible();
		await expect(pinnedHeader.locator("[data-focus-view-group-header]")).toHaveAttribute(
			"data-presentation",
			"compact",
		);
		let sharedRowObserved = false;
		let singletonRowObserved = false;
		for (const fraction of [0, 0.15, 0.4, 0.7, 1, 0.2]) {
			await setFocusViewTaskListScrollFractionAndWaitForLayout(page, fraction);
			await expectRowsMatchRenderedGeometry(page);
			const rowCounts = await page.locator(railSelector).evaluateAll((rails) =>
				rails.flatMap((rail) => {
					const counts = new Map<string, number>();
					for (const entry of rail.querySelectorAll<HTMLElement>("[data-focus-view-header-rail-row]")) {
						const row = entry.dataset.focusViewHeaderRailRow!;
						counts.set(row, (counts.get(row) ?? 0) + 1);
					}
					return [...counts.values()];
				}),
			);
			sharedRowObserved ||= rowCounts.some((count) => count > 1);
			singletonRowObserved ||= rowCounts.includes(1);
			if (fraction === 0 || fraction === 0.4 || fraction === 1)
				await page.screenshot({ path: test.info().outputPath(`${scope}-collapsed-pinned-${fraction}.png`) });
		}
		expect(sharedRowObserved).toBe(true);
		expect(singletonRowObserved).toBe(true);
		for (const target of scope === "current" ? ["Review", "Backlog"] : ["Recent", "Running"]) {
			await page
				.locator(railSelector)
				.getByRole("button", { name: `跳转到 ${target}`, exact: true })
				.click();
			const section = page.locator(
				scope === "current"
					? `[data-stage-section-id="${target === "Review" ? "review" : "backlog"}"]`
					: `[data-testid="cross-project-task-switcher-section-${target === "Recent" ? "remaining" : "running"}"]`,
			);
			const firstCard = section
				.locator(scope === "current" ? "[data-task-id]" : "[data-cross-project-task-switcher-task-id]")
				.first();
			await expect
				.poll(async () => {
					const rail = (await page.locator(`${railSelector}[data-edge="top"]`).boundingBox())!;
					return (await firstCard.boundingBox())!.y - rail.y - rail.height;
				})
				.toBeGreaterThanOrEqual(0);
		}
		await pinnedHeader.getByRole("button", { name: "展开 Pinned", exact: true }).press("Enter");
		await expect(pinnedSection).toBeVisible();
		await expect(pinnedHeader).toHaveCount(0);
		await expect(pinnedScroll).toBeVisible();
		await page.screenshot({ path: test.info().outputPath(`${scope}-expanded-pinned.png`) });
		expect(
			await page.evaluate(
				(key) => localStorage.getItem(key),
				scope === "current"
					? "kanban.task-pinboard-section-collapsed-in-focus-view.v1"
					: "kanban.cross-project-task-switcher-pinned-section-collapsed.v1",
			),
		).toBe("false");
		expect(errors).toEqual([]);
	});
	for (const [width, height] of [
		[1280, 720],
		[1366, 768],
		[1440, 900],
	] as const) {
		test(`${scope} ${width}×${height} 多列压缩、连续滚动与左栏变宽`, async ({ page }) => {
			await page.setViewportSize({ width, height });
			const errors = await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, scope);
			await page.mouse.move(width - 10, 10);
			await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 0);
			await expect.poll(() => page.locator(compactHeaderSelector).count()).toBeGreaterThanOrEqual(4);
			for (const panelWidth of [280, 320, 360]) {
				await page.getByRole("spinbutton", { name: "左栏宽度" }).fill(String(panelWidth));
				const expectedColumns = panelWidth === 280 ? 2 : 3;
				await expect
					.poll(() =>
						page
							.locator(`${railSelector}[data-edge="bottom"]`)
							.evaluate((rail) => getComputedStyle(rail).gridTemplateColumns.split(" ").length),
					)
					.toBe(expectedColumns);
				const bottomRail = page.locator(`${railSelector}[data-edge="bottom"]`);
				const count = await bottomRail.locator(compactHeaderSelector).count();
				const focusedCopy = bottomRail.locator(
					'[data-testid="stage-header-rail-focused-card"], [data-cross-project-focused-task-sticky-edge]',
				);
				const headersHeight =
					(await bottomRail.boundingBox())!.height -
					((await focusedCopy.count()) > 0 ? (await focusedCopy.boundingBox())!.height : 0);
				expect(count).toBeGreaterThanOrEqual(4);
				expect(headersHeight).toBeLessThanOrEqual((count * 34 + (count - 1) * 4) / 2);
				await expectRowsMatchRenderedGeometry(page);
			}
			for (const fraction of [0.05, 0.15, 0.3, 0.5, 0.75, 1, 0.6, 0.2, 0]) {
				await setFocusViewTaskListScrollFractionAndWaitForLayout(page, fraction);
				await expectRowsMatchRenderedGeometry(page);
			}
			await page.screenshot({ path: test.info().outputPath(`${scope}-${width}x${height}.png`) });
			expect(errors).toEqual([]);
		});
	}

	test(`${scope} 无名称项保留 Tooltip、键盘聚焦、独立箭头和跳转`, async ({ page }) => {
		await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, scope);
		await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 0);
		const groupName = scope === "current" ? "Review" : "Recent";
		const header = page
			.locator(compactHeaderSelector)
			.filter({ has: page.getByRole("button", { name: `跳转到 ${groupName}`, exact: true }) });
		await expect(header).toBeVisible();
		const name = header.locator(".sr-only");
		expect(await name.textContent()).toBe(groupName);
		expect((await name.boundingBox())!.width).toBe(1);
		const jump = header.getByRole("button", { name: `跳转到 ${groupName}`, exact: true });
		await jump.hover();
		await expect(page.getByRole("tooltip").last()).toContainText(groupName);
		await page.mouse.move(1200, 20);
		await jump.focus();
		await page.getByRole("spinbutton", { name: "左栏宽度" }).evaluate((input) => {
			const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			nativeSetter.call(input, "280");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await expect(jump).toBeFocused();
		await expect(page.getByRole("tooltip").last()).toContainText(groupName);
		const scrollRoot = page.locator(scrollRootSelector);
		await jump.press("Enter");
		const section =
			scope === "current"
				? page.locator('[data-stage-section-id="review"]')
				: page.getByTestId("cross-project-task-switcher-section-remaining");
		const firstCard =
			scope === "current"
				? section.locator("[data-task-id]").first()
				: section.locator("[data-cross-project-task-switcher-task-id]").first();
		await expect
			.poll(async () => {
				const rail = await page.locator(`${railSelector}[data-edge="top"]`).boundingBox();
				return (
					(await firstCard.boundingBox())!.y - (rail ? rail.y + rail.height : (await scrollRoot.boundingBox())!.y)
				);
			})
			.toBeGreaterThanOrEqual(0);
		await expect(page.getByLabel("动作结果")).toHaveText("");
		const copySelector =
			scope === "current"
				? '[data-testid="stage-header-rail-focused-card"]'
				: "[data-cross-project-focused-task-sticky-edge]";
		const focusedCopy = page.locator(copySelector);
		await expect(focusedCopy).toHaveCount(1);
		const copyRow = focusedCopy.locator("xpath=ancestor::*[@data-focus-view-header-rail-row]");
		expect(
			Math.abs((await copyRow.boundingBox())!.width - (await scrollRoot.evaluate((root) => root.clientWidth)) + 4),
		).toBeLessThan(1);
		const beforeCollapse = await scrollRoot.evaluate((root) => root.scrollTop);
		const topRail = page.locator(`${railSelector}[data-edge="top"]`);
		const collapseName = scope === "current" ? "Backlog" : "Running";
		await topRail.getByRole("button", { name: `收起 ${collapseName}`, exact: true }).click();
		await expect(page.getByRole("button", { name: `展开 ${collapseName}`, exact: true }).first()).toBeVisible();
		expect(await scrollRoot.evaluate((root) => root.scrollTop)).toBeLessThanOrEqual(beforeCollapse);
		await expectRowsMatchRenderedGeometry(page);
	});
}

for (const scope of ["current", "all"] as const) {
	test(`${scope} 触屏 Pinned 收起后保持单列名称与点击展开`, async ({ browser }) => {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
		});
		const page = await context.newPage();
		try {
			const errors = await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, scope, {
				usesPinnedFixtures: true,
			});
			const pinnedSection = page.locator(
				scope === "current"
					? '[data-task-pinboard-container="focus-view-section"]'
					: '[data-testid="cross-project-task-switcher-section-pinned"]',
			);
			await pinnedSection.getByRole("button", { name: "收起 Pinned", exact: true }).tap();
			const pinnedHeader = page.locator(`${railSelector} [data-focus-view-group-header-rail-entry="pinned"]`);
			await expect(pinnedHeader).toBeVisible();
			await expect(page.locator(compactHeaderSelector)).toHaveCount(0);
			await expect(pinnedHeader.locator("[data-focus-view-group-header]")).toContainText("Pinned");
			await expectRowsMatchRenderedGeometry(page);
			await pinnedHeader.getByRole("button", { name: "展开 Pinned", exact: true }).tap();
			await expect(pinnedSection).toBeVisible();
			expect(errors).toEqual([]);
		} finally {
			await context.close();
		}
	});
}

test("当前项目压缩项的更多菜单保留批量操作且不触发跳转", async ({ page }) => {
	await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "current");
	await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 0);
	const trigger = page.getByRole("button", { name: "已结案 更多操作", exact: true });
	const scrollRoot = page.locator(scrollRootSelector);
	const before = await scrollRoot.evaluate((root) => root.scrollTop);
	await trigger.click();
	await page.getByRole("menuitem", { name: "永久删除已结案任务", exact: true }).click();
	await expect(page.getByLabel("动作结果")).toHaveText("清空已结案");
	expect(await scrollRoot.evaluate((root) => root.scrollTop)).toBe(before);
});

test("All projects 压缩 Recent 保留筛选浮层，数量变化不改变排列", async ({ page }) => {
	await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "all");
	await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 0);
	const recent = page.locator(`${railSelector} [data-focus-view-group-header-rail-entry="remaining"]`);
	await recent.getByRole("button", { name: /Recent 筛选与排序/ }).click();
	await expect(page.getByRole("dialog", { name: "Recent 筛选与排序", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	const before = await recent.boundingBox();
	await page.getByRole("button", { name: "增加分组数量", exact: true }).click();
	await expect(recent).toContainText("25");
	expect(await recent.boundingBox()).toEqual(before);
});

test("触屏保留名称、普通标题和单列交互", async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	try {
		await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "all");
		await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 0);
		await expect(page.locator(compactHeaderSelector)).toHaveCount(0);
		await expect(
			page.locator(`${railSelector} [data-focus-view-group-header]`).filter({ hasText: "Recent" }),
		).toBeVisible();
	} finally {
		await context.close();
	}
});
