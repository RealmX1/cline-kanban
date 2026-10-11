import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_SESSION_TERMINAL_COLS, TASK_SESSION_TERMINAL_COLS } from "@/runtime/task-session-geometry";
import type { RuntimeTerminalWsResizeMessage } from "@/runtime/types";
import {
	disposeAllPersistentTerminalsForWorkspace,
	disposePersistentTerminal,
	ensurePersistentTerminal,
} from "@/terminal/persistent-terminal-manager";
import type * as PlatformModule from "@/utils/platform";

const fitAddonProposeDimensionsMock = vi.hoisted(() => vi.fn<() => { cols: number; rows: number } | undefined>());
const screenPixelSize = vi.hoisted(() => ({ width: 480, height: 320 }));
const createdTerminalOptions = vi.hoisted(() => [] as Array<{ cols?: number; rows?: number }>);
const terminalBuffer = vi.hoisted(() => ({ baseY: 0, viewportY: 0 }));
// transcript 提取读的是 normal buffer（见 terminal-scrollback-transcript-extraction.ts）。
const terminalNormalBuffer = vi.hoisted(() => ({
	length: 0,
	getLine: (_lineIndex: number) => undefined,
}));
const terminalScrollToBottomMock = vi.hoisted(() => vi.fn());
const terminalWriteSideEffect = vi.hoisted(() => ({ current: null as null | ((data: string | Uint8Array) => void) }));
// 用来复现「xterm 的 write 回调再也不触发」这一真实卡死形态：写队列是一条串行 promise 链，
// 链上任何一次回调没来就永久悬停，applyRestore 第一句正是 await 这条链。
const terminalWriteCallbackControl = vi.hoisted(() => ({
	suspended: false,
	// 被吞掉的写回调原样留档，供「渲染只是慢、后来还是回来了」这类迟到落屏场景显式放行。
	swallowedWriteCompletionCallbacks: [] as Array<() => void>,
}));
const webglAddonConstructions = vi.hoisted(() => ({ count: 0 }));
const platformOverrides = vi.hoisted(() => ({ isSafari: false }));
const webSocketInstances = vi.hoisted(
	() =>
		[] as Array<{
			addEventListener: (type: string, handler: (event: MessageEvent) => void) => void;
			close: () => void;
			messageListeners: Array<(event: MessageEvent) => void>;
			onmessage: ((event: MessageEvent) => void) | null;
			readyState: number;
			sentMessages: string[];
			url: string;
		}>,
);

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		proposeDimensions(): { cols: number; rows: number } | undefined {
			return fitAddonProposeDimensionsMock();
		}
	},
}));

vi.mock("@xterm/addon-clipboard", () => ({
	ClipboardAddon: class {},
}));

vi.mock("@xterm/addon-search", () => ({
	SearchAddon: class {
		clearDecorations(): void {}

		findNext(): boolean {
			return true;
		}

		findPrevious(): boolean {
			return true;
		}

		onDidChangeResults(_handler: (results: unknown) => void): void {}
	},
}));

vi.mock("@xterm/addon-unicode11", () => ({
	Unicode11Addon: class {},
}));

vi.mock("@xterm/addon-web-links", () => ({
	WebLinksAddon: class {},
}));

vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		constructor() {
			webglAddonConstructions.count += 1;
		}

		dispose(): void {}

		onContextLoss(_handler: () => void): void {}
	},
}));

vi.mock("@/utils/platform", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof PlatformModule;
	return {
		...actual,
		get isSafari() {
			return platformOverrides.isSafari;
		},
	};
});

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols: number;
		element: HTMLElement | undefined;
		options: { theme?: unknown };
		rows: number;
		unicode = { activeVersion: "" };
		buffer = { active: terminalBuffer, normal: terminalNormalBuffer };

		constructor(options: { cols?: number; rows?: number; theme?: unknown }) {
			this.cols = options.cols ?? 80;
			this.rows = options.rows ?? 24;
			this.options = { theme: options.theme };
			createdTerminalOptions.push({
				cols: options.cols,
				rows: options.rows,
			});
		}

		attachCustomKeyEventHandler(_handler: (event: KeyboardEvent) => boolean): void {}

		clear(): void {}

		clearSelection(): void {}

		dispose(): void {}

		focus(): void {}

		getSelection(): string {
			return "";
		}

		hasSelection(): boolean {
			return false;
		}

		input(_text: string): void {}

		loadAddon(_addon: unknown): void {}

		onBinary(_handler: (data: string) => void): void {}

		onData(_handler: (data: string) => void): void {}

		onScroll(_handler: (viewportY: number) => void): void {}

		open(hostElement: HTMLElement): void {
			this.element = hostElement;
			const screenElement = document.createElement("div");
			screenElement.className = "xterm-screen";
			screenElement.getBoundingClientRect = () =>
				({
					bottom: screenPixelSize.height,
					height: screenPixelSize.height,
					left: 0,
					right: screenPixelSize.width,
					toJSON: () => ({}),
					top: 0,
					width: screenPixelSize.width,
					x: 0,
					y: 0,
				}) as DOMRect;
			hostElement.appendChild(screenElement);
		}

		paste(_text: string): void {}

		reset(): void {}

		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
		}

		scrollToBottom(): void {
			terminalScrollToBottomMock();
		}

		write(data: string | Uint8Array, callback?: () => void): void {
			terminalWriteSideEffect.current?.(data);
			if (terminalWriteCallbackControl.suspended) {
				// 回调故意吞掉：这一次写永远不会「完成」，写队列自此卡死。
				if (callback) {
					terminalWriteCallbackControl.swallowedWriteCompletionCallbacks.push(callback);
				}
				return;
			}
			callback?.();
		}
	},
}));

class MockResizeObserver implements ResizeObserver {
	static readonly instances: MockResizeObserver[] = [];

	constructor(readonly callback: ResizeObserverCallback) {
		MockResizeObserver.instances.push(this);
	}

	readonly root: Element | Document | null = null;
	readonly rootMargin = "";
	readonly thresholds = [0];

