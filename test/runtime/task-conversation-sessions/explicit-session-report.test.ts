import { describe, expect, it } from "vitest";
import { parseExplicitTaskConversationSessionReport } from "../../../src/task-conversation-sessions/explicit-session-report";

const report = '<kanban-session-report>\n{"text":"检查完成"}\n</kanban-session-report>';

describe("只读侧会话的显式可选回报", () => {
	it("只接受回答末尾的独立结构块", () => {
		expect(parseExplicitTaskConversationSessionReport(`结论。\n\n${report}`)).toEqual({ text: "检查完成" });
		expect(parseExplicitTaskConversationSessionReport("普通回答")).toBeNull();
		expect(parseExplicitTaskConversationSessionReport(`${report}\n后面还有正文`)).toBeNull();
	});
	it("排除代码示例、引用和非法目标，不从工具内容提取报告", () => {
		for (const text of [
			`\`\`\`xml\n${report}\n\`\`\``,
			`> ${report}`,
			`<kanban-session-report>\n{"text":""}\n</kanban-session-report>`,
		]) {
			expect(parseExplicitTaskConversationSessionReport(text)).toBeNull();
		}
	});
});
