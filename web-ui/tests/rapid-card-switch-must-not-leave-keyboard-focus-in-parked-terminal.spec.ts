import { expect, type Page, test } from "@playwright/test";

/**
 * 「连按 alt+↑/↓ 快速翻卡时，键盘焦点不得滞留在已泊车（park）的旧 task 终端上」的真实浏览器验证。
 *
 * 被守住的塌方长这样：`PersistentTerminal.mount()` 把 autoFocus 排进 `requestAnimationFrame`；排下这一帧
 * 到回调执行之间，用户又按了一次 alt+↓，于是这个终端已经被 `unmount()` 搬进屏幕外的 parking root。回调
 * 照旧执行 `terminal.focus()`，焦点就落进了**旧 task** 的 helper textarea：用户看着新卡，击键与 Ctrl+S
 * 暂存却全打进旧 task 的 PTY。而且 `shouldHandOffKeyboardFocusToAgentEntryNow()` 会把这个泊车 textarea
 * 认成「用户正在编辑」，从此每一次焦点交接请求都被否决，焦点永久留在屏幕外。
 *
 * 为什么非得进真浏览器：这条链路的三个环节全在 jsdom 之外——`requestAnimationFrame` 的真实调度顺序、
 * 把持有焦点的 DOM 子树 `appendChild` 到别处时浏览器真正的失焦行为、以及 xterm 真实的 helper textarea。
 * jsdom 里这三样都是近似物，测不出「焦点最终归谁」。
 *
 * 不连接 runtime：合成页用 `page.route` 在 Vite dev server 的同源下伪造，模块本身是**生产模块**
 * （`/src/terminal/persistent-terminal-manager.ts` 与 `/src/utils/keyboard-focus-handoff-to-agent-entry.ts`），
 * 复刻的只有 React 切卡时的调用序列。`WebSocket` 在模块加载前被换成永不 open 的哑实现，绝不触碰任何
 * 真实 runtime。
 */

const PROBE_PAGE_URL = "http://127.0.0.1:4173/__rapid-card-switch-keyboard-focus-probe";

interface ActiveElementDescription {
	tagName: string | null;
	className: string;
	isBody: boolean;
	insideParkedTerminalParkingRoot: boolean;
	insideVisibleDetailTerminalContainer: boolean;
}

interface RapidCardSwitchKeyboardFocusProbe {
	/** 切到另一张**同样跑 PTY 终端**的卡：旧终端 effect cleanup（park）+ 新终端 mount(autoFocus)。 */
	switchToAdjacentTaskCardWithTerminal(previousTaskId: string | null, nextTaskId: string): void;
	/** 切到一张**不跑 PTY 终端**的卡（会话面板卡）：只有旧终端被 park，没有新终端接手焦点。 */
	switchToAdjacentTaskCardWithoutTerminal(previousTaskId: string): void;
	/** 把已排队的 rAF 全部放掉，再读焦点归属。 */
	settleAnimationFramesThenDescribeActiveElement(): Promise<ActiveElementDescription>;
	readWhetherFocusHandoffGuardAllowsHandoffNow(): boolean;
}

declare global {
	interface Window {
		rapidCardSwitchKeyboardFocusProbe: RapidCardSwitchKeyboardFocusProbe;
		rapidCardSwitchKeyboardFocusProbeReady?: boolean;
	}
}

const PROBE_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>rapid card switch keyboard focus probe</title></head>
<body>
<div id="visible-detail-terminal-container" style="width:640px;height:320px"></div>
<script>
	// 在生产模块加载之前换掉 WebSocket：合成页绝不能连上任何真实 runtime。
	window.WebSocket = class NeverConnectingStubWebSocket {
		static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
		constructor() { this.readyState = 0; }
		send() {}
		close() { this.readyState = 3; }
		addEventListener() {}
		removeEventListener() {}
	};
