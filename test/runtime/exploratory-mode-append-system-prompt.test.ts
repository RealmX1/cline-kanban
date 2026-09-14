import { beforeEach, describe, expect, it, vi } from "vitest";

const exploratoryModeInstructionsMocks = vi.hoisted(() => ({
	ensureExploratoryModeInstructionsFile: vi.fn(),
}));

vi.mock("../../src/state/exploratory-mode-instructions.js", () => ({
	ensureExploratoryModeInstructionsFile: exploratoryModeInstructionsMocks.ensureExploratoryModeInstructionsFile,
}));

import { resolveExploratoryModeAppendSystemPrompt } from "../../src/prompts/exploratory-mode-append-system-prompt";

describe("resolveExploratoryModeAppendSystemPrompt", () => {
	beforeEach(() => {
		exploratoryModeInstructionsMocks.ensureExploratoryModeInstructionsFile.mockReset();
	});

	it("非 exploratory 启动（operational / 缺省）不物化指令文件、不注入", async () => {
		expect(await resolveExploratoryModeAppendSystemPrompt("operational")).toBeNull();
		expect(await resolveExploratoryModeAppendSystemPrompt(undefined)).toBeNull();
		expect(exploratoryModeInstructionsMocks.ensureExploratoryModeInstructionsFile).not.toHaveBeenCalled();
	});

	it("exploratory 启动渲染指向指令文件绝对路径的注入段", async () => {
		exploratoryModeInstructionsMocks.ensureExploratoryModeInstructionsFile.mockResolvedValue(
			"/Users/example/.cline/kanban/agent-exploratory-mode-instructions/exploratory-mode-session-map.md",
		);

		const rendered = await resolveExploratoryModeAppendSystemPrompt("exploratory");

		expect(rendered).toContain(
			"`/Users/example/.cline/kanban/agent-exploratory-mode-instructions/exploratory-mode-session-map.md`",
		);
		expect(exploratoryModeInstructionsMocks.ensureExploratoryModeInstructionsFile).toHaveBeenCalledTimes(1);
	});

	it("指令文件物化失败 ⇒ 退化为 null（不阻断会话启动）", async () => {
		exploratoryModeInstructionsMocks.ensureExploratoryModeInstructionsFile.mockRejectedValue(
			new Error("disk is read-only"),
		);

		expect(await resolveExploratoryModeAppendSystemPrompt("exploratory")).toBeNull();
	});
});
