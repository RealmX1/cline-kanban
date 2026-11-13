import { expect, type Page, test } from "@playwright/test";
import type { RuntimeTaskCardActionUpdateFieldValuesRequest } from "../src/runtime/types";
import type { BoardCard, TaskCommentEntry } from "../src/types";
import { taskCardActionToolbar } from "./task-card-action-toolbar-browser-locators";

test.setTimeout(60_000);
test.describe.configure({ mode: "parallel" });

async function openWorkbench(page: Page, width: number, height: number, scenario = "") {
	await page.setViewportSize({ width, height });
	await page.route("**/api/**", (route) => route.abort());
	let terminalConnections = 0;
	await page.routeWebSocket("**/*", (socket) => {
		const url = new URL(socket.url());
		if (url.pathname === "/api/terminal/io") terminalConnections++;
		if (url.pathname === "/api/terminal/control")
			socket.send(JSON.stringify({ type: "restore", cols: 60, rows: 24, snapshot: "隔离工作台终端\r\n> " }));
	});
	await page.route("**/isolated-desktop-task-workbench*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-desktop-task-workbench${scenario ? `?${scenario}` : ""}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/desktop-focus-view-task-workbench-browser-harness.tsx" });
	await expect(page.locator('[data-verification-anchor="task-detail:workbench-test-task"]')).toBeVisible();
	if (!scenario.includes("column=trash") && !scenario.includes("acp"))
		await expect(page.locator(".xterm-screen")).toBeVisible();
	return () => terminalConnections;
}

