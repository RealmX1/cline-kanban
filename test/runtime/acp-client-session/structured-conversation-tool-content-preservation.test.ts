import { describe, expect, it } from "vitest";
import { createAcpTaskSessionEntry } from "../../../src/acp-client-session/acp-session-state";
import { applyAcpSessionUpdate } from "../../../src/acp-client-session/acp-session-update-adapter";

describe("结构化工具事件保真", () => {
	it("保留原始输入、输出和 diff，增量状态不擦除已有字段", () => {
		const entry = createAcpTaskSessionEntry("comparison-session", "codex");
		const context = {
			taskId: "comparison-session",
			agentId: "codex" as const,
			pid: 42,
			entry,
			isReplayingPersistedConversationHistory: true,
			emitSummary() {},
			emitMessage() {},
		};
		const rawInput = { command: "echo '```'", arguments: ["中文", "\n"] };
		const content = [{ type: "diff" as const, path: "/workspace/a.ts", oldText: "before", newText: "after" }];
		applyAcpSessionUpdate(context, {
			sessionId: "native-session",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "tool-1",
				title: "修改文件",
				kind: "edit",
				rawInput,
				content,
			},
		});
		applyAcpSessionUpdate(context, {
			sessionId: "native-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: "completed",
				rawOutput: { ok: true },
			},
		});
		expect(entry.messages).toHaveLength(1);
		expect(entry.messages[0]?.meta?.structuredToolCall).toMatchObject({ rawInput, rawOutput: { ok: true }, content });
	});
	it("按 ACP 扩展的增量语义拼接终端输出，保留超过摘要预算的尾部", () => {
		const entry = createAcpTaskSessionEntry("comparison-session", "codex");
		const context = {
			taskId: "comparison-session",
			agentId: "codex" as const,
			pid: 42,
			entry,
			isReplayingPersistedConversationHistory: true,
			emitSummary() {},
			emitMessage() {},
		};
		applyAcpSessionUpdate(context, {
			sessionId: "native-session",
			update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "读取文件" },
		});
		for (const data of ["x".repeat(6000), "完整尾部"])
			applyAcpSessionUpdate(context, {
				sessionId: "native-session",
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "tool-1",
					_meta: { terminal_output_delta: { data } },
				},
			});
		expect(entry.messages[0]?.meta?.structuredToolCall?.terminalOutputText).toBe(`${"x".repeat(6000)}完整尾部`);
	});
});
