import { expect, type Locator, type Page, test } from "@playwright/test";
import { taskCardActionToolbar } from "./task-card-action-toolbar-browser-locators";

async function visibleBox(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	return box!;
}

async function measureTaskCardSummaryMetadataCellGeometry(summary: Locator) {
	return summary.locator("[data-task-card-summary-cell]").evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			const contentBounds = [...element.children]
				.map((child) => child.getBoundingClientRect())
				.filter((child) => child.width > 0 && child.height > 0);
			return {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				contentCenterY: contentBounds.length
					? (Math.min(...contentBounds.map((child) => child.top)) +
							Math.max(...contentBounds.map((child) => child.bottom))) /
						2
					: null,
				scrollWidth: element.scrollWidth,
				clientWidth: element.clientWidth,
			};
		}),
	);
}

for (const cardWidth of [200, 240, 320, 480]) {
	test(`${cardWidth}px 卡宽：普通统计变化保持中间列起点，Files 图标保留可访问文件数`, async ({ page }) => {
		await page.setViewportSize({ width: 1600, height: 1100 });
		await mountCardMetadataHarness(page, `cardWidth=${cardWidth}`);
		const hosts = ["all-projects", "project-specific", "standard-board"];
		const before = await Promise.all(
			hosts.map((host) =>
				measureTaskCardSummaryMetadataCellGeometry(
					page.locator(`[data-layout-host="${host}"] [data-task-card-secondary-metadata-row]:visible`),
				),
			),
		);
		await page.getByRole("button", { name: "切换统计密度", exact: true }).click();
		for (const [index, host] of hosts.entries()) {
			const summary = page.locator(`[data-layout-host="${host}"] [data-task-card-secondary-metadata-row]:visible`);
			const after = await measureTaskCardSummaryMetadataCellGeometry(summary);
			if (cardWidth >= 320) expect(Math.abs(after[1].x - before[index][1].x)).toBeLessThan(1);
			else expect(after[1].width).toBeGreaterThan((await visibleBox(summary)).width * 0.25);
			expect(Math.abs(after[4].x - after[1].x)).toBeLessThan(1);
			const dirty = summary.locator('[data-task-card-summary-cell="dirty"]');
			await expect(dirty.locator("svg.lucide-files")).toBeVisible();
			await expect(dirty).toContainText("123 files");
			await expect(dirty.locator(".sr-only")).toHaveText(" files");
			for (const cell of after) expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);
		}
	});
	test(`${cardWidth}px 卡宽：列宽随内容分配，空统计不占一整列`, async ({ page }) => {
		await page.setViewportSize({ width: 1600, height: 1100 });
		const populatedProjectWidths: number[] = [];
		for (const zeroStatistics of [false, true]) {
			await mountCardMetadataHarness(page, `${zeroStatistics ? "zeroStatistics&" : ""}cardWidth=${cardWidth}`);
			for (const [index, host] of ["all-projects", "project-specific", "standard-board"].entries()) {
				const summary = page.locator(
					`[data-layout-host="${host}"] [data-task-card-secondary-metadata-row]:visible`,
				);
				await expect(summary).toBeVisible();
				const cells = await measureTaskCardSummaryMetadataCellGeometry(summary);
				for (const cell of cells) {
					if (cell.contentCenterY !== null)
						expect(Math.abs(cell.contentCenterY - cell.y - cell.height / 2)).toBeLessThan(1);
				}
				if (zeroStatistics) {
					expect(cells[2].width).toBeLessThan(1);
					expect(cells[0].width).toBeGreaterThan(populatedProjectWidths[index] + 20);
				} else {
					populatedProjectWidths.push(cells[0].width);
					for (const cell of cells.slice(0, 3)) expect(cell.width).toBeGreaterThan(0);
				}
			}
			await page.screenshot({
				path: test.info().outputPath(`summary-grid-${cardWidth}-${zeroStatistics ? "zero" : "populated"}.png`),
			});
		}
	});

	test(`${cardWidth}px 卡宽：大数字完整保留，摘要只在六个单元格内部换行`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 1100 });
		const errors = await mountCardMetadataHarness(page, `longMetadata&largeStatistics&cardWidth=${cardWidth}`);
		const summary = page.locator('[data-layout-host="all-projects"] [data-task-card-secondary-metadata-row]:visible');
		await expect(summary).toContainText("123457K");
		await expect(summary).toContainText("987654K");
		await expect(summary.getByRole("button", { name: "已提交 +123456789 −987654321", exact: true })).toBeVisible();
		const cells = await measureTaskCardSummaryMetadataCellGeometry(summary);
		expect(cells).toHaveLength(6);
		for (let index = 0; index < 3; index++) {
			expect(Math.abs(cells[index].x - cells[index + 3].x)).toBeLessThan(1);
			expect(Math.abs(cells[index].y - cells[0].y)).toBeLessThan(1);
			expect(Math.abs(cells[index + 3].y - cells[3].y)).toBeLessThan(1);
			expect(Math.abs(cells[index].height - cells[0].height)).toBeLessThan(1);
			expect(Math.abs(cells[index + 3].height - cells[3].height)).toBeLessThan(1);
		}
		for (const cell of cells) {
			expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);
			if (cell.contentCenterY !== null)
				expect(Math.abs(cell.contentCenterY - cell.y - cell.height / 2)).toBeLessThan(1);
		}
		await page.screenshot({ path: test.info().outputPath(`summary-grid-large-statistics-${cardWidth}.png`) });
		const project = summary.locator("[data-task-card-project-metadata-group]");
		for (const host of ["all-projects", "project-specific", "standard-board"]) {
			await expect(
				page.locator(`[data-layout-host="${host}"] [data-task-card-project-metadata-group]:visible`),
			).toHaveAttribute("aria-label", "很长的项目名称-project-with-a-long-name-and-repository-context");
		}
		await project.locator("span").last().focus();
		await expect(page.getByRole("tooltip")).toContainText(
			"很长的项目名称-project-with-a-long-name-and-repository-context",
		);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("tooltip")).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

