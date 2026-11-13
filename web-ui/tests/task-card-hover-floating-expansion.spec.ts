import { expect, type Locator, type Page, test } from "@playwright/test";
import { taskCardActionToolbar } from "./task-card-action-toolbar-browser-locators";

const expansionStateAttribute = "data-cross-project-task-switcher-row-in-place-expansion-state";
const floatingCardSelector = "[data-cross-project-task-switcher-hover-floating-card]";

test("共享快捷操作首次悬停同时显示上方名称与下方菜单，键盘和禁用提示可用", async ({ page }) => {
	const { rows, pageErrors } = await mountHoverExpansionHarness(page, "focus");
	await hoverRow(page, rows.first());
	const prompt = (await taskCardActionToolbar(rows.first())).getByRole("button", {
		name: "View original prompt",
		exact: true,
	});
	await prompt.hover();
	const tooltip = page.getByRole("tooltip").filter({ hasText: "查看原始 Prompt" });
	const menu = page.getByRole("menu", { name: "查看原始 Prompt附加操作" });
	await expect(tooltip).toBeVisible();
	await expect(menu).toBeVisible();
	const triggerBounds = (await prompt.boundingBox())!;
	const tooltipBounds = (await tooltip.boundingBox())!;
	const menuBounds = (await menu.boundingBox())!;
	expect(tooltipBounds.y + tooltipBounds.height).toBeLessThanOrEqual(triggerBounds.y);
	expect(menuBounds.y).toBeGreaterThanOrEqual(triggerBounds.y + triggerBounds.height);
	await page.getByRole("menuitem", { name: "复制原始 Prompt" }).focus();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(prompt).toBeFocused();
	await expect(tooltip).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(tooltip).toHaveCount(0);
	const disabled = page.getByRole("button", { name: "禁用快捷操作", exact: true });
	await disabled.locator("..").hover();
	await expect(page.getByRole("tooltip").filter({ hasText: "禁用快捷操作" })).toBeVisible();
	await expect(disabled).toBeDisabled();
	await page.mouse.move(1200, 10);
	await disabled.locator("..").focus();
	await expect(page.getByRole("tooltip").filter({ hasText: "禁用快捷操作" })).toBeVisible();
	await expect(page.getByRole("menu")).toHaveCount(0);
	expect(pageErrors).toEqual([]);
});

