// 「这条聊天消息此刻还在动吗」的判定。会话面板同时渲染两条通道的消息（进程内 Cline SDK 与 ACP），
// 而两条通道把「进行中」写在**不同的 meta 字段**上：
//   Cline SDK  —— hookEventName（"tool_call_start" / "reasoning_delta"，见 cline-session-state.ts）
//   ACP        —— toolCallStatus（协议自带的 ToolCallStatus）与 streamType（见 acp-session-state.ts）
// 组件直接读某一侧的字段，另一侧就静默地永远不转圈 / 思考块永不自动展开——这正是 ACP 会话上
// 曾经发生的事。把两套标记收敛到这里的两个谓词，新增通道时只改这一个文件。
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";

// Cline SDK 在工具开始时写、完成时改写的标记。
const CLINE_TOOL_CALL_STARTED_HOOK_EVENT_NAME = "tool_call_start";
// Cline SDK 在每个思考增量上写的标记。
const CLINE_REASONING_STREAMING_HOOK_EVENT_NAME = "reasoning_delta";

// ACP 的 ToolCallStatus 里表示「还没出结果」的两个取值；其余（completed / failed）是终态。
const ACP_TOOL_CALL_STATUSES_STILL_RUNNING: ReadonlySet<string> = new Set(["pending", "in_progress"]);
// ACP 侧 reasoning 消息「仍在流」的 streamType（收束时由回合边界改写成 "reasoning"）。
const ACP_REASONING_STREAM_TYPE_WHILE_STREAMING = "reasoning_streaming";

export function isAgentChatToolMessageStillRunning(message: ClineChatMessage): boolean {
	if (message.meta?.hookEventName === CLINE_TOOL_CALL_STARTED_HOOK_EVENT_NAME) {
		return true;
	}
	const toolCallStatus = message.meta?.toolCallStatus;
	return typeof toolCallStatus === "string" && ACP_TOOL_CALL_STATUSES_STILL_RUNNING.has(toolCallStatus);
}

export function isAgentChatReasoningMessageStillStreaming(message: ClineChatMessage): boolean {
	return (
		message.meta?.hookEventName === CLINE_REASONING_STREAMING_HOOK_EVENT_NAME ||
		message.meta?.streamType === ACP_REASONING_STREAM_TYPE_WHILE_STREAMING
	);
}
