import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * 应用内通知点击「SW 中转跨 tab 聚焦」协议（public/sw.js 的 focus-workspace-tab-request
 * message handler）的真实浏览器验证：
 *  - 同一 browser context 的两个 page 共享同一 SW registration；
 *  - page.mouse.click 的受信 pointerdown 产生真实 transient activation（探针在
 *    window 级 pointerdown capture 上 arm，见下方 helper 注释）；
 *  - 断言锚定协议可观察结果（MessageChannel 回报的 outcome、目标页收到的
 *    focus-task-from-notification 消息、发起页 pathname 不变），不依赖 headless
 *    的窗口视觉聚焦语义。
 *
 * 探针结论（2026-07 实测，headed/headless 一致）：Chromium 只在 notificationclick 的
 * window-interaction token 下允许 `WindowClient.focus()`（w3c/ServiceWorker#602），页面
 * 点击发起的 message 上下文一律 InvalidAccessError——即使发起窗口正持有 transient
 * activation（MDN 的「origin 级 activation」描述与实现不符）。因此正向用例断言的是
 * 现实可达的 `task-selected-in-background-tab` outcome（选中消息已送达目标 tab、由页面
 * 侧 toast 引导手动切换）；`focused` outcome 留给未来 Chromium 放宽后自动升级。
 *
 * 刻意不断言「无手势直发 → 被拒」：Playwright 的 evaluate 以 userGesture 执行，
 * 无法在测试内构造真正的无激活上下文；该负向行为属浏览器门槛而非本仓代码。
 */

const PROJECT_A_WORKSPACE_ID = "pw-sw-cross-tab-focus-project-a";
const PROJECT_B_WORKSPACE_ID = "pw-sw-cross-tab-focus-project-b";

interface FocusWorkspaceTabProbeRequest {
	workspaceId: string;
	taskId: string | null;
	workspacePathname: string;
}

declare global {
	interface Window {
		__swFocusProbeResponse?: Promise<unknown>;
		__receivedFocusTaskMessages?: unknown[];
	}
}

function workspacePathnameOf(workspaceId: string): string {
	return `/${workspaceId}`;
}

// 打开一个「锁定在某项目 pathname」的页面并等 SW 接管（controller 就位）。
// /api 的 HTTP 请求一律 abort、WebSocket 一律 mock（page.route 拦不到 WS）：本 spec 只验证
// SW 协议，不触碰 dev proxy 背后可能存在的真实 runtime。WS 必须 mock 而非放行——真连 runtime
// 时未知 workspace 会被关连接进入重连循环，而 use-runtime-state-stream 在重连成功的 onopen
// 里会跑 reloadBrowserIfServedBuildAssetsChanged() → location.reload()，把已 arm 的探针
// 监听器整页刷掉（曾造成本 spec 依 3484 实例状态而定的 flake）。mock 的 WS 打开后永不
// 关闭 → 无重连 → 无 reload，测试确定性。
async function openProjectPageWithActiveServiceWorker(context: BrowserContext, workspaceId: string): Promise<Page> {
	const page = await context.newPage();
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.goto(workspacePathnameOf(workspaceId), { waitUntil: "load" });
	await page.waitForFunction(
		() => "serviceWorker" in navigator && navigator.serviceWorker.controller !== null,
		undefined,
		{ timeout: 15_000 },
	);
	return page;
}

// 在目标页装 navigator.serviceWorker message 收集器（镜像 use-notification-task-focus 的监听通道）。
async function installFocusTaskMessageCollector(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.__receivedFocusTaskMessages = [];
		navigator.serviceWorker.addEventListener("message", (event) => {
			window.__receivedFocusTaskMessages?.push((event as MessageEvent).data);
		});
	});
}

// 在发起页装「下一次真实按下即发起请求」的 window 级 pointerdown capture 监听：
// 应用自身可能弹出 modal（Radix 遮罩 + react-remove-scroll 的 pointer-events 操纵），
// 元素级按钮会被 Playwright 可点性检查拦下；而且遮罩的 pointerdown-dismiss 会在按下与
// 抬起之间改写 DOM，令 Chrome 因 target 消失而根本不合成 click 事件（实测 pointerdown/
// mouseup 均到达 window 而 click 从未出现）——所以监听必须落在 pointerdown（capture、
// window 层，早于一切遮罩处理）；page.mouse.click 的受信按下在 dispatch 前即已授予
// transient activation。handler 内同步 MessageChannel + controller.postMessage（复刻
// workspace-tab-focus-via-service-worker.ts 的发送纪律：手势内、postMessage 前零 await）。
async function armFocusRequestProbeOnNextRealPointerdown(
	page: Page,
	request: FocusWorkspaceTabProbeRequest,
): Promise<void> {
	await page.evaluate(
		({ probeRequest }) => {
			window.__swFocusProbeResponse = undefined;
			window.addEventListener(
				"pointerdown",
				() => {
					window.__swFocusProbeResponse = new Promise((resolve) => {
						const channel = new MessageChannel();
						const timeoutId = setTimeout(() => resolve({ outcome: "probe-timeout" }), 5_000);
						channel.port1.onmessage = (event) => {
							clearTimeout(timeoutId);
							resolve(event.data);
						};
						navigator.serviceWorker.controller?.postMessage(
							{
								source: "cline-kanban",
								type: "focus-workspace-tab-request",
								workspaceId: probeRequest.workspaceId,
								taskId: probeRequest.taskId,
								workspacePathname: probeRequest.workspacePathname,
							},
							[channel.port2],
						);
					});
				},
				{ capture: true, once: true },
			);
		},
		{ probeRequest: request },
	);
}

