import { expect, type Page, test } from "@playwright/test";
import type { TaskVisualizationPreviewRequestedMessage } from "../src/runtime/types";

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
	test(`${width}×${height} 顶栏与热键一致，回收空间并保留尺寸、草稿和终端`, async ({ page }) => {
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
		await page.getByRole("button", { name: "关闭任务编辑器", exact: true }).click();
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
	await counter.evaluate(() => window.scrollTo(0, 300));
	await page.evaluate(() => {
		const target = window as unknown as SidebarHarnessWindow;
		target.sidebarOriginalIframe = document.querySelector("iframe")!;
		target.sidebarOriginalContentWindow = target.sidebarOriginalIframe.contentWindow!;
	});
	await page.getByRole("button", { name: "隐藏任务工作台", exact: true }).click();
	await expect(iframe).toBeHidden();
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

test("Diff 最大化详情经跨项目在途外壳重新挂载后恢复 Agent 区域与顶栏状态", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openSidebarHarness(page);
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByRole("button", { name: "Expand split diff view", exact: true }).click();
	await expect(page.locator("[data-focus-view-agent-panel]")).toBeHidden();
	await page.getByRole("button", { name: "切换跨项目在途外壳", exact: true }).click();
	await expect(page.getByTestId("focus-view-cross-project-task-open-in-transit-shell")).toBeVisible();
	await expect(page.getByRole("button", { name: "隐藏任务列表", exact: true })).toBeVisible();
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
