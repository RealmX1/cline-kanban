// 是否启用 agent session PTY host 模式（agent 会话的 PTY 交给独立长驻进程持有，runtime 重启不打断会话）。
//
// opt-in：只有显式设置 KANBAN_AGENT_SESSION_PTY_HOST_MODE=enabled 才启用。以下情形即使设置了也强制关闭：
// - `--port auto`：host 按「runtime home + 固定端口」认领会话，端口每次随机就认不回来，还会给每个
//   dev:full 实例留下一个孤儿 host；
// - remote-host 模式：hook 用的内部 token 每次启动随机生成，存活会话里冻结的旧 token 在新 runtime 上失效
//   （hook token 持久化之后可解除）；
// - win32：host 依赖 Unix domain socket、setsid 与进程组信号；
// - Electron 桌面壳（KANBAN_DESKTOP=1）：壳自己管理 runtime 子进程的生命周期，退出即应全部收尾。

export const KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME = "KANBAN_AGENT_SESSION_PTY_HOST_MODE";

export type AgentSessionPtyHostModeDisabledReason =
	| "not_opted_in"
	| "runtime_port_auto_selected"
	| "remote_host_mode"
	| "unsupported_platform_win32"
	| "electron_desktop_shell";

export type AgentSessionPtyHostModeEnablementDecision =
	| { agentSessionPtyHostModeEnabled: true }
	| { agentSessionPtyHostModeEnabled: false; disabledReason: AgentSessionPtyHostModeDisabledReason };

export interface AgentSessionPtyHostModeEnablementInput {
	agentSessionPtyHostModeEnvironmentValue: string | undefined;
	kanbanDesktopEnvironmentValue: string | undefined;
	runtimePortWasAutoSelected: boolean;
	runtimeServesRemoteHost: boolean;
	platform: NodeJS.Platform;
}

export function resolveAgentSessionPtyHostModeEnablement(
	input: AgentSessionPtyHostModeEnablementInput,
): AgentSessionPtyHostModeEnablementDecision {
	if (input.agentSessionPtyHostModeEnvironmentValue?.trim().toLowerCase() !== "enabled") {
		return { agentSessionPtyHostModeEnabled: false, disabledReason: "not_opted_in" };
	}
	if (input.platform === "win32") {
		return { agentSessionPtyHostModeEnabled: false, disabledReason: "unsupported_platform_win32" };
	}
	if (input.kanbanDesktopEnvironmentValue === "1") {
		return { agentSessionPtyHostModeEnabled: false, disabledReason: "electron_desktop_shell" };
	}
	if (input.runtimePortWasAutoSelected) {
		return { agentSessionPtyHostModeEnabled: false, disabledReason: "runtime_port_auto_selected" };
	}
	if (input.runtimeServesRemoteHost) {
		return { agentSessionPtyHostModeEnabled: false, disabledReason: "remote_host_mode" };
	}
	return { agentSessionPtyHostModeEnabled: true };
}
