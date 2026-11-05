// host 与 runtime 共用的有界模式解析器；不持有屏幕或输出历史，也不依赖 xterm。
export interface HostedSessionTerminalModes {
	alternateScreenActive: boolean;
	mouseTrackingMode: 0 | 9 | 1000 | 1002 | 1003;
	mouseCoordinateEncoding: 0 | 1006 | 1016;
	bracketedPasteActive: boolean;
	focusReportingActive: boolean;
}

export interface HostedSessionTerminalModeReplayState {
	terminalModes: HostedSessionTerminalModes;
	// 起点可能位于控制序列或 UTF-8 字符内部；恢复模式后先补此前缀，再交付原始字节。
	parserContinuationHex: string;
}

export interface HostedSessionTerminalModeCheckpoint extends HostedSessionTerminalModeReplayState {
	schemaVersion: 1;
	hostedSessionKey: string;
	pid: number;
	spawnedAtEpochMs: number;
	outputByteOffset: number;
}

const DEFAULT_TERMINAL_MODES: HostedSessionTerminalModes = {
	alternateScreenActive: false,
	mouseTrackingMode: 0,
	mouseCoordinateEncoding: 0,
	bracketedPasteActive: false,
	focusReportingActive: false,
};
const TERMINAL_MODE_NAMES = Object.keys(DEFAULT_TERMINAL_MODES) as (keyof HostedSessionTerminalModes)[];
// EXPERIMENT_NODE: 前缀最多保存 512 字符，超限转为未知；出现更长的真实 TUI 初始化序列后再调整。
const MAXIMUM_PARSER_CONTINUATION_CHARACTER_LENGTH = 512;
// 与 xterm 的 Params 默认上限一致，超出的参数不会生效。
const MAXIMUM_TERMINAL_MODE_PARAMETER_COUNT = 32;

export class HostedSessionTerminalModeStateTracker {
	private terminalModes = { ...DEFAULT_TERMINAL_MODES };
	private knownTerminalModes = new Set(TERMINAL_MODE_NAMES);
	private parserState: "ground" | "escape" | "csi" | "osc" | "ignored_string" = "ground";
	private parserContinuation = "";
	private pendingUtf8InputBytes = Buffer.alloc(0);
	private csiOverflowed = false;

	get terminalModesAreKnown(): boolean {
		return this.knownTerminalModes.size === TERMINAL_MODE_NAMES.length;
	}

	markTerminalModesUnknown(): void {
		this.knownTerminalModes.clear();
	}

	clone(): HostedSessionTerminalModeStateTracker {
		const copy = new HostedSessionTerminalModeStateTracker();
		copy.terminalModes = { ...this.terminalModes };
		copy.knownTerminalModes = new Set(this.knownTerminalModes);
		copy.parserState = this.parserState;
		copy.parserContinuation = this.parserContinuation;
		copy.pendingUtf8InputBytes = Buffer.from(this.pendingUtf8InputBytes);
		copy.csiOverflowed = this.csiOverflowed;
		return copy;
	}

	readReplayState(): HostedSessionTerminalModeReplayState | undefined {
		if (!this.terminalModesAreKnown || this.csiOverflowed) return undefined;
		return {
			terminalModes: { ...this.terminalModes },
			parserContinuationHex: Buffer.concat([
				Buffer.from(this.parserContinuation, "utf8"),
				this.pendingUtf8InputBytes,
			]).toString("hex"),
		};
	}

