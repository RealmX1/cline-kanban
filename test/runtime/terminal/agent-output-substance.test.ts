import { describe, expect, it } from "vitest";

import {
	createAgentOutputSubstanceMemory,
	detectFreshSubstantiveAgentOutput,
	extractAgentOutputContentSignatures,
	isSubstantiveAgentOutput,
} from "../../../src/terminal/agent-output-substance";

// 真实 Claude/Codex TUI 帧的代表性样本（含 \r 重绘前缀与 ANSI SGR，验证 stripAnsiAndControl 前置生效）。
// spinner / footer / 框线属装饰性重绘 → 非实质；assistant / 工具 / 报错文本属实质产出。
const SGR = "[38;5;213m";
const RESET = "[0m";

describe("isSubstantiveAgentOutput（无状态：chrome 掩码语义）", () => {
	describe("装饰性重绘 → false", () => {
		it("spinner 状态行（sparkle 字形 + 计时器 + esc to interrupt，带 \\r 与 ANSI）", () => {
			expect(isSubstantiveAgentOutput(`\r${SGR}✻${RESET} Cogitating… (12s · esc to interrupt)`)).toBe(false);
		});

		it("spinner 状态行（带 token 计量）", () => {
			expect(isSubstantiveAgentOutput("✶ Herding… (8s · ↑ 1.2k tokens · esc to interrupt)")).toBe(false);
		});

		it("早期 spinner 帧（仅 sparkle 字形 + 动词，无计时器 / esc to interrupt）", () => {
			expect(isSubstantiveAgentOutput("✻ Cogitating…")).toBe(false);
		});

		it("braille 进度 spinner", () => {
			expect(isSubstantiveAgentOutput("⠋ Loading project context")).toBe(false);
		});

		it("独立 token 计量行", () => {
			expect(isSubstantiveAgentOutput("↑ 1.2k tokens")).toBe(false);
		});

		it("独立费用计量行", () => {
			expect(isSubstantiveAgentOutput("$0.42")).toBe(false);
		});

		it("auto-compact 上下文余量 footer", () => {
			expect(isSubstantiveAgentOutput("Context left until auto-compact: 23%")).toBe(false);
		});

		it("纯框线行", () => {
			expect(isSubstantiveAgentOutput("╭──────────────────────────────────────╮")).toBe(false);
		});

		it("空输入框行（框线 + 空 `>` 提示符）", () => {
			expect(isSubstantiveAgentOutput("│ >                                    │")).toBe(false);
		});

		it("多行纯 chrome（框线 + spinner + 计量，无任何正文）", () => {
			const frame = [
				"╭──────────────────────────────────────╮",
				"│ >                                    │",
				"╰──────────────────────────────────────╯",
				"✻ Schlepping… (46s · esc to interrupt)",
			].join("\r\n");
			expect(isSubstantiveAgentOutput(frame)).toBe(false);
		});

		it("纯空白 / 空 chunk", () => {
			expect(isSubstantiveAgentOutput("")).toBe(false);
			expect(isSubstantiveAgentOutput("   \r\n   \n")).toBe(false);
		});
	});

	describe("实质产出 → true", () => {
		it("assistant 正文行（前缀 ⏺，绝不被当作 spinner）", () => {
			expect(isSubstantiveAgentOutput("⏺ I'll start by reading the config file.")).toBe(true);
		});

		it("工具调用行", () => {
			expect(isSubstantiveAgentOutput("⏺ Bash(npm test)")).toBe(true);
		});

		it("工具结果行（前缀 ⎿）", () => {
			expect(isSubstantiveAgentOutput("⎿  Running 42 tests across 6 files")).toBe(true);
		});

		it("报错文本", () => {
			expect(isSubstantiveAgentOutput("Error: cannot find module 'foo'")).toBe(true);
		});

		it("markdown 列表项（前缀 `*`，不被 spinner 误杀）", () => {
			expect(isSubstantiveAgentOutput("* first bullet point")).toBe(true);
		});

		it("markdown 引用行（前缀 `>`，不被 chrome-only 误杀）", () => {
			expect(isSubstantiveAgentOutput("> quoted user text")).toBe(true);
		});

		it("混合 chunk：spinner 重绘 + 同 chunk 新正文 → true", () => {
			const chunk = "\r✻ Cogitating… (3s · esc to interrupt)\n⏺ Now editing the file.";
			expect(isSubstantiveAgentOutput(chunk)).toBe(true);
		});
	});

	it("extractAgentOutputContentSignatures 只回内容行、剔 chrome、归一化为小写折空白签名", () => {
		const chunk = ["✻ Cogitating… (1s · esc to interrupt)", "⏺   Reading    THE   File", "╰────╯"].join("\n");
		expect(extractAgentOutputContentSignatures(chunk)).toEqual(["⏺ reading the file"]);
	});
});

