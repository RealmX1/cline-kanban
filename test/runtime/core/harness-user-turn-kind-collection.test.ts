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

describe("classifyHookUserTurnKind（Claude hook metadata → permission）", () => {
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
});