async function mountHoverExpansionHarness(
	page: Page,
	host: "home" | "focus" | "single-home" | "single-focus",
	historyCommitCount = 0,
	includesGroupSpacingFixtures = false,
	includesCompleteReviewCardActions = false,
) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		// 所有 API/WebSocket 都隔离，任何请求均不触达真实 runtime。
		expect(route.request().method()).toBe("GET");
		const requestUrl = new URL(route.request().url());
		const procedures = requestUrl.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const requestInputs = JSON.parse(requestUrl.searchParams.get("input") ?? "{}") as Record<
			string,
			{ taskId?: string; expectedTaskIncarnationCreatedAtEpochMs?: number }
		>;
		await route.fulfill({
			json: procedures.map((procedure, procedureIndex) => ({
				result: {
					data:
						procedure === "taskCardAction.readTaskCardWithBoardColumn"
							? {
									taskCardLookupOutcome: "task_card_found_on_workspace_board",
									taskCardSnapshot: {
										taskCard: {
											id: requestInputs[procedureIndex]?.taskId,
											title: "悬浮任务 0",
											createdAt: requestInputs[procedureIndex]?.expectedTaskIncarnationCreatedAtEpochMs,
											taskCommentEntries: [],
										},
										boardColumnIdContainingTaskCard: "review",
										taskSessionSummaryLiveInRuntimeProcessMemory: null,
										taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
									},
								}
							: procedure === "workspace.getTaskRetainedCommittedLineChangeHistory"
								? {
										summary: {
											status: "complete",
											commitCount: 1,
											additions: 123,
											deletions: 45,
											historyVersion: "wheel-history",
											unavailableReason: null,
										},
										commits: Array.from({ length: historyCommitCount }, (_, index) => ({
											commitSha: index.toString(16).padStart(40, "0"),
											subject: `累计提交 ${index}`,
											committedAtMs: 1_700_000_000_000 + index,
											additions: 123,
											deletions: 45,
										})),
									}
								: procedure.includes("DirectlyRelatedTaskPreview") ||
										procedure.includes("directlyRelatedTaskPreview")
									? {
											entries: [],
											totalTaskCount: 125,
											mutedOnlyTaskCount: 0,
											standaloneSessionCount: 0,
											neighborhoodRevision: "empty",
											nextCursor: null,
										}
									: { tasks: [] },
				},
			})),
		});
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-task-card-hover**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(
		`/isolated-task-card-hover?host=${host}${includesGroupSpacingFixtures ? "&groupSpacing=1" : ""}${includesCompleteReviewCardActions ? "&completeReviewCardActions=1" : ""}`,
	);
	await page.addScriptTag({
		type: "module",
		content: `import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;`,
	});
	await page.addScriptTag({ type: "module", url: "/tests/task-card-hover-floating-expansion-browser-harness.tsx" });
	const scrollContainer =
		host === "single-home"
			? page.locator(".kb-column-cards")
			: host === "single-focus"
				? page.locator(".kb-detail-task-list-scroll")
				: host === "home"
					? page.getByTestId("cross-project-task-switcher-section-column-scroll-container-remaining")
					: page.getByTestId("cross-project-recently-active-task-switcher-panel");
	const rows = scrollContainer.locator(
		host.startsWith("single-")
			? '[data-task-card-render-role="canonical_card_in_its_stage_list"]'
			: '[data-cross-project-task-switcher-section="remaining"][data-cross-project-task-switcher-task-id]',
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
				'[data-cross-project-task-switcher-section="remaining"][data-cross-project-task-switcher-task-id], [data-task-card-render-role="canonical_card_in_its_stage_list"]',
			),
		].map((row) => {
			const rect = row.getBoundingClientRect();
			return { top: rect.top, height: rect.height, width: rect.width };
		}),
	}));
}

async function expectFirstCardTouchesPrecedingHeaderOrControls(card: Locator, expectedHeaderHeight: number) {
	const geometry = await card.evaluate((element) => {
		let ancestor = element;
		while (ancestor.parentElement) {
			const preceding = ancestor.previousElementSibling;
			if (preceding && preceding.getBoundingClientRect().height > 0) {
				const boundary = preceding.getBoundingClientRect();
				const section = element.closest('section[data-testid^="cross-project-task-switcher-section-"]');
				return {
					gap: element.getBoundingClientRect().top - boundary.bottom,
					headerHeight: section?.firstElementChild?.getBoundingClientRect().height ?? boundary.height,
				};
			}
			ancestor = ancestor.parentElement;
		}
		throw new Error("首卡缺少可测量的标题或筛选控件");
	});
	expect(Math.abs(geometry.gap)).toBeLessThanOrEqual(0.5);
	expect(geometry.headerHeight).toBe(expectedHeaderHeight);
}

