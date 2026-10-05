// runtime 启动时决定是否启用 agent session PTY host 模式，启用则启动 facade（发现 / 拉起 host 并连接）。
// 由 cli.ts 在创建 workspace registry 之前懒加载调用。

import { getKanbanRuntimePort, isKanbanRemoteHost } from "../../core/runtime-endpoint";
import { getRuntimeHomePath } from "../../state/runtime-home-path";
import {
	KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME,
	resolveAgentSessionPtyHostModeEnablement,
} from "./agent-session-pty-host-mode-enablement";
import {
	AgentSessionPtyHostPreventsSafeRuntimeStartupError,
	AgentSessionPtyHostRuntimeFacade,
} from "./agent-session-pty-host-runtime-facade";

export async function startAgentSessionPtyHostRuntimeFacadeWhenEnabled(input: {
	runtimePortWasAutoSelected: boolean;
	warn: (message: string) => void;
}): Promise<AgentSessionPtyHostRuntimeFacade | null> {
	const enablement = resolveAgentSessionPtyHostModeEnablement({
		agentSessionPtyHostModeEnvironmentValue:
			process.env[KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME],
		kanbanDesktopEnvironmentValue: process.env.KANBAN_DESKTOP,
		runtimePortWasAutoSelected: input.runtimePortWasAutoSelected,
		runtimeServesRemoteHost: isKanbanRemoteHost(),
		platform: process.platform,
	});
	if (!enablement.agentSessionPtyHostModeEnabled) {
		if (enablement.disabledReason !== "not_opted_in") {
			input.warn(
				`${KANBAN_AGENT_SESSION_PTY_HOST_MODE_ENVIRONMENT_VARIABLE_NAME}=enabled is ignored (${enablement.disabledReason}); agent sessions will end when this runtime exits`,
			);
		}
		return null;
	}
	try {
		return await AgentSessionPtyHostRuntimeFacade.start({
			runtimeIdentity: { runtimeHomeDirectoryPath: getRuntimeHomePath(), runtimePort: getKanbanRuntimePort() },
			warn: input.warn,
		});
	} catch (error) {
		// 有 host 活着却不应答：它手里的会话既不能接管也不能当作不存在，启动失败、交给 supervisor 重试。
		if (error instanceof AgentSessionPtyHostPreventsSafeRuntimeStartupError) {
			throw error;
		}
		// 其余失败（例如当前 build 的 host 拉不起来、且旧 generation 没有待接管的会话；有会话时 start 不抛，
		// 而是交出 facade 完成接管、新会话降级为进程内 PTY）退回进程内 PTY，不阻断 runtime 启动。
		input.warn(
			`agent session pty host could not start; falling back to in-process PTY sessions: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}