	disconnect(): void {}

	observe(_target: Element): void {}

	takeRecords(): ResizeObserverEntry[] {
		return [];
	}

	unobserve(_target: Element): void {}
}

class MockWebSocket {
	static readonly CLOSED = 3;
	static readonly OPEN = 1;

	binaryType: BinaryType = "blob";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = MockWebSocket.OPEN;
	readonly messageListeners: Array<(event: MessageEvent) => void> = [];
	readonly sentMessages: string[] = [];
	readonly url: string;

	constructor(url: string | URL) {
		this.url = String(url);
		webSocketInstances.push(this);
	}

	addEventListener(type: string, handler: (event: MessageEvent) => void): void {
		if (type === "message") {
			this.messageListeners.push(handler);
		}
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close"));
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (typeof data === "string") {
			this.sentMessages.push(data);
		}
	}
}

const appearance = {
	cursorColor: "#fff",
	terminalBackgroundColor: "#000",
};

function createContainer(): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	return container;
}

function getResizeMessages(): RuntimeTerminalWsResizeMessage[] {
	return webSocketInstances
		.filter((socket) => socket.url.includes("/api/terminal/control"))
		.flatMap((socket) => socket.sentMessages)
		.map((message) => JSON.parse(message) as RuntimeTerminalWsResizeMessage)
		.filter((message) => message.type === "resize");
}

function dispatchSocketMessage(
	socket: {
		messageListeners: Array<(event: MessageEvent) => void>;
		onmessage: ((event: MessageEvent) => void) | null;
	},
	data: string | ArrayBuffer,
): void {
	const event = new MessageEvent("message", { data });
	for (const listener of socket.messageListeners) {
		listener(event);
	}
	socket.onmessage?.(event);
}

function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: hidden ? "hidden" : "visible",
		writable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

function parseControlMessages(socket: { sentMessages: string[] }): Array<{ type: string; bytes?: number }> {
	return socket.sentMessages.map((message) => JSON.parse(message) as { type: string; bytes?: number });
}