	applyOutput(bytes: Buffer): void {
		const source = this.pendingUtf8InputBytes.length ? Buffer.concat([this.pendingUtf8InputBytes, bytes]) : bytes;
		let completeByteLength = source.length;
		for (let index = source.length - 1; index >= Math.max(0, source.length - 4); index--) {
			const byte = source[index];
			if (byte === undefined) continue;
			if ((byte & 0xc0) === 0x80) continue;
			const expectedLength =
				(byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
			if (source.length - index < expectedLength) completeByteLength = index;
			break;
		}
		this.pendingUtf8InputBytes = Buffer.from(source.subarray(completeByteLength));
		for (const character of source.toString("utf8", 0, completeByteLength)) this.applyCharacter(character);
	}

	private applyCharacter(character: string): void {
		// xterm 在 ESC / CSI 中忽略 DEL，不让它改变参数或结束尚未完成的序列。
		if (character === "\u007f") return;
		if (character === "\u0018" || character === "\u001a") {
			this.finishControlSequence();
			return;
		}
		if (character === "\u001b") {
			this.parserState = "escape";
			this.parserContinuation = "\u001b";
			this.csiOverflowed = false;
			return;
		}
		if (character === "\u009c" || (this.parserState === "osc" && character === "\u0007")) {
			this.finishControlSequence();
			return;
		}
		if (character === "\u009b" || character === "\u009d" || character === "\u0090") {
			this.startIntroducedControlSequence(character === "\u009b" ? "[" : character === "\u009d" ? "]" : "P");
			return;
		}
		if (this.parserState === "osc" || this.parserState === "ignored_string") return;
		if (this.parserState === "escape") {
			if (["[", "]", "P", "_", "^", "X"].includes(character) && this.parserContinuation === "\u001b") {
				this.startIntroducedControlSequence(character);
				return;
			}
			if (character >= " " && character <= "/") {
				if (this.parserContinuation.length < MAXIMUM_PARSER_CONTINUATION_CHARACTER_LENGTH)
					this.parserContinuation += character;
				return;
			}
			if (character === "c" && this.parserContinuation === "\u001b") {
				this.terminalModes = { ...DEFAULT_TERMINAL_MODES };
				this.knownTerminalModes = new Set(TERMINAL_MODE_NAMES);
			}
			if (character >= "0") this.finishControlSequence();
			return;
		}
		if (this.parserState !== "csi" || character < " ") return;
		if (character >= "@" && character <= "~") {
			if (!this.csiOverflowed) this.applyCsiSequence(this.parserContinuation.slice(2), character);
			this.finishControlSequence();
		} else if (this.parserContinuation.length < MAXIMUM_PARSER_CONTINUATION_CHARACTER_LENGTH) {
			this.parserContinuation += character;
		} else {
			this.csiOverflowed = true;
			this.markTerminalModesUnknown();
		}
	}

	private startIntroducedControlSequence(introducer: string): void {
		this.csiOverflowed = false;
		this.parserState = introducer === "[" ? "csi" : introducer === "]" ? "osc" : "ignored_string";
		// 字符串正文无需保存；恢复时使用未注册的命令，让被截断的尾部保持不可见且不触发旧查询。
		this.parserContinuation = introducer === "[" ? "\u001b[" : introducer === "]" ? "\u001b]99999;" : "\u001b_";
	}

	private finishControlSequence(): void {
		this.parserState = "ground";
		this.parserContinuation = "";
		this.csiOverflowed = false;
	}

	private setTerminalMode<ModeName extends keyof HostedSessionTerminalModes>(
		name: ModeName,
		value: HostedSessionTerminalModes[ModeName],
	): void {
		this.terminalModes[name] = value;
		this.knownTerminalModes.add(name);
	}

	private applyCsiSequence(body: string, final: string): void {
		if (/^[\d;:]*!$/.test(body) && final === "p") {
			// DECSTR 重置 core modes，但不切换 buffer 或重置鼠标服务（与 xterm 一致）。
			this.setTerminalMode("bracketedPasteActive", false);
			this.setTerminalMode("focusReportingActive", false);
		}
		if ((final !== "h" && final !== "l") || !/^\?[\d;:]+$/.test(body)) return;
		const enabled = final === "h";
		for (const parameter of body.slice(1).split(";").slice(0, MAXIMUM_TERMINAL_MODE_PARAMETER_COUNT)) {
			const mode = Number(parameter.split(":")[0]);
			if (mode === 47 || mode === 1047 || mode === 1049) this.setTerminalMode("alternateScreenActive", enabled);
			if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003)
				this.setTerminalMode("mouseTrackingMode", enabled ? mode : 0);
			if (mode === 1006 || mode === 1016) this.setTerminalMode("mouseCoordinateEncoding", enabled ? mode : 0);
			if (mode === 2004) this.setTerminalMode("bracketedPasteActive", enabled);
			if (mode === 1004) this.setTerminalMode("focusReportingActive", enabled);
		}
	}
}

export function serializeHostedSessionTerminalModes(modes: HostedSessionTerminalModes): Buffer {
	const privateModes = [
		...(modes.alternateScreenActive ? [1049] : []),
		...(modes.mouseCoordinateEncoding ? [modes.mouseCoordinateEncoding] : []),
		...(modes.mouseTrackingMode ? [modes.mouseTrackingMode] : []),
		...(modes.bracketedPasteActive ? [2004] : []),
		...(modes.focusReportingActive ? [1004] : []),
	];
	return Buffer.from(privateModes.map((mode) => `\u001b[?${mode}h`).join(""), "utf8");
}

export function readHostedSessionTerminalModeCheckpointForReplay(input: {
	checkpoint: HostedSessionTerminalModeCheckpoint | undefined;
	hostedSessionKey: string;
	pid: number;
	spawnedAtEpochMs: number;
	outputByteOffset: number;
}): HostedSessionTerminalModeReplayState | undefined {
	const checkpoint = input.checkpoint;
	if (
		!checkpoint ||
		checkpoint.schemaVersion !== 1 ||
		checkpoint.hostedSessionKey !== input.hostedSessionKey ||
		checkpoint.pid !== input.pid ||
		checkpoint.spawnedAtEpochMs !== input.spawnedAtEpochMs ||
		checkpoint.outputByteOffset !== input.outputByteOffset
	)
		return undefined;
	const modes = checkpoint.terminalModes;
	if (
		!modes ||
		typeof modes.alternateScreenActive !== "boolean" ||
		![0, 9, 1000, 1002, 1003].includes(modes.mouseTrackingMode) ||
		![0, 1006, 1016].includes(modes.mouseCoordinateEncoding) ||
		typeof modes.bracketedPasteActive !== "boolean" ||
		typeof modes.focusReportingActive !== "boolean" ||
		typeof checkpoint.parserContinuationHex !== "string" ||
		checkpoint.parserContinuationHex.length > MAXIMUM_PARSER_CONTINUATION_CHARACTER_LENGTH * 2 + 8 ||
		!/^(?:[\da-f]{2})*$/.test(checkpoint.parserContinuationHex)
	)
		return undefined;
	// 前缀只能让解析器停在未完成状态，不能夹带已完成的查询或可见正文。
	const continuationTracker = new HostedSessionTerminalModeStateTracker();
	continuationTracker.applyOutput(Buffer.from(checkpoint.parserContinuationHex, "hex"));
	if (continuationTracker.readReplayState()?.parserContinuationHex !== checkpoint.parserContinuationHex)
		return undefined;
	return { terminalModes: { ...modes }, parserContinuationHex: checkpoint.parserContinuationHex };
}
