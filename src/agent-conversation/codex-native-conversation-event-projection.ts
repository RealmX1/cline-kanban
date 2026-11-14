import type { AcpSessionNotification, AcpToolCallStatus } from "../acp-client-session/acp-protocol-boundary";

export function readNativeProtocolRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function projectCodexNativeNotification(
	sessionId: string,
	method: string,
	parameters: Record<string, unknown>,
): AcpSessionNotification[] {
	if (parameters.threadId !== sessionId) return [];
	if (
		(method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") &&
		typeof parameters.delta === "string"
	) {
		return [
			{
				sessionId,
				update: {
					sessionUpdate: method === "item/agentMessage/delta" ? "agent_message_chunk" : "agent_thought_chunk",
					messageId: typeof parameters.itemId === "string" ? parameters.itemId : undefined,
					content: { type: "text", text: parameters.delta },
				},
			},
		];
	}
	if (method === "turn/plan/updated" && Array.isArray(parameters.plan)) {
		return [
			{
				sessionId,
				update: {
					sessionUpdate: "plan",
					entries: parameters.plan.map((value) => {
						const step = readNativeProtocolRecord(value);
						return {
							content: String(step.step ?? ""),
							priority: "medium",
							status:
								step.status === "completed"
									? "completed"
									: step.status === "inProgress"
										? "in_progress"
										: "pending",
						};
					}),
				},
			},
		];
	}
	if (method !== "item/started" && method !== "item/completed") return [];
	const item = readNativeProtocolRecord(parameters.item);
	if (typeof item.id !== "string") return [];
	if (item.type === "userMessage" && Array.isArray(item.content)) {
		return item.content.flatMap((block) => {
			const content = readNativeProtocolRecord(block);
			return content.type === "text" && typeof content.text === "string"
				? [
						{
							sessionId,
							update: {
								sessionUpdate: "user_message_chunk" as const,
								content: { type: "text" as const, text: content.text },
							},
						},
					]
				: [];
		});
	}
	if (
		![
			"commandExecution",
			"fileChange",
			"mcpToolCall",
			"dynamicToolCall",
			"webSearch",
			"collabAgentToolCall",
		].includes(String(item.type))
	)
		return [];
	const status: AcpToolCallStatus =
		item.status === "failed" || item.status === "declined"
			? "failed"
			: method === "item/completed"
				? "completed"
				: "in_progress";
	return [
		{
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: item.id,
				title: String(item.command ?? item.tool ?? item.type),
				kind: item.type === "commandExecution" ? "execute" : item.type === "fileChange" ? "edit" : "other",
				status,
				rawInput: { command: item.command, cwd: item.cwd, arguments: item.arguments },
				rawOutput: item,
			},
		},
	];
}
