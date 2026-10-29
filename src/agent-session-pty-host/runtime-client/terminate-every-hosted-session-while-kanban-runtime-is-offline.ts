// runtime 离线时的显式全停：CLI 作为非 controller 客户端，请 host 原子检查 controller 槽并开始全停。
// 不能把“先查询无 controller、再握手取得 controller”拼起来：查询之后新 runtime 可能正在接管，旧握手会把它顶掉。
// 新增原子请求只增不改；旧 host 不支持时明确失败，不回退到有竞态的路径。

import {
	type AgentSessionPtyHostRuntimeIdentity,
	listAgentSessionPtyHostGenerationSocketPaths,
} from "./agent-session-pty-host-socket-path-for-runtime-identity";
import { requestAgentSessionPtyHostToTerminateAllHostedSessionsIfNoController } from "./hosted-session-cli-client-requests-to-agent-session-pty-host";

const AGENT_SESSION_PTY_HOST_OFFLINE_TERMINATION_RESPONSE_DEADLINE_MS = 2_000;

export type OfflineHostedSessionTerminationOutcomeOfGeneration =
	| "terminate_all_hosted_sessions_requested"
	| "skipped_because_a_kanban_runtime_is_connected_as_controller"
	| "skipped_because_no_agent_session_pty_host_is_listening"
	| "failed_to_reach_agent_session_pty_host";

export interface OfflineHostedSessionTerminationResultOfGeneration {
	agentSessionPtyHostSocketPath: string;
	outcome: OfflineHostedSessionTerminationOutcomeOfGeneration;
	failureMessage?: string;
}

export interface TerminateEveryHostedSessionWhileKanbanRuntimeIsOfflineDependencies {
	runtimeIdentity: AgentSessionPtyHostRuntimeIdentity;
	// 测试注入。
	listGenerationSocketPaths?: (identity: AgentSessionPtyHostRuntimeIdentity) => string[];
	requestTerminationIfNoController?: typeof requestAgentSessionPtyHostToTerminateAllHostedSessionsIfNoController;
}

export async function terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline(
	deps: TerminateEveryHostedSessionWhileKanbanRuntimeIsOfflineDependencies,
): Promise<OfflineHostedSessionTerminationResultOfGeneration[]> {
	const listGenerationSocketPaths = deps.listGenerationSocketPaths ?? listAgentSessionPtyHostGenerationSocketPaths;
	const requestTerminationIfNoController =
		deps.requestTerminationIfNoController ?? requestAgentSessionPtyHostToTerminateAllHostedSessionsIfNoController;
	const results: OfflineHostedSessionTerminationResultOfGeneration[] = [];
	for (const agentSessionPtyHostSocketPath of listGenerationSocketPaths(deps.runtimeIdentity)) {
		const response = await requestTerminationIfNoController({
			agentSessionPtyHostSocketPath,
			responseDeadlineMilliseconds: AGENT_SESSION_PTY_HOST_OFFLINE_TERMINATION_RESPONSE_DEADLINE_MS,
		});
		if (response.kind === "agent_session_pty_host_unreachable") {
			results.push({
				agentSessionPtyHostSocketPath,
				outcome: response.noHostIsListening
					? "skipped_because_no_agent_session_pty_host_is_listening"
					: "failed_to_reach_agent_session_pty_host",
				failureMessage: response.failureMessage,
			});
		} else {
			results.push({
				agentSessionPtyHostSocketPath,
				outcome:
					response.kind === "termination_requested"
						? "terminate_all_hosted_sessions_requested"
						: "skipped_because_a_kanban_runtime_is_connected_as_controller",
			});
		}
	}
	return results;
}