for (const host of ["home", "focus", "single-home", "single-focus"] as const) {
	test(`${host}：首卡与 Pinned 无顶部占位，悬浮按钮覆盖标题且不改变列表几何`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host, 0, true);
		await scrollContainer.evaluate((element) => {
			element.scrollTop = 0;
		});
		const headerHeight = host.endsWith("focus") || host === "focus" ? 32 : 40;
		await expectFirstCardTouchesPrecedingHeaderOrControls(rows.first(), headerHeight);
		const pinned = host.startsWith("single-")
			? page
					.locator(
						'[data-task-pinboard-container] [data-task-card-render-role="pinned_card_copy_in_task_pinboard"]',
					)
					.first()
			: page
					.getByTestId("cross-project-task-switcher-section-pinned")
					.locator("[data-cross-project-task-switcher-task-id]")
					.first();
		await expectFirstCardTouchesPrecedingHeaderOrControls(pinned, headerHeight);
		const before = await measureList(scrollContainer);
		const cardBounds = (await rows.first().boundingBox())!;
		await page.mouse.move(cardBounds.x + 30, cardBounds.y + cardBounds.height / 2);
		const toolbar = await taskCardActionToolbar(rows.first());
		await expect(toolbar).toHaveAttribute("data-task-card-action-toolbar-state", "visible");
		await expect(toolbar).toHaveCSS("visibility", "visible");
		await expect.poll(() => measureList(scrollContainer)).toEqual(before);
		const button = toolbar.getByRole("button", {
			name: host.startsWith("single-") ? "Move task to validation" : "Keep expanded in list",
			exact: true,
		});
		const buttonBounds = (await button.boundingBox())!;
		const coveredHeaderPoint = { x: buttonBounds.x + buttonBounds.width / 2, y: cardBounds.y - 2 };
		expect(
			await button.evaluate(
				(element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
				coveredHeaderPoint,
			),
		).toBe(true);
		await page.mouse.click(coveredHeaderPoint.x, coveredHeaderPoint.y);
		if (host.startsWith("single-")) await expect(page.getByLabel("动作结果")).toHaveText("validation:hover-0");
		else await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "kept_expanded_in_list");
		await page.mouse.move(1200, 10);
		await page.getByRole("button", { name: "恢复卡片内容" }).focus();
		await expect(await taskCardActionToolbar(rows.first())).toHaveAttribute(
			"data-task-card-action-toolbar-state",
			"hidden",
		);
		if (host === "home") {
			await page.getByRole("button", { name: "Collapse Recent", exact: true }).click();
			await expect(page.getByRole("button", { name: "Expand Recent", exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Expand Recent", exact: true }).click();
		} else if (host === "focus") {
			await page.getByRole("button", { name: /^Recent 筛选与排序/ }).click();
			await expect(page.getByRole("dialog", { name: "Recent 筛选与排序" })).toBeVisible();
		}
		await page.screenshot({ path: test.info().outputPath(`${host}-first-card-spacing.png`) });
		expect(pageErrors).toEqual([]);
	});
}

test("单项目吸顶副本紧贴 32px 标题，按钮不改变 rail 高度，键盘拖拽保持唯一卡片身份", async ({ page }) => {
	const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, "single-focus", 0, true);
	await scrollContainer.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	const copy = page.locator('[data-task-card-render-role="focused_card_copy_under_sticky_stage_header"]').first();
	await expect(copy).toBeVisible();
	await expectFirstCardTouchesPrecedingHeaderOrControls(copy, 32);
	const rail = copy.locator("xpath=ancestor::*[contains(@class,'kb-stage-header-rail')]");
	const beforeHeight = (await rail.boundingBox())!.height;
	const copyBounds = (await copy.boundingBox())!;
	await page.mouse.move(copyBounds.x + 20, copyBounds.y + 10);
	const toolbar = await taskCardActionToolbar(copy);
	await expect(toolbar).toHaveCSS("visibility", "visible");
	expect((await rail.boundingBox())!.height).toBe(beforeHeight);
	await scrollContainer.evaluate((element) => {
		element.scrollTop = 0;
	});
	await rows.first().focus();
	await page.keyboard.press("Space");
	await expect(page.locator('[data-task-id="hover-0"]')).toHaveCSS("position", "fixed");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Space");
	await expect(page.getByLabel("动作结果")).toHaveText("drag:hover-0");
	await expect(page.locator('[data-task-id="hover-0"]')).toHaveCount(1);
	expect(pageErrors).toEqual([]);
});