for (const cardWidth of [200, 240]) {
	test(`${cardWidth}px 卡宽：手动压缩缓存药丸在时间单元格内换行`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 1100 });
		await mountCardMetadataHarness(page, `compactedContext&cardWidth=${cardWidth}`);
		const host = page.locator('[data-layout-host="all-projects"]');
		const row = host.locator("[data-cross-project-task-switcher-task-id]");
		for (const expanded of [false, true]) {
			if (expanded) {
				// 展开开关由行悬停显现，先进入卡面再点击，保留真实命中检查。
				await row.hover({ position: { x: 45, y: 14 } });
				await expect(row).toHaveAttribute(
					"data-cross-project-task-switcher-row-in-place-expansion-state",
					"expanded_in_place_by_hover",
				);
				await (await taskCardActionToolbar(row))
					.getByRole("button", { name: "Keep expanded in list", exact: true })
					.click();
				await page.mouse.move(1275, 5);
				await expect(row).toHaveAttribute(
					"data-cross-project-task-switcher-row-in-place-expansion-state",
					"kept_expanded_in_list",
				);
			}
			const time = host.locator('[data-task-card-summary-cell="time"]:visible');
			await expect(time).toContainText("Compacted · ~200k");
			expect(await time.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
			const cellBox = await visibleBox(time);
			const pillBox = await visibleBox(time.locator('span[title^="Compacted"]'));
			expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 1);
		}
	});
}

for (const activation of ["mouse", "touch"] as const) {
	test.describe(`项目名激活方式：${activation}`, () => {
		test.use({ hasTouch: activation === "touch" });
		test(`缩略行项目名保留任务打开动作：${activation}`, async ({ page }) => {
			await mountCardMetadataHarness(page);
			const project = page.locator(
				'[data-layout-host="all-projects"] [data-cross-project-task-switcher-compact-row-placeholder] [data-task-card-project-metadata-group] span[tabindex]',
			);
			if (activation === "mouse") await project.click();
			else await project.tap();
			await expect(page.getByRole("status", { name: "打开任务次数" })).toHaveText("1");
		});
	});
}