for (const width of [320, 390, 1440]) {
	for (const panel of ["terminal", "chat", "history"]) {
		test(`${width}px ${panel} 项目入口截断长名称且保留工具和会话内容`, async ({ page }) => {
			const scenario = panel === "chat" ? "acp" : panel === "history" ? "column=trash" : "column=review";
			const connections = await openWorkbench(
				page,
				width,
				900,
				`${scenario}&project_navigation&compact&back_to_board`,
			);
			const projectButton = page.getByTestId("agent-session-toolbar-focused-task-project-narrowing-button");
			await expect(projectButton).toBeVisible();
			const projectName = await projectButton.innerText();
			expect(await projectButton.getAttribute("title")).toContain(`${projectName} (`);
			expect(await projectButton.getAttribute("aria-label")).toBe(`仅显示项目 ${projectName}`);
			expect(
				await projectButton
					.locator("span")
					.last()
					.evaluate((name) => name.scrollWidth > name.clientWidth),
			).toBe(true);
			const question = page.getByRole("button", { name: "展开问答记录", exact: true });
			expect((await projectButton.boundingBox())!.x).toBeLessThan((await question.boundingBox())!.x);
			if (width < 769) {
				const header = page.locator("[data-mobile-focused-task-card-header]");
				for (const button of await header.locator("button:visible").all()) {
					const box = (await button.boundingBox())!;
					expect(box.width).toBeGreaterThanOrEqual(44);
					expect(box.height).toBeGreaterThanOrEqual(44);
					expect(box.x).toBeGreaterThanOrEqual(0);
					expect(box.x + box.width).toBeLessThanOrEqual(width);
				}
			}
			await question.click();
			await expect(page.getByRole("dialog", { name: "问答记录", exact: true })).toBeVisible();
			await page.keyboard.press("Escape");
			if (panel === "terminal") {
				await page.getByRole("button", { name: "终端工具与更多信息", exact: true }).click();
				await expect(page.getByRole("dialog", { name: "终端工具与更多信息", exact: true })).toBeVisible();
				await page.keyboard.press("Escape");
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
			await page.screenshot({ path: test.info().outputPath(`session-toolbar-project-${panel}-${width}.png`) });
			const terminal = panel === "terminal" ? await page.locator(".xterm-screen").elementHandle() : null;
			const beforeConnections = connections();
			// 先关闭前一工具的提示，再独立验证项目入口的点击与会话连续性。
			await page.keyboard.press("Escape");
			await expect(page.getByRole("tooltip")).toHaveCount(0);
			await projectButton.click();
			await expect(projectButton).toHaveCount(0);
			expect(
				await page.evaluate(() =>
					(window as unknown as { readTaskActionInvocations: () => string[] }).readTaskActionInvocations(),
				),
			).toEqual(["project:isolated-workbench"]);
			if (terminal) expect(await terminal.evaluate((element) => element.isConnected)).toBe(true);
			expect(connections()).toBe(beforeConnections);
		});
	}
}

for (const width of [320, 360, 390, 768, 960]) {
	test(`${width}px 紧凑信息入口、浮层与任务操作不压缩终端`, async ({ page }) => {
		const connections = await openWorkbench(page, width, 812, "compact&column=review");
		const beforeConnections = connections();
		const toolbar = page.locator("[data-focus-view-session-information-toolbar]");
		await expect(toolbar).toBeVisible();
		expect((await toolbar.boundingBox())!.height).toBe(width <= 768 ? 44 : 32);
		const terminal = page.locator(".kb-terminal-container");
		const before = (await terminal.boundingBox())!;
		if (width <= 768) expect(before.height).toBeGreaterThan(600);
		const questionTrigger = page.getByRole("button", { name: "展开问答记录", exact: true });
		const stop = page.getByRole("button", { name: "停止当前会话", exact: true });
		if (width <= 768) {
			for (const target of [questionTrigger, stop, page.getByRole("button", { name: "终端工具与更多信息" })]) {
				const box = (await target.boundingBox())!;
				expect(box.width).toBeGreaterThanOrEqual(44);
				expect(box.height).toBeGreaterThanOrEqual(44);
			}
		}
		let historyReads = 0;
		await page.route("**/api/trpc/runtime.listAgentRaisedUserDecisionHistoryForTask*", (route) => {
			historyReads++;
			return route.fulfill({ json: [{ result: { data: { historyEntries: [] } } }] });
		});
		expect(historyReads).toBe(0);
		await questionTrigger.click();
		const history = page.getByRole("dialog", { name: "问答记录", exact: true });
		await expect(history).toBeVisible();
		await expect(history).toContainText("还没有已了结");
		expect(historyReads).toBe(1);
		expect((await terminal.boundingBox())!.height).toBe(before.height);
		const popup = (await history.boundingBox())!;
		expect(popup.x).toBeGreaterThanOrEqual(0);
		expect(popup.x + popup.width).toBeLessThanOrEqual(width);
		await page.keyboard.press("Escape");
		await expect(history).toHaveCount(0);
		await expect(questionTrigger).toBeFocused();
		if (width < 360) await page.getByRole("button", { name: "终端工具与更多信息" }).click();
		await page.getByRole("button", { name: "展开资源占用明细", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "资源占用", exact: true })).toContainText("CPU 12%");
		expect((await terminal.boundingBox())!.height).toBe(before.height);
		await page.keyboard.press("Escape");
		if (width < 360) await page.keyboard.press("Escape");
		const actions = page.getByRole("button", { name: "任务操作", exact: true });
		await expect(page.getByRole("menuitem", { name: "结案任务", exact: true })).toHaveCount(0);
		await actions.click();
		await expect(page.getByRole("menuitem", { name: "移至 Validation", exact: true })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Commit", exact: true })).toBeVisible();
		await expect(page.getByRole("menu", { name: "任务操作", exact: true })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(actions).toBeFocused();
		if (width <= 768) {
			await page.getByRole("button", { name: "展开下方按键栏", exact: true }).click();
			await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toBeVisible();
			await expect(actions).toBeVisible();
			await page.getByRole("button", { name: "收起下方按键栏", exact: true }).click();
			await expect(page.locator("[data-terminal-virtual-key-input-bar]")).toHaveCount(0);
		}
		expect(connections()).toBe(beforeConnections);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		await page.screenshot({ path: test.info().outputPath(`compact-focus-view-${width}.png`) });
	});
}

for (const width of [320, 359, 360, 390]) {
	test(`${width}px 返回看板与自动动作组合保留完整的手机导航及触控目标`, async ({ page }) => {
		await openWorkbench(page, width, 812, "compact&column=review&back_to_board&auto_review");
		const header = page.locator("[data-mobile-focused-task-card-header]");
		for (const button of await header.locator("button:visible").all()) {
			const box = (await button.boundingBox())!;
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(width);
		}
		await expect(header.getByRole("button", { name: "返回看板", exact: true })).toBeVisible();
		await expect(header.getByRole("button", { name: "展开上方导航与工具", exact: true })).toBeVisible();
		await expect(header.getByRole("button", { name: "展开问答记录", exact: true })).toBeVisible();
		if (width >= 360)
			await expect(header.getByRole("button", { name: "展开资源占用明细", exact: true })).toBeVisible();
		const cancelAutomaticAction = page.getByRole("button", { name: "Cancel Auto-commit", exact: true });
		await expect(cancelAutomaticAction).toBeVisible();
		const cancelBox = (await cancelAutomaticAction.boundingBox())!;
		expect(cancelBox.width).toBeGreaterThanOrEqual(44);
		expect(cancelBox.height).toBeGreaterThanOrEqual(44);
		expect(cancelBox.x).toBeGreaterThanOrEqual(0);
		expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(width);
		expect(cancelBox.y).toBeGreaterThanOrEqual(0);
		expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(812);
		await cancelAutomaticAction.click();
		expect(
			await page.evaluate(() =>
				(window as unknown as { readTaskActionInvocations: () => string[] }).readTaskActionInvocations(),
			),
		).toEqual(["cancel-automatic"]);
		await page.getByRole("button", { name: "展开下方按键栏", exact: true }).click();
		await expect(cancelAutomaticAction).toBeVisible();
		await page.getByRole("button", { name: "收起下方按键栏", exact: true }).click();
		await page.getByRole("button", { name: "终端工具与更多信息", exact: true }).click();
		const tools = page.getByRole("dialog", { name: "终端工具与更多信息", exact: true });
		await tools.getByRole("button", { name: "Find in terminal", exact: true }).click();
		const search = page.getByRole("textbox", { name: "Find in terminal", exact: true });
		await expect(search).toBeVisible();
		await expect(search).toBeFocused();
		await search.press("Escape");
		await expect(search).toHaveCount(0);
		await expect(header.getByRole("button", { name: "展开上方导航与工具", exact: true })).toBeVisible();
	});
}

for (const width of [320, 360]) {
	test(`${width}px ACP 没有移列资格时默认保留取消自动动作`, async ({ page }) => {
		await openWorkbench(page, width, 812, "compact&acp&back_to_board&auto_review");
		const cancelAutomaticAction = page.getByRole("button", { name: "Cancel Auto-commit", exact: true });
		await expect(page.getByRole("button", { name: "任务操作", exact: true })).toHaveCount(0);
		await expect(cancelAutomaticAction).toBeVisible();
		const box = (await cancelAutomaticAction.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(width);
		const composer = page.locator("textarea");
		await expect(composer).toBeVisible();
		expect(box.y + box.height).toBeLessThanOrEqual((await composer.boundingBox())!.y);
		await cancelAutomaticAction.click();
		expect(
			await page.evaluate(() =>
				(window as unknown as { readTaskActionInvocations: () => string[] }).readTaskActionInvocations(),
			),
		).toEqual(["cancel-automatic"]);
	});
}

for (const sessionScenario of ["acp&column=review", "column=trash&auto_review"]) {
	for (const width of [320, 359]) {
		test(`${width}px 非 PTY 工作台保留资源详情入口：${sessionScenario}`, async ({ page }) => {
			await openWorkbench(page, width, 812, `compact&back_to_board&${sessionScenario}`);
			const moreInformation = page.getByRole("button", { name: "会话更多信息", exact: true });
			await moreInformation.click();
			const resourceDetails = page
				.getByRole("dialog", { name: "会话更多信息", exact: true })
				.getByRole("button", { name: "展开资源占用明细", exact: true });
			await expect(resourceDetails).toBeVisible();
			const box = (await resourceDetails.boundingBox())!;
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.x + box.width).toBeLessThanOrEqual(width);
			await resourceDetails.click();
			const resourcePopover = page.getByRole("dialog", { name: "资源占用", exact: true });
			await expect(resourcePopover).toContainText("CPU 12%");
			await expect(resourcePopover).toBeFocused();
			// 焦点不足以证明 Radix 交互层已就绪；先等浮层稳定且可命中，再验证键盘关闭。
			await resourcePopover.click({ trial: true });
			await resourcePopover.press("Escape");
			await expect(resourcePopover).toHaveCount(0);
			await expect(resourceDetails).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(moreInformation).toBeFocused();
			if (sessionScenario.includes("acp")) {
				await expect(page.getByRole("menuitem", { name: "结案任务", exact: true })).toHaveCount(0);
				const actions = page.getByRole("button", { name: "任务操作", exact: true });
				await actions.click();
				await expect(page.getByRole("menuitem", { name: "Commit", exact: true })).toBeVisible();
				await expect(page.getByRole("menuitem", { name: "移至 Validation", exact: true })).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(actions).toBeFocused();
			} else {
				await expect(page.getByRole("button", { name: "任务操作", exact: true })).toHaveCount(0);
				await expect(page.getByRole("button", { name: "Cancel Auto-commit", exact: true })).toHaveCount(0);
			}
		});
	}
}

test("Project Specific 的 Pinned 内部溢出时与普通分组按实际滚动条占宽保持卡片等宽", async ({ page }) => {
	await openWorkbench(page, 1280, 700, "column=review&stage_headers");
	await page.addStyleTag({ content: "* { scrollbar-width: auto; } *::-webkit-scrollbar { width: 14px; }" });
	const scrollRoot = page.locator(".kb-detail-task-list-scroll");
	const pinned = page.locator('[data-task-pinboard-container="focus-view-section"]');
	const group = page.locator('[data-stage-section-id="backlog"]');
	await pinned.evaluate((element) => {
		element.style.maxHeight = "100px";
	});
	const pinnedScrollContainer = pinned.locator(":scope > div").last();
	await expect
		.poll(() => pinnedScrollContainer.evaluate((element) => element.scrollHeight - element.clientHeight))
		.toBeGreaterThan(0);
	const pinnedCard = pinned.locator('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]');
	const regularCard = group.locator('[data-task-id="backlog-sample-0"]');
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
	await page.screenshot({ path: test.info().outputPath("project-specific-pinned-width.png") });
});

test("Project Specific 吸顶标题与当前任务卡上的滚轮接续整列滚动", async ({ page }) => {
	await openWorkbench(page, 1280, 700, "column=review&stage_headers");
	const scrollRoot = page.locator(".kb-detail-task-list-scroll");
	for (const edge of ["top", "bottom"] as const) {
		for (const targetSelector of [
			"[data-focus-view-group-header]",
			'[data-testid="stage-header-rail-focused-card"]',
		]) {
			await scrollRoot.evaluate((element, direction) => {
				element.scrollTop = direction === "top" ? element.scrollHeight : 0;
				element.dispatchEvent(new Event("scroll"));
			}, edge);
			const target = page.locator(`.kb-stage-header-rail[data-edge="${edge}"]`).locator(targetSelector).first();
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

for (const source of ["列表卡片", "吸顶副本"] as const) {
	test(`Project Specific ${source}的附加菜单不会截住慢速滚轮`, async ({ page }) => {
		await openWorkbench(page, 1280, 700, "column=review&stage_headers");
		const scrollRoot = page.locator(".kb-detail-task-list-scroll");
		await scrollRoot.evaluate((element, sticky) => {
			element.scrollTop = sticky ? element.scrollHeight : 0;
			element.dispatchEvent(new Event("scroll"));
		}, source === "吸顶副本");
		const card =
			source === "吸顶副本"
				? page.getByTestId("stage-header-rail-focused-card")
				: page.locator('[data-task-id="backlog-sample-0"]');
		await expect(card).toBeVisible();
		await card.hover();
		await expect(card.locator(".kb-board-card-surface")).not.toHaveCSS("box-shadow", "none");
		await (await taskCardActionToolbar(card))
			.getByRole("button", { name: "View original prompt", exact: true })
			.hover();
		const menu = page.getByRole("menu", { name: "查看原始 Prompt附加操作" });
		await menu.hover();
		const before = await scrollRoot.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, source === "吸顶副本" ? -8 : 8);
		await expect
			.poll(() => scrollRoot.evaluate((element) => element.scrollTop))
			[source === "吸顶副本" ? "toBeLessThan" : "toBeGreaterThan"](before);
	});
}

test("Stage 与 sticky 标题共享 32px 几何，首卡贴顶且浮动操作可覆盖标题", async ({ page }) => {
	await openWorkbench(page, 1280, 900, "column=review&stage_headers");
	await page.locator(".kb-stage-header-rail").getByRole("button", { name: "跳转到 Backlog", exact: true }).click();
	const stage = page.locator('[data-stage-section-id="backlog"]');
	const inlineHeader = stage.locator("[data-focus-view-group-header]");
	await expect(stage.getByRole("button", { name: "收起 Backlog", exact: true })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	for (const header of await page.locator("[data-focus-view-group-header]:visible").all())
		expect((await header.boundingBox())!.height).toBe(32);
	const firstCard = stage.locator('[data-task-id="backlog-sample-0"]');
	await firstCard.hover();
	const actions = await taskCardActionToolbar(firstCard);
	const headerBox = (await inlineHeader.boundingBox())!;
	expect((await firstCard.boundingBox())!.y).toBe(headerBox.y + headerBox.height);
	await expect(actions).toHaveCSS("visibility", "visible");
	expect((await actions.boundingBox())!.y).toBeLessThan(headerBox.y + headerBox.height);
	await stage.getByRole("button", { name: "收起 Backlog", exact: true }).click();
	await expect(stage.getByRole("button", { name: "展开 Backlog", exact: true })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(page.locator('[data-task-id="workbench-test-task"]')).toHaveCount(1);
});

test("任务菜单保留回调与 Stage/Shelved/侧会话资格", async ({ page }) => {
	await openWorkbench(page, 1080, 900, "column=review&side");
	const actions = page.getByRole("button", { name: "任务操作", exact: true });
	await actions.click();
	await page.getByRole("menuitem", { name: "移至 Validation", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as { readTaskActionInvocations: () => string[] }).readTaskActionInvocations(),
			),
		)
		.toEqual(["validation"]);
	await page.getByText("侧会话验证", { exact: true }).click();
	await expect(actions).toHaveCount(0);
});

test("Validation 菜单只保留结案并沿用回调", async ({ page }) => {
	await openWorkbench(page, 1080, 900, "column=validation");
	await page.getByRole("button", { name: "任务操作", exact: true }).click();
	await expect(page.getByRole("menuitem", { name: "移至 Validation", exact: true })).toHaveCount(0);
	await expect(page.getByRole("menuitem", { name: "Commit", exact: true })).toHaveCount(0);
	await page.getByRole("menuitem", { name: "结案任务", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as { readTaskActionInvocations: () => string[] }).readTaskActionInvocations(),
			),
		)
		.toEqual(["done"]);
});

for (const scenario of ["column=review&shelved", "column=trash"])
	test(`${scenario} 不提供任务执行菜单`, async ({ page }) => {
		await openWorkbench(page, 1080, 900, scenario);
		await expect(page.getByRole("button", { name: "任务操作", exact: true })).toHaveCount(0);
	});

for (const [width, height] of [
	[1080, 1920],
	[1440, 2560],
	[769, 1024],
	[1920, 1080],
]) {
	test(`${width}×${height} 自动布局、模块交换和终端连续性`, async ({ page }) => {
		const connections = await openWorkbench(page, width!, height!);
		const initialConnections = connections();
		const arrangement = height! > width! ? "agent_above_workbench_below" : "agent_left_workbench_right";
		await expect(page.locator("[data-focus-view-panel-arrangement]")).toHaveAttribute(
			"data-focus-view-panel-arrangement",
			arrangement,
		);
		const terminal = await page.locator(".kb-terminal-container").boundingBox();
		const workbench = await page.getByRole("region", { name: "任务工作台", exact: true }).boundingBox();
		expect(terminal).not.toBeNull();
		expect(workbench).not.toBeNull();
		if (height! > width!) {
			expect(workbench!.y).toBeGreaterThan(terminal!.y + terminal!.height - 2);
			expect(terminal!.width).toBeGreaterThan(width! * 0.7);
		} else expect(workbench!.x).toBeGreaterThan(terminal!.x);
		await page.screenshot({ path: test.info().outputPath(`task-workbench-${width}x${height}.png`) });
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption("prompt_tools");
		await expect(page.getByLabel("工作台格位 2", { exact: true })).toHaveValue("task_sessions");
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption("cross_task_relations");
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption("exploration_map");
		await page.getByRole("button", { name: "工作台布局", exact: true }).click();
		await page.getByRole("menuitemradio", { name: "上下", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.setViewportSize({ width: 1920, height: 1080 });
		await expect(page.locator("[data-focus-view-panel-arrangement]")).toHaveAttribute(
			"data-focus-view-panel-arrangement",
			"agent_above_workbench_below",
		);
		if (width === 1080) {
			const terminalNode = await page.locator(".kb-terminal-container").elementHandle();
			await page.setViewportSize({ width: 390, height: 812 });
			await expect(page.locator("[data-mobile-focused-task-session-toolbar-host]")).toBeVisible();
			await page.setViewportSize({ width: 1920, height: 1080 });
			expect(
				await terminalNode!.evaluate((element) => element === document.querySelector(".kb-terminal-container")),
			).toBe(true);
		}
		expect(connections()).toBe(initialConnections);
		expect(
			await page.evaluate(() =>
				(window as unknown as { readWorkbenchTerminalCount: () => number }).readWorkbenchTerminalCount(),
			),
		).toBe(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
		await page.getByRole("button", { name: "重置布局", exact: true }).click();
		await expect(page.getByLabel("工作台格位 1", { exact: true })).toHaveValue("task_sessions");
		await page.getByRole("button", { name: "工作台布局", exact: true }).click();
		await expect(page.getByRole("menuitemradio", { name: "自动", exact: true })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});
}

test("会话对话框关闭、换格与 Changes 返回后保留草稿", async ({ page }) => {
	await openWorkbench(page, 1080, 1920);
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await page.getByPlaceholder("首条消息可留空，创建后再输入…").fill("跨格位保留的会话草稿");
	await page.keyboard.press("Escape");
	await page.getByLabel("工作台格位 1", { exact: true }).selectOption("cross_task_relations");
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByLabel("工作台格位 1", { exact: true }).selectOption("task_sessions");
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await expect(page.getByPlaceholder("首条消息可留空，创建后再输入…")).toHaveValue("跨格位保留的会话草稿");
	await page.route("**/api/trpc/runtime.lookupTaskConversationSessionCreation*", (route) =>
		route.fulfill({ json: [{ result: { data: null } }] }),
	);
	await page.route("**/api/trpc/runtime.createTaskConversationSession*", (route) =>
		route.fulfill({
			json: [{ result: { data: { ok: false, error: "隔离环境：创建失败后保留草稿", creation: null } } }],
		}),
	);
	await page.getByRole("button", { name: "创建会话", exact: true }).click();
	await expect(page.getByText("隔离环境：创建失败后保留草稿", { exact: true })).toBeVisible();
	await expect(page.getByPlaceholder("首条消息可留空，创建后再输入…")).toHaveValue("跨格位保留的会话草稿");
	await page.screenshot({ path: test.info().outputPath("portrait-session-creation.png") });
});

test("拖动比例和手动布局在刷新后恢复", async ({ page }) => {
	await openWorkbench(page, 1080, 1920);
	const handle = await page
		.getByRole("separator", { name: "Resize agent and diff panels", exact: true })
		.boundingBox();
	await page.mouse.move(handle!.x + handle!.width / 2, handle!.y);
	await page.mouse.down();
	await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 100);
	await page.mouse.up();
	const ratio = await page.evaluate(() =>
		localStorage.getItem("kanban.focus-view-stacked-agent-panel-height-ratio.v1"),
	);
	expect(Number(ratio)).toBeGreaterThan(0.6);
	await page.getByRole("separator", { name: "调整任务工作台格位大小" }).focus();
	await page.keyboard.press("ArrowRight");
	await page.getByLabel("工作台格位 2", { exact: true }).selectOption("exploration_map");
	await page.getByRole("button", { name: "工作台布局", exact: true }).click();
	await page.getByRole("menuitemradio", { name: "上下", exact: true }).click();
	await page.keyboard.press("Escape");
	await openWorkbench(page, 1920, 1080);
	await page.getByRole("button", { name: "工作台布局", exact: true }).click();
	await expect(page.getByRole("menuitemradio", { name: "上下", exact: true })).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("工作台格位 2", { exact: true })).toHaveValue("exploration_map");
	expect(
		await page.evaluate(() => localStorage.getItem("kanban.focus-view-stacked-agent-panel-height-ratio.v1")),
	).toBe(ratio);
	expect(
		Number(await page.evaluate(() => localStorage.getItem("kanban.task-workbench-side-by-side-slot-width-ratio.v1"))),
	).toBeCloseTo(0.55);
});

test("手机任务卡保留评论入口，读取失败不提供覆盖评论的保存入口", async ({ page }) => {
	await openWorkbench(page, 390, 812);
	await page.getByRole("button", { name: "展开任务卡", exact: true }).click();
	const button = page.getByRole("button", { name: "任务评论", exact: true });
	const box = await button.boundingBox();
	expect(box!.width).toBeGreaterThanOrEqual(44);
	expect(box!.height).toBeGreaterThanOrEqual(44);
	await button.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByRole("button", { name: "重新读取", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add comment", exact: true })).toHaveCount(0);
});

async function openCommentsWithIsolatedRuntime(page: Page, failFirstSave = false) {
	await openWorkbench(page, 390, 812);
	const currentTaskCard = await page.evaluate(() =>
		(window as unknown as { readWorkbenchTaskCard: () => BoardCard }).readWorkbenchTaskCard(),
	);
	const savedComments: TaskCommentEntry[] = [];
	const writes: unknown[] = [];
	await page.route("**/api/trpc/taskCardAction.*", async (route) => {
		const snapshot = () => ({
			taskCard: { ...currentTaskCard, title: "隔离评论验证", taskCommentEntries: [...savedComments] },
			boardColumnIdContainingTaskCard: "in_progress",
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		});
		if (route.request().url().includes("readTaskCardWithBoardColumn")) {
			await route.fulfill({
				json: [
					{
						result: {
							data: {
								taskCardLookupOutcome: "task_card_found_on_workspace_board",
								taskCardSnapshot: snapshot(),
							},
						},
					},
				],
			});
		} else if (route.request().url().includes("updateTaskCardFieldValues")) {
			const input = (
				route.request().postDataJSON() as Record<string, RuntimeTaskCardActionUpdateFieldValuesRequest>
			)["0"]!;
			writes.push(input);
			if (failFirstSave && writes.length === 1) {
				await route.fulfill({
					status: 500,
					json: [
						{
							error: {
								message: "隔离环境：评论保存失败",
								code: -32603,
								data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
							},
						},
					],
				});
				return;
			}
			if (input.taskCardFieldUpdate.taskCardFieldUpdateInputKind !== "three_state_task_card_field_value_patch")
				throw new Error("评论保存必须使用字段 patch。");
			savedComments.splice(
				0,
				savedComments.length,
				...(input.taskCardFieldUpdate.taskCardFieldValuePatch.taskCommentEntries ?? []),
			);
			await route.fulfill({ json: [{ result: { data: { taskCardSnapshotAfterAction: snapshot() } } }] });
		} else await route.abort();
	});
	await page.getByRole("button", { name: "展开任务卡", exact: true }).click();
	await page.getByRole("button", { name: "任务评论", exact: true }).click();
	await expect(page.getByPlaceholder("Write a task comment...")).toBeVisible();
	return { writes, savedComments };
}

for (const closeMethod of ["关闭按钮", "Escape"] as const) {
	test(`评论对话框通过${closeMethod}关闭不会提交新评论草稿`, async ({ page }) => {
		const { writes, savedComments } = await openCommentsWithIsolatedRuntime(page);
		await page.getByPlaceholder("Write a task comment...").fill("尚未确认的新评论");
		if (closeMethod === "关闭按钮") await page.getByRole("button", { name: "关闭填写窗口", exact: true }).click();
		else await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
		await page.getByRole("button", { name: "任务评论", exact: true }).click();
		await expect(page.getByPlaceholder("Write a task comment...")).toBeVisible();
		expect(writes).toHaveLength(0);
		expect(savedComments).toHaveLength(0);
	});
}

test("评论浮窗允许操作背景，保留草稿且不自动提交", async ({ page }) => {
	const { writes } = await openCommentsWithIsolatedRuntime(page);
	await page.getByPlaceholder("Write a task comment...").fill("背景操作后保留的评论");
	await page.mouse.click(1, 1);
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByPlaceholder("Write a task comment...")).toHaveValue("背景操作后保留的评论");
	expect(writes).toHaveLength(0);
});

test("评论对话框新评论只显式提交，失败可重试且既有评论仍在失焦时保存", async ({ page }) => {
	const { writes, savedComments } = await openCommentsWithIsolatedRuntime(page, true);
	const newComment = page.getByPlaceholder("Write a task comment...");
	await newComment.fill("明确提交的新评论");
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeFocused();
	expect(writes).toHaveLength(0);
	await expect(newComment).toHaveValue("明确提交的新评论");
	await page.getByRole("button", { name: "Add comment", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("隔离环境：评论保存失败");
	await expect(page.getByPlaceholder("Edit task comment...")).toHaveValue("明确提交的新评论");
	expect(savedComments).toHaveLength(0);
	await page.getByRole("button", { name: "重试保存", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect.poll(() => writes.length).toBe(2);
	await expect(newComment).toBeEnabled();
	expect(savedComments).toEqual([expect.objectContaining({ commentText: "明确提交的新评论" })]);
	await page.getByPlaceholder("Edit task comment...").fill("修改已有评论");
	await newComment.click();
	await expect.poll(() => savedComments[0]?.commentText).toBe("修改已有评论");
	expect(writes).toHaveLength(3);
});
