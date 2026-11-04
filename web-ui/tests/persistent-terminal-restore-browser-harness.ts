import type { Terminal } from "@xterm/xterm";
import { ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

const container = document.createElement("div");
container.style.width = "100%";
container.style.height = "100%";
document.body.append(container);
const appearance = { cursorColor: "white", terminalBackgroundColor: "black" };
const persistentTerminal = ensurePersistentTerminal({
	...appearance,
	taskId: "isolated-terminal-restore-task",
	workspaceId: "isolated-terminal-restore-workspace",
});
// 仅测试读取真实 xterm，无需为探针扩展生产 API。
const terminal = Reflect.get(persistentTerminal, "terminal") as Terminal;
let connectionReadyCount = 0;
let resetCount = 0;
let refreshAttemptCount = 0;
let holdNextWriteCompletion = false;
const heldWriteCompletions: Array<() => void> = [];
let holdNextNativeInputParsing = false;
const heldNativeInputParsingContinuations: Array<() => void> = [];
const originalWrite = terminal.write.bind(terminal);
const originalReset = terminal.reset.bind(terminal);
terminal.parser.registerCsiHandler({ final: "m" }, (params) => {
	if (!holdNextNativeInputParsing || params[0] !== 9999) return false;
	holdNextNativeInputParsing = false;
	return new Promise<boolean>((resolve) => heldNativeInputParsingContinuations.push(() => resolve(true)));
});
terminal.parser.registerEscHandler({ final: "c" }, () => {
	resetCount += 1;
	return false;
});
terminal.write = (data, callback) => {
	const shouldHoldCompletion = data !== "\x18\x1bc" && holdNextWriteCompletion;
	if (shouldHoldCompletion) holdNextWriteCompletion = false;
	originalWrite(data, () => {
		if (shouldHoldCompletion && callback) heldWriteCompletions.push(callback);
		else callback?.();
	});
};
terminal.reset = () => {
	resetCount += 1;
	originalReset();
};
persistentTerminal.refresh = async () => {
	refreshAttemptCount += 1;
	throw new Error("终端画面恢复不得重启 agent");
};
persistentTerminal.subscribe({ onConnectionReady: () => connectionReadyCount++ });
persistentTerminal.mount(container, appearance, { isVisible: true });

function readTerminalState() {
	const buffer = terminal.buffer.active;
	const screenLines = Array.from({ length: terminal.rows }, (_, index) =>
		buffer.getLine(buffer.viewportY + index)?.translateToString(true),
	);
	const screenBounds = terminal.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
	return {
		bufferType: buffer.type,
		mouseTrackingMode: terminal.modes.mouseTrackingMode,
		baseY: buffer.baseY,
		viewportY: buffer.viewportY,
		cols: terminal.cols,
		rows: terminal.rows,
		screenLines,
		connectionReadyCount,
		resetCount,
		refreshAttemptCount,
		restoreSnapshotArrivalSequence: Reflect.get(persistentTerminal, "restoreSnapshotArrivalSequence") as number,
		heldWriteCompletionCount: heldWriteCompletions.length,
		heldNativeInputParsingCount: heldNativeInputParsingContinuations.length,
		hasHorizontalOverflow:
			document.documentElement.scrollWidth > document.documentElement.clientWidth ||
			(screenBounds?.right ?? 0) > container.getBoundingClientRect().right + 1,
	};
}

declare global {
	interface Window {
		persistentTerminalRestoreHarness: {
			readTerminalState: typeof readTerminalState;
			holdNextWriteCompletion(): void;
			holdNextNativeInputParsing(): void;
			releaseHeldNativeInputParsing(): void;
			releaseHeldWriteCompletions(): Promise<void>;
			resync(): Promise<void>;
			setDocumentVisible(visible: boolean): void;
		};
	}
}

window.persistentTerminalRestoreHarness = {
	readTerminalState,
	holdNextWriteCompletion() {
		holdNextWriteCompletion = true;
	},
	holdNextNativeInputParsing() {
		holdNextNativeInputParsing = true;
	},
	releaseHeldNativeInputParsing() {
		for (const continueParsing of heldNativeInputParsingContinuations.splice(0)) continueParsing();
	},
	async releaseHeldWriteCompletions() {
		for (const completeWrite of heldWriteCompletions.splice(0)) completeWrite();
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	},
	resync: () => persistentTerminal.resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession(),
	setDocumentVisible(visible) {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: visible ? "visible" : "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	},
};
