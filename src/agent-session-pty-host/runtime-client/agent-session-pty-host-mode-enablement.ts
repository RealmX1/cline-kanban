// 受支持的固定端口实例默认启用；环境只覆盖本次启动，持久偏好仍由全局 config.json 保存。
import type { RuntimeAgentSessionPtyHostEnablementPreference } from "../../core/api-contract";

export const KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME = "KANBAN_AGENT_SESSION_PTY_HOST_MODE";

export type AgentSessionPtyHostModeDisabledReason =
	| "persistent_preference_disabled"
	| "environment_override_disabled"
	| "invalid_environment_override"
	| "runtime_port_auto_selected"
	| "remote_host_mode"
	| "unsupported_platform_win32"
	| "electron_desktop_shell";

export interface AgentSessionPtyHostModeEnablementDecision {
	agentSessionPtyHostModeEnabled: boolean;
	canAdoptExistingHostedSessions: boolean;
	disabledReason: AgentSessionPtyHostModeDisabledReason | null;
	enablementPreferenceSource: "environment_override" | "persistent_preference" | "default_enabled";
	effectiveStartupIntent: RuntimeAgentSessionPtyHostEnablementPreference;
	persistentPreference: RuntimeAgentSessionPtyHostEnablementPreference | null;
	environmentOverride: string | null;
}

export interface AgentSessionPtyHostModeEnablementInput {
	agentSessionPtyHostEnablementPreference?: RuntimeAgentSessionPtyHostEnablementPreference;
	agentSessionPtyHostModeEnvironmentValue: string | undefined;
	kanbanDesktopEnvironmentValue: string | undefined;
	runtimePortWasAutoSelected: boolean;
	runtimeServesRemoteHost: boolean;
	platform: NodeJS.Platform;
}

export function resolveAgentSessionPtyHostModeEnablement(
	input: AgentSessionPtyHostModeEnablementInput,
): AgentSessionPtyHostModeEnablementDecision {
	const environmentOverride = input.agentSessionPtyHostModeEnvironmentValue?.trim().toLowerCase() ?? null;
	const effectiveStartupIntent =
		environmentOverride !== null
			? environmentOverride === "enabled"
				? "enabled"
				: "disabled"
			: (input.agentSessionPtyHostEnablementPreference ?? "enabled");
	// 身份与平台约束优先；用户关闭只影响新会话，不能使存量 hosted 会话失联。
	const unsupportedReason =
		input.platform === "win32"
			? "unsupported_platform_win32"
			: input.kanbanDesktopEnvironmentValue === "1"
				? "electron_desktop_shell"
				: input.runtimePortWasAutoSelected
					? "runtime_port_auto_selected"
					: input.runtimeServesRemoteHost
						? "remote_host_mode"
						: null;
	const disabledReason =
		unsupportedReason ??
		(effectiveStartupIntent === "enabled"
			? null
			: environmentOverride === null
				? "persistent_preference_disabled"
				: environmentOverride === "disabled"
					? "environment_override_disabled"
					: "invalid_environment_override");
	return {
		agentSessionPtyHostModeEnabled: disabledReason === null,
		canAdoptExistingHostedSessions: unsupportedReason === null,
		disabledReason,
		enablementPreferenceSource:
			environmentOverride !== null
				? "environment_override"
				: input.agentSessionPtyHostEnablementPreference !== undefined
					? "persistent_preference"
					: "default_enabled",
		effectiveStartupIntent,
		persistentPreference: input.agentSessionPtyHostEnablementPreference ?? null,
		environmentOverride,
	};
}
