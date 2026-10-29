// 离线全停只用 host 的原子检查/终止请求，不取得 controller；旧 host 不支持或响应不明时必须明确失败。
import { describe, expect, it, vi } from "vitest";
import type { HostedSessionCliClientRequestFailure } from "../../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import { terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline } from "../../../src/agent-session-pty-host/runtime-client/terminate-every-hosted-session-while-kanban-runtime-is-offline";
import type { TerminateAllHostedSessionsIfNoControllerOutcome } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";

describe("terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline", () => {
	it("逐 generation 发原子全停请求，跳过有 controller 的 host 和确定不存在的 socket", async () => {
		const requestTerminationIfNoController = vi.fn(
			async ({
				agentSessionPtyHostSocketPath,
			}: {
				agentSessionPtyHostSocketPath: string;
			}): Promise<TerminateAllHostedSessionsIfNoControllerOutcome | HostedSessionCliClientRequestFailure> => {
				if (agentSessionPtyHostSocketPath.endsWith("dead.sock"))
					return {
						kind: "agent_session_pty_host_unreachable",
						noHostIsListening: true,
						failureMessage: "ECONNREFUSED",
					};
				return agentSessionPtyHostSocketPath.includes("runtime-starting")
					? { kind: "refused_because_controller_connected" }
					: { kind: "termination_requested" };
			},
		);

		const results = await terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline({
			runtimeIdentity: { runtimeHomeDirectoryPath: "/isolated-home", runtimePort: 3497 },
			listGenerationSocketPaths: () => [
				"/isolated-a-idle.sock",
				"/isolated-b-runtime-starting.sock",
				"/isolated-c-dead.sock",
			],
			requestTerminationIfNoController,
		});

		expect(results.map((result) => result.outcome)).toEqual([
			"terminate_all_hosted_sessions_requested",
			"skipped_because_a_kanban_runtime_is_connected_as_controller",
			"skipped_because_no_agent_session_pty_host_is_listening",
		]);
		expect(requestTerminationIfNoController).toHaveBeenCalledTimes(3);
	});

	it("旧 host 不支持、超时或未知传输失败都不冒充‘没有 host’或全停成功", async () => {
		const results = await terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline({
			runtimeIdentity: { runtimeHomeDirectoryPath: "/isolated-home", runtimePort: 3497 },
			listGenerationSocketPaths: () => ["/isolated-legacy-host.sock"],
			requestTerminationIfNoController: async () => ({
				kind: "agent_session_pty_host_unreachable",
				failureMessage: "旧 host 未响应原子终止请求",
			}),
		});

		expect(results).toEqual([
			{
				agentSessionPtyHostSocketPath: "/isolated-legacy-host.sock",
				outcome: "failed_to_reach_agent_session_pty_host",
				failureMessage: "旧 host 未响应原子终止请求",
			},
		]);
	});
});
