// 终端作答原文解析：标签本身含「, 」时不得被拆碎；拼不出标签的片段才算自由回答。
import { describe, expect, it } from "vitest";

import { splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText } from "../../../src/core/agent-terminal-multi-select-answer-text-parsing";

const OPTION_LABELS_WITH_COMMA_INSIDE_ONE_LABEL = ["读写分离, 带缓存", "用 ORM", "自建 SQL"];

describe("splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText", () => {
	it("多选里有一个标签本身含「, 」：整体识别为一个标签，不再拆碎成自由回答", () => {
		expect(
			splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
				"读写分离, 带缓存, 用 ORM",
				OPTION_LABELS_WITH_COMMA_INSIDE_ONE_LABEL,
			),
		).toEqual({ selectedOptionLabels: ["读写分离, 带缓存", "用 ORM"], freeformAnswerText: null });
	});

	it("单选整段即标签", () => {
		expect(
			splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
				"读写分离, 带缓存",
				OPTION_LABELS_WITH_COMMA_INSIDE_ONE_LABEL,
			),
		).toEqual({ selectedOptionLabels: ["读写分离, 带缓存"], freeformAnswerText: null });
	});

	it("标签与手打的「Other」文字混在一起：只有拼不出标签的片段归入自由回答", () => {
		expect(
			splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
				"自建 SQL, 先做读路径, 再说",
				OPTION_LABELS_WITH_COMMA_INSIDE_ONE_LABEL,
			),
		).toEqual({ selectedOptionLabels: ["自建 SQL"], freeformAnswerText: "先做读路径, 再说" });
	});

	it("完全对不上任何标签：整段是自由回答", () => {
		expect(
			splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
				"都不要",
				OPTION_LABELS_WITH_COMMA_INSIDE_ONE_LABEL,
			),
		).toEqual({ selectedOptionLabels: [], freeformAnswerText: "都不要" });
	});

	it("较短标签是较长标签的前缀时优先拼出较长的那个", () => {
		expect(
			splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText("A, B, C", ["A", "A, B", "C"]),
		).toEqual({ selectedOptionLabels: ["A, B", "C"], freeformAnswerText: null });
	});
});
