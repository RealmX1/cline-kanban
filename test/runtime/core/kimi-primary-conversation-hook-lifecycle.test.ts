import { describe, expect, it } from "vitest";
import { extractAgentToolCallExecutionOutcomeFromHookPayload } from "../../../src/commands/hook-events/agent-tool-call-execution-outcome-extraction";
import { buildAgentRaisedDecisionPayloads } from "../../../src/commands/hooks";
import { classifyHookUserTurnKind } from "../../../src/core/harness-user-turn-kind-collection";
import {
	normalizeKimiNativeHookToolCallIdentity,
	resolveKimiPrimaryConversationHookEvent,
} from "../../../src/core/kimi-primary-conversation-hook-lifecycle";

// 字段形状来自隔离 Kimi 2.3.1 原生探针 native-current-question-interrupt-check，身份已替换。
const nativeQuestionPayload = {
	hook_event_name: "PreToolUse",
	session_id: "session_isolated-primary-conversation",
	client_type: "kimi_code_cli",
	tool_name: "AskUserQuestion",
	tool_call_id: "isolated-question-call",
	tool_input: {
		questions: [{ question: "选择一个测试答案？", multi_select: true, options: [{ label: "甲" }, { label: "乙" }] }],
	},
};

describe("Kimi 主会话交互 hook 归一化", () => {
	it.each([
		["PreToolUse", "AskUserQuestion", "activity", "to_review", "question"],
		["PreToolUse", "ExitPlanMode", "activity", "to_review", "plan_review"],
		["PermissionRequest", "Bash", "to_review", "to_review", "permission"],
		["PostToolUse", "AskUserQuestion", "to_in_progress", "to_in_progress", null],
		["PostToolUseFailure", "AskUserQuestion", "to_in_progress", "to_in_progress", null],
		["PermissionResult", "Bash", "activity", "to_in_progress", null],
		["PermissionResult", "AskUserQuestion", "activity", "activity", null],
		["Interrupt", null, "to_review", "to_review", "interrupted"],
		["StopFailure", null, "to_review", "to_review", "error"],
	] as const)("%s / %s 的事件与人轴一致", (hookEventName, toolName, event, expectedEvent, expectedKind) => {
		const metadata = { source: "kimi", hookEventName, toolName };
		expect(resolveKimiPrimaryConversationHookEvent(event, metadata, nativeQuestionPayload)).toBe(expectedEvent);
		if (expectedEvent === "to_review") expect(classifyHookUserTurnKind(metadata)).toBe(expectedKind);
	});

	it.each(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionResult"])(
		"后台问题 %s 不抢主会话的用户回合",
		(hookEventName) => {
			expect(
				resolveKimiPrimaryConversationHookEvent(
					"to_in_progress",
					{ source: "kimi", hookEventName, toolName: "AskUserQuestion" },
					{ ...nativeQuestionPayload, tool_input: { ...nativeQuestionPayload.tool_input, background: true } },
				),
			).toBe("activity");
		},
	);

	it.each(["Notification", "TaskStarted", "SubagentStart", "SubagentStop"])("%s 不代表主会话停止", (hookEventName) => {
		expect(resolveKimiPrimaryConversationHookEvent("to_review", { source: "kimi", hookEventName }, {})).toBe(
			"activity",
		);
	});

	it("子代理的 Stop 也不转移主会话，其他 harness 保持原逻辑", () => {
		expect(
			resolveKimiPrimaryConversationHookEvent(
				"to_review",
				{ source: "kimi", hookEventName: "Stop" },
				{ agent_id: "subagent-1" },
			),
		).toBe("activity");
		expect(
			resolveKimiPrimaryConversationHookEvent("activity", { source: "claude", hookEventName: "Interrupt" }, {}),
		).toBe("activity");
	});

	it("原生 tool_call_id 关联已有工具执行元数据，不以问题正文代替调用身份", () => {
		const payload = normalizeKimiNativeHookToolCallIdentity(nativeQuestionPayload);
		expect(
			extractAgentToolCallExecutionOutcomeFromHookPayload({
				payload,
				hookEventName: "PreToolUse",
				toolName: "AskUserQuestion",
			}),
		).toMatchObject({ toolUseId: "isolated-question-call", toolCallLifecyclePhase: "tool_call_started" });
	});

	it("状态采集不新增尚无安全投递能力的 Kimi 面板问答记录", () => {
		expect(
			buildAgentRaisedDecisionPayloads(normalizeKimiNativeHookToolCallIdentity(nativeQuestionPayload), {
				source: "kimi",
				hookEventName: "PreToolUse",
				toolName: "AskUserQuestion",
			}),
		).toEqual({});
	});

	it("Kimi 工具授权也只在原生终端处理，不登记缺乏安全投递的面板表单", () => {
		expect(
			buildAgentRaisedDecisionPayloads(
				{ tool_call_id: "isolated-permission-call", tool_use_id: "isolated-permission-call" },
				{ source: "kimi", hookEventName: "PermissionRequest", toolName: "Bash" },
			),
		).toEqual({});
	});
});
