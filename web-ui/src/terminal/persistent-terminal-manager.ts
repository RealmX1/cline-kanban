import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { type ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { getTerminalThemeColors, type ThemeTerminalColors } from "@/hooks/use-theme";
import { estimateTaskSessionGeometry, SHELL_SESSION_TERMINAL_COLS } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsResizeMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import { isMacPlatform, isSafari } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const TERMINAL_RECONNECT_INITIAL_DELAY_MS = 250;
const TERMINAL_RECONNECT_MAX_DELAY_MS = 5_000;
const VIEWER_QUEUE_STALL_MS = 5_000;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";
const HOME_TERMINAL_TASK_ID = "__home_terminal__";
const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";
const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
	activeMatchBackground: "#0084FF",
	activeMatchBorder: "#66B7FF",
	activeMatchColorOverviewRuler: "#0084FF",
	matchBackground: "#D29922",
	matchBorder: "#D4A72C",
	matchOverviewRuler: "#D29922",
};

export interface TerminalSearchResultState {
	resultCount: number;
	resultIndex: number;
}

interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors?: ThemeTerminalColors;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
	onSearchOpenRequested?: () => void;
	onSearchResults?: (results: TerminalSearchResultState) => void;
}

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
}

interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
}

function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalIoWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/io`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function getTerminalControlWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/control`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.shiftKey && event.key.toLowerCase() === "c") ||
			(!isMacPlatform && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c"))
	);
}

function isFindShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.ctrlKey) || (!isMacPlatform && event.ctrlKey && !event.metaKey)) &&
		!event.altKey &&
		!event.shiftKey &&
		event.key.toLowerCase() === "f"
	);
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function isShellTerminalTaskId(taskId: string): boolean {
	return taskId === HOME_TERMINAL_TASK_ID || taskId.startsWith(DETAIL_TERMINAL_TASK_PREFIX);
}

function estimateInitialTerminalGeometry(taskId: string): { cols: number; rows: number } {
	const geometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
	if (!isShellTerminalTaskId(taskId)) {
		return geometry;
	}
	return {
		...geometry,
		cols: SHELL_SESSION_TERMINAL_COLS,
	};
}

function resizeMessagesEqual(left: RuntimeTerminalWsResizeMessage, right: RuntimeTerminalWsResizeMessage): boolean {
	return (
		left.cols === right.cols &&
		left.rows === right.rows &&
		left.pixelWidth === right.pixelWidth &&
		left.pixelHeight === right.pixelHeight
	);
}

