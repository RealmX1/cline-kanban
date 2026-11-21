// `kanban runtime …`：本机 Kanban runtime 的生命周期操作。
//
// - `handover-restart`：热重启。agent session PTY host 里的会话留给下一个 runtime 接管（同 pid、屏幕连续），
//   runtime 以 exit 75 退出、由 supervisor 立即重拉；可选等到新 runtime 开始监听。
// - `stop --terminate-hosted-agent-sessions`：停 runtime，并终止 host 里的全部 agent 会话（含没被接管的）。
//   注意普通的 `kill <pid>`（SIGTERM）不再等于「全停」：它只停 runtime，agent 继续跑（见 src/core/runtime-shutdown-trigger.ts）。
//   runtime 在线时经 tRPC；离线时直连 host socket。
// 目标端口取 KANBAN_RUNTIME_PORT（缺省 3484），与其余 CLI 子命令一致。

import type { Command } from "commander";
import { terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline } from "../agent-session-pty-host/runtime-client/terminate-every-hosted-session-while-kanban-runtime-is-offline";
import { authorizedUnretainableSessionHandoverSchema } from "../core/api-contract";
import { DEFAULT_CLI_RUNTIME_HANDOVER_SUCCESSOR_WAIT_SECONDS } from "../core/cli-process-guards";
import { buildKanbanRuntimeUrl, getKanbanRuntimePort, getRuntimeFetch } from "../core/runtime-endpoint";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { isRuntimeConnectionRefusedTransportError } from "./cli-runtime-request-retry-while-kanban-runtime-restarts";
import { createRuntimeTrpcClient, printJson } from "./task";

const WAIT_FOR_RUNTIME_PROCESS_TRANSITION_POLL_INTERVAL_MS = 250;
const WAIT_FOR_STOPPED_RUNTIME_PROCESS_TO_EXIT_MAXIMUM_MS = 20_000;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function isProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		// EPERM：进程在但不归我们管——仍算活着。
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function isKanbanRuntimeAcceptingHttpRequests(): Promise<boolean> {
	try {
		const runtimeFetch = await getRuntimeFetch();
		const response = await runtimeFetch(buildKanbanRuntimeUrl("/"), { signal: AbortSignal.timeout(2_000) });
		await response.body?.cancel();
		return true;
	} catch {
		return false;
	}
}

// 先等旧 runtime 进程退出，再等端口上有人应答：中间那段就是热重启窗口。
async function waitForSuccessorKanbanRuntimeToListen(input: {
	previousRuntimeProcessId: number;
	waitDeadlineEpochMs: number;
}): Promise<
	"successor_runtime_is_listening" | "previous_runtime_still_running" | "successor_runtime_not_listening_yet"
> {
	while (isProcessAlive(input.previousRuntimeProcessId)) {
		if (Date.now() >= input.waitDeadlineEpochMs) {
			return "previous_runtime_still_running";
		}
		await sleep(WAIT_FOR_RUNTIME_PROCESS_TRANSITION_POLL_INTERVAL_MS);
	}
	while (!(await isKanbanRuntimeAcceptingHttpRequests())) {
		if (Date.now() >= input.waitDeadlineEpochMs) {
			return "successor_runtime_not_listening_yet";
		}
		await sleep(WAIT_FOR_RUNTIME_PROCESS_TRANSITION_POLL_INTERVAL_MS);
	}
	return "successor_runtime_is_listening";
}

