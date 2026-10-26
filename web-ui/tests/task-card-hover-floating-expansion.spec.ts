import { expect, type Locator, type Page, test } from "@playwright/test";

const expansionStateAttribute = "data-cross-project-task-switcher-row-in-place-expansion-state";
const floatingCardSelector = "[data-cross-project-task-switcher-hover-floating-card]";

async function mountHoverExpansionHarness(page: Page, host: "home" | "focus") {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		// 所有 API/WebSocket 都隔离，任何请求均不触达真实 runtime。
		expect(route.request().method()).toBe("GET");
		const procedures = new URL(route.request().url()).pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		await route.fulfill({ json: procedures.map(() => ({ result: { data: { tasks: [] } } })) });
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-task-card-hover**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-task-card-hover?host=${host}`);
	await page.addScriptTag({
		type: "module",
		content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
	});
	await page.addScriptTag({ type: "module", url: "/tests/task-card-hover-floating-expansion-browser-harness.tsx" });
	const scrollContainer =
		host === "home"
			? page.getByTestId("cross-project-task-switcher-section-column-scroll-container-remaining")
			: page.getByTestId("cross-project-recently-active-task-switcher-panel");
	const rows = scrollContainer.locator(
		'[data-cross-project-task-switcher-section="remaining"][data-cross-project-task-switcher-task-id]',
	);
	await expect(rows.first()).toBeVisible();
	return { scrollContainer, rows, pageErrors };
}

async function measureList(scrollContainer: Locator) {
	return scrollContainer.evaluate((root) => ({
		scrollTop: root.scrollTop,
		scrollHeight: root.scrollHeight,
		rows: [
			...root.querySelectorAll<HTMLElement>(
				'[data-cross-project-task-switcher-section="remaining"][data-cross-project-task-switcher-task-id]',
			),
		].map((row) => {
			const rect = row.getBoundingClientRect();
			return { top: rect.top, height: rect.height, width: rect.width };
		}),
	}));
}

async function hoverRow(page: Page, row: Locator) {
	const rect = await row.boundingBox();
	await page.mouse.move(rect!.x + 35, rect!.y + rect!.height / 2);
	await expect(row).toHaveAttribute(expansionStateAttribute, "expanded_in_place_by_hover");
	await expect(row.locator(floatingCardSelector)).toBeVisible();
}

async function expectFloatingCardWithinViewport(scrollContainer: Locator, row: Locator) {
	await expect
		.poll(async () => {
			const bounds = await scrollContainer.boundingBox();
			const floating = await row.locator(floatingCardSelector).boundingBox();
			const anchor = await row.boundingBox();
			return Boolean(
				bounds &&
					floating &&
					anchor &&
					floating.y >= bounds.y - 1 &&
					floating.y + floating.height <= bounds.y + bounds.height + 1 &&
					Math.abs(floating.x - anchor.x) < 1 &&
					Math.abs(floating.width - anchor.width) < 1,
			);
		})
		.toBe(true);
}

for (const host of ["home", "focus"] as const) {
	test(`${host}：悬浮展开交接精简行的键盘焦点，焦点离开后自动收起`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		const before = await measureList(scrollContainer);
		await page.keyboard.press("Tab");
		await rows.first().getByRole("button", { name: "打开任务：悬浮任务 0", exact: true }).focus();
		await hoverRow(page, rows.first());
		const floatingCard = rows.first().locator(floatingCardSelector);
		await expect(floatingCard.locator("[data-task-card-title]")).toBeFocused();
		await page.mouse.move(1200, 10);
		await page.waitForTimeout(400);
		await expect(floatingCard).toBeVisible();
		await page.getByRole("button", { name: "恢复卡片内容" }).focus();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(await measureList(scrollContainer)).toEqual(before);
		expect(pageErrors).toEqual([]);
	});

	test(`${host}：展开、收起与交接保持行坐标、占位高度及滚动尺寸，浮层遮蔽下方内容且按钮可点`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		const before = await measureList(scrollContainer);
		await hoverRow(page, rows.first());
		await expect.poll(() => measureList(scrollContainer)).toEqual(before);
		const compactPlaceholder = rows.first().locator("[data-cross-project-task-switcher-compact-row-placeholder]");
		await expect(compactPlaceholder).toHaveAttribute("inert", "");
		await expect(compactPlaceholder).toBeHidden();
		const floatingCard = rows.first().locator(floatingCardSelector);
		const overlayRect = await floatingCard.boundingBox();
		const nextRowRect = await rows.nth(1).boundingBox();
		expect(overlayRect!.y + overlayRect!.height).toBeGreaterThan(nextRowRect!.y);
		expect(
			await floatingCard.evaluate((overlay) => {
				const rect = overlay.getBoundingClientRect();
				return overlay.contains(document.elementFromPoint(rect.x + 12, rect.bottom - 4));
			}),
		).toBe(true);
		await floatingCard.getByRole("button", { name: "Move task to validation", exact: true }).click();
		await expect(page.getByLabel("动作结果")).toHaveText("validation:hover-0");
		await page.mouse.move(1200, 10);
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(await measureList(scrollContainer)).toEqual(before);
		await hoverRow(page, rows.nth(2));
		await hoverRow(page, rows.first());
		await expect(rows.nth(2)).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(await measureList(scrollContainer)).toEqual(before);
		await page.screenshot({ path: test.info().outputPath(`${host}-floating-card.png`) });
		expect(pageErrors).toEqual([]);
	});

	test(`${host}：滚到底时向上避让，滚动、窄列与窗口缩放后仍在所属视口内`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		await page.getByRole("button", { name: "模拟卡片内容增长" }).dispatchEvent("click");
		await scrollContainer.evaluate((root) => {
			root.scrollTop = root.scrollHeight;
		});
		const before = await measureList(scrollContainer);
		const last = rows.last();
		await hoverRow(page, last);
		await expectFloatingCardWithinViewport(scrollContainer, last);
		expect(await measureList(scrollContainer)).toEqual(before);
		await page.keyboard.press("Escape");
		// Focus View 在 Recent 下方还有其他分区；另把组内任务移到可视区底沿，明确制造底部空间不足。
		await scrollContainer.evaluate((root) => {
			const row = root.querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="hover-20"]')!;
			root.scrollTop += row.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom + 3;
		});
		const target = rows.nth(20);
		const nearBottom = await measureList(scrollContainer);
		await hoverRow(page, target);
		await expectFloatingCardWithinViewport(scrollContainer, target);
		const source = await target.boundingBox();
		const floating = await target.locator(floatingCardSelector).boundingBox();
		expect(floating!.y + 16).toBeLessThan(source!.y);
		expect(await measureList(scrollContainer)).toEqual(nearBottom);
		await scrollContainer.evaluate((root) => {
			root.scrollTop -= 12;
		});
		await expectFloatingCardWithinViewport(scrollContainer, target);
		if (host === "focus")
			await page.locator("[data-isolated-hover-host]").evaluate((root) => {
				(root as HTMLElement).style.width = "260px";
			});
		await page.setViewportSize({ width: 1100, height: 500 });
		await expect
			.poll(async () => {
				const viewport = await scrollContainer.boundingBox();
				const overlay = await target.locator(floatingCardSelector).boundingBox();
				return overlay!.y + overlay!.height <= viewport!.y + viewport!.height + 1;
			})
			.toBe(true);
		await expectFloatingCardWithinViewport(scrollContainer, target);
		expect(await scrollContainer.evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(true);
		expect(pageErrors).toEqual([]);
	});

	test(`${host}：内容动态增长时才启用内部滚动，恢复后解除，保持外部列表尺寸`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		await hoverRow(page, rows.first());
		const floatingCard = rows.first().locator(floatingCardSelector);
		await expect(floatingCard).not.toHaveCSS("overflow-y", "auto");
		await floatingCard.locator("[data-task-card-title]").focus();
		const naturalCardHeight = (await floatingCard.boundingBox())!.height;
		// 可视区只比当前卡片高 5px；三行标题到达后卡片才会超过整个可视区。
		await scrollContainer.evaluate((root, height) => {
			const element = root as HTMLElement;
			element.style.flex = "none";
			element.style.height = `${height}px`;
			const row = root.querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="hover-0"]')!;
			root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
		}, naturalCardHeight + 5);
		await expectFloatingCardWithinViewport(scrollContainer, rows.first());
		const before = await measureList(scrollContainer);
		// 模拟推流更新卡片正文，不触发面板外 pointerdown。
		await page.getByRole("button", { name: "模拟卡片内容增长" }).dispatchEvent("click");
		await expect(floatingCard).toHaveCSS("overflow-y", "auto");
		await expectFloatingCardWithinViewport(scrollContainer, rows.first());
		expect(await floatingCard.evaluate((overlay) => overlay.scrollHeight > overlay.clientHeight)).toBe(true);
		await floatingCard.evaluate((overlay) => {
			overlay.scrollTop = overlay.scrollHeight;
		});
		expect(await floatingCard.evaluate((overlay) => overlay.scrollTop)).toBeGreaterThan(0);
		expect(await measureList(scrollContainer)).toEqual(before);
		await page.getByRole("button", { name: "恢复卡片内容" }).dispatchEvent("click");
		await expect(floatingCard).not.toHaveCSS("overflow-y", "auto");
		expect(await measureList(scrollContainer)).toEqual(before);
		expect(pageErrors).toEqual([]);
	});

	test(`${host}：键盘焦点、菜单和 Portal 弹窗保持展开，Esc 先关闭弹窗，保持展开继续占据完整高度`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		const before = await measureList(scrollContainer);
		await hoverRow(page, rows.first());
		const card = rows.first().locator(floatingCardSelector);
		await card.getByRole("button", { name: "View original prompt", exact: true }).focus();
		await page.mouse.move(1200, 10);
		await page.waitForTimeout(400);
		await expect(card).toBeVisible();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("原始需求：悬浮任务 0");
		await dialog.click();
		await page.waitForTimeout(400);
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(card).toBeVisible();
		const doneAction = card.getByRole("button", { name: "Move task to done", exact: true });
		await doneAction.focus();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByRole("menu")).toBeVisible();
		await page.waitForTimeout(400);
		await expect(card).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(card).toBeVisible();
		await card.getByRole("button", { name: "Keep expanded in list", exact: true }).click();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "kept_expanded_in_list");
		expect((await measureList(scrollContainer)).rows[0].height).toBeGreaterThan(before.rows[0].height);
		await rows.first().getByRole("button", { name: "Collapse to compact row", exact: true }).click();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(await measureList(scrollContainer)).toEqual(before);
		expect(pageErrors).toEqual([]);
	});
}

test.describe("触屏长按", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 760 } });
	test("长按展开保持占位、抬手不打开任务，外部触碰收起", async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, "focus");
		const before = await measureList(scrollContainer);
		const rect = await rows.first().boundingBox();
		const session = await page.context().newCDPSession(page);
		await session.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: rect!.x + 35, y: rect!.y + 12 }],
		});
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "expanded_in_place_by_hover");
		await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect(page.getByLabel("动作结果")).toBeEmpty();
		expect(await measureList(scrollContainer)).toEqual(before);
		await page.getByRole("button", { name: "恢复卡片内容" }).tap();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(pageErrors).toEqual([]);
	});
});
