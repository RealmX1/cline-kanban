import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_SESSION_TERMINAL_COLS, TASK_SESSION_TERMINAL_COLS } from "@/runtime/task-session-geometry";
import type { RuntimeTerminalWsResizeMessage } from "@/runtime/types";
import {
	disposeAllPersistentTerminalsForWorkspace,
	ensurePersistentTerminal,
} from "@/terminal/persistent-terminal-manager";

const fitAddonProposeDimensionsMock = vi.hoisted(() => vi.fn<() => { cols: number; rows: number } | undefined>());
const screenPixelSize = vi.hoisted(() => ({ width: 480, height: 320 }));
const createdTerminalOptions = vi.hoisted(() => [] as Array<{ cols?: number; rows?: number }>);
const terminalBuffer = vi.hoisted(() => ({ baseY: 0, viewportY: 0 }));
const terminalScrollToBottomMock = vi.hoisted(() => vi.fn());
const terminalWriteSideEffect = vi.hoisted(() => ({ current: null as null | ((data: string | Uint8Array) => void) }));
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
		dispose(): void {}

		onContextLoss(_handler: () => void): void {}
	},
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols: number;
		element: HTMLElement | undefined;
		options: { theme?: unknown };
		rows: number;
		unicode = { activeVersion: "" };
		buffer = { active: terminalBuffer };

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
			callback?.();
		}
	},
}));

class MockResizeObserver implements ResizeObserver {
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

describe("persistent-terminal-manager", () => {
	beforeEach(() => {
		fitAddonProposeDimensionsMock.mockReset();
		fitAddonProposeDimensionsMock.mockReturnValue({ cols: 80, rows: 30 });
		terminalBuffer.baseY = 0;
		terminalBuffer.viewportY = 0;
		terminalScrollToBottomMock.mockReset();
		terminalWriteSideEffect.current = null;
		createdTerminalOptions.length = 0;
		webSocketInstances.length = 0;
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
	});

	afterEach(() => {
		disposeAllPersistentTerminalsForWorkspace("workspace-1");
		vi.useRealTimers();
		document.body.replaceChildren();
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
});