class PersistentTerminal {
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly searchAddon = new SearchAddon({ highlightLimit: 3000 });
	private readonly hostElement: HTMLDivElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	private readonly unicode11Addon = new Unicode11Addon();
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	private readonly clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	private slowFlushLogged = false;
	private lastSentResizeMessage: RuntimeTerminalWsResizeMessage | null = null;
	private reconnectTimer: number | null = null;
	private reconnectAttempt = 0;
	private disposed = false;
	// User-initiated refresh swaps the backing PTY but should NOT wipe the visible
	// scrollback. The hook reads and clears this flag before deciding whether the
	// new sessionStartedAt warrants resetting the xterm instance.
	private suppressNextRestartReset = false;
	// While the browser tab is hidden the renderer (xterm's requestAnimationFrame loop)
	// is paused by the browser, so writing live output would pile up a backlog that
	// replays as a multi-minute "time-lapse" when the tab is shown again. Instead we
	// suspend rendering while hidden (still acking so the agent keeps running) and snap
	// straight to a fresh server snapshot on return.
	private documentVisible: boolean;
	private renderingSuspended: boolean;
	private needsSnapshotResync = false;

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
	) {
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateInitialTerminalGeometry(this.taskId);

		this.terminal = new Terminal({
			...createKanbanTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
				themeColors: this.appearance.themeColors ?? getTerminalThemeColors(),
			}),
			cols: initialGeometry.cols,
			rows: initialGeometry.rows,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(this.searchAddon);
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.open(this.hostElement);
		this.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sendIoData(bytes);
		});
		this.terminal.attachCustomKeyEventHandler((event) => {
			if (event.key === "Enter" && event.shiftKey) {
				if (event.type === "keydown") {
					this.terminal.input(SHIFT_ENTER_SEQUENCE);
				}
				return false;
			}
			if (isCopyShortcut(event) && this.terminal.hasSelection()) {
				void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {
					// Ignore clipboard failures.
				});
				return false;
			}
			if (isFindShortcut(event)) {
				event.preventDefault();
				this.notifySearchOpenRequested();
				return false;
			}
			return true;
		});
		this.searchAddon.onDidChangeResults((results) => {
			this.notifySearchResults(results);
		});

		if (!isSafari) {
			// Safari 走 xterm 的 DOM 渲染器：它在 Cmd +/- 缩放时始终清晰（Safari 不改变
			// window.devicePixelRatio，WebGL canvas 缓冲区不会按新 DPR 重新光栅化、文字发虚），
			// 同时也规避了较新 Safari 的 WebGL 渲染破损（xterm.js #5816）。
			try {
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon.dispose();
				});
				this.terminal.loadAddon(webglAddon);
			} catch {
				// Fall back to the default DOM renderer when WebGL is unavailable.
			}
		}

		this.documentVisible = typeof document === "undefined" || document.visibilityState === "visible";
		this.renderingSuspended = !this.documentVisible;
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.handleVisibilityChange);
		}

		this.ensureConnected();
	}

	private readonly handleVisibilityChange = (): void => {
		this.setDocumentVisible(document.visibilityState === "visible");
	};

	private setDocumentVisible(visible: boolean): void {
		if (this.documentVisible === visible) {
			return;
		}
		this.documentVisible = visible;
		this.renderingSuspended = !visible;
		if (visible && this.needsSnapshotResync) {
			this.needsSnapshotResync = false;
			this.requestSnapshotResync();
		}
	}

	private requestSnapshotResync(): void {
		// We discarded live output while hidden, so the visible terminal is stale. Ask the
		// server for a fresh snapshot (the server-side mirror stays current in real time) to
		// jump straight to the latest screen — no frame-by-frame catch-up. If the control
		// socket is currently closed, the pending reconnect already sends a restore snapshot,
		// so this is a no-op in that case.
		this.sendControlMessage({ type: "request_restore" });
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		this.connectionReady = true;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private notifySearchOpenRequested(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onSearchOpenRequested?.();
		}
	}

	private notifySearchResults(results: TerminalSearchResultState): void {
		for (const subscriber of this.subscribers) {
			subscriber.onSearchResults?.(results);
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer !== null) {
			return;
		}
		const delay = Math.min(
			TERMINAL_RECONNECT_INITIAL_DELAY_MS * 2 ** this.reconnectAttempt,
			TERMINAL_RECONNECT_MAX_DELAY_MS,
		);
		this.reconnectAttempt += 1;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.ensureConnected();
			if (!this.disposed && (!this.ioSocket || !this.controlSocket)) {
				this.scheduleReconnect();
			}
		}, delay);
	}

	private markSocketOpen(): void {
		this.reconnectAttempt = 0;
		this.clearReconnectTimer();
		this.lastError = null;
		this.notifyLastError();
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): boolean {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.controlSocket.send(JSON.stringify(message));
		return true;
	}

	private sendIoData(data: string | Uint8Array): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
			keepScrolledToBottom?: boolean;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		const enqueuedAt = performance.now();
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.disposed) {
							resolve();
							return;
						}
						const shouldKeepScrolledToBottom =
							options.keepScrolledToBottom === false ? false : this.shouldKeepScrolledToBottom();
						this.terminal.write(data, () => {
							const elapsed = performance.now() - enqueuedAt;
							if (elapsed > VIEWER_QUEUE_STALL_MS) {
								if (!this.slowFlushLogged) {
									console.warn(
										`[tui-freeze] viewer-queue taskId=${this.taskId} elapsedMs=${Math.round(elapsed)}`,
									);
									this.slowFlushLogged = true;
								}
							} else if (this.slowFlushLogged) {
								this.slowFlushLogged = false;
							}
							if (notifyText) {
								this.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							this.keepScrolledToBottom(shouldKeepScrolledToBottom);
							resolve();
						});
					}),
			);
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		const shouldKeepScrolledToBottom = this.shouldKeepScrolledToBottom();
		await this.terminalWriteQueue.catch(() => undefined);
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (!snapshot) {
			this.keepScrolledToBottom(shouldKeepScrolledToBottom);
			return;
		}
		await this.enqueueTerminalWrite(snapshot, { keepScrolledToBottom: false });
		this.keepScrolledToBottom(shouldKeepScrolledToBottom);
	}

	private getRenderedPixelSize(): { pixelWidth?: number; pixelHeight?: number } {
		const screenElement = this.terminal.element?.querySelector<HTMLElement>(".xterm-screen");
		if (!screenElement) {
			return {};
		}
		const bounds = screenElement.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		return {
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		};
	}

	private requestResize(): void {
		if (!this.visibleContainer) {
			return;
		}
		const proposedDimensions = this.fitAddon.proposeDimensions();
		const nextCols =
			proposedDimensions && Number.isFinite(proposedDimensions.cols)
				? Math.max(1, Math.floor(proposedDimensions.cols))
				: this.terminal.cols;
		const nextRows =
			proposedDimensions && Number.isFinite(proposedDimensions.rows)
				? Math.max(1, Math.floor(proposedDimensions.rows))
				: this.terminal.rows;
		if (nextCols !== this.terminal.cols || nextRows !== this.terminal.rows) {
			this.terminal.resize(nextCols, nextRows);
		}
		const renderedPixelSize = this.getRenderedPixelSize();
		reportTerminalGeometry(this.taskId, {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
		const resizeMessage: RuntimeTerminalWsResizeMessage = {
			type: "resize",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			pixelWidth: renderedPixelSize.pixelWidth,
			pixelHeight: renderedPixelSize.pixelHeight,
		};
		if (this.lastSentResizeMessage && resizeMessagesEqual(this.lastSentResizeMessage, resizeMessage)) {
			return;
		}
		if (this.sendControlMessage(resizeMessage)) {
			this.lastSentResizeMessage = resizeMessage;
		}
	}

	private shouldKeepScrolledToBottom(): boolean {
		const buffer = this.terminal.buffer.active;
		return buffer.baseY - buffer.viewportY <= 1;
	}

	private keepScrolledToBottom(shouldKeepScrolledToBottom: boolean): void {
		if (!shouldKeepScrolledToBottom) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (this.disposed) {
				return;
			}
			this.terminal.scrollToBottom();
		});
	}

	private connectIo(): void {
		if (this.ioSocket) {
			return;
		}
		const ioSocket = new WebSocket(getTerminalIoWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const ackBytes = getTerminalSocketChunkByteLength(event.data);
			// Decode every chunk regardless of visibility so the streaming TextDecoder and
			// activity notifications stay consistent across the hidden window.
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			if (this.renderingSuspended) {
				// Tab is hidden: skip the xterm write (the renderer is paused, so it would
				// only build a backlog). Ack immediately to keep the agent's PTY flowing,
				// keep activity notifications alive, and remember to resync on return.
				this.sendControlMessage({ type: "output_ack", bytes: ackBytes });
				if (decoded) {
					this.notifyOutputText(decoded);
				}
				this.needsSnapshotResync = true;
				return;
			}
			void this.enqueueTerminalWrite(writeData, {
				ackBytes,
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.markSocketOpen();
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			if (this.restoreCompleted) {
				this.notifyConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.lastError = "Terminal stream failed.";
			this.notifyLastError();
		};
		ioSocket.onclose = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.connectionReady = false;
			this.lastError = "Terminal stream closed. Reconnecting...";
			this.notifyLastError();
			this.scheduleReconnect();
		};
	}

	private connectControl(): void {
		if (this.controlSocket) {
			return;
		}
		const controlSocket = new WebSocket(getTerminalControlWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		this.controlSocket = controlSocket;
		this.lastSentResizeMessage = null;
		controlSocket.onopen = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.markSocketOpen();
		};
		controlSocket.onmessage = (event) => {
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						if (this.ioSocket && this.visibleContainer) {
							this.requestResize();
						}
						if (this.ioSocket) {
							this.notifyConnectionReady();
						}
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.lastError = "Terminal restore failed.";
						this.notifyLastError();
					});
				return;
			}
			if (payload.type === "state") {
				this.notifySummary(payload.summary);
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[kanban] ${label}\r\n`);
				return;
			}
			if (payload.type === "error") {
				this.lastError = payload.message;
				this.notifyLastError();
				void this.enqueueTerminalWrite(`\r\n[kanban] ${payload.message}\r\n`);
			}
		};
		controlSocket.onerror = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.lastError = "Terminal control connection failed.";
			this.notifyLastError();
		};
		controlSocket.onclose = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.controlSocket = null;
			this.connectionReady = false;
			this.restoreCompleted = false;
			this.lastError = "Terminal control connection closed. Reconnecting...";
			this.notifyLastError();
			this.scheduleReconnect();
		};
	}

	private ensureConnected(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket) {
			this.connectIo();
		}
		if (!this.controlSocket) {
			this.connectControl();
		}
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createKanbanTerminalOptions({
				cursorColor: appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
				themeColors: appearance.themeColors ?? getTerminalThemeColors(),
			}).theme,
		};
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		const shouldKeepScrolledToBottom = this.shouldKeepScrolledToBottom();
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		if (options.isVisible !== false) {
			window.requestAnimationFrame(() => {
				this.requestResize();
				this.keepScrolledToBottom(shouldKeepScrolledToBottom);
				if (options.autoFocus) {
					this.terminal.focus();
				}
			});
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.visibleContainer = null;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
	}

	focus(): void {
		this.terminal.focus();
	}

	input(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.clear();
			});
	}

	searchNext(query: string, options: Pick<ISearchOptions, "caseSensitive"> = {}): boolean {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) {
			this.clearSearch();
			this.notifySearchResults({ resultCount: 0, resultIndex: -1 });
			return false;
		}
		return this.searchAddon.findNext(normalizedQuery, {
			...options,
			decorations: SEARCH_DECORATIONS,
			incremental: true,
		});
	}

	searchPrevious(query: string, options: Pick<ISearchOptions, "caseSensitive"> = {}): boolean {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) {
			this.clearSearch();
			this.notifySearchResults({ resultCount: 0, resultIndex: -1 });
			return false;
		}
		return this.searchAddon.findPrevious(normalizedQuery, {
			...options,
			decorations: SEARCH_DECORATIONS,
		});
	}

	clearSearch(): void {
		this.searchAddon.clearDecorations();
		this.terminal.clearSelection();
	}

	reset(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.reset();
			});
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	async refresh(): Promise<{ ok: boolean; error?: string; mode?: "resume" | "fresh" }> {
		this.suppressNextRestartReset = true;
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		try {
			const result = await trpcClient.runtime.refreshTaskTerminal.mutate({
				taskId: this.taskId,
				cols: this.terminal.cols,
				rows: this.terminal.rows,
			});
			if (!result.ok) {
				this.suppressNextRestartReset = false;
			}
			return { ok: result.ok, error: result.error, mode: result.mode };
		} catch (error) {
			this.suppressNextRestartReset = false;
			throw error;
		}
	}

	consumeRestartResetSuppression(): boolean {
		const value = this.suppressNextRestartReset;
		this.suppressNextRestartReset = false;
		return value;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.handleVisibilityChange);
		}
		this.clearReconnectTimer();
		this.unmount(this.visibleContainer);
		this.ioSocket?.close();
		this.controlSocket?.close();
		this.ioSocket = null;
		this.controlSocket = null;
		this.subscribers.clear();
		this.terminal.dispose();
		this.hostElement.remove();
	}
}

const terminals = new Map<string, PersistentTerminal>();

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	let terminal = terminals.get(key);
	if (!terminal) {
		terminal = new PersistentTerminal(input.taskId, input.workspaceId, {
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		});
		terminals.set(key, terminal);
		return terminal;
	}
	terminal.setAppearance({
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
		themeColors: input.themeColors,
	});
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}
