// runtime 为什么要退出，以及每种退出对 agent session PTY host 里的会话意味着什么。
//
// 用户 2026-10-05 定下的停止语义：runtime 无论怎么退出都不终止 hosted 会话（下次启动时接管），只有显式全停例外。
// 「怎么退出」分三种触发：
// - 进程信号（SIGINT / SIGTERM / SIGHUP）：Ctrl+C、supervisor 停机、终端关闭。会话保活，退出码照旧 130 / 143 / 129，
//   supervisor 看到 130 / 143 照旧停机——停的是 runtime，agent 继续跑（停止时打印保留会话数与全停命令）。
// - 计划内 handover 重启（`kanban runtime handover-restart` / SIGUSR2）：会话保活，exit 75，supervisor 立即重拉。
// - 显式全停（`kanban runtime stop --terminate-hosted-agent-sessions`）：终止全部 hosted 会话，按 SIGTERM 退出（143），
//   supervisor 不再重拉。
//
// 单一开关点：resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger。想回到「信号即终止」的旧语义，设
// KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS=terminate（只影响信号触发）。

import type { RuntimeAgentSessionCountsAffectedByRuntimeExit } from "./api-contract";

export const RUNTIME_SHUTDOWN_PROCESS_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type RuntimeShutdownProcessSignal = (typeof RUNTIME_SHUTDOWN_PROCESS_SIGNALS)[number];

// 与版本无关的 handover 兜底入口：handover procedure 调不通（例如新 CLI 对旧 runtime 的版本错位）时用它。
export const RUNTIME_PLANNED_HANDOVER_RESTART_PROCESS_SIGNAL = "SIGUSR2" as const;

// EX_TEMPFAIL：「临时退出，请立即重拉」。supervisor 据此跳过重拉前的等待。
export const KANBAN_RUNTIME_PLANNED_HANDOVER_RESTART_EXIT_CODE = 75;

// 信号没有“允许打断”的请求载荷；只在本次所有活 agent 会话都可由 host 保留时接受。
export function canAcceptPlannedHandoverRestartSignalWithoutInterruptingAgentSessions(input: {
	agentSessionPtyHostModeEnabled: boolean;
	agentSessionCountsAffectedByRuntimeExit: RuntimeAgentSessionCountsAffectedByRuntimeExit;
}): boolean {
	return (
		input.agentSessionPtyHostModeEnabled &&
		input.agentSessionCountsAffectedByRuntimeExit.agentSessionsWithPtyOwnedByRuntimeProcess === 0 &&
		input.agentSessionCountsAffectedByRuntimeExit.conversationAgentSessionsRunningInsideRuntimeProcess === 0
	);
}

export type RuntimeShutdownTrigger =
	| { kind: "process_signal"; signal: RuntimeShutdownProcessSignal }
	| {
			kind: "planned_handover_restart_preserving_hosted_agent_sessions";
			requestedVia: "runtime_trpc_procedure" | "process_signal_sigusr2";
	  }
	| { kind: "explicit_stop_terminating_hosted_agent_sessions"; requestedVia: "runtime_trpc_procedure" };

export type HostedAgentSessionDispositionForRuntimeShutdown =
	// 不发任何信号：会话留在 host 里，下一个 runtime 启动时接管（runtime 迟迟不回来时由 host 按回收期限孤儿回收）。
	| "detach_hosted_agent_sessions_for_successor_runtime"
	// 旧语义：停止全部会话（进程组 SIGTERM / SIGHUP），记为中断。
	| "terminate_hosted_agent_sessions";

export const KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS_ENVIRONMENT_VARIABLE_NAME =
	"KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS";

export function resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger(
	trigger: RuntimeShutdownTrigger,
	shutdownSignalDispositionEnvironmentValue: string | undefined,
): HostedAgentSessionDispositionForRuntimeShutdown {
	switch (trigger.kind) {
		case "planned_handover_restart_preserving_hosted_agent_sessions":
			return "detach_hosted_agent_sessions_for_successor_runtime";
		case "explicit_stop_terminating_hosted_agent_sessions":
			return "terminate_hosted_agent_sessions";
		case "process_signal":
			return shutdownSignalDispositionEnvironmentValue?.trim().toLowerCase() === "terminate"
				? "terminate_hosted_agent_sessions"
				: "detach_hosted_agent_sessions_for_successor_runtime";
	}
}

const PROCESS_SIGNAL_SHUTDOWN_DEADLINE_MS = 10_000;
// EXPERIMENT_NODE: handover 的总期限。排空在途投递、等启动期会话、逐会话 checkpoint 都在里面；超时以 exit 1 退出，
// 退化为崩溃路径（会话依旧由 host 持有，下一个 runtime 从环形缓冲重放接管）。
const PLANNED_HANDOVER_RESTART_SHUTDOWN_DEADLINE_MS = 30_000;
const EXPLICIT_STOP_SHUTDOWN_DEADLINE_MS = 15_000;

export function resolveRuntimeShutdownDeadlineMilliseconds(trigger: RuntimeShutdownTrigger): number {
	switch (trigger.kind) {
		case "process_signal":
			return PROCESS_SIGNAL_SHUTDOWN_DEADLINE_MS;
		case "planned_handover_restart_preserving_hosted_agent_sessions":
			return PLANNED_HANDOVER_RESTART_SHUTDOWN_DEADLINE_MS;
		case "explicit_stop_terminating_hosted_agent_sessions":
			return EXPLICIT_STOP_SHUTDOWN_DEADLINE_MS;
	}
}

// 关停完成后怎么结束进程：重放信号（让父进程看到「被该信号结束」，supervisor 的 130 / 143 判据依赖它），或按退出码退出。
export type RuntimeProcessTerminationAfterShutdown =
	| { kind: "reraise_process_signal"; signal: RuntimeShutdownProcessSignal }
	| { kind: "exit_with_code"; exitCode: number };

export function resolveRuntimeProcessTerminationAfterShutdown(
	trigger: RuntimeShutdownTrigger,
): RuntimeProcessTerminationAfterShutdown {
	switch (trigger.kind) {
		case "process_signal":
			return { kind: "reraise_process_signal", signal: trigger.signal };
		case "planned_handover_restart_preserving_hosted_agent_sessions":
			return { kind: "exit_with_code", exitCode: KANBAN_RUNTIME_PLANNED_HANDOVER_RESTART_EXIT_CODE };
		case "explicit_stop_terminating_hosted_agent_sessions":
			// 与 SIGTERM 停机同一结局：supervisor 不再重拉。
			return { kind: "reraise_process_signal", signal: "SIGTERM" };
	}
}

export function describeRuntimeShutdownTrigger(trigger: RuntimeShutdownTrigger): string {
	switch (trigger.kind) {
		case "process_signal":
			return trigger.signal;
		case "planned_handover_restart_preserving_hosted_agent_sessions":
			return `planned handover restart (${trigger.requestedVia})`;
		case "explicit_stop_terminating_hosted_agent_sessions":
			return `explicit stop terminating hosted agent sessions (${trigger.requestedVia})`;
	}
}
