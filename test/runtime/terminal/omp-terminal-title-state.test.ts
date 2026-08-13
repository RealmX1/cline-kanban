// omp 把会话状态编码进 OSC 终端标题；Kanban 的 omp PTY 会话状态判定全靠解析它。
// 三条要钉住的东西：三态映射正确、一批输出里多次写入取最后一个、spinner 帧不污染正文
// （经 stripAnsiAndControl 后不留痕 ⇒ 不会把「agent 上次响应」刷成刚刚）。
import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	detectOmpTerminalTitleStateTransition,
	parseOmpTerminalTitleState,
	readLatestOmpTerminalTitleState,
} from "../../../src/terminal/omp-terminal-title-state";
import { stripAnsiAndControl } from "../../../src/terminal/terminal-output-normalization";

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);

function writeOscTerminalTitle(title: string): string {
	return `${ESCAPE}]0;${title}${BELL}`;
}

// 探测器不读 summary（omp 的标题本身已带完整状态），给个最小占位即可。
const ANY_SUMMARY = { taskId: "task-omp" } as unknown as RuntimeTaskSessionSummary;

describe("omp terminal title state", () => {
	it("maps the three run-state separators", () => {
		expect(parseOmpTerminalTitleState("π > kanban")).toBe("idle");
		expect(parseOmpTerminalTitleState("π ! kanban")).toBe("attention");
		expect(parseOmpTerminalTitleState("π ⠋ kanban")).toBe("working");
		// Windows 上 omp 不做标题动画，working 是静态冒号分隔符。
		expect(parseOmpTerminalTitleState("π : kanban")).toBe("working");
		// 无标签时分隔符紧跟品牌，状态照样可读。
		expect(parseOmpTerminalTitleState("π >")).toBe("idle");
	});

	it("accepts every spinner frame omp animates through", () => {
		for (const frame of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
			expect(parseOmpTerminalTitleState(`π ${frame} kanban`)).toBe("working");
		}
	});

	// `tui.titleState` 关掉时 omp 写的是 `π: label`（冒号紧贴品牌，无空格）。它不带状态信息，
	// 必须被忽略而不是误读成 Windows 的 working——否则一个关了该设置的用户会看到卡片恒在 In Progress。
	it("ignores the stateless title emitted when tui.titleState is off", () => {
		expect(parseOmpTerminalTitleState("π: kanban")).toBeNull();
		expect(parseOmpTerminalTitleState("π")).toBeNull();
		expect(parseOmpTerminalTitleState("some other program")).toBeNull();
	});

	it("takes the last title in a batch that contains several writes", () => {
		const batch = [
			writeOscTerminalTitle("π ⠋ kanban"),
			"some agent output\n",
			writeOscTerminalTitle("π ⠙ kanban"),
			writeOscTerminalTitle("π > kanban"),
		].join("");
		expect(readLatestOmpTerminalTitleState(batch)).toBe("idle");
	});

	it("ignores an unterminated trailing sequence split across chunk boundaries", () => {
		const batch = `${writeOscTerminalTitle("π > kanban")}${ESCAPE}]0;π ⠋ kan`;
		expect(readLatestOmpTerminalTitleState(batch)).toBe("idle");
	});

	it("turns the three states into the right session transitions", () => {
		expect(detectOmpTerminalTitleStateTransition(writeOscTerminalTitle("π ⠋ kanban"), ANY_SUMMARY)).toEqual({
			type: "hook.to_in_progress",
		});
		expect(detectOmpTerminalTitleStateTransition(writeOscTerminalTitle("π > kanban"), ANY_SUMMARY)).toEqual({
			type: "hook.to_review",
			reviewReason: "hook",
		});
		expect(detectOmpTerminalTitleStateTransition(writeOscTerminalTitle("π ! kanban"), ANY_SUMMARY)).toEqual({
			type: "hook.to_review",
			reviewReason: "hook",
			userTurnKindOverride: "needs_input",
		});
		expect(detectOmpTerminalTitleStateTransition("plain agent output\n", ANY_SUMMARY)).toBeNull();
	});

	// 承重前提：spinner 每 80ms 写一次标题，但那不是 agent 产出。正文经 stripAnsiAndControl 的 osc
	// 模式剥除后必须不留痕，否则「agent 上次响应」会被动画刷成刚刚。
	it("leaves nothing behind in the analysed text after stripping", () => {
		const batch = `${writeOscTerminalTitle("π ⠋ kanban")}${writeOscTerminalTitle("π ⠙ kanban")}`;
		expect(stripAnsiAndControl(batch)).toBe("");
		expect(stripAnsiAndControl(`before${writeOscTerminalTitle("π > kanban")}after`)).toBe("beforeafter");
	});
});
