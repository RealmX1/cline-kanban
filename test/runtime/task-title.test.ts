import { describe, expect, it } from "vitest";

import {
	DEFAULT_TASK_TITLE_MAX_CHARS,
	deriveTaskTitleFromPrompt,
	resolveTaskTitle,
} from "../../src/core/task-title.js";

describe("task title helpers", () => {
	it("结构化任务正文继续从首个有内容的行生成兜底标题，显式标题保持优先", () => {
		const prompt = [
			'<task-initial-prompt schema-version="1">',
			'  <task-original-user-request request-id="request-1" source-reference="synthetic:request-1">',
			"先调查并提出方案，等批准后实施。",
			"  </task-original-user-request>",
			"</task-initial-prompt>",
		].join("\n");
		expect(deriveTaskTitleFromPrompt(prompt)).toBe("先调查并提出方案，等批准后实施。");
		expect(resolveTaskTitle("[RESEARCH]调查登录问题", prompt)).toBe("[RESEARCH]调查登录问题");
	});
	it("derives a title from the first non-empty prompt line", () => {
		expect(deriveTaskTitleFromPrompt("\n\nImplement editable task titles\nWith prompt details")).toBe(
			"Implement editable task titles",
		);
	});

	it("prefers the first sentence on the first non-empty line", () => {
		expect(deriveTaskTitleFromPrompt("Implement editable task titles. Also add a regenerate button.")).toBe(
			"Implement editable task titles.",
		);
	});

	it("prefers an explicit title when present", () => {
		expect(resolveTaskTitle("  Custom title  ", "Prompt body")).toBe("Custom title");
	});

	it("strips user_input wrapper tags from an explicit stored title", () => {
		expect(resolveTaskTitle('<user_input mode="act">Fix the login bug</user_input>', "Prompt body")).toBe(
			"Fix the login bug",
		);
	});

	it("strips a leading user_input tag from an explicit stored title", () => {
		expect(resolveTaskTitle('<user_input mode="act">Fix the login bug', "Prompt body")).toBe("Fix the login bug");
	});

	it("falls back to the prompt when explicit title only contains user_input wrapper tags", () => {
		expect(resolveTaskTitle('<user_input mode="act"></user_input>', "Prompt body")).toBe("Prompt body");
	});

	it("falls back to the prompt when the title is blank", () => {
		expect(resolveTaskTitle("   ", "Prompt body")).toBe("Prompt body");
	});

	it("does not alter explicit titles that contain XML-like text in the middle", () => {
		expect(resolveTaskTitle("Investigate React <Component> rendering", "Prompt body")).toBe(
			"Investigate React <Component> rendering",
		);
	});

	it("strips a leading XML tag when deriving from a prompt", () => {
		expect(deriveTaskTitleFromPrompt('<user_input mode="act">Fix the login bug\nWith extra details')).toBe(
			"Fix the login bug",
		);
	});

	it("strips both leading and trailing XML tags on a single-line prompt", () => {
		expect(deriveTaskTitleFromPrompt('<user_input mode="act">Fix the login bug</user_input>')).toBe(
			"Fix the login bug",
		);
	});

	it("handles a prompt that is only an XML tag", () => {
		expect(deriveTaskTitleFromPrompt("<user_input>")).toBe("");
	});

	it("truncates an over-long first line with an ellipsis at the configured limit", () => {
		const overLongLine = "x".repeat(DEFAULT_TASK_TITLE_MAX_CHARS + 20);
		const derived = deriveTaskTitleFromPrompt(overLongLine);
		expect(derived).toBe(`${"x".repeat(DEFAULT_TASK_TITLE_MAX_CHARS)}…`);
		expect(derived).toHaveLength(DEFAULT_TASK_TITLE_MAX_CHARS + 1);
	});

	it("collapses runs of whitespace inside the derived title", () => {
		expect(deriveTaskTitleFromPrompt("  Fix   the\t\tlogin   bug  ")).toBe("Fix the login bug");
	});

	it("keeps deriving from the first non-empty line when that line has real content", () => {
		// 逐行扫描是为裸标签首行加的；首行本就有正文时结果必须与逐行扫描之前逐字节一致。
		expect(deriveTaskTitleFromPrompt("Real first line\n<trajectory>\nignored")).toBe("Real first line");
	});

	// 伪 HTML 块插入按钮上线后，「描述以 <trajectory> 独占一行开头」会变成常态。
	// 老实现在这里返回 ""，而 web-ui 的 normalizeCard 会把空标题兜成整份 prompt。
	it("skips a bare pseudo HTML opening tag line and derives from the first line with content", () => {
		expect(deriveTaskTitleFromPrompt("<trajectory>\nInvestigate the flaky login test\n</trajectory>")).toBe(
			"Investigate the flaky login test",
		);
	});

	it("skips several consecutive bare tag lines", () => {
		expect(deriveTaskTitleFromPrompt("<question>\n</question>\n<answer>\nUse a retry budget\n</answer>")).toBe(
			"Use a retry budget",
		);
	});

	it("still returns an empty title when every line is a bare tag", () => {
		expect(deriveTaskTitleFromPrompt("<trajectory>\n\n</trajectory>")).toBe("");
	});
});
