// 每个「经 ACP 通话」的 agent 的启动配置。ACP 本身是 agent 无关协议，这张表是唯一放
// agent 专属知识（子命令、权限旗标怎么写、plan 用哪个 session mode id）的地方，
// 其余 ACP 代码保持通用。
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskAgentPermissionMode } from "../core/api-contract";

export interface AcpAgentSpawnCommand {
	binary: string;
	args: string[];
	env: Record<string, string>;
}

export interface AcpAgentLaunchDefinition {
	agentId: RuntimeAgentId;
	// plan 起步要切到的 session mode id；null 表示该 agent 不支持以 mode 表达 plan。
	planModeSessionModeId: string | null;
	buildSpawnCommand(input: { permissionMode: RuntimeTaskAgentPermissionMode }): AcpAgentSpawnCommand;
}

// oh-my-pi：`omp acp` 复用同一套根命令 flag 解析（commands/acp.ts 只是把 mode 强制成 "acp"），
// 所以 --approval-mode 等旗标在 ACP 模式下同样生效。
const ompAcpLaunchDefinition: AcpAgentLaunchDefinition = {
	agentId: "omp",
	planModeSessionModeId: "plan",
	buildSpawnCommand({ permissionMode }) {
		const catalogEntry = getRuntimeAgentCatalogEntry("omp");
		return {
			binary: catalogEntry?.binary ?? "omp",
			args: [...(catalogEntry?.baseArgs ?? ["acp"]), "--approval-mode", resolveOmpApprovalMode(permissionMode)],
			env: {
				// setup 向导本就只在 TTY 下触发（ACP 走管道 stdio，不会命中），这里再显式关一层，
				// 免得将来换成带 TTY 的 spawn 方式时被全屏向导卡死握手。
				OMP_SKIP_SETUP: "1",
				// ACP 模式下 stdout 是 JSON-RPC 通道，任何非 JSON 输出都会破坏协议。
				PI_NO_TITLE: "1",
			},
		};
	},
};

// omp 的 tools.approvalMode 三档正好与 Kanban 的权限轴一一对应。注意必须**显式**传：
// omp 的 schema 默认虽是 yolo，但「默认值」不算 isConfigured，ACP 权限门仍会保留。
function resolveOmpApprovalMode(permissionMode: RuntimeTaskAgentPermissionMode): string {
	switch (permissionMode) {
		case "bypass_all_permission_prompts":
			return "yolo";
		case "auto_approve_file_edits_only":
			return "write";
		case "ask_for_every_tool_use":
			return "always-ask";
	}
}

const ACP_AGENT_LAUNCH_DEFINITIONS: readonly AcpAgentLaunchDefinition[] = [ompAcpLaunchDefinition];

export function getAcpAgentLaunchDefinition(agentId: RuntimeAgentId): AcpAgentLaunchDefinition | null {
	return ACP_AGENT_LAUNCH_DEFINITIONS.find((definition) => definition.agentId === agentId) ?? null;
}

export function requireAcpAgentLaunchDefinition(agentId: RuntimeAgentId): AcpAgentLaunchDefinition {
	const definition = getAcpAgentLaunchDefinition(agentId);
	if (!definition) {
		throw new Error(`Agent "${agentId}" has no ACP launch definition registered.`);
	}
	return definition;
}