</script>
<script type="module">
	import { ensurePersistentTerminal } from "/src/terminal/persistent-terminal-manager.ts";
	import { shouldHandOffKeyboardFocusToAgentEntryNow } from "/src/utils/keyboard-focus-handoff-to-agent-entry.ts";

	const appearance = {
		cursorColor: "#E6EDF3",
		terminalBackgroundColor: "#1F2428",
		themeColors: {
			textPrimary: "#E6EDF3",
			surfacePrimary: "#1F2428",
			surfaceRaised: "#24292E",
			selectionBackground: "#0084FF4D",
			selectionForeground: "#ffffff",
			selectionInactiveBackground: "#2D333966",
			isLightBackground: false,
		},
	};
	const workspaceId = "rapid-card-switch-probe-workspace";
	const visibleDetailTerminalContainer = document.getElementById("visible-detail-terminal-container");

	function terminalForTaskCard(taskId) {
		return ensurePersistentTerminal({ taskId, workspaceId, ...appearance });
	}

	function describeActiveElement() {
		const activeElement = document.activeElement;
		// id 与生产的 PARKING_ROOT_ID 一致；泊车根是 persistent-terminal-manager 自己建进 body 的。
		const parkingRoot = document.getElementById("kb-persistent-terminal-parking-root");
		return {
			tagName: activeElement ? activeElement.tagName : null,
			className: activeElement && typeof activeElement.className === "string" ? activeElement.className : "",
			isBody: activeElement === document.body,
			insideParkedTerminalParkingRoot: Boolean(parkingRoot && activeElement && parkingRoot.contains(activeElement)),
			insideVisibleDetailTerminalContainer: Boolean(
				activeElement && visibleDetailTerminalContainer.contains(activeElement),
			),
		};
	}

	const nextAnimationFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

	window.rapidCardSwitchKeyboardFocusProbe = {
		switchToAdjacentTaskCardWithTerminal(previousTaskId, nextTaskId) {
			if (previousTaskId !== null) {
				terminalForTaskCard(previousTaskId).unmount(visibleDetailTerminalContainer);
			}
			terminalForTaskCard(nextTaskId).mount(visibleDetailTerminalContainer, appearance, {
				autoFocus: true,
				isVisible: true,
			});
		},
		switchToAdjacentTaskCardWithoutTerminal(previousTaskId) {
			terminalForTaskCard(previousTaskId).unmount(visibleDetailTerminalContainer);
		},
		async settleAnimationFramesThenDescribeActiveElement() {
			await nextAnimationFrame();
			await nextAnimationFrame();
			await nextAnimationFrame();
			return describeActiveElement();
		},
		readWhetherFocusHandoffGuardAllowsHandoffNow() {
			return shouldHandOffKeyboardFocusToAgentEntryNow();
		},
	};
	window.rapidCardSwitchKeyboardFocusProbeReady = true;
</script>
</body></html>`;

async function openProbePage(page: Page): Promise<void> {
	await page.route(PROBE_PAGE_URL, async (route) => {
		await route.fulfill({ body: PROBE_PAGE_HTML, contentType: "text/html; charset=utf-8" });
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(PROBE_PAGE_URL);
	await page.waitForFunction(() => window.rapidCardSwitchKeyboardFocusProbeReady === true, { timeout: 20_000 });
	// 先稳稳停在第一张卡上，让它的 autoFocus 正常兑现——后面每条用例都从「焦点在可见终端里」出发。
	await page.evaluate(() => {
		window.rapidCardSwitchKeyboardFocusProbe.switchToAdjacentTaskCardWithTerminal(null, "task-first");
	});
	const settled = await settleThenDescribeActiveElement(page);
	expect(settled.insideVisibleDetailTerminalContainer).toBe(true);
}

async function settleThenDescribeActiveElement(page: Page): Promise<ActiveElementDescription> {
	return await page.evaluate(
		async () => await window.rapidCardSwitchKeyboardFocusProbe.settleAnimationFramesThenDescribeActiveElement(),
	);
}

test("同一帧内连按两次切卡：焦点落在当前可见终端，不滞留在泊车的旧 task 终端", async ({ page }) => {
	await openProbePage(page);

	// 两次 React commit 落在同一帧里——第一次切卡排下的 autoFocus rAF 还没跑，用户已经切走了。
	await page.evaluate(() => {
		window.rapidCardSwitchKeyboardFocusProbe.switchToAdjacentTaskCardWithTerminal("task-first", "task-second");
		window.rapidCardSwitchKeyboardFocusProbe.switchToAdjacentTaskCardWithTerminal("task-second", "task-third");
	});

	const settled = await settleThenDescribeActiveElement(page);

	expect(settled.insideParkedTerminalParkingRoot).toBe(false);
	expect(settled.insideVisibleDetailTerminalContainer).toBe(true);
});

test("切到不跑终端的卡时，被泊车的旧终端不得夺走焦点、把后续焦点交接全部否决", async ({ page }) => {
	await openProbePage(page);

	// 打开一张 PTY 卡（autoFocus 排进 rAF），同一帧内立刻切到一张会话面板卡：旧终端只剩泊车一条路，
	// 没有新终端接手焦点，会话侧的输入框只能靠 agentEntryKeyboardFocusRequestKey 那条请求拿到焦点。
	await page.evaluate(() => {
		window.rapidCardSwitchKeyboardFocusProbe.switchToAdjacentTaskCardWithTerminal("task-first", "task-second");
		window.rapidCardSwitchKeyboardFocusProbe.switchToAdjacentTaskCardWithoutTerminal("task-second");
	});

	const settled = await settleThenDescribeActiveElement(page);

	expect(settled.insideParkedTerminalParkingRoot).toBe(false);
	expect(settled.isBody).toBe(true);
	// 焦点一旦落进泊车终端的 helper textarea，守卫就会把它当成「用户正在编辑」而否决交接，
	// 会话输入框再也拿不到焦点。这条断言就是那条否决路径的直接信号。
	const guardAllowsHandoff = await page.evaluate(() =>
		window.rapidCardSwitchKeyboardFocusProbe.readWhetherFocusHandoffGuardAllowsHandoffNow(),
	);
	expect(guardAllowsHandoff).toBe(true);
});