describe("detectFreshSubstantiveAgentOutput（带记忆：内容行新鲜度）", () => {
	it("同一实质内容行重复 → 首次 true、再现 false（抑制周期重绘）", () => {
		const memory = createAgentOutputSubstanceMemory();
		const line = "⏺ Applying the patch to session-manager.ts";
		expect(detectFreshSubstantiveAgentOutput(memory, line)).toBe(true);
		expect(detectFreshSubstantiveAgentOutput(memory, line)).toBe(false);
		expect(detectFreshSubstantiveAgentOutput(memory, line)).toBe(false);
	});

	it("持续出现不同新正文 → 每次 true（真在流式产出）", () => {
		const memory = createAgentOutputSubstanceMemory();
		expect(detectFreshSubstantiveAgentOutput(memory, "⏺ First reasoning step.")).toBe(true);
		expect(detectFreshSubstantiveAgentOutput(memory, "⏺ Second reasoning step.")).toBe(true);
		expect(detectFreshSubstantiveAgentOutput(memory, "⏺ Third reasoning step.")).toBe(true);
	});

	it("混合 chunk：含至少一条新内容行即 true（即使另有已见过的行）", () => {
		const memory = createAgentOutputSubstanceMemory();
		expect(detectFreshSubstantiveAgentOutput(memory, "⏺ Shared footer-ish line.")).toBe(true);
		const mixed = "⏺ Shared footer-ish line.\n⏺ Brand new content line.";
		expect(detectFreshSubstantiveAgentOutput(memory, mixed)).toBe(true);
	});

	it("内容不变、周期重绘的静态行（如模式指示器）→ 仅首次 true", () => {
		const memory = createAgentOutputSubstanceMemory();
		const modeIndicator = "⏵⏵ accept edits on (shift+tab to cycle)";
		expect(detectFreshSubstantiveAgentOutput(memory, modeIndicator)).toBe(true);
		expect(detectFreshSubstantiveAgentOutput(memory, modeIndicator)).toBe(false);
	});

	it("spinner 空转：无论重复多少次都 → false（spinner 行从不进入内容记忆）", () => {
		const memory = createAgentOutputSubstanceMemory();
		for (let elapsed = 1; elapsed <= 5; elapsed++) {
			const spinnerFrame = `\r✻ Cogitating… (${elapsed}s · esc to interrupt)`;
			expect(detectFreshSubstantiveAgentOutput(memory, spinnerFrame)).toBe(false);
		}
	});

	it("记忆 FIFO 上限：被淘汰的旧内容行再现时重新判为 fresh", () => {
		const memory = createAgentOutputSubstanceMemory();
		const oldest = "⏺ content line number 0";
		expect(detectFreshSubstantiveAgentOutput(memory, oldest)).toBe(true);
		// 灌入 64 条全新内容行（上限 64），把 oldest 挤出记忆。
		for (let i = 1; i <= 64; i++) {
			expect(detectFreshSubstantiveAgentOutput(memory, `⏺ content line number ${i}`)).toBe(true);
		}
		// oldest 已被淘汰 → 再现重新判为 fresh。
		expect(detectFreshSubstantiveAgentOutput(memory, oldest)).toBe(true);
	});
});