describe("persistent-terminal-manager", () => {
	beforeEach(() => {
		fitAddonProposeDimensionsMock.mockReset();
		fitAddonProposeDimensionsMock.mockReturnValue({ cols: 80, rows: 30 });
		terminalBuffer.baseY = 0;
		terminalBuffer.viewportY = 0;
		terminalScrollToBottomMock.mockReset();
		terminalWriteSideEffect.current = null;
		terminalWriteCallbackControl.suspended = false;
		terminalWriteCallbackControl.swallowedWriteCompletionCallbacks.length = 0;
		webglAddonConstructions.count = 0;
		platformOverrides.isSafari = false;
		createdTerminalOptions.length = 0;
		webSocketInstances.length = 0;
		MockResizeObserver.instances.length = 0;
		screenPixelSize.width = 480;
		screenPixelSize.height = 320;
		Object.defineProperty(globalThis, "ResizeObserver", {
			configurable: true,
			value: MockResizeObserver,
			writable: true,
		});
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			value: MockWebSocket,
			writable: true,
		});
		Object.defineProperty(window, "requestAnimationFrame", {
			configurable: true,
			value: (callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			},
			writable: true,
		});
		setDocumentHidden(false);
	});

	afterEach(() => {
		disposeAllPersistentTerminalsForWorkspace("workspace-1");
		vi.useRealTimers();
		document.body.replaceChildren();
	});

	it("reclaims the oldest parked terminal beyond the cap, keeping mounted and newer parked ones", () => {
		// mounted 终端（mount 后 visibleContainer 非 null → 非 parked）：永不参与 LRU 回收。
		const mounted = ensurePersistentTerminal({ ...appearance, taskId: "task-keep", workspaceId: "workspace-1" });
		mounted.mount(createContainer(), appearance, { isVisible: true });
		const mountedDisposeSpy = vi.spyOn(mounted, "dispose");

		// 三个 parked 终端（创建后不 mount → isParked()===true）；上限 MAX_PARKED_TERMINALS=2。
		const oldestParked = ensurePersistentTerminal({ ...appearance, taskId: "task-a", workspaceId: "workspace-1" });
		const oldestDisposeSpy = vi.spyOn(oldestParked, "dispose");
		const newerParked = ensurePersistentTerminal({ ...appearance, taskId: "task-b", workspaceId: "workspace-1" });
		const newerDisposeSpy = vi.spyOn(newerParked, "dispose");
		// 创建第 3 个 parked 触发 sweep：parked=[task-a, task-b, task-c]，只回收最旧的 task-a。
		ensurePersistentTerminal({ ...appearance, taskId: "task-c", workspaceId: "workspace-1" });

		expect(oldestDisposeSpy).toHaveBeenCalledTimes(1); // 最旧 parked 被回收
		expect(newerDisposeSpy).not.toHaveBeenCalled(); // 较新 parked 在最近 2 个内，保留
		expect(mountedDisposeSpy).not.toHaveBeenCalled(); // mounted 永不被回收
	});

	it("does not resend unchanged resize control frames", () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();

		terminal.mount(container, appearance, { isVisible: true });
		terminal.mount(container, appearance, { isVisible: true });

		expect(getResizeMessages()).toEqual([
			{
				cols: 80,
				pixelHeight: 320,
				pixelWidth: 480,
				rows: 30,
				type: "resize",
			},
		]);
	});

	it.each([false, true])("隐藏挂载的异步尺寸回调不调整 PTY，可见后正常调整（预热=%s）", async (prewarmed) => {
		vi.useFakeTimers();
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-hidden-resize",
			workspaceId: "workspace-1",
			deferAutomaticSessionResumeUntilVisibleMount: prewarmed,
		});
		const container = createContainer();
		terminal.mount(container, appearance, { isVisible: false });
		const observer = MockResizeObserver.instances.at(-1);
		if (!observer) throw new Error("隐藏挂载未注册 ResizeObserver");
		// 浏览器首次尺寸通知在 observe 返回后异步到达，再经 manager 的防抖计时器执行。
		await Promise.resolve().then(() => observer.callback([], observer));
		vi.advanceTimersByTime(50);

		expect(fitAddonProposeDimensionsMock).not.toHaveBeenCalled();
		expect(getResizeMessages()).toEqual([]);
		terminal.mount(container, appearance, { isVisible: true });
		vi.advanceTimersByTime(20);
		expect(getResizeMessages().map((message) => [message.cols, message.rows])).toEqual([[80, 30]]);

		const visibleObserver = MockResizeObserver.instances.at(-1);
		if (!visibleObserver) throw new Error("可见挂载未注册 ResizeObserver");
		fitAddonProposeDimensionsMock.mockReturnValue({ cols: 100, rows: 31 });
		await Promise.resolve().then(() => visibleObserver.callback([], visibleObserver));
		vi.advanceTimersByTime(50);
		expect(getResizeMessages().map((message) => [message.cols, message.rows])).toEqual([
			[80, 30],
			[100, 31],
		]);
	});

	it("sends a resize control frame when fitted dimensions change", () => {
		fitAddonProposeDimensionsMock.mockReturnValueOnce({ cols: 80, rows: 30 }).mockReturnValueOnce({
			cols: 100,
			rows: 31,
		});
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();

		terminal.mount(container, appearance, { isVisible: true });
		terminal.mount(container, appearance, { isVisible: true });

		expect(getResizeMessages().map((message) => [message.cols, message.rows])).toEqual([
			[80, 30],
			[100, 31],
		]);
	});

	// 防回灌守卫：移动视口下行数必须与桌面一样如实跟随 fit 结果，不得被「钉在首次适配值」。
	// 曾短暂存在过一个 mobileLockedRows 软键盘锁，它把首次 fit 的行数永久锁死：既可能锁进
	// display:none 容器算出的极小值且再也抬不回来，也会在可视高度真的变小时让 TUI 把输入行
	// 绘到已被裁掉、且不属于 scrollback 的底部行里（手机上无法靠滚动找回）。若未来又有人以
	// 「防软键盘抖动」为由把行数锁回去，这条会当场失败。
	it("keeps rows following fitted dimensions on a mobile viewport instead of pinning the first fit", () => {
		const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation(
			(query: string) =>
				({
					matches: true,
					media: query,
					onchange: null,
					addListener: () => {},
					removeListener: () => {},
					addEventListener: () => {},
					removeEventListener: () => {},
					dispatchEvent: () => false,
				}) as MediaQueryList,
		);
		// 第一次 fit 落在一个高度极小的容器上（模拟 display:none 的 tab），随后容器恢复正常高度，
		// 最后可视高度真的变小（软键盘/横屏）——三段都必须原样传播。
		fitAddonProposeDimensionsMock
			.mockReturnValueOnce({ cols: 40, rows: 2 })
			.mockReturnValueOnce({ cols: 40, rows: 24 })
			.mockReturnValueOnce({ cols: 40, rows: 10 });
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();

		terminal.mount(container, appearance, { isVisible: true });
		terminal.mount(container, appearance, { isVisible: true });
		terminal.mount(container, appearance, { isVisible: true });

		expect(getResizeMessages().map((message) => [message.cols, message.rows])).toEqual([
			[40, 2],
			[40, 24],
			[40, 10],
		]);
		matchMediaSpy.mockRestore();
	});

	it("initializes shell persistent terminals with shell columns", () => {
		ensurePersistentTerminal({
			...appearance,
			taskId: "__home_terminal__",
			workspaceId: "workspace-1",
		});
		ensurePersistentTerminal({
			...appearance,
			taskId: "__detail_terminal__:task-a",
			workspaceId: "workspace-1",
		});
		ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});

		expect(createdTerminalOptions.map((options) => options.cols)).toEqual([
			SHELL_SESSION_TERMINAL_COLS,
			SHELL_SESSION_TERMINAL_COLS,
			TASK_SESSION_TERMINAL_COLS,
		]);
	});

	it("reconnects the terminal stream after a websocket close", () => {
		vi.useFakeTimers();
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();
		const lastErrors: Array<string | null> = [];
		terminal.subscribe({
			onLastError: (message) => {
				lastErrors.push(message);
			},
		});
		terminal.mount(container, appearance, { isVisible: true });
		const originalIoSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/io"));

		originalIoSocket?.close();
		vi.advanceTimersByTime(250);

		const ioSockets = webSocketInstances.filter((socket) => socket.url.includes("/api/terminal/io"));
		expect(ioSockets).toHaveLength(2);
		expect(lastErrors.at(-1)).toBe("Terminal stream closed. Reconnecting...");
	});

	// 运行时 redeploy（服务端重启）不会重建 PersistentTerminal：两条 socket 关闭只走 scheduleReconnect →
	// ensureConnected，在同一个实例上重连。重连后服务端 mirror 已丢 ⇒ 空 restore 快照把 xterm reset 成白板，
	// 「有没有渲染过内容」必须跟着落回 false，面板的可解释空态（+「重启终端会话」按钮）才会出现。
	it("resets rendered-content presence when an empty restore snapshot clears a reconnected terminal", async () => {
		vi.useFakeTimers();
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		terminal.mount(createContainer(), appearance, { isVisible: true });
		const terminalContentPresenceChanges: boolean[] = [];
		terminal.subscribe({
			onTerminalContentPresenceChange: (hasRenderedAnyTerminalContent) => {
				terminalContentPresenceChanges.push(hasRenderedAnyTerminalContent);
			},
		});
		const ioSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/io"));
		const controlSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/control"));
		if (!ioSocket || !controlSocket) {
			throw new Error("Expected both control and io sockets.");
		}

		dispatchSocketMessage(
			controlSocket,
			JSON.stringify({ type: "restore", snapshot: "restored screen", cols: 80, rows: 30 }),
		);
		await vi.waitFor(() => {
			expect(terminalContentPresenceChanges).toEqual([false, true]);
		});

		// 服务端重启：两条 socket 关闭，同一实例（未 dispose）退避重连。
		ioSocket.close();
		controlSocket.close();
		await vi.advanceTimersByTimeAsync(1000);
		const reconnectedControlSocket = webSocketInstances
			.filter((socket) => socket.url.includes("/api/terminal/control"))
			.at(-1);
		if (!reconnectedControlSocket || reconnectedControlSocket === controlSocket) {
			throw new Error("Expected a reconnected control socket.");
		}

		dispatchSocketMessage(
			reconnectedControlSocket,
			JSON.stringify({ type: "restore", snapshot: "", cols: 80, rows: 30 }),
		);
		await vi.waitFor(() => {
			expect(terminalContentPresenceChanges).toEqual([false, true, false]);
		});
	});

	it("suspends rendering while hidden and snaps to a fresh snapshot on return", () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();
		const writes: Array<string | Uint8Array> = [];
		terminalWriteSideEffect.current = (data) => writes.push(data);
		terminal.mount(container, appearance, { isVisible: true });

		const controlSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/control"));
		const ioSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/io"));
		if (!controlSocket || !ioSocket) {
			throw new Error("Expected both control and io sockets.");
		}

		// Finish the initial restore handshake so live output would normally render.
		dispatchSocketMessage(controlSocket, JSON.stringify({ type: "restore", snapshot: "", cols: 80, rows: 30 }));
		const writesAfterRestore = writes.length;

		// Tab goes to the background: output keeps arriving but must not pile up in xterm.
		setDocumentHidden(true);
		dispatchSocketMessage(ioSocket, "output-while-hidden");

		// Nothing was written to the terminal while hidden...
		expect(writes.length).toBe(writesAfterRestore);
		// ...but the bytes were acked so the server keeps the agent's PTY running.
		const acks = parseControlMessages(controlSocket).filter((message) => message.type === "output_ack");
		expect(acks.length).toBeGreaterThan(0);
		// No snapshot was requested yet — only on return.
		expect(parseControlMessages(controlSocket).some((message) => message.type === "request_restore")).toBe(false);

		// Returning to the tab requests one fresh snapshot instead of replaying the backlog.
		setDocumentHidden(false);
		const restoreRequests = parseControlMessages(controlSocket).filter(
			(message) => message.type === "request_restore",
		);
		expect(restoreRequests).toHaveLength(1);
	});

	it("keeps the terminal at the bottom after restore when it was following output", async () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();
		terminal.mount(container, appearance, { isVisible: true });
		terminalScrollToBottomMock.mockClear();
		terminalBuffer.baseY = 20;
		terminalBuffer.viewportY = 20;

		const controlSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/control"));
		controlSocket?.onmessage?.(
			new MessageEvent("message", {
				data: JSON.stringify({ type: "restore", snapshot: "restored", cols: 80, rows: 30 }),
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		await vi.waitFor(() => {
			expect(terminalScrollToBottomMock).toHaveBeenCalledTimes(1);
		});
	});

	// 「重新同步画面」：只把屏幕从服务端 mirror 重画一遍，绝不碰 PTY / agent 进程。
	// 它与 refresh()（重启 agent 会话）是两条彻底分开的路，这组用例守的就是这条边界。
	describe("重新同步画面（不重启 agent 会话）", () => {
		function findNewestControlSocket() {
			const socket = webSocketInstances.filter((entry) => entry.url.includes("/api/terminal/control")).at(-1);
			if (!socket) {
				throw new Error("control socket not found");
			}
			return socket;
		}

		function readClientId(socketUrl: string): string {
			return new URL(socketUrl, "http://127.0.0.1").searchParams.get("clientId") ?? "";
		}

		function dispatchRestoreToNewest(snapshot: string): void {
			dispatchSocketMessage(
				findNewestControlSocket(),
				JSON.stringify({ type: "restore", snapshot, cols: 80, rows: 30 }),
			);
		}

		function dispatchStateToNewest(summary: Record<string, unknown>): void {
			dispatchSocketMessage(findNewestControlSocket(), JSON.stringify({ type: "state", summary }));
		}

		function countRestoreCompletions(socket: { sentMessages: string[] }): number {
			return parseControlMessages(socket).filter((message) => message.type === "restore_complete").length;
		}

		function mountedTerminal(taskId: string) {
			const terminal = ensurePersistentTerminal({ ...appearance, taskId, workspaceId: "workspace-1" });
			terminal.mount(createContainer(), appearance, { isVisible: true });
			return terminal;
		}

		it("只在控制通道上要一份快照，不打 refreshTaskTerminal", async () => {
			const terminal = mountedTerminal("task-resync-basic");
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true });
			const controlSocket = findNewestControlSocket();

			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			expect(
				parseControlMessages(controlSocket).filter((message) => message.type === "request_restore"),
			).toHaveLength(1);

			dispatchRestoreToNewest("restored screen");
			await resync;

			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("写队列已经卡死时，快照依然能落屏（这正是「TUI 冻住」最常见的形态）", async () => {
			const terminal = mountedTerminal("task-resync-stalled-write-queue");
			// 制造一次永不回调的写：此后写队列永久悬停，applyRestore 会一直卡在它的第一句上。
			terminalWriteCallbackControl.suspended = true;
			dispatchRestoreToNewest("frozen screen");
			await Promise.resolve();
			terminalWriteCallbackControl.suspended = false;

			const controlSocket = findNewestControlSocket();
			expect(countRestoreCompletions(controlSocket)).toBe(0);

			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			dispatchRestoreToNewest("recovered screen");
			await resync;

			expect(countRestoreCompletions(controlSocket)).toBeGreaterThan(0);
		});

		// 回归护栏：discardStalledTerminalWriteQueue 换掉的只是队尾指针，取消不了旧链——链上那些还没跑的
		// link 会在前驱 write 回调迟到触发后（写队列卡死最常见的成因恰恰是「渲染只是被节流、后来还是回来
		// 了」）照常排空。没有代次判据的话它们会把陈旧字节补写进刚被恢复快照重画的屏幕，还会插进
		// sliceRestoreSnapshotForIncrementalWrite 按固定字符数硬切出来的快照分片之间截断 ANSI 序列；
		// 反过来，若只是让它们别执行，这批字节的 output_ack 就永远发不出去——服务端在发送时已按量累加
		// unacknowledgedOutputBytes，而「只发 request_restore、control socket 不重连」这条非升级路径不会
		// 触发服务端的 resetUnacknowledgedOutputAccounting，PTY 会在画面看似已恢复之后继续被背压按住。
		// 两头都得守住：不落屏，但 ack 照发。
		it("被丢弃的旧写队列解冻后不再补写陈旧字节，但仍把它们的 output_ack 发出去", async () => {
			const terminal = mountedTerminal("task-resync-discarded-write-queue-generation");
			const ioSocket = webSocketInstances.filter((entry) => entry.url.includes("/api/terminal/io")).at(-1);
			if (!ioSocket) {
				throw new Error("terminal io socket not found");
			}
			const dataHandedToXtermWrite: string[] = [];
			terminalWriteSideEffect.current = (data) => {
				dataHandedToXtermWrite.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			};
			const staleChunkAlreadyHandedToXterm = "stale-chunk-already-handed-to-xterm";
			const staleChunkStillQueuedBehindTheStalledWrite = "stale-chunk-still-queued-behind-the-stalled-write";

			// 写队列卡死：第一段实时输出的 write 回调被吞掉，第二段就一直排在它后面没机会跑。
			terminalWriteCallbackControl.suspended = true;
			dispatchSocketMessage(ioSocket, staleChunkAlreadyHandedToXterm);
			await Promise.resolve();
			await Promise.resolve();
			dispatchSocketMessage(ioSocket, staleChunkStillQueuedBehindTheStalledWrite);
			await Promise.resolve();
			await Promise.resolve();
			terminalWriteCallbackControl.suspended = false;
			expect(dataHandedToXtermWrite).toEqual([staleChunkAlreadyHandedToXterm]);

			const controlSocket = findNewestControlSocket();
			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			dispatchRestoreToNewest("recovered screen");
			await resync;

			// 卡住的那次写回调此刻才迟到回来：旧链解冻并排空，第二段陈旧输出的 link 于是跑了起来。
			for (const swallowedWriteCompletionCallback of terminalWriteCallbackControl.swallowedWriteCompletionCallbacks.splice(
				0,
			)) {
				swallowedWriteCompletionCallback();
			}
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));

			expect(dataHandedToXtermWrite).not.toContain(staleChunkStillQueuedBehindTheStalledWrite);
			// 恢复快照仍是屏幕上最后落下的东西，没有被陈旧字节追写覆盖。
			expect(dataHandedToXtermWrite.at(-1)).toBe("recovered screen");
			const acknowledgedOutputBytes = parseControlMessages(controlSocket)
				.filter((message) => message.type === "output_ack")
				.reduce((totalBytes, message) => totalBytes + (message.bytes ?? 0), 0);
			expect(acknowledgedOutputBytes).toBe(
				staleChunkAlreadyHandedToXterm.length + staleChunkStillQueuedBehindTheStalledWrite.length,
			);
		});

		it("等不到快照就换一个 clientId 重连两条 socket（服务端那条 viewer 已僵死，原地重试没用）", async () => {
			vi.useFakeTimers();
			const terminal = mountedTerminal("task-resync-escalation");
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true });
			const controlSocketBeforeResync = findNewestControlSocket();
			const clientIdBeforeResync = readClientId(controlSocketBeforeResync.url);
			const socketCountBeforeResync = webSocketInstances.length;

			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			// 服务端一声不吭：截止时间一到就升级。
			await vi.advanceTimersByTimeAsync(1_600);

			expect(controlSocketBeforeResync.readyState).toBe(3);
			expect(webSocketInstances.length).toBeGreaterThan(socketCountBeforeResync);
			expect(readClientId(findNewestControlSocket().url)).not.toBe(clientIdBeforeResync);

			dispatchRestoreToNewest("recovered after reconnect");
			await resync;
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		// 回归护栏（本次改动的核心不变式）：maybeAutoResumeStaleSession 挂在**每一次** restore 应用上，
		// 而升级重连必然要重走一遍 restore。判据全中时它会打出一次 refreshTaskTerminal——用户点的是
		// 「只解冻画面」，结果把还活着的 agent 杀了。抑制闩存在的全部理由就是这一条。
		it("升级重连后拿到空快照，也绝不能顺势变成一次重启", async () => {
			vi.useFakeTimers();
			const terminal = mountedTerminal("task-resync-auto-resume-guard");
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			// 自动续跑的判据逐条命中：PTY 型 agent、pid 为空、非用户回合，且这个 taskId 没进过冷却表。
			dispatchStateToNewest({
				taskId: "task-resync-auto-resume-guard",
				agentId: "claude",
				pid: null,
				state: "idle",
				liveness: "none",
			});

			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			await vi.advanceTimersByTimeAsync(1_600);
			dispatchRestoreToNewest("");
			await resync;

			expect(refreshSpy).not.toHaveBeenCalled();

			// 闩只压这一程：流程终结后，真正意义上的「空快照 = 服务端 mirror 已随运行时丢失」仍然照常续跑。
			dispatchRestoreToNewest("");
			await vi.advanceTimersByTimeAsync(10);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		// 回归护栏（与上一条同一条不变式，堵的是另一条到达它的路）：等待必须认「本次 resync 请求到的那一份
		// 快照」，而不是「随便哪一次 restore 落了屏」。resync 发起时若已有一份更早的快照在途（写队列慢、
		// 还没落屏），它在等待窗口里落屏会把只数次数的等待顺手满足——resync 提前收尾、finally 清掉抑制闩，
		// 本次真正请求到的空快照随后才落地且不再被抑制，于是打出一次杀 agent 的 refreshTaskTerminal。
		it("第一段等待不认 resync 之前就在途、只是此刻才落屏的旧快照", async () => {
			const terminal = mountedTerminal("task-resync-late-preexisting-snapshot");
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			// 自动续跑的判据逐条命中，闩一旦被提前清掉就会立刻兑现成一次重启。
			dispatchStateToNewest({
				taskId: "task-resync-late-preexisting-snapshot",
				agentId: "claude",
				pid: null,
				state: "idle",
				liveness: "none",
			});

			// resync 之前就有一份非空快照在途，写回调迟迟不来（渲染只是慢，不是死透）。
			terminalWriteCallbackControl.suspended = true;
			dispatchRestoreToNewest("screen frozen before resync");
			await Promise.resolve();
			await Promise.resolve();
			terminalWriteCallbackControl.suspended = false;

			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			// 那份迟到的写回调此刻才回来：**旧**快照落屏，恢复快照的落屏水位随之前进。
			for (const swallowedWriteCompletionCallback of terminalWriteCallbackControl.swallowedWriteCompletionCallbacks.splice(
				0,
			)) {
				swallowedWriteCompletionCallback();
			}
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
			// 本次 resync 真正请求到的那份快照（服务端 mirror 已随运行时重启丢空）现在才到。
			dispatchRestoreToNewest("");
			await resync;
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));

			expect(refreshSpy).not.toHaveBeenCalled();
		});

		// 回归护栏：升级重连先把 this.controlSocket 置空再 close()，而 close() 只是发起关闭握手——旧 control
		// socket 上此前已入队的 message 事件仍会派发，而「服务端 restore 迟到」正是走到升级这一步的条件本身。
		// 那一帧迟到的 restore 若没被 onmessage 顶部的守卫挡下，就会拆掉刚为新连接武装好的恢复门控、把
		// restoreCompleted 永久压回 false，并真的跑一遍 applyRestore（reset + 写陈旧快照）盖掉刚重画好的屏幕；
		// 同一条路上的 state 帧也会照样流进 notifySummary。
		it("升级重连后，旧 control socket 上迟到的帧一律不再作数", async () => {
			vi.useFakeTimers();
			const terminal = mountedTerminal("task-resync-late-frame-on-stalled-control-socket");
			const dataHandedToXtermWrite: string[] = [];
			terminalWriteSideEffect.current = (data) => {
				dataHandedToXtermWrite.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			};
			const stalledControlSocket = findNewestControlSocket();

			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			// 服务端一声不吭：截止时间一到就换 clientId 重连两条 socket。
			await vi.advanceTimersByTimeAsync(1_600);
			expect(findNewestControlSocket()).not.toBe(stalledControlSocket);

			const screenRedrawnAfterEscalatedReconnect = "screen redrawn after escalated reconnect";
			dispatchRestoreToNewest(screenRedrawnAfterEscalatedReconnect);
			await resync;

			// 旧连接上那两帧此刻才派发：服务端只是慢，不是没发。
			const onSummarySpy = vi.fn();
			const unsubscribe = terminal.subscribe({ onSummary: onSummarySpy });
			const staleScreenFromStalledControlSocket = "stale screen from the stalled control socket";
			dispatchSocketMessage(
				stalledControlSocket,
				JSON.stringify({ type: "restore", snapshot: staleScreenFromStalledControlSocket, cols: 80, rows: 30 }),
			);
			dispatchSocketMessage(
				stalledControlSocket,
				JSON.stringify({
					type: "state",
					summary: { taskId: "task-resync-late-frame-on-stalled-control-socket", state: "idle" },
				}),
			);
			await vi.advanceTimersByTimeAsync(10);
			unsubscribe();

			expect(dataHandedToXtermWrite).not.toContain(staleScreenFromStalledControlSocket);
			expect(dataHandedToXtermWrite.at(-1)).toBe(screenRedrawnAfterEscalatedReconnect);
			expect(onSummarySpy).not.toHaveBeenCalled();
		});
	});

	describe("auto-resume on focusing a runtime-restarted stale session", () => {
		function findControlSocket() {
			const socket = webSocketInstances.find((entry) => entry.url.includes("/api/terminal/control"));
			if (!socket) {
				throw new Error("control socket not found");
			}
			return socket;
		}

		function dispatchState(summary: Record<string, unknown>): void {
			dispatchSocketMessage(findControlSocket(), JSON.stringify({ type: "state", summary }));
		}

		function dispatchRestore(snapshot: string): void {
			dispatchSocketMessage(findControlSocket(), JSON.stringify({ type: "restore", snapshot, cols: 80, rows: 30 }));
		}

		function mountedTerminal() {
			const terminal = ensurePersistentTerminal({ ...appearance, taskId: "task-a", workspaceId: "workspace-1" });
			terminal.mount(createContainer(), appearance, { isVisible: true });
			return terminal;
		}

		// 自动续跑决策发生在 applyRestore().then() 回调里：restore_complete 控制消息在 maybeAutoResumeStaleSession
		// 之前的同一同步块内经 sendControlMessage 发出。故等到 restore_complete 出现即代表续跑决策已跑完，可确定性断言
		// refresh 是否被调用——取代「2 个 microtask」浅时序（那会在决策点之前就断言、无论有无 gate 都通过，形成假绿）。
		async function waitForRestoreCompleted(expectedCount = 1): Promise<void> {
			await vi.waitFor(() => {
				const completions = parseControlMessages(findControlSocket()).filter(
					(message) => message.type === "restore_complete",
				);
				expect(completions.length).toBeGreaterThanOrEqual(expectedCount);
			});
		}

		// 死会话（服务器重启后 hydrate 出的 idle、agentId 已由服务端从 board card 回填、pid=null）+ 空 restore
		// 快照 → 聚焦即自动一次性续跑；再次空 restore（切走再切回）不重复触发。
		it.each([false, true])(
			"隐藏预热（复用停放=%s）不续跑、不输入、不 resize，可见挂载后恢复",
			async (reuseParked) => {
				if (reuseParked) ensurePersistentTerminal({ ...appearance, taskId: "task-a", workspaceId: "workspace-1" });
				const terminal = ensurePersistentTerminal({
					...appearance,
					taskId: "task-a",
					workspaceId: "workspace-1",
					deferAutomaticSessionResumeUntilVisibleMount: true,
				});
				const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
				dispatchState({ taskId: "task-a", agentId: "claude", pid: null, state: "idle", liveness: "none" });
				dispatchRestore("");
				await waitForRestoreCompleted();
				expect(refreshSpy).not.toHaveBeenCalled();
				expect(terminal.input("隐藏输入")).toBe(false);
				expect(terminal.paste("隐藏粘贴")).toBe(false);
				expect(parseControlMessages(findControlSocket()).some((message) => message.type === "resize")).toBe(false);
				const container = createContainer();
				terminal.mount(container, appearance, { isVisible: false });
				expect(refreshSpy).not.toHaveBeenCalled();
				terminal.mount(container, appearance, { isVisible: true });
				expect(refreshSpy).toHaveBeenCalledTimes(1);
				expect(terminal.input("可见输入")).toBe(true);
				terminal.mount(container, appearance, { isVisible: true });
				expect(refreshSpy).toHaveBeenCalledTimes(1);
			},
		);

		it.each([false, true])("预热期间的画面重同步不能变成续跑（恢复前挂载=%s）", async (mountBeforeRestore) => {
			const terminal = ensurePersistentTerminal({
				...appearance,
				taskId: "task-a",
				workspaceId: "workspace-1",
				deferAutomaticSessionResumeUntilVisibleMount: true,
			});
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			dispatchState({ taskId: "task-a", agentId: "claude", pid: null, state: "idle", liveness: "none" });
			dispatchRestore("");
			await waitForRestoreCompleted();
			const resync = terminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession();
			const container = createContainer();
			if (mountBeforeRestore) {
				terminal.mount(container, appearance, { isVisible: true });
				expect(refreshSpy).not.toHaveBeenCalled();
			}
			dispatchRestore("");
			await resync;
			terminal.mount(container, appearance, { isVisible: true });
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("auto-refreshes once for an empty snapshot terminal-agent session, then debounces", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			dispatchState({ taskId: "task-a", agentId: "claude", pid: null, state: "idle", liveness: "none" });
			dispatchRestore("");

			await vi.waitFor(() => {
				expect(refreshSpy).toHaveBeenCalledTimes(1);
			});

			dispatchRestore("");
			await waitForRestoreCompleted(2);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		it("does not auto-refresh again from a freshly created terminal instance for the same task", async () => {
			// 类里那个一次性闩是 per-实例的，而实例 churn 恰恰是常态：切一张卡（disposePersistentTerminal）、
			// 被 MAX_PARKED_TERMINALS 的 LRU 驱逐后重挂、关掉面板再打开，每次都是一份新实例。
			// 没有跨实例冷却的话，「服务端起不来」这种持续故障会被前端反复叫醒，一次故障变成一串创建请求。
			//
			// 注意 socket 要取**最新**那条：上一份实例已被销毁，它那条 control socket 还留在录制数组里，
			// 打过去等于什么都没测。
			function findNewestControlSocket() {
				const socket = webSocketInstances.filter((entry) => entry.url.includes("/api/terminal/control")).at(-1);
				if (!socket) {
					throw new Error("control socket not found");
				}
				return socket;
			}
			function dispatchStateToNewest(summary: Record<string, unknown>): void {
				dispatchSocketMessage(findNewestControlSocket(), JSON.stringify({ type: "state", summary }));
			}
			function dispatchRestoreToNewest(snapshot: string): void {
				dispatchSocketMessage(
					findNewestControlSocket(),
					JSON.stringify({ type: "restore", snapshot, cols: 80, rows: 30 }),
				);
			}
			const staleAgentSessionState = {
				taskId: "task-a",
				agentId: "claude",
				pid: null,
				state: "idle",
				liveness: "none",
			};

			const firstTerminal = mountedTerminal();
			const firstRefreshSpy = vi.spyOn(firstTerminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			dispatchStateToNewest(staleAgentSessionState);
			dispatchRestoreToNewest("");
			await vi.waitFor(() => {
				expect(firstRefreshSpy).toHaveBeenCalledTimes(1);
			});

			disposePersistentTerminal("workspace-1", "task-a");
			const secondTerminal = mountedTerminal();
			expect(secondTerminal).not.toBe(firstTerminal);
			const secondRefreshSpy = vi.spyOn(secondTerminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			dispatchStateToNewest(staleAgentSessionState);
			dispatchRestoreToNewest("");
			await vi.waitFor(() => {
				const completions = parseControlMessages(findNewestControlSocket()).filter(
					(message) => message.type === "restore_complete",
				);
				expect(completions.length).toBeGreaterThanOrEqual(1);
			});

			expect(secondRefreshSpy).not.toHaveBeenCalled();
		});

		it("does not auto-refresh a session the server has already found to have never established its conversation", async () => {
			// 8ef28 / aa23d：续跑注定被服务端预检拒绝，自动重试只会反复撞同一道拒绝；出路在终端面板上由人选。
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			dispatchState({
				taskId: "task-a",
				agentId: "cursor",
				pid: null,
				state: "idle",
				liveness: "none",
				agentNativeConversationPersistenceObservation: {
					persistenceStatus: "conversation_never_established_in_agent_native_store",
					nativeSessionId: null,
					workingDirectoryPath: "/tmp/worktree",
					suspectedBlockingCause: null,
					observedAt: 1,
				},
			});
			dispatchRestore("");
			await waitForRestoreCompleted();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("does not auto-refresh when the restore snapshot is non-empty (live/exited session, mirror intact)", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true });
			dispatchState({
				taskId: "task-a",
				agentId: "claude",
				pid: null,
				state: "awaiting_review",
				liveness: "exited",
			});
			dispatchRestore("restored screen");
			await waitForRestoreCompleted();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("does not auto-refresh an empty-snapshot session that is awaiting a user turn (review)", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			// 重启后 hydrate 出的会话即便空快照，只要仍是用户回合（awaiting_review → turnOwner==="user"）就绝不自动续跑，
			// 否则会抢跑正等待用户核对的 agent。resolveSessionFacets 从 legacy state 派生 turnOwner。
			dispatchState({ taskId: "task-a", agentId: "claude", pid: null, state: "awaiting_review" });
			dispatchRestore("");
			await waitForRestoreCompleted();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("restores an empty-snapshot question session without treating restoration as an agent turn", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true, mode: "resume" });
			dispatchState({
				taskId: "task-a",
				agentId: "claude",
				pid: null,
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "question",
			});
			dispatchRestore("");

			await vi.waitFor(() => {
				expect(refreshSpy).toHaveBeenCalledTimes(1);
			});
		});

		// 这条负例在「hydrate 多源回填 agentId」之后依然成立，且是刻意保留的：自动续跑是**静默**动作，
		// agentId 完全问不出来时不该靠猜去拉起一个 agent。真实的中断场景已由回填补上 agentId，走上面的正例；
		// 三个源全灭时用户仍有出路——面板会渲染可解释空态 + 「重启终端会话」按钮（那是显式动作，
		// 服务端可以安全地退回项目默认档）。
		it("does not auto-refresh when agentId is null (fresh/never-started or shell session)", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true });
			dispatchState({ taskId: "task-a", agentId: null, pid: null, state: "idle", liveness: "none" });
			dispatchRestore("");
			await waitForRestoreCompleted();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("does not auto-refresh the in-process Cline SDK agent", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true });
			dispatchState({ taskId: "task-a", agentId: "cline", pid: null, state: "idle", liveness: "none" });
			dispatchRestore("");
			await waitForRestoreCompleted();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("does not auto-refresh when a live PTY is present (pid non-null)", async () => {
			const terminal = mountedTerminal();
			const refreshSpy = vi.spyOn(terminal, "refresh").mockResolvedValue({ ok: true });
			dispatchState({ taskId: "task-a", agentId: "claude", pid: 4321, state: "running", liveness: "live" });
			dispatchRestore("");
			await waitForRestoreCompleted();
			expect(refreshSpy).not.toHaveBeenCalled();
		});
	});

	it("keeps the terminal at the bottom after remount when it was following output", () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const firstContainer = createContainer();
		const secondContainer = createContainer();
		terminal.mount(firstContainer, appearance, { isVisible: true });
		terminalScrollToBottomMock.mockClear();
		terminalBuffer.baseY = 20;
		terminalBuffer.viewportY = 20;

		terminal.unmount(firstContainer);
		terminal.mount(secondContainer, appearance, { isVisible: true });

		expect(terminalScrollToBottomMock).toHaveBeenCalledTimes(1);
	});

	it("does not force the terminal to the bottom after restore when the user scrolled up", async () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();
		terminal.mount(container, appearance, { isVisible: true });
		terminalScrollToBottomMock.mockClear();
		terminalBuffer.baseY = 20;
		terminalBuffer.viewportY = 10;

		const controlSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/control"));
		controlSocket?.onmessage?.(
			new MessageEvent("message", {
				data: JSON.stringify({ type: "restore", snapshot: "restored", cols: 80, rows: 30 }),
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(terminalScrollToBottomMock).not.toHaveBeenCalled();
	});

	it("keeps the terminal at the bottom after live output when it was following output", async () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();
		terminal.mount(container, appearance, { isVisible: true });
		terminalScrollToBottomMock.mockClear();
		terminalBuffer.baseY = 20;
		terminalBuffer.viewportY = 20;
		terminalWriteSideEffect.current = () => {
			terminalBuffer.viewportY = 0;
		};

		const ioSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/io"));
		if (!ioSocket) {
			throw new Error("Expected terminal IO socket.");
		}
		dispatchSocketMessage(ioSocket, "hook output");
		await Promise.resolve();
		await Promise.resolve();

		expect(terminalScrollToBottomMock).toHaveBeenCalledTimes(1);
	});

	it("does not force the terminal to the bottom after live output when the user scrolled up", async () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const container = createContainer();
		terminal.mount(container, appearance, { isVisible: true });
		terminalScrollToBottomMock.mockClear();
		terminalBuffer.baseY = 20;
		terminalBuffer.viewportY = 10;
		terminalWriteSideEffect.current = () => {
			terminalBuffer.viewportY = 0;
		};

		const ioSocket = webSocketInstances.find((socket) => socket.url.includes("/api/terminal/io"));
		if (!ioSocket) {
			throw new Error("Expected terminal IO socket.");
		}
		dispatchSocketMessage(ioSocket, "hook output");
		await Promise.resolve();
		await Promise.resolve();

		expect(terminalScrollToBottomMock).not.toHaveBeenCalled();
	});

	it("does not force the terminal to the bottom after remount when the user scrolled up", () => {
		const terminal = ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});
		const firstContainer = createContainer();
		const secondContainer = createContainer();
		terminal.mount(firstContainer, appearance, { isVisible: true });
		terminalScrollToBottomMock.mockClear();
		terminalBuffer.baseY = 20;
		terminalBuffer.viewportY = 10;

		terminal.unmount(firstContainer);
		terminal.mount(secondContainer, appearance, { isVisible: true });

		expect(terminalScrollToBottomMock).not.toHaveBeenCalled();
	});

	it("loads the WebGL renderer on non-Safari browsers", () => {
		platformOverrides.isSafari = false;

		ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});

		expect(webglAddonConstructions.count).toBe(1);
	});

	it("skips the WebGL renderer on Safari so the crisp DOM renderer is used", () => {
		// Safari 不改变 window.devicePixelRatio，WebGL canvas 在 Cmd +/- 缩放时会发虚；
		// 跳过 WebGL 后 xterm 回退到 DOM 渲染器，任意缩放都清晰。
		platformOverrides.isSafari = true;

		ensurePersistentTerminal({
			...appearance,
			taskId: "task-a",
			workspaceId: "workspace-1",
		});

		expect(webglAddonConstructions.count).toBe(0);
	});
});