test("浮动动作组通过原卡 Tab 顺序进入和离开，不抢占其他任务的焦点", async ({ page }) => {
	const { rows } = await mountHoverExpansionHarness(page, "single-home");
	await page.keyboard.press("Tab");
	await rows.first().locator("[data-task-card-action-toolbar-placeholder]").focus();
	const toolbar = await taskCardActionToolbar(rows.first());
	await expect(toolbar.locator("button").first()).toBeFocused();
	await toolbar.locator("button").last().focus();
	await page.keyboard.press("Tab");
	expect(await toolbar.evaluate((element) => element.contains(document.activeElement))).toBe(false);
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("Shift+Tab 从后续控件反向进入最后动作，逐项遍历后回到来源前项", async ({ page }) => {
	const { rows, pageErrors } = await mountHoverExpansionHarness(page, "single-home", 0, false, true);
	await rows.first().locator("[data-task-card-action-toolbar-placeholder]").focus();
	const toolbar = await taskCardActionToolbar(rows.first());
	const actions = toolbar.locator("button:not(:disabled)");
	await expect(actions).toHaveCount(9);
	await expect(actions.first()).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await page.evaluate(() => document.activeElement?.setAttribute("data-reverse-tab-preceding-control", ""));
	const precedingControl = page.locator("[data-reverse-tab-preceding-control]");
	await expect(precedingControl).toBeFocused();
	expect(await precedingControl.evaluate((element) => element.tagName)).not.toBe("BODY");
	await rows.first().locator("[data-task-card-action-toolbar-placeholder]").focus();
	await expect(actions.first()).toBeFocused();
	await actions.last().focus();
	await page.keyboard.press("Tab");
	expect(await toolbar.evaluate((element) => element.contains(document.activeElement))).toBe(false);
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
	await expect(toolbar).toHaveAttribute("data-task-card-action-toolbar-state", "hidden");
	for (let index = (await actions.count()) - 1; index >= 0; index -= 1) {
		await page.keyboard.press("Shift+Tab");
		await expect(actions.nth(index)).toBeFocused();
	}
	await page.keyboard.press("Shift+Tab");
	await expect(precedingControl).toBeFocused();
	expect(pageErrors).toEqual([]);
});

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
	for (const overlay of ["附加菜单", "侧边按钮", "累计统计", "Tooltip"] as const) {
		test(`${host}：${overlay} 没有内部滚动时，慢速滚轮继续滚动所属列`, async ({ page }) => {
			const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
			await hoverRow(page, rows.first());
			let surface: Locator;
			if (overlay === "附加菜单" || overlay === "Tooltip") {
				await (await taskCardActionToolbar(rows.first()))
					.getByRole("button", { name: "View original prompt", exact: true })
					.hover();
				surface =
					overlay === "附加菜单"
						? page.getByRole("menu", { name: "查看原始 Prompt附加操作" })
						: page.getByRole("tooltip").filter({ hasText: "查看原始 Prompt" });
				if (overlay === "Tooltip") surface = surface.locator("..");
			} else if (overlay === "侧边按钮") {
				surface = page.locator(
					`[id="${await rows.first().locator(".kb-board-card-shell").getAttribute("aria-owns")}"]`,
				);
			} else {
				await rows.first().getByRole("button", { name: "已提交 +123 −45", exact: true }).hover();
				surface = page.getByRole("dialog", { name: "任务已提交增删行明细", exact: true });
			}
			await expect(surface).toBeVisible();
			await surface.hover();
			const before = await scrollContainer.evaluate((element) => element.scrollTop);
			await page.mouse.wheel(0, 8);
			await expect.poll(() => scrollContainer.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
			expect(await page.evaluate(() => window.scrollY)).toBe(0);
			expect(pageErrors).toEqual([]);
		});
	}

	test(`${host}：累计面板先内部滚动，到边界后接续原列`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host, 60);
		await hoverRow(page, rows.first());
		await rows.first().getByRole("button", { name: "已提交 +123 −45", exact: true }).hover();
		const panel = page.getByRole("dialog", { name: "任务已提交增删行明细", exact: true });
		await expect(panel.getByText("累计提交 59", { exact: true })).toHaveCount(1);
		await expect
			.poll(() => panel.evaluate((element) => element.scrollHeight - element.clientHeight))
			.toBeGreaterThan(0);
		await panel.hover();
		const before = await scrollContainer.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, 20);
		await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		expect(await scrollContainer.evaluate((element) => element.scrollTop)).toBe(before);
		await panel.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await page.mouse.wheel(0, 8);
		await expect.poll(() => scrollContainer.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
		expect(pageErrors).toEqual([]);
	});

	test(`${host}：未悬停的紧凑卡片有柔和边界，摘要和标题属于同一卡面`, async ({ page }) => {
		const { rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		const surface = rows.first().locator("[data-cross-project-task-switcher-compact-row-placeholder]");
		await expect(surface).not.toHaveCSS("box-shadow", "none");
		const box = (await surface.boundingBox())!;
		for (const item of [
			surface.locator("[data-task-card-secondary-metadata-row]"),
			surface.getByText("悬浮任务 0", { exact: true }),
		]) {
			await expect(item).toBeVisible();
			const child = (await item.boundingBox())!;
			expect(child.y).toBeGreaterThanOrEqual(box.y);
			expect(child.y + child.height).toBeLessThanOrEqual(box.y + box.height);
		}
		await page.screenshot({ path: test.info().outputPath(`${host}-compact-card-boundaries.png`) });
		expect(pageErrors).toEqual([]);
	});

	test(`${host}：纯指针进入 Prompt 附加菜单后保持悬浮卡片`, async ({ page }) => {
		const { rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		const row = rows.first();
		await hoverRow(page, row);
		await (await taskCardActionToolbar(row))
			.getByRole("button", { name: "View original prompt", exact: true })
			.hover();
		const menu = page.getByRole("menu", { name: "查看原始 Prompt附加操作" });
		await expect(menu).toBeVisible();
		await menu.hover();
		await page.waitForTimeout(400);
		await expect(row).toHaveAttribute(expansionStateAttribute, "expanded_in_place_by_hover");
		await expect(menu.getByRole("menuitem", { name: "复制原始 Prompt" })).toBeVisible();
		expect(pageErrors).toEqual([]);
	});

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
		await page.getByRole("button", { name: "模拟卡片内容增长" }).click();
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
		await (await taskCardActionToolbar(floatingCard))
			.getByRole("button", { name: "Move task to validation", exact: true })
			.click();
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
		await scrollContainer.evaluate((root) => {
			const row = root.querySelector<HTMLElement>('[data-cross-project-task-switcher-task-id="hover-0"]')!;
			root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
		});
		if (host === "focus") {
			await expect(page.locator('.kb-stage-header-rail[data-edge="top"]')).toBeVisible();
		}
		// 卡片可用区比自然高度多 5px；Focus View 同时缩放 rail 宿主，保留标题占用的高度。
		await scrollContainer.evaluate(
			(root, { height, host }) => {
				const element = (host === "focus" ? root.parentElement : root) as HTMLElement;
				const railHeight = [
					...(root.parentElement?.querySelectorAll(":scope > .kb-stage-header-rail") ?? []),
				].reduce((total, rail) => total + rail.getBoundingClientRect().height, 0);
				element.style.flex = "none";
				element.style.height = `${height + railHeight}px`;
			},
			{ height: naturalCardHeight + 5, host },
		);
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
		await page.getByRole("button", { name: "模拟卡片内容增长" }).click();
		const before = await measureList(scrollContainer);
		await hoverRow(page, rows.first());
		const card = rows.first().locator(floatingCardSelector);
		await page.keyboard.press("Tab");
		await (await taskCardActionToolbar(card))
			.getByRole("button", { name: "View original prompt", exact: true })
			.focus();
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
		const doneAction = (await taskCardActionToolbar(card)).getByRole("button", { name: "结案任务", exact: true });
		await doneAction.focus();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByRole("menu")).toBeVisible();
		await page.waitForTimeout(400);
		await expect(card).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(card).toBeVisible();
		await (await taskCardActionToolbar(card))
			.getByRole("button", { name: "Keep expanded in list", exact: true })
			.click();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "kept_expanded_in_list");
		expect((await measureList(scrollContainer)).rows[0]!.height).toBeGreaterThan(before.rows[0]!.height);
		await (await taskCardActionToolbar(rows.first()))
			.getByRole("button", { name: "Collapse to compact row", exact: true })
			.click();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(await measureList(scrollContainer)).toEqual(before);
		expect(pageErrors).toEqual([]);
	});
}

