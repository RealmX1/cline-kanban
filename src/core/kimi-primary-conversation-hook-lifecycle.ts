import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "./api-contract";

function normalizeHookName(value: string | null | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function readToolInput(payload: Record<string, unknown> | null): Record<string, unknown> | null {
	const input = payload?.tool_input;
	return input !== null && typeof input === "object" && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: null;
}

export function normalizeKimiNativeHookToolCallIdentity(
	payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const nativeToolCallId = payload?.tool_call_id;
	return typeof nativeToolCallId === "string" && nativeToolCallId.trim()
		? { ...payload, tool_use_id: nativeToolCallId }
		: payload;
}

export function isKimiPrimaryConversationTerminalHook(
	metadata: Partial<RuntimeTaskHookActivity> | null | undefined,
): boolean {
	return (
		normalizeHookName(metadata?.source) === "kimi" &&
		["stop", "stopfailure", "interrupt"].includes(normalizeHookName(metadata?.hookEventName))
	);
}

export function resolveKimiPrimaryConversationHookEvent(
	event: RuntimeHookEvent,
	metadata: Partial<RuntimeTaskHookActivity> | null | undefined,
	payload: Record<string, unknown> | null,
): RuntimeHookEvent {
	if (normalizeHookName(metadata?.source) !== "kimi") return event;
	const subagentId = payload?.agent_id;
	if (typeof subagentId === "string" && subagentId.trim() && subagentId !== "main") return "activity";
	const hookName = normalizeHookName(metadata?.hookEventName);
	const toolName = normalizeHookName(metadata?.toolName);
	const isUserQuestion = toolName === "askuserquestion";
	if (isUserQuestion && readToolInput(payload)?.background === true) return "activity";
	switch (hookName) {
		case "pretooluse":
			return isUserQuestion || toolName === "exitplanmode" ? "to_review" : "activity";
		case "permissionrequest":
		case "stop":
		case "stopfailure":
		case "interrupt":
			return "to_review";
		case "permissionresult":
			// 提问工具获准执行后，真正的问题选择器才开始等待，不能因此回到 agent 回合。
			return isUserQuestion ? "activity" : "to_in_progress";
		case "posttooluse":
		case "posttoolusefailure":
		case "userpromptsubmit":
			return "to_in_progress";
		case "sessionstart":
		case "postcompact":
			return event;
		default:
			return "activity";
	}
}
