// 跑在 hosted agent 会话里的 CLI（`kanban hooks …`、`kanban task …` 等）直连 agent session PTY host 的一问一答。
// runtime 不可达时用：把 hook 事件存进 host 的 spool，或询问「runtime 是不是正在重启」。
//
// 会话由谁 hosting、socket 在哪，由 runtime spawn 时注入的两个环境变量告知（见下）；不在 hosted 会话里就没有它们。

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
	type AgentSessionPtyHostReadOnlyHostStatus,
	agentSessionPtyHostReadOnlyHostStatusSchema,
} from "../../core/agent-session-pty-host-diagnostics-contract";
import {
	AgentSessionPtyHostWireFrameDecoder,
	encodeJsonControlMessageFrame,
} from "../wire-protocol/agent-session-pty-host-wire-frame-codec";
import {
	AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
	type AgentSessionPtyHostHostedSessionCliClientToHostMessage,
	type AppendHookEventToHostedSessionSpoolOutcome,
	readWireControlMessageType,
	type TerminateAllHostedSessionsIfNoControllerOutcome,
} from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";

// runtime spawn hosted 会话时注入：会话所在 host 的 socket 路径与会话 key。名字只增不改（存活会话里冻结着旧值）。
export const AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME = "KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH";
export const AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME =
	"KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY";

export interface HostedSessionBindingToAgentSessionPtyHost {
	agentSessionPtyHostSocketPath: string;
	hostedSessionKey: string;
}

export function readHostedSessionBindingToAgentSessionPtyHostFromEnvironment(
	environment: NodeJS.ProcessEnv,
): HostedSessionBindingToAgentSessionPtyHost | null {
	const agentSessionPtyHostSocketPath =
		environment[AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME]?.trim();
	const hostedSessionKey = environment[AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME]?.trim();
	if (!agentSessionPtyHostSocketPath || !hostedSessionKey) {
		return null;
	}
	return { agentSessionPtyHostSocketPath, hostedSessionKey };
}

export type HostedSessionCliClientRequestFailure = {
	kind: "agent_session_pty_host_unreachable";
	failureMessage: string;
	// 仅明确的 ECONNREFUSED / ENOENT 表示无 host；旧 host 不支持、响应超时和协议错误不等于不存在。
	noHostIsListening?: boolean;
};

// 连上 → hello + 请求 → 等同 requestId 的响应 → 断开。连不上、对端先断开（旧 host 不认这个握手）、超时都按不可达返回，绝不抛。
function sendOneHostedSessionCliClientRequest(
	agentSessionPtyHostSocketPath: string,
	buildRequest: (requestId: string) => AgentSessionPtyHostHostedSessionCliClientToHostMessage,
	responseDeadlineMilliseconds: number,
): Promise<{ kind: "responded"; response: unknown } | HostedSessionCliClientRequestFailure> {
	const requestId = randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		const socket = createConnection(agentSessionPtyHostSocketPath);
		const settle = (result: { kind: "responded"; response: unknown } | HostedSessionCliClientRequestFailure) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(deadlineTimer);
			socket.destroy();
			resolve(result);
		};
		const deadlineTimer = setTimeout(() => {
			settle({
				kind: "agent_session_pty_host_unreachable",
				failureMessage: `agent session pty host did not respond within ${responseDeadlineMilliseconds}ms`,
			});
		}, responseDeadlineMilliseconds);
		const decoder = new AgentSessionPtyHostWireFrameDecoder();
		socket.once("connect", () => {
			socket.write(
				encodeJsonControlMessageFrame({
					type: "hosted_session_cli_client_hello",
					protocolVersion: AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
					hostedSessionCliClientProcessId: process.pid,
				} satisfies AgentSessionPtyHostHostedSessionCliClientToHostMessage),
			);
			socket.write(encodeJsonControlMessageFrame(buildRequest(requestId)));
		});
		socket.on("data", (chunk: Buffer) => {
			let frames: ReturnType<AgentSessionPtyHostWireFrameDecoder["push"]>;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				settle({
					kind: "agent_session_pty_host_unreachable",
					failureMessage: `agent session pty host sent an undecodable frame: ${error instanceof Error ? error.message : String(error)}`,
				});
				return;
			}
			for (const frame of frames) {
				if (
					frame.kind === "json_control_message" &&
					(frame.message as { requestId?: unknown }).requestId === requestId
				) {
					settle({ kind: "responded", response: frame.message });
					return;
				}
			}
		});
		socket.on("error", (error) => {
			settle({
				kind: "agent_session_pty_host_unreachable",
				failureMessage: error.message,
				noHostIsListening:
					(error as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
					(error as NodeJS.ErrnoException).code === "ENOENT",
			});
		});
		socket.on("close", () => {
			settle({
				kind: "agent_session_pty_host_unreachable",
				failureMessage: "agent session pty host closed the connection without responding",
			});
		});
	});
}

// EXPERIMENT_NODE: 存 spool 的响应期限；hook 进程还要留出余量给 codex 的 8s hook 超时。
const HOOK_SPOOL_APPEND_RESPONSE_DEADLINE_MS = 1_500;