for (const host of ["home", "focus"] as const) {
	test(`${host}：侧边附着区在卡面外缘，进入关联预览和固定展开均保留卡片`, async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host);
		const row = rows.first();
		await expect(row.locator("[data-task-card-side-attachments]:visible")).toHaveCount(0);
		await hoverRow(page, row);
		const rail = page.locator(`[id="${await row.locator(".kb-board-card-shell").getAttribute("aria-owns")}"]`);
		await expect(rail).toHaveCSS("opacity", "1");
		const surfaceBounds = await row.locator(".kb-board-card-surface").boundingBox();
		const railBounds = await rail.boundingBox();
		expect(railBounds!.x).toBeGreaterThanOrEqual(surfaceBounds!.x + surfaceBounds!.width);
		await expectFloatingCardWithinViewport(scrollContainer, row);
		await rail.getByRole("button", { name: "查看关联任务" }).hover();
		await expect(page.getByRole("dialog", { name: "关联任务预览" })).toBeVisible();
		await expect(rail).toContainText("125");
		const attachmentBounds = (await rail.boundingBox())!;
		const cardBounds = (await row.locator(".kb-board-card-shell").boundingBox())!;
		expect(attachmentBounds.x).toBeGreaterThanOrEqual(cardBounds.x + cardBounds.width - 1);
		expect(attachmentBounds.y + attachmentBounds.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height + 1);
		await page.getByRole("dialog", { name: "关联任务预览" }).hover();
		await page.waitForTimeout(350);
		await expect(row).toHaveAttribute(expansionStateAttribute, "expanded_in_place_by_hover");
		await page.keyboard.press("Escape");
		await (await taskCardActionToolbar(row))
			.getByRole("button", { name: "Keep expanded in list", exact: true })
			.click();
		await page.mouse.move(1200, 10);
		await expect(row).toHaveAttribute(expansionStateAttribute, "kept_expanded_in_list");
		await expect(rail).toHaveCSS("opacity", "0");
		expect(pageErrors).toEqual([]);
	});
}

