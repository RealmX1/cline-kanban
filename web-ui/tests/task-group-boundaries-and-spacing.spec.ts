import { expect, type Page, test } from "@playwright/test";
import { openIsolatedFocusViewCompactGroupHeadersBrowserHarness } from "./focus-view-group-header-browser-test-helpers";

async function expectTaskGroupBoundariesAndHeadingContrast(page: Page) {
	const errors = await page.locator(".kb-task-group").evaluateAll((groups) => {
		const errors: string[] = [];
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d")!;
		const luminance = (color: string) => {
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
				const value = channel / 255;
				return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
			});
			return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
		};
		for (const group of groups) {
			const bounds = group.getBoundingClientRect();
			if (!bounds.width || !bounds.height) continue;
			const style = getComputedStyle(group);
			if (
				[style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(
					(width) => width !== "1px",
				)
			)
				errors.push("分组未使用完整的 1px 边框");
			if (style.borderRadius !== "4px") errors.push("分组圆角不是 4px");
			const header = group.querySelector<HTMLElement>(".kb-task-group-header")!;
			const headerStyle = getComputedStyle(header);
			if (headerStyle.backgroundColor === style.backgroundColor) errors.push("标题缺少着色底");
			if (headerStyle.borderBottomWidth !== "1px") errors.push("标题缺少细分隔线");
			for (const title of header.querySelectorAll<HTMLElement>(
				".font-semibold:not(.sr-only), .tabular-nums, span.text-xs",
			)) {
				const foreground = luminance(getComputedStyle(title).color);
				const background = luminance(headerStyle.backgroundColor);
				const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
				if (contrast < 4.5)
					errors.push(
						`${document.documentElement.dataset.theme} 标题文字「${title.textContent}」对比度不足：${contrast.toFixed(2)}（${title.className}）`,
					);
			}
			const firstCard = group.querySelector<HTMLElement>(
				".kb-board-card-shell, [data-cross-project-task-switcher-task-id]",
			);
			if (firstCard?.getBoundingClientRect().width) {
				const cardBounds = firstCard.getBoundingClientRect();
				if (Math.abs(cardBounds.left - bounds.left - 3) > 1) errors.push("卡片到分组内缘不是 2px");
				if (cardBounds.right > bounds.right - 1) errors.push("卡片超出分组右侧边框");
			}
		}
		if (document.documentElement.scrollWidth > innerWidth) errors.push("页面意外横向溢出");
		return errors;
	});
	expect(errors).toEqual([]);
}

for (const scope of ["current", "all"] as const) {
	for (const view of ["focus", "board"] as const) {
		for (const width of [1440, 1024, 768, 390, 320]) {
			test(`${scope} ${view} ${width}px 分组边界、Pinned、长标题及明暗主题`, async ({ browser }) => {
				const context = await browser.newContext({
					viewport: { width, height: 900 },
					isMobile: width <= 768,
					hasTouch: width <= 768,
				});
				try {
					const page = await context.newPage();
					const pageErrors = await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, scope, {
						view,
						usesGroupBoundaryFixtures: true,
					});
					await page.mouse.move(width - 1, 1);
					await expect(page.locator(".kb-task-group").first()).toContainText("Pinned");
					for (const theme of ["graphite", "light", "high-contrast-dark", "high-contrast-light"]) {
						await page
							.locator("html")
							.evaluate((element, theme) => element.setAttribute("data-theme", theme), theme);
						await expectTaskGroupBoundariesAndHeadingContrast(page);
						if (theme === "light")
							await page.screenshot({ path: test.info().outputPath(`${scope}-${view}-${width}-light.png`) });
					}
					if (view === "focus" || (scope === "all" && width <= 768)) {
						const scrollRoot = page.locator("[data-task-card-column-scroll-container]");
						const offsets = await scrollRoot.evaluate((root) => {
							const group = root.querySelector(".kb-task-group")!.getBoundingClientRect();
							const bounds = root.getBoundingClientRect();
							return [group.left - bounds.left, bounds.left + root.clientWidth - group.right];
						});
						expect(offsets).toEqual([2, 2]);
						const pinnedBounds = (await page.locator(".kb-task-group").first().boundingBox())!;
						expect((await scrollRoot.boundingBox())!.y - pinnedBounds.y - pinnedBounds.height).toBe(4);
						await expect(
							page.locator('[data-focus-view-group-header][data-presentation="standard"]').first(),
						).toHaveCSS("font-size", view === "focus" ? "13px" : "14px");
					} else if (scope === "current" || width > 768) {
						const gaps = await page
							.locator(
								scope === "current"
									? ".kb-board"
									: '[data-testid="board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board"] > div',
							)
							.last()
							.evaluate((root) => {
								const groups = [...root.querySelectorAll<HTMLElement>(":scope > .kb-task-group")];
								return groups.slice(1).map((group, index) => {
									const previous = groups[index]!.getBoundingClientRect();
									const current = group.getBoundingClientRect();
									return innerWidth <= 768 ? current.top - previous.bottom : current.left - previous.right;
								});
							});
						expect(gaps.length).toBeGreaterThan(0);
						for (const gap of gaps) expect(gap).toBeCloseTo(4, 0);
					}
					await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "graphite"));
					await page.screenshot({ path: test.info().outputPath(`${scope}-${view}-${width}.png`) });
					expect(pageErrors).toEqual([]);
				} finally {
					await context.close();
				}
			});
		}
	}
}

