import { expect, type Page, test } from "@playwright/test";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../src/config/user-interface-preferences-shared-across-browser-origins";
import type { RuntimeConfigResponse, TaskVisualizationPreviewRequestedMessage } from "../src/runtime/types";

const artifact = {
	workspaceId: "isolated-sidebar-project",
	taskId: "sidebar-task",
	visualizationArtifactId: "a".repeat(64),
	revisionId: "b".repeat(64),
	versionNumber: 1,
	title: "侧栏连续性图",
	entryHtmlRelativePath: "index.html",
	publishedAtMs: 1,
	sourceConversationSessionId: null,
};
const confirmationId = "11111111-1111-4111-8111-111111111111";
interface SidebarHarnessWindow extends Window {
	createSidebarPreviewOffer: () => TaskVisualizationPreviewRequestedMessage;
	deliverSidebarPreview: (message: TaskVisualizationPreviewRequestedMessage) => void;
	readSidebarTerminalMountCount: () => number;
	readSidebarPreviewAcknowledgments: () => { outcome?: string }[];
	sidebarPreviewOffer: TaskVisualizationPreviewRequestedMessage;
	sidebarOriginalIframe: HTMLIFrameElement;
	sidebarOriginalContentWindow: Window;
}
async function openSidebarHarness(page: Page, width = 1920, height = 1080) {
	await page.setViewportSize({ width, height });
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = url.pathname.split("/api/trpc/")[1]!.split(",");
		const responses = procedures.map((procedure) => {
			if (procedure === "taskVisualizationArtifacts.list") return { result: { data: { artifacts: [artifact] } } };
			if (procedure === "taskVisualizationArtifacts.preparePreview")
				return {
					result: {
						data: {
							artifact,
							contentRelativeUrl: "/isolated-sidebar-visualization",
							viewerRelativeUrl: "/task-visualization-preview",
							contentAccessExpiresAtMs: Date.now() + 60_000,
							contentLoadConfirmationId: confirmationId,
						},
					},
				};
			return {
				error: {
					message: `隔离测试不执行 ${procedure}`,
					code: -32601,
					data: { code: "NOT_FOUND", httpStatus: 404 },
				},
			};
		});
		await route.fulfill({ json: url.searchParams.has("batch") ? responses : responses[0] });
	});
	let terminalConnections = 0;
	const terminalInputs: string[] = [];
	await page.routeWebSocket("**/*", (socket) => {
		const url = new URL(socket.url());
		if (url.pathname === "/api/terminal/io") {
			terminalConnections++;
			socket.onMessage((message) => terminalInputs.push(String(message)));
		}
		if (url.pathname === "/api/terminal/control")
			socket.send(JSON.stringify({ type: "restore", cols: 60, rows: 24, snapshot: "隔离侧栏终端\r\n> " }));
	});
	let contentLoads = 0;
	await page.route("**/isolated-sidebar-visualization", (route) => {
		contentLoads++;
		const proof = JSON.stringify({
			...artifact,
			type: "kanban_visualization_content_loaded",
			contentLoadConfirmationId: confirmationId,
		});
		return route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><body><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><div style="height:2000px"></div><script>window.addEventListener("load",()=>parent.postMessage(${proof},"*"));</script></body></html>`,
		});
	});
	await page.route("**/isolated-sidebar-visibility", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const harness=document.createElement('script');harness.type='module';harness.src='/tests/sidebar-visibility-browser-harness.tsx';document.body.append(harness);</script></body></html>",
		}),
	);
	await page.goto("/isolated-sidebar-visibility");
	await page.bringToFront();
	await expect(page.locator(".xterm-screen")).toBeVisible();
	const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"));
	return {
		modifier,
		terminalConnections: () => terminalConnections,
		terminalInputs,
		contentLoads: () => contentLoads,
	};
}

for (const platform of ["MacIntel", "Win32"]) {
	test(`${platform} 平台精确修饰键、原生 Ctrl+B、长按和启动全部迁移`, async ({ page }) => {
		await page.addInitScript(
			(platform) => Object.defineProperty(navigator, "platform", { value: platform }),
			platform,
		);
		const evidence = await openSidebarHarness(page);
		const terminalInput = page.locator(".xterm-helper-textarea");
		const leftSidebar = page.locator("[data-focus-view-task-list-sidebar]");
		await terminalInput.focus();
		const visibleSidebarButtonBackground = await page
			.getByRole("button", { name: "隐藏任务列表", exact: true })
			.evaluate((button) => getComputedStyle(button).backgroundColor);
		if (platform === "MacIntel") {
			await page.keyboard.press("Control+b");
			await expect.poll(() => evidence.terminalInputs.includes("\u0002")).toBe(true);
			await expect(leftSidebar).toBeVisible();
		}
		await page.keyboard.press(`${evidence.modifier}+Shift+b`);
		await expect(page.getByLabel("启动全部请求次数")).toHaveText("1");
		await page.keyboard.down(evidence.modifier);
		await page.keyboard.down("b");
		await page.keyboard.down("b");
		await page.keyboard.up("b");
		await page.keyboard.up(evidence.modifier);
		await expect(leftSidebar).toBeHidden();
		expect(
			await page
				.getByRole("button", { name: "显示任务列表", exact: true })
				.evaluate((button) => getComputedStyle(button).backgroundColor),
		).not.toBe(visibleSidebarButtonBackground);
		await expect(page.getByLabel("启动全部请求次数")).toHaveText("1");
	});
}

for (const [width, height] of [
	[1920, 1080],
	[1080, 1920],
]) {
	test(`${width}×${height} 标题栏与热键一致，回收空间并保留尺寸、草稿和终端`, async ({ page }) => {
		const evidence = await openSidebarHarness(page, width, height);
		const agent = page.locator("[data-focus-view-agent-panel]");
		const left = page.locator("[data-focus-view-task-list-sidebar]");
		const workbench = page.locator("[data-focus-view-workbench-sidebar]");
		const resizeTaskList = (await page
			.getByRole("separator", { name: "Resize task cards and detail panels", exact: true })
			.boundingBox())!;
		await page.mouse.move(resizeTaskList.x, resizeTaskList.y + 100);
		await page.mouse.down();
		await page.mouse.move(resizeTaskList.x + 50, resizeTaskList.y + 100);
		await page.mouse.up();
		const resizeAgent = (await page
			.getByRole("separator", { name: "Resize agent and diff panels", exact: true })
			.boundingBox())!;
		await page.mouse.move(resizeAgent.x + resizeAgent.width / 2, resizeAgent.y + resizeAgent.height / 2);
		await page.mouse.down();
		await page.mouse.move(
			resizeAgent.x + resizeAgent.width / 2 + (height! > width! ? 0 : 50),
			resizeAgent.y + resizeAgent.height / 2 + (height! > width! ? 50 : 0),
		);
		await page.mouse.up();
		const initialAgent = (await agent.boundingBox())!;
		const initialLeft = (await left.boundingBox())!;
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		await page.getByPlaceholder("首条消息可留空，创建后再输入…", { exact: true }).fill("隐藏后保留的会话草稿");
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
		await expect(workbench).toBeHidden();
		await expect(page.getByRole("separator", { name: "Resize agent and diff panels", exact: true })).toHaveCount(0);
		const expandedAgent = (await agent.boundingBox())!;
		if (height! > width!) expect(expandedAgent.height).toBeGreaterThan(initialAgent.height + 100);
		else expect(expandedAgent.width).toBeGreaterThan(initialAgent.width + 100);
		await page.locator(".xterm-helper-textarea").focus();
		await page.keyboard.press(`${evidence.modifier}+Alt+b`);
		await expect(workbench).toBeVisible();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		const restoredSessionDraftInput = page.getByPlaceholder("首条消息可留空，创建后再输入…", { exact: true });
		await expect(restoredSessionDraftInput).toHaveValue("隐藏后保留的会话草稿");
		await restoredSessionDraftInput.focus();
		await page.keyboard.press(`${evidence.modifier}+b`);
		await expect(left).toBeVisible();
		await page.getByRole("button", { name: "关闭会话创建", exact: true }).click();
		await expect(page.getByRole("dialog")).toBeHidden();
		await page.locator(".xterm-helper-textarea").focus();
		const originalScrollTop = await page.locator(".kb-detail-task-list-scroll").evaluate((element) => {
			element.scrollTop = 360;
			return element.scrollTop;
		});
		expect(originalScrollTop).toBeGreaterThan(0);
		await page.keyboard.press(`${evidence.modifier}+b`);
		await expect(left).toBeHidden();
		await expect(page.getByRole("button", { name: "显示任务列表", exact: true })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await page.getByRole("button", { name: "显示任务列表", exact: true }).click();
		await expect(left).toBeVisible();
		expect(await page.locator(".kb-detail-task-list-scroll").evaluate((element) => element.scrollTop)).toBe(
			originalScrollTop,
		);
		expect((await left.boundingBox())!.width).toBeCloseTo(initialLeft.width, 0);
		expect((await agent.boundingBox())!.width).toBeCloseTo(initialAgent.width, 0);
		expect((await agent.boundingBox())!.height).toBeCloseTo(initialAgent.height, 0);
		expect(evidence.terminalConnections()).toBe(1);
		expect(
			await page.evaluate(() => (window as unknown as SidebarHarnessWindow).readSidebarTerminalMountCount()),
		).toBe(1);
		await page.screenshot({ path: test.info().outputPath(`sidebar-restored-${width}x${height}.png`) });
	});

	test(`${width}×${height} 两种项目范围的标题按钮顺序一致，悬浮入口不占空间且独立恢复`, async ({ page }) => {
		await openSidebarHarness(page, width, height);
		const left = page.locator("[data-focus-view-task-list-sidebar]");
		const workbench = page.locator("[data-focus-view-workbench-sidebar]");
		for (const allProjects of [false, true]) {
			if (allProjects) await page.getByRole("button", { name: "切换项目范围", exact: true }).click();
			const hideLeft = page.getByRole("button", { name: "隐藏任务列表", exact: true });
			expect(
				await hideLeft.evaluate((button) => {
					const header = button.parentElement!;
					return (
						header.firstElementChild === button &&
						header.children[1]?.getAttribute("aria-label") === "Create task"
					);
				}),
			).toBe(true);
			const leftBounds = (await left.boundingBox())!;
			expect(leftBounds.x).toBe(0);
			const workbenchBounds = (await workbench.boundingBox())!;
			expect(workbenchBounds.x + workbenchBounds.width).toBeCloseTo(width);
			const hideRight = page.getByRole("button", { name: "隐藏任务工作台", exact: true });
			await expect(
				hideRight.locator(height > width ? "svg.lucide-chevron-down" : "svg.lucide-chevron-right"),
			).toBeVisible();
			expect((await hideRight.boundingBox())!.height).toBeLessThanOrEqual(32);
			await hideLeft.click();
			await expect(page.getByRole("button", { name: "显示任务列表", exact: true })).toBeFocused();
			await hideRight.click();
			const revealLeft = page.getByRole("button", { name: "显示任务列表", exact: true });
			const revealRight = page.getByRole("button", { name: "显示任务工作台", exact: true });
			await expect(revealRight).toBeFocused();
			await page.locator(".xterm-helper-textarea").focus();
			await page.mouse.move(width / 2, 50);
			expect((await revealLeft.boundingBox())!.width).toBeLessThanOrEqual(36);
			expect((await revealRight.boundingBox())!.width).toBeLessThanOrEqual(36);
			const agentBounds = (await page.locator("[data-focus-view-agent-panel]").boundingBox())!;
			expect(agentBounds.x).toBe(0);
			expect(agentBounds.width).toBe(width);
			await revealLeft.hover();
			expect((await revealLeft.boundingBox())!.width).toBeGreaterThan(90);
			await expect(page.getByRole("tooltip")).toContainText(/显示任务列表 \((Cmd|Ctrl)\+B\)/);
			await expect(left).toBeHidden();
			await page.mouse.move(width / 2, 50);
			await revealRight.focus();
			expect((await revealRight.boundingBox())!.width).toBeGreaterThan(90);
			await expect(workbench).toBeHidden();
			await revealLeft.click();
			await expect(hideLeft).toBeFocused();
			await expect(left).toBeVisible();
			await expect(workbench).toBeHidden();
			await revealRight.click();
			await expect(hideRight).toBeFocused();
			await expect(workbench).toBeVisible();
		}
		await page.screenshot({ path: test.info().outputPath(`sidebar-headers-${width}x${height}.png`) });
	});
}

test("首个工作台模块更换后仍在标题右端显示隐藏按钮，Changes 工具栏可隐藏", async ({ page }) => {
	await openSidebarHarness(page);
	for (const module of [
		"prompt_tools",
		"cross_task_relations",
		"exploration_map",
		"task_visualizations",
		"task_sessions",
	]) {
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption(module);
		const hide = page.getByRole("button", { name: "隐藏任务工作台", exact: true });
		await expect(hide).toBeVisible();
		expect(
			await hide.evaluate((button) => {
				const header = button.parentElement!.parentElement!;
				return (
					header.lastElementChild === button.parentElement &&
					header.querySelector('[aria-label="工作台格位 1"]') !== null
				);
			}),
		).toBe(true);
		await expect(
			page
				.locator(`[data-task-workbench-module="${module}"]`)
				.getByRole("button", { name: "隐藏任务工作台", exact: true }),
		).toBeVisible();
	}
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	const hideChanges = page.getByRole("button", { name: "隐藏任务工作台", exact: true });
	expect(
		await hideChanges.evaluate(
			(button) =>
				button.parentElement?.lastElementChild === button &&
				button.parentElement?.textContent?.includes("All Changes"),
		),
	).toBe(true);
	await hideChanges.click();
	await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeHidden();
	await page.getByRole("button", { name: "显示任务工作台", exact: true }).click();
	await expect(page.getByRole("button", { name: "All Changes", exact: true })).toBeVisible();
});

for (const [module, expandLabel] of [
	["task_visualizations", "全屏预览"],
	["cross_task_relations", "展开关系图"],
	["exploration_map", "展开探索地图"],
] as const) {
	test(`${module} 前景不提供隐藏工作台入口，返回后隐藏和焦点交接正常`, async ({ page }) => {
		await openSidebarHarness(page);
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption(module);
		await page.getByRole("button", { name: expandLabel, exact: true }).click();
		const foreground = page.locator('[data-expanded-foreground-view="active"]');
		await expect(foreground).toBeVisible();
		await expect(foreground.getByRole("button", { name: "隐藏任务工作台", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "返回", exact: true }).click();
		await expect(foreground).toHaveCount(0);
		await expect(page).not.toHaveURL(/expandedView=/u);
		await expect(page.locator("[inert]")).toHaveCount(0);
		await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
		await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeHidden();
		const restoreWorkbench = page.getByRole("button", { name: "显示任务工作台", exact: true });
		await expect(restoreWorkbench).toBeFocused();
		await restoreWorkbench.click();
		await expect(page.getByRole("button", { name: "隐藏任务工作台", exact: true })).toBeFocused();
		await page.getByRole("button", { name: "隐藏任务列表", exact: true }).click();
		await expect(page.locator("[data-focus-view-task-list-sidebar]")).toBeHidden();
	});
}

test("三个侧栏独立持久化，首页图标列与宽度保持，重置立即恢复", async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem("kanban.project-navigation-panel-collapsed", "true");
		localStorage.setItem("kanban.project-navigation-panel-width", "380");
	});
	const { modifier } = await openSidebarHarness(page);
	await page.keyboard.press(`${modifier}+b`);
	await page.keyboard.press(`${modifier}+Alt+b`);
	await page.getByRole("button", { name: "切换首页与 Focus View", exact: true }).click();
	await expect(page.locator("aside")).toBeVisible();
	await page.keyboard.press(`${modifier}+b`);
	await expect(page.locator("aside")).toBeHidden();
	await page.reload();
	await expect(page.locator("[data-focus-view-task-list-sidebar]")).toBeHidden();
	await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeHidden();
	await page.getByRole("button", { name: "切换首页与 Focus View", exact: true }).click();
	await expect(page.locator("aside")).toBeHidden();
	await page.getByRole("button", { name: "显示项目栏", exact: true }).click();
	await expect(page.locator("aside")).toBeVisible();
	const beforeReset = await page.evaluate(() => ({
		collapsed: localStorage.getItem("kanban.project-navigation-panel-collapsed"),
		width: localStorage.getItem("kanban.project-navigation-panel-width"),
	}));
	expect(beforeReset).toEqual({ collapsed: "true", width: "380" });
	await page.getByRole("button", { name: "重置布局", exact: true }).click();
	await page.getByRole("button", { name: "切换首页与 Focus View", exact: true }).click();
	await expect(page.locator("[data-focus-view-task-list-sidebar]")).toBeVisible();
	await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeVisible();
});

test("隐藏工作台保留 iframe 节点与内容，新请求展开且重放不重复打开", async ({ page }) => {
	const evidence = await openSidebarHarness(page);
	await page.getByLabel("工作台格位 2", { exact: true }).selectOption("task_visualizations");
	const iframe = page.locator('iframe[title="侧栏连续性图"]');
	const counter = page.frameLocator('iframe[title="侧栏连续性图"]').locator("#counter");
	await expect(counter).toBeVisible();
	await counter.click();
	await counter.evaluate((element) => {
		element.blur();
		window.scrollTo(0, 300);
	});
	await page.evaluate(() => {
		const target = window as unknown as SidebarHarnessWindow;
		target.sidebarOriginalIframe = document.querySelector("iframe")!;
		target.sidebarOriginalContentWindow = target.sidebarOriginalIframe.contentWindow!;
	});
	await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
	await expect(iframe).toBeHidden();
	await page.setViewportSize({ width: 1080, height: 1920 });
	await page.getByRole("button", { name: "显示任务工作台", exact: true }).click();
	await expect(counter).toHaveText("1");
	await expect.poll(() => counter.evaluate(() => window.scrollY)).toBe(300);
	expect(
		await page.evaluate(() => {
			const target = window as unknown as SidebarHarnessWindow;
			return (
				target.sidebarOriginalIframe === document.querySelector("iframe") &&
				target.sidebarOriginalContentWindow === document.querySelector("iframe")?.contentWindow
			);
		}),
	).toBe(true);
	expect(evidence.contentLoads()).toBe(1);
	await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
	await page.evaluate(() => {
		const target = window as unknown as SidebarHarnessWindow;
		target.sidebarPreviewOffer = target.createSidebarPreviewOffer();
		target.deliverSidebarPreview(target.sidebarPreviewOffer);
		target.deliverSidebarPreview({ ...target.sidebarPreviewOffer, deliveryState: "accepted" });
	});
	await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as SidebarHarnessWindow)
					.readSidebarPreviewAcknowledgments()
					.some((message) => message.outcome === "displayed"),
			),
		)
		.toBe(true);
	await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
	await page.evaluate(() => {
		const target = window as unknown as SidebarHarnessWindow;
		target.deliverSidebarPreview({ ...target.sidebarPreviewOffer, deliveryState: "accepted" });
	});
	await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeHidden();
});

test("Diff 最大化时打开左栏或隐藏右栏都恢复 Agent 区域", async ({ page }) => {
	await openSidebarHarness(page);
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeHidden();
	await page.getByRole("button", { name: "显示任务列表", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeVisible();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeVisible();
	await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeHidden();
	await page.getByRole("button", { name: "显示任务工作台", exact: true }).click();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await page.getByRole("button", { name: "重置布局", exact: true }).click();
	await expect(page.locator("[data-focus-view-task-list-sidebar]")).toBeVisible();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeVisible();
});

test("Diff 最大化详情经跨项目在途外壳重新挂载后恢复 Agent 区域与标题栏入口", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openSidebarHarness(page);
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeHidden();
	await page.getByRole("button", { name: "切换跨项目在途外壳", exact: true }).click();
	await expect(page.getByTestId("focus-view-cross-project-task-open-in-transit-shell")).toBeVisible();
	await expect(page.getByRole("button", { name: "隐藏任务列表", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "隐藏任务列表", exact: true }).click();
	await expect(page.getByRole("button", { name: "显示任务列表", exact: true })).toBeFocused();
	await page.getByRole("button", { name: "显示任务列表", exact: true }).click();
	await expect(page.getByRole("button", { name: "隐藏任务列表", exact: true })).toBeFocused();
	await page.getByRole("button", { name: "切换跨项目在途外壳", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeVisible();
	await expect(page.getByRole("button", { name: "隐藏任务列表", exact: true })).toBeVisible();
	expect(pageErrors).toEqual([]);
});

test("Diff 最大化时新的有效自动预览保留工作台最大化", async ({ page }) => {
	await openSidebarHarness(page);
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeHidden();
	const maximizedWorkbenchBoundingBox = await page.locator("[data-focus-view-workbench-sidebar]").boundingBox();
	await page.evaluate(() => {
		const sidebarHarnessWindow = window as unknown as SidebarHarnessWindow;
		sidebarHarnessWindow.sidebarPreviewOffer = sidebarHarnessWindow.createSidebarPreviewOffer();
		sidebarHarnessWindow.deliverSidebarPreview(sidebarHarnessWindow.sidebarPreviewOffer);
		sidebarHarnessWindow.deliverSidebarPreview({
			...sidebarHarnessWindow.sidebarPreviewOffer,
			deliveryState: "accepted",
		});
	});
	await expect(page.frameLocator('iframe[title="侧栏连续性图"]').locator("#counter")).toBeVisible();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeHidden();
	await expect(page.getByRole("button", { name: "显示任务列表", exact: true })).toBeVisible();
	const previewWorkbenchBoundingBox = await page.locator("[data-focus-view-workbench-sidebar]").boundingBox();
	expect(previewWorkbenchBoundingBox!.width).toBeCloseTo(maximizedWorkbenchBoundingBox!.width);
	expect(previewWorkbenchBoundingBox!.height).toBeCloseTo(maximizedWorkbenchBoundingBox!.height);
});

test("手机忽略桌面隐藏偏好，继续使用页签和首页抽屉", async ({ page }) => {
	await page.addInitScript(() => {
		for (const name of ["home-project-sidebar", "focus-view-task-list-sidebar", "focus-view-workbench-sidebar"])
			localStorage.setItem(`kanban.${name}-hidden.v1`, "true");
	});
	await openSidebarHarness(page, 390, 812);
	await expect(page.getByRole("button", { name: "显示任务工作台", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).click();
	await page.getByRole("button", { name: "Sessions", exact: true }).click();
	await expect(page.getByRole("region", { name: "任务工作台", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "切换首页与 Focus View", exact: true }).click();
	await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
	await expect(page.locator("aside")).toBeVisible();
	expect((await page.locator("aside").boundingBox())!.width).toBe(390);
	expect(await page.evaluate(() => localStorage.getItem("kanban.home-project-sidebar-hidden.v1"))).toBe("true");
});

test("首页项目导航从标题行隐藏并从内容区恢复，展开宽度不变", async ({ page }) => {
	await openSidebarHarness(page);
	await page.getByRole("button", { name: "切换首页与 Focus View", exact: true }).click();
	const initialWidth = (await page.locator("aside").boundingBox())!.width;
	await page.getByRole("button", { name: "隐藏项目栏", exact: true }).click();
	await expect(page.locator("aside")).toBeHidden();
	await expect(page.getByRole("button", { name: "显示项目栏", exact: true })).toBeFocused();
	await page.getByRole("button", { name: "显示项目栏", exact: true }).click();
	await expect(page.getByRole("button", { name: "隐藏项目栏", exact: true })).toBeFocused();
	expect((await page.locator("aside").boundingBox())!.width).toBe(initialWidth);
});

test.describe("无 hover 设备", () => {
	test.use({ hasTouch: true });
	test("悬浮入口可直接触摸点击，不依赖悬停", async ({ page }) => {
		await openSidebarHarness(page, 1080, 1920);
		expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
		await page.getByRole("button", { name: "隐藏任务列表", exact: true }).tap();
		await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).tap();
		await page.getByRole("button", { name: "显示任务列表", exact: true }).tap();
		await expect(page.locator("[data-focus-view-task-list-sidebar]")).toBeVisible();
		await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeHidden();
		await page.getByRole("button", { name: "显示任务工作台", exact: true }).tap();
		await expect(page.locator("[data-focus-view-workbench-sidebar]")).toBeVisible();
	});
});

const workspaceId = "isolated-task-lookup-sidebar-project";
const task = {
	id: "look1",
	title: "查卡侧栏回归任务",
	prompt: "核验真实 App 的侧栏状态转换",
	baseRef: "main",
	createdAt: 123,
	updatedAt: 123,
};
const workspaceState = {
	repoPath: `/isolated/${workspaceId}`,
	statePath: `/isolated/${workspaceId}/state.json`,
	revision: 1,
	git: { currentBranch: "main", defaultBranch: "main", branches: [{ name: "main", isCurrent: true }] },
	sessions: {},
	board: {
		columns: ["backlog", "in_progress", "review", "validation", "trash"].map((id) => ({
			id,
			title: id,
			cards: id === "review" ? [task] : [],
		})),
	},
};
const runtimeConfig: RuntimeConfigResponse = {
	selectedAgentId: "codex",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	newTaskStartInPlanModeByDefault: false,
	ompAgentSessionTransportForNewTasks: "pty_terminal",
	effectiveCommand: "codex",
	globalConfigPath: "/isolated/config.json",
	projectConfigPath: `/isolated/${workspaceId}/config.json`,
	readyForReviewNotificationsEnabled: false,
	notificationSoundEnabled: false,
	autoContinueOnConnectionDropEnabled: false,
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: false,
	postDeployVerificationForceCompleteEnabled: false,
	detectedCommands: ["codex"],
	agents: [
		{
			id: "codex",
			label: "OpenAI Codex",
			binary: "codex",
			command: "codex",
			defaultArgs: [],
			installed: true,
			configured: true,
		},
	],
	shortcuts: [],
	commitPromptTemplate: "",
	openPrPromptTemplate: "",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	userInterfacePreferencesSharedAcrossBrowserOrigins:
		USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
	runtimeHostRemoteEditorAccessIdentity: {
		operatingSystemAccountUsername: "isolated-user",
		operatingSystemHostname: "isolated-host",
	},
};

async function openIsolatedRealApp(page: Page) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.addInitScript(() => {
		localStorage.setItem("kanban.onboarding.dialog.shown", "true");
		localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "single_project_scope");
	});
	// 真实 App 与组件照常加载；所有 API 和 WebSocket 均在浏览器内截获，禁止访问真实运行时。
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", (socket) => {
		if (new URL(socket.url()).pathname !== "/api/runtime/ws") return;
		socket.send(
			JSON.stringify({
				type: "snapshot",
				currentProjectId: workspaceId,
				projects: [
					{
						id: workspaceId,
						name: "隔离查卡项目",
						path: workspaceState.repoPath,
						availability: { status: "available" },
						taskCounts: { backlog: 0, in_progress: 0, review: 1, validation: 0, trash: 0 },
						inProgressTaskDetails: [],
						crossProjectTaskSwitcherEntries: [],
					},
				],
				workspaceState,
				workspaceMetadata: { homeGitSummary: null, homeGitStateVersion: 0, taskWorkspaces: [] },
				clineSessionContextVersion: 0,
				notificationLog: [],
			}),
		);
	});
	await page.route("**/api/passcode/status", (route) =>
		route.fulfill({ json: { enabled: false, authenticated: true } }),
	);
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = decodeURIComponent(url.pathname.split("/api/trpc/")[1] ?? "").split(",");
		const responses = procedures.map((procedure) => {
			let data: unknown;
			if (procedure === "runtime.getConfig" || procedure === "runtime.saveConfig") data = runtimeConfig;
			else if (procedure === "workspace.getState" || procedure === "workspace.saveState") data = workspaceState;
			else if (procedure === "support.listTaskLookupConversations") data = [];
			else if (procedure === "support.getTaskAssistanceModelProviderRoutingSettings")
				data = { preferredModelProviderId: "minimax", fallbackModelProviderId: "deepseek" };
			else if (procedure === "workspace.getChangesConditional")
				data = {
					status: "changed",
					contentVersion: "isolated-empty-changes",
					changes: { files: [], generatedAt: 1 },
				};
			else
				return {
					error: {
						message: `隔离测试不执行 ${procedure}`,
						code: -32004,
						data: { code: "NOT_FOUND", httpStatus: 404 },
					},
				};
			return { result: { data } };
		});
		await route.fulfill({ json: url.searchParams.get("batch") === "1" ? responses : responses[0] });
	});
	await page.goto(`/${workspaceId}?task=${task.id}`);
	await expect(page.getByRole("button", { name: "隐藏任务列表", exact: true })).toBeVisible();
	return pageErrors;
}

test("真实 App 在 Changes 最大化后打开查卡，首次隐藏任务列表即生效且可恢复", async ({ page }) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	const pageErrors = await openIsolatedRealApp(page);
	const taskList = page.locator("[data-focus-view-task-list-sidebar]");
	await page.getByRole("button", { name: "Show task changes", exact: true }).click();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await expect(taskList).toBeHidden();
	await page.getByRole("button", { name: "切换 AI 查卡工作台", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "查卡问题", exact: true })).toBeVisible();
	await expect(taskList).toBeVisible();
	await page.getByRole("button", { name: "隐藏任务列表", exact: true }).click();
	await expect(taskList).toBeHidden();
	await expect(page.getByRole("button", { name: "显示任务列表", exact: true })).toBeFocused();
	await page.getByRole("button", { name: "显示任务列表", exact: true }).click();
	await expect(taskList).toBeVisible();
	await expect(page.getByRole("button", { name: "隐藏任务列表", exact: true })).toBeFocused();
	await page.getByRole("button", { name: "切换 AI 查卡工作台", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeVisible();
	expect(pageErrors).toEqual([]);
});