test("已知零值统计隐藏内容，但保留固定摘要单元格", async ({ page }) => {
	const errors = await mountCardMetadataHarness(page, "zeroStatistics");
	for (const host of ["all-projects", "project-specific", "standard-board"]) {
		const summary = page.locator(`[data-layout-host="${host}"] [data-task-card-secondary-metadata-row]:visible`);
		await expect(summary.locator("[data-task-card-summary-cell]")).toHaveCount(6);
		await expect(summary.locator('[data-task-card-summary-cell="dirty"]')).toBeEmpty();
		await expect(summary.locator('[data-task-card-summary-cell="committed_diff"]')).toBeEmpty();
		await expect(summary.locator('[data-task-card-summary-cell="deployment_coverage"]')).toContainText("2/5");
	}
	expect(errors).toEqual([]);
});

test("附着操作越过列裁切，浏览器右沿自动翻到左侧", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const errors = await mountCardMetadataHarness(page);
	const host = page.locator('[data-layout-host="standard-board"]');
	await host.evaluate((element) =>
		Object.assign(element.style, {
			position: "fixed",
			left: "260px",
			top: "150px",
			width: "280px",
			height: "220px",
			overflow: "hidden",
		}),
	);
	const card = host.locator(".kb-board-card-shell");
	const surface = host.locator(".kb-board-card-surface");
	await host.locator("[data-task-card-title]").hover();
	const attachments = page.locator(`[id="${await card.getAttribute("aria-owns")}"]`);
	await expect(attachments).toHaveAttribute("data-attachment-side", "right");
	const button = attachments.getByRole("button", { name: "查看关联任务" });
	await button.hover();
	const buttonBounds = await visibleBox(button);
	expect(buttonBounds.x).toBeGreaterThanOrEqual((await visibleBox(host)).x + (await visibleBox(host)).width);
	expect(
		await button.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return (
				document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element
			);
		}),
	).toBe(true);
	await page.keyboard.press("Escape");
	await host.evaluate((element) => Object.assign(element.style, { left: "auto", right: "0px" }));
	await host.locator("[data-task-card-title]").hover();
	await expect(attachments).toHaveAttribute("data-attachment-side", "left");
	expect((await visibleBox(attachments)).x + (await visibleBox(attachments)).width).toBeLessThanOrEqual(
		(await visibleBox(surface)).x + 1,
	);
	await page.mouse.move(100, 850);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await expect(attachments).toHaveAttribute("data-task-card-side-attachments-state", "hidden");
	await button.focus();
	await expect(attachments).toHaveCSS("opacity", "1");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "关联任务预览" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(button).toBeFocused();
	expect(errors).toEqual([]);
});

test.describe("触屏附着操作", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 1000 } });
	test("卡底常驻操作行保留 44px 点击区域", async ({ page }) => {
		await mountCardMetadataHarness(page);
		const host = page.locator('[data-layout-host="standard-board"]');
		await host.scrollIntoViewIfNeeded();
		const attachments = host.locator("[data-task-card-side-attachments]");
		await expect(attachments).toHaveCSS("position", "relative");
		const surfaceBounds = await visibleBox(host.locator(".kb-board-card-surface"));
		expect((await visibleBox(attachments)).y).toBeGreaterThanOrEqual(surfaceBounds.y + surfaceBounds.height);
		const button = attachments.getByRole("button", { name: "查看关联任务" });
		const bounds = await visibleBox(button);
		expect(bounds.width).toBeGreaterThanOrEqual(44);
		expect(bounds.height).toBeGreaterThanOrEqual(44);
		await button.tap();
		await expect(page.getByRole("dialog", { name: "关联任务预览" })).toBeVisible();
	});
});

async function mountCardMetadataHarness(page: Page, queryString = "") {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	// 所有请求都与真实运行时隔离；快照不可用场景也只验证真实兜底 UI。
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-task-card-layout*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-task-card-layout${queryString ? `?${queryString}` : ""}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/task-card-status-corners-and-metadata-layout-browser-harness.tsx",
	});
	return pageErrors;
}

