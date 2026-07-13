import { describe, expect, it } from "vitest";

import { shouldSuppressTerminalScrollbackErasureForAgentLaunch } from "../../../src/terminal/session-manager";
import {
	createTerminalProtocolFilterState,
	filterTerminalProtocolOutput,
} from "../../../src/terminal/terminal-protocol-filter";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

// Regression for the Codex "inline transcript opt-in" path.
//
// Codex 默认跑原生 alt-screen（原地重绘、不堆 scrollback），无此问题。但用户仍可显式传
// --no-alt-screen 让 Codex 走 inline transcript opt-in——该模式下 Codex 每次 resize (SIGWINCH) 发
//   ESC[r ESC[0m ESC[H ESC[2J ESC[3J ESC[H <整段重印>
// 即整屏清除（screen + scrollback）后重印整段对话（已抓 codex-cli 0.142.5 真实 PTY 字节确认）。
//
// 只有该 opt-in 路径需要放行 ESC[3J：若 filter 抑制掉 ESC[3J，旧 scrollback 永不清除，重印会叠加在
// 旧历史下面（可见翻倍），server mirror 只增不清、每次 restore 全量重放。
// shouldSuppressTerminalScrollbackErasureForAgentLaunch 对「codex + 显式 --no-alt-screen」返回 false
// （放行 CSI 3 J，让重印干净 REPLACE），对默认路径返回 true（抑制、保护 Kanban 历史）。

const esc = String.fromCharCode(0x1b);

// Codex 真实 resize 重印：重置滚动区/属性、home、清屏、清 scrollback、重印。
function codexResizeRepaint(transcript: string): string {
	return `${esc}[r${esc}[0m${esc}[H${esc}[2J${esc}[3J${esc}[H${transcript}`;
}

async function firstLineOccurrencesInMirror(
	agentId: "codex" | "claude",
	commandArgs: readonly string[],
	initial: string,
	repaint: string,
): Promise<number> {
	// Build the filter exactly as session-manager does for a task agent session.
	const filter = createTerminalProtocolFilterState({
		interceptOscColorQueries: true,
		suppressScrollbackErasure: shouldSuppressTerminalScrollbackErasureForAgentLaunch(agentId, commandArgs),
	});
	const mirror = new TerminalStateMirror(80, 6);
	try {
		mirror.applyOutput(filterTerminalProtocolOutput(filter, Buffer.from(initial, "utf8")));
		mirror.applyOutput(filterTerminalProtocolOutput(filter, Buffer.from(repaint, "utf8")));
		const { snapshot } = await mirror.getSnapshot();
		return snapshot.split("turn-line-001").length - 1;
	} finally {
		mirror.dispose();
	}
}

describe("Codex inline (--no-alt-screen opt-in) scrollback erasure", () => {
	// A transcript tall enough that its first lines scroll off the 6-row viewport into scrollback.
	const tallTranscript = Array.from(
		{ length: 40 },
		(_, index) => `turn-line-${String(index + 1).padStart(3, "0")}`,
	).join("\r\n");
	const repaint = codexResizeRepaint(`${tallTranscript}\r\ncomposer`);

	it("keeps the Codex mirror bounded under explicit --no-alt-screen — the resize reprint REPLACES, it does not stack", async () => {
		const occurrences = await firstLineOccurrencesInMirror("codex", ["--no-alt-screen"], tallTranscript, repaint);
		expect(occurrences).toBe(1);
	});

	it("documents why the opt-in disables suppression: with CSI 3 J suppressed (the default) the reprint would stack a duplicate", async () => {
		const occurrences = await firstLineOccurrencesInMirror("codex", [], tallTranscript, repaint);
		expect(occurrences).toBeGreaterThanOrEqual(2);
	});
});
