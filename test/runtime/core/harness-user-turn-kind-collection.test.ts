import { describe, expect, it } from "vitest";
import { classifyClineUserAttentionTool } from "../../../src/cline-sdk/cline-session-state";
import { classifyHookUserTurnKind } from "../../../src/core/harness-user-turn-kind-collection";

// Stage 4 Phase B harness 采集增强：把 best-effort hook / SDK 工具信号映射为更细人轴的纯分类器。

describe("classifyClineUserAttentionTool（Cline SDK 工具 → 人轴）", () => {
	it("ask_followup_question → question", () => {
		expect(classifyClineUserAttentionTool("ask_followup_question")).toBe("question");
	});
	it("plan_mode_respond → plan_review", () => {
		expect(classifyClineUserAttentionTool("plan_mode_respond")).toBe("plan_review");
	});
	it("大小写 / 空白不敏感", () => {
		expect(classifyClineUserAttentionTool("  ASK_FOLLOWUP_QUESTION  ")).toBe("question");
		expect(classifyClineUserAttentionTool("Plan_Mode_Respond")).toBe("plan_review");
	});
	it("其它工具 / null → null", () => {
		expect(classifyClineUserAttentionTool("read_file")).toBe(null);
		expect(classifyClineUserAttentionTool(null)).toBe(null);
		expect(classifyClineUserAttentionTool("")).toBe(null);
	});
});

describe("classifyHookUserTurnKind（Claude hook metadata → permission / question / plan_review）", () => {
	it("claude + PermissionRequest → permission", () => {
		expect(classifyHookUserTurnKind({ source: "claude", hookEventName: "PermissionRequest" })).toBe("permission");
	});
	it("claude + permission_prompt notificationType → permission", () => {
		expect(classifyHookUserTurnKind({ source: "claude", notificationType: "permission_prompt" })).toBe("permission");
	});
	it("大小写不敏感", () => {
		expect(classifyHookUserTurnKind({ source: "Claude", hookEventName: "permissionrequest" })).toBe("permission");
	});
	it("非 claude 来源 → null（即使带 permission 信号）", () => {
		expect(classifyHookUserTurnKind({ source: "codex", hookEventName: "PermissionRequest" })).toBe(null);
		expect(classifyHookUserTurnKind({ source: "opencode", notificationType: "permission.asked" })).toBe(null);
	});
	it("claude 但非 permission 信号（Stop / 普通 Notification）→ null", () => {
		expect(classifyHookUserTurnKind({ source: "claude", hookEventName: "Stop" })).toBe(null);
		expect(classifyHookUserTurnKind({ source: "claude", notificationType: "user_attention" })).toBe(null);
	});
	it("空 metadata → null", () => {
		expect(classifyHookUserTurnKind(null)).toBe(null);
		expect(classifyHookUserTurnKind(undefined)).toBe(null);
		expect(classifyHookUserTurnKind({})).toBe(null);
	});

	// Stage 5：Claude Code 原生工具名 → question / plan_review（与 Cline SDK 同语义、不同工具名）。
	it("claude + ExitPlanMode toolName → plan_review", () => {
		expect(
			classifyHookUserTurnKind({ source: "claude", hookEventName: "PreToolUse", toolName: "ExitPlanMode" }),
		).toBe("plan_review");
	});
	it("claude + AskUserQuestion toolName → question", () => {
		expect(
			classifyHookUserTurnKind({ source: "claude", hookEventName: "PreToolUse", toolName: "AskUserQuestion" }),
		).toBe("question");
	});
	it("toolName 大小写 / 空白 / snake_case alias 不敏感", () => {
		expect(classifyHookUserTurnKind({ source: "claude", toolName: "  exitplanmode  " })).toBe("plan_review");
		expect(classifyHookUserTurnKind({ source: "claude", toolName: "exit_plan_mode" })).toBe("plan_review");
		expect(classifyHookUserTurnKind({ source: "claude", toolName: "ASKUSERQUESTION" })).toBe("question");
		expect(classifyHookUserTurnKind({ source: "claude", toolName: "ask_user_question" })).toBe("question");
	});
	it("非 claude 来源带工具名 → null", () => {
		expect(classifyHookUserTurnKind({ source: "cline", toolName: "ExitPlanMode" })).toBe(null);
		expect(classifyHookUserTurnKind({ source: "codex", toolName: "AskUserQuestion" })).toBe(null);
	});
	it("claude 未知工具名 → null（回落单源派生，不强加人轴）", () => {
		expect(classifyHookUserTurnKind({ source: "claude", hookEventName: "PreToolUse", toolName: "Bash" })).toBe(null);
		expect(classifyHookUserTurnKind({ source: "claude", toolName: "Read" })).toBe(null);
	});
	it("通用工具的 PermissionRequest（如 Bash）→ permission（无特定 plan/question 工具名）", () => {
		expect(classifyHookUserTurnKind({ source: "claude", hookEventName: "PermissionRequest", toolName: "Bash" })).toBe(
			"permission",
		);
	});
	// 竞态鲁棒（评审确认）：ExitPlanMode/AskUserQuestion 也经 PermissionRequest 抵达，且该 hook 在本仓库
	// adapter 走 "*"→to_review；toolName 必须先于通用 permission 判定，否则「批准计划」的权限请求会被误标
	// permission 而非 plan_review。语义上 ExitPlanMode 的权限请求本就是 plan_review。
	it("ExitPlanMode 经 PermissionRequest 抵达 → plan_review（非 permission，竞态鲁棒）", () => {
		expect(
			classifyHookUserTurnKind({ source: "claude", hookEventName: "PermissionRequest", toolName: "ExitPlanMode" }),
		).toBe("plan_review");
	});
	it("AskUserQuestion 经 PermissionRequest 抵达 → question（非 permission，竞态鲁棒）", () => {
		expect(
			classifyHookUserTurnKind({
				source: "claude",
				hookEventName: "PermissionRequest",
				toolName: "AskUserQuestion",
			}),
		).toBe("question");
	});
});