test("4px 看板组缝仍可拖动、键盘调宽、双击恢复及拖卡", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "current", { view: "board" });
	const backlog = page.locator('.kb-board > [data-column-id="backlog"]');
	const handle = page.getByRole("separator", { name: "Resize Backlog column", exact: true });
	const initialWidth = (await backlog.boundingBox())!.width;
	await handle.focus();
	await handle.press("ArrowRight");
	await expect.poll(async () => (await backlog.boundingBox())!.width).toBeGreaterThan(initialWidth);
	await handle.press("Enter");
	await expect.poll(async () => (await backlog.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
	const handleBounds = (await handle.boundingBox())!;
	await page.mouse.move(handleBounds.x, handleBounds.y + 30);
	await page.mouse.down();
	await page.mouse.move(handleBounds.x + 70, handleBounds.y + 30, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await backlog.boundingBox())!.width).toBeGreaterThan(initialWidth + 50);
	await handle.dblclick();
	await expect.poll(async () => (await backlog.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
	await page.getByRole("button", { name: "Collapse Review column", exact: true }).click();
	await expect(page.locator('.kb-board > [data-column-id="review"]')).toHaveAttribute(
		"data-kanban-board-column-collapsed",
		"true",
	);
	const collapsedHeader = page.getByRole("button", { name: "Expand Review column", exact: true });
	await page.mouse.move(1400, 10);
	const collapsedHeaderBackground = await collapsedHeader.evaluate(
		(element) => getComputedStyle(element).backgroundColor,
	);
	await collapsedHeader.hover();
	await expect
		.poll(() => collapsedHeader.evaluate((element) => getComputedStyle(element).backgroundColor))
		.not.toBe(collapsedHeaderBackground);
	await collapsedHeader.click();
	const card = backlog.locator("[data-rfd-drag-handle-draggable-id]").first();
	await card.focus();
	await page.keyboard.press("Space");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Space");
	await expect(page.getByLabel("动作结果")).toHaveText("移动:backlog-0:in_progress");
	const secondCardBounds = (await backlog.locator("[data-rfd-drag-handle-draggable-id]").nth(1).boundingBox())!;
	const destinationBounds = (await page
		.locator('.kb-board > [data-column-id="in_progress"] .kb-column-cards')
		.boundingBox())!;
	await page.mouse.move(secondCardBounds.x + 40, secondCardBounds.y + 10);
	await page.mouse.down();
	await page.mouse.move(destinationBounds.x + 40, destinationBounds.y + 20, { steps: 12 });
	await page.mouse.up();
	await expect(page.getByLabel("动作结果")).toHaveText("移动:backlog-1:in_progress");
});
