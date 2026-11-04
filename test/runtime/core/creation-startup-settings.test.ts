import { describe, expect, it } from "vitest";
import { runtimeCreationResolvedSettingsSchema } from "../../../src/core/api-contract";
import { resolveCreationStartupSettings } from "../../../src/core/creation-startup-settings";

describe("创建工作台共用启动设置", () => {
	it("Task 默认 Agent 与侧会话的回执使用同一来源契约", () => {
		const settings = resolveCreationStartupSettings({
			agentId: "codex",
			startInPlanMode: false,
			agentSelectionSource: "workspace_config_default",
		});
		expect(runtimeCreationResolvedSettingsSchema.parse(settings).effectiveAgentId).toEqual({
			value: "codex",
			source: "workspace_config_default",
		});
	});
	it("显式 false 独立于默认全部允许，侧会话不继承宿主", () => {
		const settings = resolveCreationStartupSettings({
			agentId: "codex",
			startInPlanMode: false,
			defaultModelId: "agent-default",
		});
		expect(settings.startInPlanMode).toEqual({ value: false, source: "explicit_request" });
		expect(settings.requestedTaskAgentPermissionMode.value).toBe("bypass_all_permission_prompts");
		expect(settings.modelId).toEqual({ value: "agent-default", source: "agent_default_configuration" });
	});
	it("模型显式选择优先；不可表达的权限只收紧，By the way 另记只读约束", () => {
		const settings = resolveCreationStartupSettings({
			agentId: "codex",
			startInPlanMode: true,
			taskAgentPermissionMode: "auto_approve_file_edits_only",
			modelId: "chosen-model",
			defaultModelId: "agent-default",
			sessionRole: "by_the_way",
		});
		expect(settings.modelId).toEqual({ value: "chosen-model", source: "explicit_request" });
		expect(settings.effectiveTaskAgentPermissionMode.value).toBe("ask_for_every_tool_use");
		expect(settings.roleReadOnlyConstraint).toEqual({ value: true, source: "session_role_constraint" });
		expect(settings.startInPlanMode.value).toBe(true);
	});
});
