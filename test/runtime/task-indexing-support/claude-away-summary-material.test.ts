import { describe, expect, it } from "vitest";
import { readClaudeAwaySummaryFromExistingTranscriptLine } from "../../../src/task-indexing-support/collect-task-indexing-materials";

describe("复用 Claude 已有 away summary", () => {
	it("读取原生 system/away_summary 的 content，忽略侧链与正文提到的同名词", () => {
		expect(
			readClaudeAwaySummaryFromExistingTranscriptLine(
				JSON.stringify({
					type: "system",
					subtype: "away_summary",
					content: "已经实现核心，仍待验收。",
					isSidechain: false,
				}),
			),
		).toBe("已经实现核心，仍待验收。");
		expect(
			readClaudeAwaySummaryFromExistingTranscriptLine(
				JSON.stringify({ type: "system", subtype: "away_summary", content: "分身的结论", isSidechain: true }),
			),
		).toBeNull();
		expect(
			readClaudeAwaySummaryFromExistingTranscriptLine(
				JSON.stringify({ type: "assistant", message: { content: "代码含有 away_summary 字样" } }),
			),
		).toBeNull();
	});
});
