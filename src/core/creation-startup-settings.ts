import { getRuntimeAgentSessionTransport } from "./agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeCreationResolvedSettings,
	RuntimeTaskAgentPermissionMode,
} from "./api-contract";
import { resolveTaskAgentPermissionModeForAgent } from "./task-agent-permission-mode";

export function resolveCreationStartupSettings(input: {
	agentId: RuntimeAgentId;
	startInPlanMode: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	modelId?: string;
	defaultModelId?: string | null;
	agentSelectionSource?: "explicit_request" | "creator_session_agent" | "workspace_config_default";
	sessionRole?: "by_the_way" | "task_collaborator";
	requestedAgentSessionTransport?: RuntimeAgentSessionTransport;
	defaultSessionTransport?: RuntimeAgentSessionTransport;
}): RuntimeCreationResolvedSettings {
	const requested = input.taskAgentPermissionMode ?? "bypass_all_permission_prompts";
	const permission = resolveTaskAgentPermissionModeForAgent(input.agentId, requested);
	const permissionSource = input.taskAgentPermissionMode === undefined ? "built_in_default" : "explicit_request";
	return {
		effectiveAgentId: { value: input.agentId, source: input.agentSelectionSource ?? "explicit_request" },
		startInPlanMode: { value: input.startInPlanMode, source: "explicit_request" },
		requestedTaskAgentPermissionMode: { value: requested, source: permissionSource },
		effectiveTaskAgentPermissionMode: {
			value: permission.effectivePermissionMode,
			source: permission.degradedBecauseAgentCannotExpressRequestedMode
				? "harness_permission_mapping"
				: permissionSource,
		},
		harnessPermissionMode: {
			value: input.sessionRole === "by_the_way" ? null : permission.effectivePermissionMode,
			source: input.sessionRole === "by_the_way" ? "session_role_constraint" : "harness_permission_mapping",
		},
		roleReadOnlyConstraint: { value: input.sessionRole === "by_the_way", source: "session_role_constraint" },
		modelId: {
			value: input.modelId ?? input.defaultModelId ?? null,
			source: input.modelId === undefined ? "agent_default_configuration" : "explicit_request",
		},
		sessionTransport: {
			value:
				input.requestedAgentSessionTransport ??
				input.defaultSessionTransport ??
				getRuntimeAgentSessionTransport(input.agentId),
			source: input.requestedAgentSessionTransport ? "explicit_request" : "agent_default_configuration",
		},
	};
}

export function assertCreationPlanModeWasExplicitlySelected(value: boolean | undefined): asserts value is boolean {
	if (typeof value !== "boolean")
		throw new Error("创建必须显式提供 --start-in-plan-mode true 或 --start-in-plan-mode false；未创建任何对象。");
}