async function firePointerdownAndReadProbeResponse(page: Page): Promise<unknown> {
	await page.mouse.click(4, 4);
	await page.waitForFunction(() => window.__swFocusProbeResponse !== undefined);
	return page.evaluate(() => window.__swFocusProbeResponse);
}

test.describe("service worker cross-tab focus protocol (focus-workspace-tab-request)", () => {
	test("delivers the task-focus message to the existing target-project tab; sender tab stays put", async ({
		context,
	}, testInfo) => {
		const pageA = await openProjectPageWithActiveServiceWorker(context, PROJECT_A_WORKSPACE_ID);
		const pageB = await openProjectPageWithActiveServiceWorker(context, PROJECT_B_WORKSPACE_ID);
		await installFocusTaskMessageCollector(pageB);

		await armFocusRequestProbeOnNextRealPointerdown(pageA, {
			workspaceId: PROJECT_B_WORKSPACE_ID,
			taskId: "probe-task-1",
			workspacePathname: workspacePathnameOf(PROJECT_B_WORKSPACE_ID),
		});
		const response = await firePointerdownAndReadProbeResponse(pageA);

		// 见文件头注释：当前 Chromium 下 client.focus() 必被拒，可达 outcome 是
		// task-selected-in-background-tab；若未来某次 Playwright/Chromium 升级后此断言
		// 失败且实际收到 "focused"，说明平台已放宽——届时把断言升级为 "focused" 即可。
		expect(response).toEqual({
			source: "cline-kanban",
			type: "focus-workspace-tab-response",
			outcome: "task-selected-in-background-tab",
		});

		// 目标页经既有 focus-task-from-notification 通道收到选中指令。
		await pageB.waitForFunction(() =>
			(window.__receivedFocusTaskMessages ?? []).some(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					(message as { type?: unknown }).type === "focus-task-from-notification",
			),
		);
		const focusTaskMessages = await pageB.evaluate(() =>
			(window.__receivedFocusTaskMessages ?? []).filter(
				(message) => (message as { type?: unknown }).type === "focus-task-from-notification",
			),
		);
		expect(focusTaskMessages).toEqual([
			{
				source: "cline-kanban",
				type: "focus-task-from-notification",
				taskId: "probe-task-1",
				workspaceId: PROJECT_B_WORKSPACE_ID,
			},
		]);

		// 发起页原地不动（未被 in-tab 切项目）。
		expect(new URL(pageA.url()).pathname).toBe(workspacePathnameOf(PROJECT_A_WORKSPACE_ID));

		// headless 下窗口级焦点语义不稳定，仅记录供人工参考，不作断言。
		const targetPageHasFocus = await pageB.evaluate(() => document.hasFocus());
		testInfo.annotations.push({
			type: "target-page-document-hasFocus",
			description: String(targetPageHasFocus),
		});
	});

	test("responds no-tab-found when no other tab is on the target project pathname", async ({ context }) => {
		const pageA = await openProjectPageWithActiveServiceWorker(context, PROJECT_A_WORKSPACE_ID);

		await armFocusRequestProbeOnNextRealPointerdown(pageA, {
			workspaceId: PROJECT_B_WORKSPACE_ID,
			taskId: "probe-task-2",
			workspacePathname: workspacePathnameOf(PROJECT_B_WORKSPACE_ID),
		});
		const response = await firePointerdownAndReadProbeResponse(pageA);

		expect(response).toEqual({
			source: "cline-kanban",
			type: "focus-workspace-tab-response",
			outcome: "no-tab-found",
		});
	});

	test("excludes the sender tab from matching: requesting the sender's own pathname yields no-tab-found", async ({
		context,
	}) => {
		const pageA = await openProjectPageWithActiveServiceWorker(context, PROJECT_A_WORKSPACE_ID);

		await armFocusRequestProbeOnNextRealPointerdown(pageA, {
			workspaceId: PROJECT_A_WORKSPACE_ID,
			taskId: "probe-task-3",
			workspacePathname: workspacePathnameOf(PROJECT_A_WORKSPACE_ID),
		});
		const response = await firePointerdownAndReadProbeResponse(pageA);

		expect(response).toEqual({
			source: "cline-kanban",
			type: "focus-workspace-tab-response",
			outcome: "no-tab-found",
		});
	});

	test("responds focus-failed on a payload missing taskId (SW-side validation)", async ({ context }) => {
		const pageA = await openProjectPageWithActiveServiceWorker(context, PROJECT_A_WORKSPACE_ID);
		const pageB = await openProjectPageWithActiveServiceWorker(context, PROJECT_B_WORKSPACE_ID);
		await installFocusTaskMessageCollector(pageB);

		await armFocusRequestProbeOnNextRealPointerdown(pageA, {
			workspaceId: PROJECT_B_WORKSPACE_ID,
			taskId: null,
			workspacePathname: workspacePathnameOf(PROJECT_B_WORKSPACE_ID),
		});
		const response = await firePointerdownAndReadProbeResponse(pageA);

		expect(response).toEqual({
			source: "cline-kanban",
			type: "focus-workspace-tab-response",
			outcome: "focus-failed",
		});
		// 校验失败时不得向目标页转发选中消息。
		expect(
			await pageB.evaluate(() =>
				(window.__receivedFocusTaskMessages ?? []).filter(
					(message) => (message as { type?: unknown }).type === "focus-task-from-notification",
				),
			),
		).toEqual([]);
	});
});
