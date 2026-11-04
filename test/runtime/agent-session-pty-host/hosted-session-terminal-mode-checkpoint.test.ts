import { describe, expect, it } from "vitest";
import { HostedSessionOutputRingBufferWithAbsoluteByteOffsets } from "../../../src/agent-session-pty-host/host-process/hosted-session-output-ring-buffer-with-absolute-byte-offsets";
import {
	HostedSessionTerminalModeStateTracker,
	readHostedSessionTerminalModeCheckpointForReplay,
	serializeHostedSessionTerminalModes,
} from "../../../src/agent-session-pty-host/wire-protocol/hosted-session-terminal-mode-checkpoint";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

describe("hosted 会话终端模式检查点", () => {
	it.each([
		"\u001b[?1049;1002;1006;2004;1004h",
		"\u001b[?1047;1003;1016;2004;1004h\u001b[?1000;1006l",
		"\u001b[?1049;1002;1006;2004;1004h\u001b[?47;1003;1016;2004;1004l",
		"\u001b[?1049;1003;1016;2004;1004h\u001b[!p",
		"\u001b[?1049;1003;1016;2004;1004h\u001b[0!p",
		"\u001b[?1049;1003;1016;2004;1004h\u001b[0:0!p",
		"\u001b[?1049;1003;1006;2004;1004h\u001b[?100\u007f6l",
		"\u001b[?1049;1003;1006;2004;1004h\u001b\u007fc",
		"\u001b[?1049:0;1002:0;1006:0;2004;1004h",
		`\u001b[?${"0;".repeat(32)}1006h`,
		"\u001b[?1049;1002;1006;2004;1004h\u001bc",
		"\u001b]0;伪造 [?1003h\u0007\u001bPq[?1006h\u001b\\",
		"\u009b?1049;1002;1006;2004;1004h",
	])("任意字节分片与真实 xterm 模式语义一致：%j", async (output) => {
		const tracker = new HostedSessionTerminalModeStateTracker();
		const sourceMirror = new TerminalStateMirror(80, 24);
		const restoredMirror = new TerminalStateMirror(80, 24);
		try {
			const bytes = Buffer.from(output);
			for (const byte of bytes) tracker.applyOutput(Buffer.from([byte]));
			sourceMirror.applyOutput(bytes);
			const replayState = tracker.readReplayState();
			if (!replayState) throw new Error("模式未知");
			restoredMirror.applyOutput(serializeHostedSessionTerminalModes(replayState.terminalModes));
			// 使用生产 mirror 的序列化同时比较 buffer、跟踪、坐标编码、焦点与粘贴。
			expect((await restoredMirror.getSnapshot()).snapshot).toBe((await sourceMirror.getSnapshot()).snapshot);
		} finally {
			sourceMirror.dispose();
			restoredMirror.dispose();
		}
	});

	it.each(["\u001b[?100\u007f6l", "\u001b[0:0!p"])(
		"关闭或软重置被 3 MiB 输出淘汰后，可信检查点仍与真实 xterm 模式一致：%j",
		async (closingSequence) => {
			const output = Buffer.from(`\u001b[?1049;1002;1006;2004;1004h${closingSequence}`);
			const overwrittenOutput = Buffer.alloc(3 * 1024 * 1024);
			const ring = new HostedSessionOutputRingBufferWithAbsoluteByteOffsets();
			for (const byte of output) ring.append(Buffer.from([byte]));
			ring.append(overwrittenOutput);
			const retained = ring.readFromAbsoluteByteOffset(0);
			const state = ring.readTerminalModeStateAtAbsoluteByteOffset(retained.startByteOffset);
			if (!state) throw new Error("保留起点模式未知");
			const identity = {
				hostedSessionKey: "overwritten-closing-sequence",
				pid: 100,
				spawnedAtEpochMs: 200,
				outputByteOffset: retained.startByteOffset,
			};
			const checkpoint = readHostedSessionTerminalModeCheckpointForReplay({
				...identity,
				checkpoint: { schemaVersion: 1, ...identity, ...state },
			});
			if (!checkpoint) throw new Error("检查点被拒绝");
			const originalResponses: string[] = [];
			const restoredResponses: string[] = [];
			const originalMirror = new TerminalStateMirror(80, 24, {
				onInputResponse: (data) => originalResponses.push(data),
			});
			const restoredMirror = new TerminalStateMirror(80, 24, {
				onInputResponse: (data) => restoredResponses.push(data),
			});
			try {
				originalMirror.applyOutput(output);
				originalMirror.applyOutput(overwrittenOutput);
				restoredMirror.applyOutput(serializeHostedSessionTerminalModes(checkpoint.terminalModes));
				restoredMirror.applyOutput(Buffer.from(checkpoint.parserContinuationHex, "hex"));
				restoredMirror.applyOutput(retained.bytes);
				const queries = Buffer.from("\u001b[?1006$p\u001b[?2004$p\u001b[?1004$p");
				originalMirror.applyOutput(queries);
				restoredMirror.applyOutput(queries);
				await originalMirror.getSnapshot();
				await restoredMirror.getSnapshot();
				expect(originalResponses).toHaveLength(3);
				expect(restoredResponses).toEqual(originalResponses);
			} finally {
				originalMirror.dispose();
				restoredMirror.dispose();
			}
		},
	);

	it("未知模式只在原生初始化补齐或 RIS 后恢复，不把重绘当证据", () => {
		const tracker = new HostedSessionTerminalModeStateTracker();
		tracker.markTerminalModesUnknown();
		tracker.applyOutput(Buffer.from("\u001b[2J\u001b[H普通重绘"));
		expect(tracker.readReplayState()).toBeUndefined();
		for (const part of ["\u001b[?1049;1002h", "\u001b[?1006;2004;1004h"]) tracker.applyOutput(Buffer.from(part));
		expect(tracker.terminalModesAreKnown).toBe(true);
		tracker.markTerminalModesUnknown();
		tracker.applyOutput(Buffer.from("\u001bc"));
		expect(tracker.readReplayState()?.terminalModes.alternateScreenActive).toBe(false);
	});

	it.each(["不是 hex", "1b5b366e", "76697369626c65", "00".repeat(1024)])(
		"拒绝损坏或含完整命令的解析前缀：%j",
		(parserContinuationHex) => {
			const identity = { hostedSessionKey: "hosted-1", pid: 100, spawnedAtEpochMs: 200, outputByteOffset: 300 };
			const state = new HostedSessionTerminalModeStateTracker().readReplayState();
			if (!state) throw new Error("初始模式未知");
			expect(
				readHostedSessionTerminalModeCheckpointForReplay({
					...identity,
					checkpoint: { schemaVersion: 1, ...identity, ...state, parserContinuationHex },
				}),
			).toBeUndefined();
		},
	);

	it("超长未终止字符串保持有界，且正文中的假模式不被接受", () => {
		const tracker = new HostedSessionTerminalModeStateTracker();
		tracker.applyOutput(Buffer.from(`\u001b]0;${"x".repeat(2 * 1024 * 1024)}[?1049h`));
		expect(tracker.readReplayState()).toMatchObject({ terminalModes: { alternateScreenActive: false } });
		expect(tracker.readReplayState()?.parserContinuationHex.length).toBeLessThan(32);
	});

	it("任意重放切点都能续接 CSI、OSC、DCS 和 UTF-8，且不会把字符串正文解析成模式", () => {
		const bytes = Buffer.from(
			"\u001b[?1049;1002;1006;2004;1004h中文\u001b]0;标题[?1003h\u0007\u001bPq假模式\u001b\\\u001b[?1002;1006l",
		);
		const source = new HostedSessionTerminalModeStateTracker();
		source.applyOutput(bytes);
		for (let cut = 1; cut < bytes.length; cut++) {
			const ring = new HostedSessionOutputRingBufferWithAbsoluteByteOffsets(bytes.length - cut);
			for (const byte of bytes) ring.append(Buffer.from([byte]));
			const state = ring.readTerminalModeStateAtAbsoluteByteOffset(cut);
			if (!state) throw new Error(`切点 ${cut} 模式未知`);
			const restored = new HostedSessionTerminalModeStateTracker();
			restored.applyOutput(serializeHostedSessionTerminalModes(state.terminalModes));
			restored.applyOutput(Buffer.from(state.parserContinuationHex, "hex"));
			restored.applyOutput(ring.readFromAbsoluteByteOffset(cut).bytes);
			expect(restored.readReplayState()?.terminalModes, `切点 ${cut}`).toEqual(
				source.readReplayState()?.terminalModes,
			);
		}
	});

	it.each(["hostedSessionKey", "pid", "spawnedAtEpochMs", "outputByteOffset", "schemaVersion"] as const)(
		"拒绝绑定不匹配的 %s，同时保持旧 host 可缺省",
		(field) => {
			const tracker = new HostedSessionTerminalModeStateTracker();
			const state = tracker.readReplayState();
			if (!state) throw new Error("初始模式未知");
			const identity = { hostedSessionKey: "hosted-1", pid: 100, spawnedAtEpochMs: 200, outputByteOffset: 300 };
			const checkpoint = { schemaVersion: 1 as const, ...identity, ...state };
			expect(readHostedSessionTerminalModeCheckpointForReplay({ ...identity, checkpoint })).toEqual(state);
			expect(
				readHostedSessionTerminalModeCheckpointForReplay({ ...identity, checkpoint: undefined }),
			).toBeUndefined();
			expect(
				readHostedSessionTerminalModeCheckpointForReplay({
					...identity,
					checkpoint: { ...checkpoint, [field]: field === "hostedSessionKey" ? "other" : -1 },
				}),
			).toBeUndefined();
		},
	);
});