for (const viewportWidth of [360, 390]) {
	test.describe(`完整 Review 卡 ${viewportWidth}px 触屏动作`, () => {
		test.use({ hasTouch: true, viewport: { width: viewportWidth, height: 760 } });
		for (const host of ["single-home", "single-focus"] as const) {
			test(`${host}：首卡与后续卡标题不被遮挡，点按展开九个 44px 动作且列表几何不变`, async ({ page }) => {
				await page.addInitScript(() => {
					Object.defineProperty(navigator, "clipboard", {
						value: {
							writeText: async (text: string) => {
								document.documentElement.dataset.copiedTaskDirectoryPath = text;
							},
						},
					});
				});
				const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, host, 0, false, true);
				await scrollContainer.evaluate((element) => {
					element.scrollTop = 0;
				});
				const expectTouchableAction = async (button: Locator, actionName: string) => {
					await expect(button).toBeVisible();
					const bounds = (await button.boundingBox())!;
					expect(bounds.width, actionName).toBeGreaterThanOrEqual(44);
					expect(bounds.height, actionName).toBeGreaterThanOrEqual(44);
					expect(bounds.x, actionName).toBeGreaterThanOrEqual(0);
					expect(bounds.x + bounds.width, actionName).toBeLessThanOrEqual(viewportWidth);
					expect(
						await button.evaluate((element) => {
							const rect = element.getBoundingClientRect();
							return element.contains(
								document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
							);
						}),
						actionName,
					).toBe(true);
				};
				const expectCollapsedToolbarAndUnobscuredTitle = async (cardIndex: number) => {
					const card = rows.nth(cardIndex);
					const cardToolbar = await taskCardActionToolbar(card);
					await expect(cardToolbar).toHaveCSS("position", "fixed");
					await expect(cardToolbar).toHaveCSS("visibility", "visible");
					await expect(cardToolbar).toHaveAttribute("data-task-card-action-toolbar-disclosure-state", "collapsed");
					await expect(cardToolbar.getByRole("button")).toHaveCount(1);
					await expect(cardToolbar.locator("[data-task-card-action-toolbar-expanded-actions]")).toBeHidden();
					await expectTouchableAction(
						cardToolbar.getByRole("button", { name: "显示任务操作", exact: true }),
						`悬浮任务 ${cardIndex} 的触屏入口`,
					);
					const title = card.locator("[data-task-card-title]");
					await expect(title).toHaveText(`悬浮任务 ${cardIndex}`);
					await expect
						.poll(() =>
							title.evaluate((element) => {
								// 采样实际文字矩形，不能用段落容器可见性代替文字未被 Portal 遮挡。
								const textRange = document.createRange();
								textRange.selectNodeContents(element);
								const textRects = [...textRange.getClientRects()].filter(
									(rect) => rect.width > 0 && rect.height > 0,
								);
								return (
									textRects.length > 0 &&
									textRects.every((rect) =>
										[0.1, 0.5, 0.9].every((fraction) =>
											element.contains(
												document.elementFromPoint(rect.x + rect.width * fraction, rect.y + rect.height / 2),
											),
										),
									)
								);
							}),
						)
						.toBe(true);
				};
				await expectCollapsedToolbarAndUnobscuredTitle(0);
				await expectCollapsedToolbarAndUnobscuredTitle(1);
				const before = await measureList(scrollContainer);
				const toolbar = await taskCardActionToolbar(rows.first());
				const expandedActions = toolbar.locator("[data-task-card-action-toolbar-expanded-actions]");
				const actionNames = [
					"搁置任务",
					"Pin task to pinboard",
					"添加便签",
					"任务评论",
					"View original prompt",
					"Move task to validation",
					"结案任务",
					"Delete task permanently",
					"Copy directory path",
				] as const;
				for (const actionName of actionNames) {
					if ((await toolbar.getAttribute("data-task-card-action-toolbar-disclosure-state")) === "collapsed") {
						await toolbar.getByRole("button", { name: "显示任务操作", exact: true }).tap();
					}
					await expect(toolbar).toHaveAttribute("data-task-card-action-toolbar-disclosure-state", "expanded");
					await expect(expandedActions.getByRole("button")).toHaveCount(actionNames.length);
					await expect.poll(() => measureList(scrollContainer)).toEqual(before);
					const button = expandedActions.getByRole("button", { name: actionName, exact: true });
					await expectTouchableAction(button, actionName);
					await button.tap();
					if (actionName === "添加便签") {
						await page.getByRole("textbox", { name: "便签正文" }).tap();
						await expect(toolbar).toHaveAttribute("data-task-card-action-toolbar-disclosure-state", "expanded");
						await page.keyboard.press("Escape");
						await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(0);
					} else if (actionName === "任务评论") {
						const commentsDialog = page.getByRole("dialog", { name: "任务评论 · 悬浮任务 0", exact: true });
						await expect(commentsDialog).toBeVisible();
						await expect(commentsDialog.getByRole("alert")).toHaveCount(0);
						await page.keyboard.press("Escape");
						await expect(commentsDialog).toHaveCount(0);
					} else if (actionName === "View original prompt") {
						const originalPromptDialog = page.getByRole("dialog", { name: "Original prompt", exact: true });
						await expect(originalPromptDialog).toContainText("原始需求：悬浮任务 0");
						// 文字挂载早于 Radix 的交互层注册；先确认弹窗已可接收输入。
						await expect(originalPromptDialog).toHaveCSS("pointer-events", "auto");
						await expect(
							originalPromptDialog.getByRole("button", { name: "Close", exact: true }).first(),
						).toBeFocused();
						await page.keyboard.press("Escape");
						await expect(page.getByRole("dialog")).toHaveCount(0);
					} else if (actionName === "Copy directory path") {
						await expect(page.locator("html")).toHaveAttribute(
							"data-copied-task-directory-path",
							"/isolated/project-a/hover-0",
						);
					} else {
						const expectedActionResult = {
							搁置任务: "shelve:hover-0",
							"Pin task to pinboard": "pin:hover-0",
							"Move task to validation": "validation:hover-0",
							结案任务: "done:hover-0",
							"Delete task permanently": "delete:hover-0",
						};
						await expect(page.getByLabel("动作结果")).toHaveText(expectedActionResult[actionName]);
					}
					await expect.poll(() => measureList(scrollContainer)).toEqual(before);
				}
				const collapseButton = toolbar.getByRole("button", { name: "收起任务操作", exact: true });
				await expectTouchableAction(collapseButton, "收起任务操作");
				await collapseButton.tap();
				await expectCollapsedToolbarAndUnobscuredTitle(0);
				await expectCollapsedToolbarAndUnobscuredTitle(1);
				await expect.poll(() => measureList(scrollContainer)).toEqual(before);
				const subsequentCardToolbar = await taskCardActionToolbar(rows.nth(1));
				await subsequentCardToolbar.getByRole("button", { name: "显示任务操作", exact: true }).tap();
				await expect(subsequentCardToolbar).toHaveAttribute(
					"data-task-card-action-toolbar-disclosure-state",
					"expanded",
				);
				await expect.poll(() => measureList(scrollContainer)).toEqual(before);
				const subsequentCardAction = subsequentCardToolbar.getByRole("button", { name: "搁置任务", exact: true });
				await expectTouchableAction(subsequentCardAction, "后续卡搁置任务");
				await subsequentCardAction.tap();
				await expect(page.getByLabel("动作结果")).toHaveText("shelve:hover-1");
				await page.getByRole("button", { name: "恢复卡片内容", exact: true }).tap();
				await expectCollapsedToolbarAndUnobscuredTitle(0);
				await expectCollapsedToolbarAndUnobscuredTitle(1);
				await expect.poll(() => measureList(scrollContainer)).toEqual(before);
				await page.screenshot({
					path: test.info().outputPath(`${host}-${viewportWidth}px-complete-review-actions.png`),
				});
				expect(pageErrors).toEqual([]);
			});
		}
	});
}

