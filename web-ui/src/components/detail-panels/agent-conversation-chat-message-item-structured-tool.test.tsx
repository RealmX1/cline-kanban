import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AgentConversationChatMessageItem } from "./agent-conversation-chat-message-item";

describe("结构化工具完整内容", () => {
	it("折叠只改变显示，展开保留终端尾部与原始输入中的围栏", async () => {
		const terminalOutputText = `${"完整内容\n".repeat(1000)}尾部哨兵`;
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<AgentConversationChatMessageItem
						message={{
							id: "tool-1",
							role: "tool",
							content: "截断摘要",
							createdAt: 1,
							meta: {
								toolName: "exec_command",
								toolCallStatus: "completed",
								structuredToolCall: { rawInput: { command: "echo '```'" }, terminalOutputText },
							},
						}}
					/>,
				),
			);
			expect(container.textContent).not.toContain("尾部哨兵");
			await act(async () => container.querySelector("button")?.click());
			expect(container.textContent).toContain(terminalOutputText);
			expect(container.textContent).toContain("```");
		} finally {
			await act(async () => root.unmount());
		}
	});
});
