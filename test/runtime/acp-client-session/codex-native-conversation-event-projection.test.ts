import { describe, expect, it } from "vitest";
import { projectCodexNativeNotification } from "../../../src/agent-conversation/codex-native-conversation-event-projection";

describe("Codex 原生事件投影", () => {
	it("按原生 item 分组，拒绝旁支事件", () => {
		expect(
			projectCodexNativeNotification("thread-1", "item/agentMessage/delta", {
				threadId: "thread-2",
				itemId: "item-1",
				delta: "旁支",
			}),
		).toEqual([]);
		expect(
			projectCodexNativeNotification("thread-1", "item/agentMessage/delta", {
				threadId: "thread-1",
				itemId: "item-1",
				delta: "中文\n```",
			})[0]?.update,
		).toMatchObject({ sessionUpdate: "agent_message_chunk", messageId: "item-1", content: { text: "中文\n```" } });
	});
	it("工具完成保留完整原生输入输出，不受展示截断预算影响", () => {
		const item = {
			id: "tool-1",
			type: "commandExecution",
			command: "cat a.ts",
			cwd: "/work",
			status: "completed",
			aggregatedOutput: "x".repeat(9000),
		};
		expect(
			projectCodexNativeNotification("thread-1", "item/completed", { threadId: "thread-1", item })[0]?.update,
		).toMatchObject({ sessionUpdate: "tool_call", rawInput: { command: "cat a.ts" }, rawOutput: item });
	});
	it("未知原生事件不伪装为完成或消息接受", () => {
		expect(projectCodexNativeNotification("thread-1", "thread/tokenUsage/updated", { threadId: "thread-1" })).toEqual(
			[],
		);
	});
});
