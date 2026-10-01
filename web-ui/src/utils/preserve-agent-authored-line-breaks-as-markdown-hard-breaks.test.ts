import { describe, expect, it } from "vitest";

import { preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks } from "@/utils/preserve-agent-authored-line-breaks-as-markdown-hard-breaks";

describe("preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks", () => {
	it("列表后紧跟的立场行改为硬换行，不再被惰性续行并进最后一个要点", () => {
		expect(
			preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks("主审范围不变：\n- 补测试\n- 只读\n⚖️ 维度立场：完整性=高"),
		).toBe("主审范围不变：  \n- 补测试  \n- 只读  \n⚖️ 维度立场：完整性=高");
	});

	it("空行（段落分隔）与末行不加硬换行", () => {
		expect(preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks("第一段\n\n第二段\n")).toBe("第一段\n\n第二段\n");
	});

	it("代码块内的每一行原样保留", () => {
		const text = "看这段：\n```\nconst a = 1;\nconst b = 2;\n```\n结束";
		expect(preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks(text)).toBe(
			"看这段：  \n```\nconst a = 1;\nconst b = 2;\n```\n结束",
		);
	});
});