async function waitForStoppedKanbanRuntimeProcessToExit(runtimeProcessId: number): Promise<boolean> {
	const waitDeadlineEpochMs = Date.now() + WAIT_FOR_STOPPED_RUNTIME_PROCESS_TO_EXIT_MAXIMUM_MS;
	while (isProcessAlive(runtimeProcessId)) {
		if (Date.now() >= waitDeadlineEpochMs) {
			return false;
		}
		await sleep(WAIT_FOR_RUNTIME_PROCESS_TRANSITION_POLL_INTERVAL_MS);
	}
	return true;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runHandoverRestartCommand(options: {
	waitForSuccessorSeconds: string;
	allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost?: boolean;
	authorizedUnretainableSessionHandover?: string;
}): Promise<void> {
	const waitForSuccessorSeconds = Number(options.waitForSuccessorSeconds);
	if (!Number.isFinite(waitForSuccessorSeconds) || waitForSuccessorSeconds < 0) {
		throw new Error(
			`--wait-for-successor-seconds must be a non-negative number, got "${options.waitForSuccessorSeconds}"`,
		);
	}
	const authorizedUnretainableSessionHandover =
		options.authorizedUnretainableSessionHandover === undefined
			? undefined
			: authorizedUnretainableSessionHandoverSchema.parse(JSON.parse(options.authorizedUnretainableSessionHandover));
	const runtime = createRuntimeTrpcClient(null).runtime;
	const response = authorizedUnretainableSessionHandover
		? await runtime.requestPlannedHandoverRestartWithAuthorizedUnretainableSessions.mutate(
				authorizedUnretainableSessionHandover,
			)
		: await runtime.requestPlannedHandoverRestartPreservingHostedAgentSessions.mutate({
				allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost:
					options.allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost === true,
			});
	if (response.outcome !== "handover_restart_started") {
		printJson({
			ok: false,
			...response,
			...(!authorizedUnretainableSessionHandover &&
			response.outcome ===
				"refused_because_agent_sessions_not_preserved_by_agent_session_pty_host_would_be_interrupted"
				? {
						hint: "Some agent sessions are owned by the runtime process itself and would end. Re-run with --allow-interrupting-agent-sessions-not-preserved-by-agent-session-pty-host to restart anyway.",
					}
				: {}),
		});
		process.exitCode = 1;
		return;
	}
	const successorRuntimeWaitOutcome =
		waitForSuccessorSeconds > 0
			? await waitForSuccessorKanbanRuntimeToListen({
					previousRuntimeProcessId: response.runtimeProcessId,
					waitDeadlineEpochMs: Date.now() + waitForSuccessorSeconds * 1000,
				})
			: "not_waited";
	printJson({
		ok:
			successorRuntimeWaitOutcome === "successor_runtime_is_listening" ||
			successorRuntimeWaitOutcome === "not_waited",
		...response,
		successorRuntimeWaitOutcome,
	});
	if (
		successorRuntimeWaitOutcome !== "successor_runtime_is_listening" &&
		successorRuntimeWaitOutcome !== "not_waited"
	) {
		process.exitCode = 1;
	}
}

async function runStopTerminatingHostedAgentSessionsCommand(): Promise<void> {
	try {
		const response =
			await createRuntimeTrpcClient(null).runtime.requestRuntimeStopTerminatingHostedAgentSessions.mutate();
		const stoppedRuntimeProcessExited =
			response.outcome === "stop_started"
				? await waitForStoppedKanbanRuntimeProcessToExit(response.runtimeProcessId)
				: null;
		printJson({
			ok: response.outcome === "stop_started",
			path: "runtime_online",
			...response,
			stoppedRuntimeProcessExited,
		});
		if (response.outcome !== "stop_started") {
			process.exitCode = 1;
		}
		return;
	} catch (error) {
		if (!isRuntimeConnectionRefusedTransportError(error)) {
			throw error;
		}
	}
	const offlineTerminationResults =
		await terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline({
			runtimeIdentity: { runtimeHomeDirectoryPath: getRuntimeHomePath(), runtimePort: getKanbanRuntimePort() },
		});
	const someHostSkippedBecauseRuntimeIsConnected = offlineTerminationResults.some(
		(result) =>
			result.outcome === "skipped_because_a_kanban_runtime_is_connected_as_controller" ||
			result.outcome === "failed_to_reach_agent_session_pty_host",
	);
	printJson({
		ok: !someHostSkippedBecauseRuntimeIsConnected,
		path: "runtime_offline_direct_to_agent_session_pty_hosts",
		offlineTerminationResults,
		...(someHostSkippedBecauseRuntimeIsConnected
			? {
					hint: "A Kanban runtime is connected to an agent session pty host (probably starting up). Re-run this command once it is listening.",
				}
			: {}),
	});
	if (someHostSkippedBecauseRuntimeIsConnected) {
		process.exitCode = 1;
	}
}

export function registerRuntimeCommand(program: Command): void {
	const runtime = program
		.command("runtime")
		.description("Restart or stop the local Kanban runtime (port from KANBAN_RUNTIME_PORT, default 3484).");

	runtime
		.command("handover-restart")
		.description(
			"Hot-restart the runtime: agent sessions in the agent session pty host keep running and are adopted by the next runtime. The runtime exits with code 75 for its supervisor to restart it.",
		)
		.option(
			"--wait-for-successor-seconds <seconds>",
			"wait until the old runtime has exited and a new one is listening (0 = do not wait)",
			String(DEFAULT_CLI_RUNTIME_HANDOVER_SUCCESSOR_WAIT_SECONDS),
		)
		.option(
			"--allow-interrupting-agent-sessions-not-preserved-by-agent-session-pty-host",
			"restart even if some agent sessions are owned by the runtime process itself and will end",
		)
		.option(
			"--authorized-unretainable-session-handover <json>",
			"JSON binding of the verified runtime generation and the sessions this restart may interrupt",
		)
		.action(
			async (options: {
				waitForSuccessorSeconds: string;
				allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost?: boolean;
				authorizedUnretainableSessionHandover?: string;
			}) => {
				try {
					await runHandoverRestartCommand(options);
				} catch (error) {
					printJson({ ok: false, error: `Runtime handover restart failed: ${toErrorMessage(error)}` });
					process.exitCode = 1;
				}
			},
		);

	runtime
		.command("stop")
		.description(
			"Stop the runtime and terminate every agent session held by its agent session pty hosts. A plain SIGTERM only stops the runtime; agent sessions keep running.",
		)
		.option(
			"--terminate-hosted-agent-sessions",
			"required: also terminate the agent sessions (this cannot be undone)",
		)
		.action(async (options: { terminateHostedAgentSessions?: boolean }) => {
			if (options.terminateHostedAgentSessions !== true) {
				printJson({
					ok: false,
					error: "kanban runtime stop only exists to also terminate agent sessions; pass --terminate-hosted-agent-sessions. To stop the runtime but keep agent sessions running, send it SIGTERM.",
				});
				process.exitCode = 1;
				return;
			}
			try {
				await runStopTerminatingHostedAgentSessionsCommand();
			} catch (error) {
				printJson({ ok: false, error: `Runtime stop failed: ${toErrorMessage(error)}` });
				process.exitCode = 1;
			}
		});
}