test.describe("触屏长按", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 760 } });
	test("长按展开保持占位、抬手不打开任务，外部触碰收起", async ({ page }) => {
		const { scrollContainer, rows, pageErrors } = await mountHoverExpansionHarness(page, "focus");
		const before = await measureList(scrollContainer);
		const rect = await rows.first().locator("[data-cross-project-task-switcher-row-title]").boundingBox();
		const session = await page.context().newCDPSession(page);
		await session.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: rect!.x + 20, y: rect!.y + rect!.height / 2 }],
		});
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "expanded_in_place_by_hover");
		await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect(page.getByLabel("动作结果")).toBeEmpty();
		const prompt = (await taskCardActionToolbar(rows.first())).getByRole("button", {
			name: "View original prompt",
			exact: true,
		});
		const rail = page.locator(
			`[id="${await rows.first().locator(".kb-board-card-shell").getAttribute("aria-owns")}"]`,
		);
		await expect(rail).toHaveCSS("opacity", "1");
		const promptBounds = await prompt.boundingBox();
		expect(promptBounds!.width).toBeGreaterThanOrEqual(44);
		expect(promptBounds!.height).toBeGreaterThanOrEqual(44);
		await session.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: promptBounds!.x + 22, y: promptBounds!.y + 22 }],
		});
		await expect(page.getByRole("menu")).toBeVisible();
		await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect(page.getByRole("menu")).toBeVisible();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "expanded_in_place_by_hover");
		await page.keyboard.press("Escape");
		await prompt.tap();
		await expect(page.getByRole("dialog")).toContainText("原始需求：悬浮任务 0");
		await page.keyboard.press("Escape");
		await session.detach();
		expect(await measureList(scrollContainer)).toEqual(before);
		await page.getByRole("button", { name: "恢复卡片内容" }).tap();
		await expect(rows.first()).toHaveAttribute(expansionStateAttribute, "compact_row");
		expect(pageErrors).toEqual([]);
	});
});