for (const width of [1280, 768, 390, 360]) {
	for (const longMetadata of [false, true]) {
		test(`${width}px，长元信息=${longMetadata}：三态摘要分组坐标和宽度保持一致`, async ({ page }) => {
			await page.setViewportSize({ width, height: 1100 });
			await page.clock.setFixedTime(new Date("2026-10-24T12:00:00.000Z"));
			const pageErrors = await mountCardMetadataHarness(page, longMetadata ? "longMetadata" : "");
			const allProjects = page.locator('[data-layout-host="all-projects"]');
			const row = allProjects.locator("[data-cross-project-task-switcher-task-id]");
			const title = row.locator(
				"[data-cross-project-task-switcher-row-title]:visible, [data-task-card-title]:visible",
			);
			const metadata = row.locator("[data-task-card-secondary-metadata-row]:visible");
			const runningDot = row.locator('[data-task-card-corner-status-indicator="running"]:visible');
			const unreadDot = row.locator('[data-task-card-corner-status-indicator="unread_handoff"]:visible');
			const taskCreatedAtTooltipContent = await page.evaluate(
				() => `创建于 · ${new Date(Date.now() - 60_000).toLocaleString()}`,
			);
			await expect(title).toBeVisible();
			for (const host of [
				allProjects,
				page.locator('[data-layout-host="project-specific"]'),
				page.locator('[data-layout-host="standard-board"]'),
			]) {
				await expect(host.getByRole("button", { name: "部署覆盖：2/5 个已知提交" })).toBeVisible();
				const creationTimePill = host.locator("[data-task-created-at-pill]:visible");
				await expect(creationTimePill).toHaveText("1m");
				await expect(creationTimePill).toHaveAttribute("title", taskCreatedAtTooltipContent);
				const creationTimeBox = await visibleBox(creationTimePill);
				expect(creationTimeBox.x).toBeGreaterThanOrEqual(0);
				expect(creationTimeBox.x + creationTimeBox.width).toBeLessThanOrEqual(width);
			}
			const standardCard = page.locator('[data-layout-host="standard-board"]');
			await standardCard.locator("[data-task-card-title]").hover();
			const actionsBounds = await visibleBox(await taskCardActionToolbar(standardCard));
			const attachmentsId = await standardCard.locator(".kb-board-card-shell").getAttribute("aria-owns");
			const attachments = page.locator(`[id="${attachmentsId}"]`);
			await expect(attachments).toHaveCSS("opacity", "1");
			await expect(attachments).toHaveAttribute("data-attachment-side", /left|right/);
			const relatedTaskTrigger = attachments.getByRole("button", { name: "查看关联任务" });
			const relatedTaskBounds = await visibleBox(relatedTaskTrigger);
			expect(relatedTaskBounds.x).toBeGreaterThanOrEqual(
				(await visibleBox(standardCard.locator(".kb-board-card-surface"))).x +
					(await visibleBox(standardCard.locator(".kb-board-card-surface"))).width,
			);
			const standardMetadataBounds = await visibleBox(
				standardCard.locator("[data-task-card-secondary-metadata-row]"),
			);
			expect(actionsBounds.y + actionsBounds.height).toBeLessThanOrEqual(standardMetadataBounds.y);
			expect(
				await relatedTaskTrigger.evaluate((button) => {
					const bounds = button.getBoundingClientRect();
					return (
						document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 2)?.closest("button") === button
					);
				}),
			).toBe(true);
			// 精简行的元信息宿主不接指针事件，创建时间自身仍需能触发原生 title 提示。
			await expect(row.locator("[data-task-created-at-pill]:visible")).toHaveCSS("pointer-events", "auto");
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
			const metadataGroupSelectors = [
				"[data-task-card-project-metadata-group]",
				"[data-task-card-base-branch-relation-group]",
				"[data-task-card-line-change-statistics-group]",
				"[data-task-card-time-metadata-group]",
			];
			const initialGroups = await Promise.all(
				metadataGroupSelectors.map((selector) => visibleBox(row.locator(`${selector}:visible`))),
			);
			await row
				.locator("[data-cross-project-task-switcher-compact-row-placeholder]")
				.dispatchEvent("pointerenter", { pointerType: "mouse" });
			await expect(await taskCardActionToolbar(row)).toHaveCSS("visibility", "visible");
			const initialExpansionToggle = await visibleBox(
				(await taskCardActionToolbar(row)).getByRole("button", { name: "Keep expanded in list", exact: true }),
			);
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
				expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
				if (locator === metadata) expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
			}
			for (let index = 0; index < metadataGroupSelectors.length; index++) {
				const after = await visibleBox(row.locator(`${metadataGroupSelectors[index]}:visible`));
				for (const dimension of ["x", "y", "width", "height"] as const)
					expect(Math.abs(after[dimension] - initialGroups[index][dimension])).toBeLessThanOrEqual(1);
			}
			if (longMetadata) {
				await expect(row.locator("[data-task-card-status-notices]:visible")).toContainText("输入确认待补证");
				await expect(metadata).not.toContainText("输入确认待补证");
			}
			const expandedToggle = await visibleBox(
				(await taskCardActionToolbar(row)).getByRole("button", { name: "Keep expanded in list", exact: true }),
			);
			for (const dimension of ["x", "y", "width", "height"] as const)
				expect(Math.abs(expandedToggle[dimension] - initialExpansionToggle[dimension])).toBeLessThanOrEqual(1);
			const sessionActivity = row.locator("[data-task-card-session-activity]");
			expect(Math.abs((await visibleBox(sessionActivity)).x - initialMetadata.x)).toBeLessThan(1);
			await (await taskCardActionToolbar(row))
				.getByRole("button", { name: "Keep expanded in list", exact: true })
				.click();
			await page.mouse.move(width - 5, 5);
			await expect(row).toHaveAttribute(
				"data-cross-project-task-switcher-row-in-place-expansion-state",
				"kept_expanded_in_list",
			);
			for (let index = 0; index < metadataGroupSelectors.length; index++) {
				const after = await visibleBox(row.locator(`${metadataGroupSelectors[index]}:visible`));
				for (const dimension of ["x", "y", "width", "height"] as const)
					expect(Math.abs(after[dimension] - initialGroups[index][dimension])).toBeLessThanOrEqual(1);
			}
			for (const host of [
				allProjects,
				page.locator('[data-layout-host="project-specific"]'),
				page.locator('[data-layout-host="standard-board"]'),
			]) {
				await page.mouse.move(width - 5, 5, { steps: 5 });
				// 卡片先进入 hover，按既有性能门控挂载 Tooltip，再移动到创建时间。
				await host.locator("[data-task-card-title]:visible").hover();
				const creationTimePill = host.locator("[data-task-created-at-pill]:visible");
				await expect(creationTimePill).toHaveAttribute("data-state", "closed");
				await page.mouse.move(width - 5, 5);
				await creationTimePill.hover();
				await expect(page.getByRole("tooltip")).toHaveText(taskCreatedAtTooltipContent);
			}

			await page.screenshot({
				path: test.info().outputPath(`task-card-layout-expanded-${width}.png`),
				fullPage: true,
			});
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
			await expect(row.locator("[data-task-created-at-pill]:visible")).toHaveText("1m");
			await expect(row.locator("[data-task-created-at-pill]:visible")).toHaveAttribute(
				"title",
				taskCreatedAtTooltipContent,
			);
			expect(Math.abs((await visibleBox(title)).x - initialTitle.x)).toBeLessThan(1);
			await page.getByRole("button", { name: "切换未读状态", exact: true }).click();
			await expect(page.locator("[data-task-card-corner-status-indicator]:visible")).toHaveCount(0);
			expect(Math.abs((await visibleBox(title)).x - initialTitle.x)).toBeLessThan(1);
			await page.getByRole("button", { name: "切换运行状态", exact: true }).click();
			await page.getByRole("button", { name: "切换未读状态", exact: true }).click();
			await page.getByRole("button", { name: "切换快照可用性", exact: true }).click();
			await expect(
				row.locator("[data-cross-project-task-switcher-full-task-card-unavailable-fallback]"),
			).toBeVisible();
			await expect(runningDot).toHaveCount(1);
			await expect(unreadDot).toHaveCount(1);
			expect(Math.abs((await visibleBox(title)).x - initialTitle.x)).toBeLessThan(1);
			await page.getByRole("button", { name: "切换快照可用性", exact: true }).click();
			await expect(row.locator("[data-task-card-title]")).toBeVisible();
			await row.hover();
			await (await taskCardActionToolbar(row))
				.getByRole("button", { name: "Collapse to compact row", exact: true })
				.click();
			await expect(row).toHaveAttribute(
				"data-cross-project-task-switcher-row-in-place-expansion-state",
				"compact_row",
			);
			await expect(row.locator("[data-task-created-at-pill]:visible")).toHaveText("1m");
			await row.getByRole("button", { name: /^打开任务：/ }).click({
				position: { x: 10, y: 10 },
			});
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
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
			expect(pageErrors).toEqual([]);
		});
	}
}
