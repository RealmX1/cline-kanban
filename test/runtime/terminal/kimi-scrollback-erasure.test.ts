import { describe, expect, it } from "vitest";
import { shouldSuppressTerminalScrollbackErasureForAgentLaunch } from "../../../src/terminal/session-manager";
import {
	createTerminalProtocolFilterState,
	filterTerminalProtocolOutput,
} from "../../../src/terminal/terminal-protocol-filter";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

describe("Kimi regular TUI 全历史重绘", () => {
	it("多次 resize 和历史区域重绘都替换旧历史，分块 CSI 也保留清历史语义", async () => {
		const filter = createTerminalProtocolFilterState({
			suppressScrollbackErasure: shouldSuppressTerminalScrollbackErasureForAgentLaunch("kimi", []),
		});
		const mirror = new TerminalStateMirror(80, 8);
		const history = Array.from({ length: 60 }, (_, index) => `kimi-history-${index}`).join("\r\n");
		try {
			for (const [cols, rows] of [
				[80, 8],
				[75, 10],
				[90, 6],
				[80, 8],
			]) {
				mirror.resize(cols, rows);
				for (const part of ["\u001b[?2026h\u001b[2J\u001b[H\u001b[", `3J${history}\r\ncomposer\u001b[?2026l`]) {
					mirror.applyOutput(filterTerminalProtocolOutput(filter, Buffer.from(part)));
				}
				const snapshot = await mirror.getSnapshot();
				expect(snapshot.snapshot.split("kimi-history-0")).toHaveLength(2);
				// 重连消费者先 reset 再写 snapshot，与持久终端管理器恢复流程相同。
				const restoredMirror = new TerminalStateMirror(cols, rows);
				try {
					restoredMirror.applyOutput(Buffer.from(snapshot.snapshot));
					expect((await restoredMirror.getSnapshot()).snapshot.split("kimi-history-0")).toHaveLength(2);
				} finally {
					restoredMirror.dispose();
				}
			}
		} finally {
			mirror.dispose();
		}
	});
	it("其他 harness 的既有保护策略不变", () => {
		expect(shouldSuppressTerminalScrollbackErasureForAgentLaunch("claude", [])).toBe(true);
		expect(shouldSuppressTerminalScrollbackErasureForAgentLaunch("omp", [])).toBe(true);
		expect(shouldSuppressTerminalScrollbackErasureForAgentLaunch("codex", [])).toBe(true);
		expect(shouldSuppressTerminalScrollbackErasureForAgentLaunch("codex", ["--no-alt-screen"])).toBe(false);
	});
});
