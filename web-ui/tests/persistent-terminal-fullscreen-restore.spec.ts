import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import type {} from "./persistent-terminal-restore-browser-harness";

const HARNESS_PAGE_URL = "/__persistent-terminal-fullscreen-restore";
const HARNESS_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>全屏终端恢复回归</title>
<link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css">
<style>html,body { margin: 0; width: 100%; height: 100%; background: black; }</style>
</head><body><script type="module" src="/tests/persistent-terminal-restore-browser-harness.ts"></script></body></html>`;

interface TerminalSocketPeer {
	role: string;
	clientId: string | null;
	socket: WebSocketRoute;
	closed: boolean;
	clientMessages: string[];
}

async function openTerminalViewer(page: Page, width = 1_100, height = 660) {
	const sockets: TerminalSocketPeer[] = [];
	const apiRequests: string[] = [];
	await page.setViewportSize({ width, height });
	await page.route(HARNESS_PAGE_URL, (route) => route.fulfill({ body: HARNESS_PAGE_HTML, contentType: "text/html" }));
	await page.route("**/api/**", (route) => {
		apiRequests.push(route.request().url());
		return route.abort();
	});
	await page.routeWebSocket(/\/api\/terminal\/(io|control)/, (socket) => {
		const url = new URL(socket.url());
		const peer: TerminalSocketPeer = {
			role: url.pathname.endsWith("/io") ? "io" : "control",
			clientId: url.searchParams.get("clientId"),
			socket,
			closed: false,
			clientMessages: [],
		};
		socket.onMessage((message) => {
			if (typeof message === "string") peer.clientMessages.push(message);
		});
		socket.onClose(() => {
			peer.closed = true;
		});
		sockets.push(peer);
	});
	await page.goto(HARNESS_PAGE_URL);
	await page.waitForFunction(() => Boolean(window.persistentTerminalRestoreHarness));
	await expect.poll(() => sockets.length).toBe(2);
	const newestSocket = (role: "io" | "control") => {
		const peer = sockets.filter((candidate) => candidate.role === role).at(-1);
		if (!peer) throw new Error(`未找到 ${role} 模拟通道`);
		return peer;
	};
	const sendRestore = async (snapshot: string) => {
		const { cols, rows } = await readTerminalState(page);
		newestSocket("control").socket.send(JSON.stringify({ type: "restore", cols, rows, snapshot }));
	};
	return { sockets, apiRequests, newestSocket, sendRestore };
}

function readTerminalState(page: Page) {
	return page.evaluate(() => window.persistentTerminalRestoreHarness.readTerminalState());
}

function countClientMessages(peer: TerminalSocketPeer, type: string): number {
	return peer.clientMessages.filter((message) => JSON.parse(message).type === type).length;
}

function fullscreenSnapshot(rows: number, label: string): string {
	return (
		`${normalBufferHistory()}\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H${label}` +
		`\x1b[${rows - 1};1H› 固定输入区\x1b[${rows};1H固定页脚`
	);
}

function normalBufferHistory(): string {
	return `${Array.from({ length: 120 }, (_, index) => `旧屏幕片段 ${index}\r\n`).join("")}普通输入区> `;
}

async function restoreFullscreen(page: Page, viewer: Awaited<ReturnType<typeof openTerminalViewer>>, label: string) {
	const { rows, connectionReadyCount } = await readTerminalState(page);
	await viewer.sendRestore(fullscreenSnapshot(rows, label));
	await expect.poll(async () => (await readTerminalState(page)).connectionReadyCount).toBe(connectionReadyCount + 1);
}

async function expectFullscreenAndNativeWheel(page: Page) {
	const before = await readTerminalState(page);
	expect(before).toMatchObject({
		bufferType: "alternate",
		mouseTrackingMode: "vt200",
		baseY: 0,
		viewportY: 0,
		hasHorizontalOverflow: false,
		refreshAttemptCount: 0,
	});
	expect(before.screenLines.at(-2)).toBe("› 固定输入区");
	expect(before.screenLines.at(-1)).toBe("固定页脚");
	await page.mouse.move(100, 100);
	await page.mouse.wheel(0, -120);
	await page.mouse.wheel(0, 120);
	const after = await readTerminalState(page);
	expect(after.screenLines).toEqual(before.screenLines);
	expect(after.viewportY).toBe(0);
}

for (const role of ["io", "control"] as const) {
	test(`仅 ${role} 通道断线后成对重连，全屏模式和原生鼠标滚动恢复`, async ({ page }) => {
		const viewer = await openTerminalViewer(page);
		await viewer.sendRestore(normalBufferHistory());
		await expect.poll(async () => (await readTerminalState(page)).connectionReadyCount).toBe(1);
		const oldIo = viewer.newestSocket("io");
		const oldControl = viewer.newestSocket("control");
		viewer.newestSocket(role).socket.close({ code: 1000, reason: "模拟单通道断线" });
		await expect.poll(() => viewer.sockets.length).toBe(4);
		expect(viewer.newestSocket("io").clientId).not.toBe(oldIo.clientId);
		expect(viewer.newestSocket("io").clientId).toBe(viewer.newestSocket("control").clientId);
		await expect.poll(() => oldIo.closed && oldControl.closed).toBe(true);
		expect((await readTerminalState(page)).connectionReadyCount).toBe(1);
		await restoreFullscreen(page, viewer, "单通道恢复后的 Codex 全屏");
		await expectFullscreenAndNativeWheel(page);
		const ioMessages = viewer.newestSocket("io").clientMessages.join("");
		expect(ioMessages).toContain("\x1b[<64;");
		expect(ioMessages).toContain("\x1b[<65;");
		expect(viewer.apiRequests).toEqual([]);
	});
}

for (const reconnect of [false, true]) {
	test(`旧快照等待回调后迟到，不能覆盖新全屏或重复完成恢复（重连=${reconnect}）`, async ({ page }) => {
		const viewer = await openTerminalViewer(page, 900, 540);
		await restoreFullscreen(page, viewer, "初始全屏");
		await page.evaluate(() => window.persistentTerminalRestoreHarness.holdNextWriteCompletion());
		viewer.newestSocket("io").socket.send("\x1b[H等待回调的输出");
		await expect.poll(async () => (await readTerminalState(page)).heldWriteCompletionCount).toBe(1);
		const previousArrivalSequence = (await readTerminalState(page)).restoreSnapshotArrivalSequence;
		await viewer.sendRestore(normalBufferHistory());
		await expect
			.poll(async () => (await readTerminalState(page)).restoreSnapshotArrivalSequence)
			.toBe(previousArrivalSequence + 1);
		await page.evaluate(() => {
			void window.persistentTerminalRestoreHarness.resync();
		});
		await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "request_restore")).toBe(1);
		if (reconnect) await expect.poll(() => viewer.sockets.filter((peer) => peer.role === "control").length).toBe(2);
		await restoreFullscreen(page, viewer, "新全屏");
		const currentControl = viewer.newestSocket("control");
		const completionsBeforeRelease = countClientMessages(currentControl, "restore_complete");
		const screenBeforeRelease = await readTerminalState(page);
		await page.evaluate(() => window.persistentTerminalRestoreHarness.releaseHeldWriteCompletions());
		const screenAfterRelease = await readTerminalState(page);
		expect(screenAfterRelease).toMatchObject({ ...screenBeforeRelease, heldWriteCompletionCount: 0 });
		expect(countClientMessages(currentControl, "restore_complete")).toBe(completionsBeforeRelease);
		await expectFullscreenAndNativeWheel(page);
		expect(viewer.apiRequests).toEqual([]);
	});
}

test("标签页恢复期间丢弃在途输出，连续恢复后仍由全屏鼠标协议处理滚轮", async ({ page }) => {
	const viewer = await openTerminalViewer(page, 375, 620);
	await restoreFullscreen(page, viewer, "手机全屏");
	for (let cycle = 0; cycle < 3; cycle += 1) {
		await page.evaluate(() => window.persistentTerminalRestoreHarness.setDocumentVisible(false));
		viewer.newestSocket("io").socket.send("\x1b[?1049l后台旧画面\r\n");
		await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "output_ack")).toBe(cycle * 2 + 1);
		await page.evaluate(() => window.persistentTerminalRestoreHarness.setDocumentVisible(true));
		await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "request_restore")).toBe(cycle + 1);
		viewer.newestSocket("io").socket.send("\x1b[?1049l返回途中的旧画面\r\n");
		await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "output_ack")).toBe(cycle * 2 + 2);
		expect((await readTerminalState(page)).bufferType).toBe("alternate");
		await restoreFullscreen(page, viewer, `手机恢复 ${cycle}`);
		await expectFullscreenAndNativeWheel(page);
	}
	expect(viewer.sockets.filter((peer) => peer.role === "control")).toHaveLength(1);
	expect(viewer.sockets.filter((peer) => peer.role === "io")).toHaveLength(4);
	expect(viewer.apiRequests).toEqual([]);
});

test("原生解析队列暂停时的旧全屏输入必须排在 shell 快照重置之前", async ({ page }) => {
	const viewer = await openTerminalViewer(page);
	await viewer.sendRestore("初始 shell> ");
	await expect.poll(async () => (await readTerminalState(page)).connectionReadyCount).toBe(1);
	await page.evaluate(() => window.persistentTerminalRestoreHarness.holdNextNativeInputParsing());
	viewer.newestSocket("io").socket.send("\x1b[9999m\x1b[?1049h\x1b[?1000h过期全屏");
	await expect.poll(async () => (await readTerminalState(page)).heldNativeInputParsingCount).toBe(1);
	await page.evaluate(() => window.persistentTerminalRestoreHarness.setDocumentVisible(false));
	viewer.newestSocket("io").socket.send("隐藏期间丢弃的输出");
	await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "output_ack")).toBe(1);
	await page.evaluate(() => window.persistentTerminalRestoreHarness.setDocumentVisible(true));
	await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "request_restore")).toBe(1);
	await viewer.sendRestore("当前 shell> ");
	await expect.poll(async () => (await readTerminalState(page)).restoreSnapshotArrivalSequence).toBe(2);
	expect(countClientMessages(viewer.newestSocket("control"), "restore_complete")).toBe(1);
	await page.evaluate(() => window.persistentTerminalRestoreHarness.releaseHeldNativeInputParsing());
	await expect.poll(() => countClientMessages(viewer.newestSocket("control"), "restore_complete")).toBe(2);
	const state = await readTerminalState(page);
	expect(state).toMatchObject({
		bufferType: "normal",
		mouseTrackingMode: "none",
		connectionReadyCount: 2,
		refreshAttemptCount: 0,
		hasHorizontalOverflow: false,
	});
	expect(state.screenLines[0]).toBe("当前 shell> ");
	expect(viewer.apiRequests).toEqual([]);
});

test("control 快照之后到达的旧 IO 被连接边界隔离，新 IO 继续输出", async ({ page }) => {
	const viewer = await openTerminalViewer(page);
	await restoreFullscreen(page, viewer, "初始全屏");
	const oldIo = viewer.newestSocket("io");
	const control = viewer.newestSocket("control");
	await page.evaluate(() => {
		window.persistentTerminalRestoreHarness.holdNextWriteCompletion();
		void window.persistentTerminalRestoreHarness.resync();
	});
	await expect.poll(() => countClientMessages(control, "request_restore")).toBe(1);
	const { rows } = await readTerminalState(page);
	await viewer.sendRestore(fullscreenSnapshot(rows, "当前全屏"));
	oldIo.socket.send("\x1b[?1049l\x1b[?1000l迟到旧 normal 输出");
	await expect.poll(async () => (await readTerminalState(page)).heldWriteCompletionCount).toBe(1);
	await expect.poll(() => oldIo.closed).toBe(true);
	expect(viewer.newestSocket("io").clientId).toBe(control.clientId);
	await page.evaluate(() => window.persistentTerminalRestoreHarness.releaseHeldWriteCompletions());
	await expect.poll(() => countClientMessages(control, "restore_complete")).toBe(2);
	viewer.newestSocket("io").socket.send("\x1b[H新 IO 输出");
	await expect.poll(async () => (await readTerminalState(page)).screenLines[0]).toBe("新 IO 输出");
	await expectFullscreenAndNativeWheel(page);
	expect(viewer.apiRequests).toEqual([]);
});

test("两个不同尺寸的 viewer 独立恢复，shell 与 --no-alt-screen 保留普通历史滚动", async ({ page, context }) => {
	const firstViewer = await openTerminalViewer(page, 1_100, 660);
	const secondPage = await context.newPage();
	const secondViewer = await openTerminalViewer(secondPage, 390, 580);
	await restoreFullscreen(page, firstViewer, "桌面全屏");
	await restoreFullscreen(secondPage, secondViewer, "手机全屏");
	const secondViewerBefore = await readTerminalState(secondPage);
	expect((await readTerminalState(page)).cols).toBeGreaterThan(secondViewerBefore.cols);
	firstViewer.newestSocket("io").socket.close({ code: 1000 });
	await expect.poll(() => firstViewer.sockets.length).toBe(4);
	await restoreFullscreen(page, firstViewer, "桌面独立恢复");
	expect(await readTerminalState(secondPage)).toEqual(secondViewerBefore);
	expect(secondViewer.sockets).toHaveLength(2);
	await expectFullscreenAndNativeWheel(secondPage);
	for (const mode of ["shell", "--no-alt-screen"]) {
		const beforeReady = (await readTerminalState(page)).connectionReadyCount;
		await page.evaluate(() => {
			void window.persistentTerminalRestoreHarness.resync();
		});
		await firstViewer.sendRestore(`${normalBufferHistory()}${mode}`);
		await expect.poll(async () => (await readTerminalState(page)).connectionReadyCount).toBe(beforeReady + 1);
		const state = await readTerminalState(page);
		expect(state).toMatchObject({ bufferType: "normal", mouseTrackingMode: "none", hasHorizontalOverflow: false });
		expect(state.baseY).toBeGreaterThan(0);
		await page.mouse.move(100, 100);
		await page.mouse.wheel(0, -300);
		await expect.poll(async () => (await readTerminalState(page)).viewportY).toBeLessThan(state.baseY);
	}
	expect(firstViewer.apiRequests).toEqual([]);
	expect(secondViewer.apiRequests).toEqual([]);
	await secondPage.close();
});