export async function appendHookEventToHostedSessionSpoolThroughAgentSessionPtyHost(input: {
	hostedSessionBinding: HostedSessionBindingToAgentSessionPtyHost;
	spooledHookIngestRequest: unknown;
	coalescibleWithAdjacentCoalescibleHookSpoolEntry: boolean;
}): Promise<AppendHookEventToHostedSessionSpoolOutcome | HostedSessionCliClientRequestFailure> {
	const result = await sendOneHostedSessionCliClientRequest(
		input.hostedSessionBinding.agentSessionPtyHostSocketPath,
		(requestId) => ({
			type: "append_hook_event_to_hosted_session_spool_request",
			requestId,
			hostedSessionKey: input.hostedSessionBinding.hostedSessionKey,
			spooledHookIngestRequest: input.spooledHookIngestRequest,
			coalescibleWithAdjacentCoalescibleHookSpoolEntry: input.coalescibleWithAdjacentCoalescibleHookSpoolEntry,
		}),
		HOOK_SPOOL_APPEND_RESPONSE_DEADLINE_MS,
	);
	if (result.kind !== "responded") {
		return result;
	}
	if (readWireControlMessageType(result.response) !== "append_hook_event_to_hosted_session_spool_response") {
		return { kind: "agent_session_pty_host_unreachable", failureMessage: "unexpected spool response" };
	}
	return (result.response as { outcome: AppendHookEventToHostedSessionSpoolOutcome }).outcome;
}

export interface AgentSessionPtyHostControllerPresence {
	controllerConnected: boolean;
	controllerAbsentSinceEpochMs: number | null;
}

export async function queryAgentSessionPtyHostControllerPresence(input: {
	agentSessionPtyHostSocketPath: string;
	responseDeadlineMilliseconds: number;
}): Promise<AgentSessionPtyHostControllerPresence | HostedSessionCliClientRequestFailure> {
	const result = await sendOneHostedSessionCliClientRequest(
		input.agentSessionPtyHostSocketPath,
		(requestId) => ({ type: "query_controller_presence_request", requestId }),
		input.responseDeadlineMilliseconds,
	);
	if (result.kind !== "responded") {
		return result;
	}
	if (readWireControlMessageType(result.response) !== "query_controller_presence_response") {
		return { kind: "agent_session_pty_host_unreachable", failureMessage: "unexpected controller presence response" };
	}
	const response = result.response as AgentSessionPtyHostControllerPresence;
	return {
		controllerConnected: response.controllerConnected === true,
		controllerAbsentSinceEpochMs:
			typeof response.controllerAbsentSinceEpochMs === "number" ? response.controllerAbsentSinceEpochMs : null,
	};
}

// 服务器在同一请求内检查槽位并预留全停，确认前后都不会被新 controller 插入。
export async function requestAgentSessionPtyHostToTerminateAllHostedSessionsIfNoController(input: {
	agentSessionPtyHostSocketPath: string;
	responseDeadlineMilliseconds: number;
}): Promise<TerminateAllHostedSessionsIfNoControllerOutcome | HostedSessionCliClientRequestFailure> {
	const result = await sendOneHostedSessionCliClientRequest(
		input.agentSessionPtyHostSocketPath,
		(requestId) => ({ type: "terminate_all_hosted_sessions_if_no_controller_request", requestId }),
		input.responseDeadlineMilliseconds,
	);
	if (result.kind !== "responded") return result;
	if (readWireControlMessageType(result.response) !== "terminate_all_hosted_sessions_if_no_controller_response") {
		return { kind: "agent_session_pty_host_unreachable", failureMessage: "host 返回了不支持的离线全停响应" };
	}
	const outcome = (result.response as { outcome?: TerminateAllHostedSessionsIfNoControllerOutcome }).outcome;
	if (outcome?.kind !== "termination_requested" && outcome?.kind !== "refused_because_controller_connected") {
		return { kind: "agent_session_pty_host_unreachable", failureMessage: "host 返回了无效的离线全停结果" };
	}
	return outcome;
}

export async function queryAgentSessionPtyHostReadOnlyStatus(input: {
	agentSessionPtyHostSocketPath: string;
	responseDeadlineMilliseconds?: number;
}): Promise<AgentSessionPtyHostReadOnlyHostStatus | HostedSessionCliClientRequestFailure> {
	const result = await sendOneHostedSessionCliClientRequest(
		input.agentSessionPtyHostSocketPath,
		(requestId) => ({ type: "query_agent_session_pty_host_readonly_status_request", requestId }),
		input.responseDeadlineMilliseconds ?? 1_000,
	);
	if (result.kind !== "responded") return result;
	const parsed = agentSessionPtyHostReadOnlyHostStatusSchema.safeParse(result.response);
	if (
		readWireControlMessageType(result.response) !== "query_agent_session_pty_host_readonly_status_response" ||
		!parsed.success
	) {
		return { kind: "agent_session_pty_host_unreachable", failureMessage: "host 未提供有效的只读诊断，保留 unknown" };
	}
	return parsed.data;
}
