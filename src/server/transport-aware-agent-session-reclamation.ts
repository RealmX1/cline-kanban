// 按 session transport 分派的会话回收动作。三种 transport 各自的停止手法完全不同，但**统一返回
// 同一形状的可审计结果**——于是「回收到底做成了没有」在 UI / 日志 / 测试里是同一套判据，而不是
// 各 transport 各说各话。
//
// 铁律：回收只终止运行时（进程 / 连接 / SDK 会话），**绝不动文件**。worktree、未提交改动、提交、
// 消息历史一律原样保留；UI 侧需要明确告诉用户这一点。

import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import type { RuntimeAgentSessionReclamationOutcome, RuntimeAgentSessionTransport } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	isProcessAlive,
	listSurvivingPids,
	snapshotDescendantPids,
} from "./agent-session-descendant-process-inspection";
import type { AgentSessionReclamationRequest } from "./agent-session-inactivity-reclamation-scheduler";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000;
const DEFAULT_FORCEFUL_TIMEOUT_MS = 500;

function resolveReclamationTrigger(
	request: AgentSessionReclamationRequest,
): RuntimeAgentSessionReclamationOutcome["reclamationTrigger"] {
	return request.record.retentionAnchorKind === "session_parked_awaiting_dispatched_background_work"
		? "park_abandoned"
		: "response_generation_grace_period_expired";
}

function buildBaseOutcome(
	request: AgentSessionReclamationRequest,
	sessionTransport: RuntimeAgentSessionTransport,
): RuntimeAgentSessionReclamationOutcome {
	return {
		runtimeSessionIncarnationId: request.record.runtimeSessionIncarnationId,
		sessionTransport,
		reclamationTrigger: resolveReclamationTrigger(request),
		attemptedAt: request.attemptedAt,
		completedAt: null,
		rootProcessExitConfirmed: false,
		descendantProcessesExitConfirmed: false,
		survivingDescendantPids: [],
		usedForcefulEscalation: false,
		releasedResources: [],
		failureReason: null,
		nextRetryAt: null,
	};
}

// ── dry-run（S2 / 回收开关关闭时）────────────────────────────────────────────────────────
// 只记审计、绝不真杀。用途：在第一次真正开杀之前，用真实负载观察「本来会回收谁」，避免上线即误杀。
// 刻意返回 failureReason: null（这不是失败）但 rootProcessExitConfirmed: false（也没有真的退出），
// 于是审计记录一眼就能看出这是一次演练。
export function createDryRunAgentSessionReclamationExecutor(options: { now?: () => number } = {}) {
	const now = options.now ?? (() => Date.now());
	return async (request: AgentSessionReclamationRequest): Promise<RuntimeAgentSessionReclamationOutcome> => {
		return {
			...buildBaseOutcome(request, request.record.sessionTransport),
			completedAt: now(),
			releasedResources: ["dry_run_no_resource_released"],
		};
	};
}

export interface TransportAwareAgentSessionReclamationDependencies {
	getTerminalManager: (workspaceId: string) => TerminalSessionManager | null;
	getAcpTaskSessionService: (workspaceId: string) => AcpTaskSessionService | null;
	now?: () => number;
	gracefulTimeoutMs?: number;
	forcefulTimeoutMs?: number;
	// 测试注入点：进程树枚举与存活探测。
	snapshotDescendantPids?: typeof snapshotDescendantPids;
	listSurvivingPids?: typeof listSurvivingPids;
	isProcessAlive?: (pid: number) => boolean;
}

export function createTransportAwareAgentSessionReclamationExecutor(
	dependencies: TransportAwareAgentSessionReclamationDependencies,
) {
	const now = dependencies.now ?? (() => Date.now());
	const gracefulTimeoutMs = dependencies.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
	const forcefulTimeoutMs = dependencies.forcefulTimeoutMs ?? DEFAULT_FORCEFUL_TIMEOUT_MS;
	const inspectDescendants = dependencies.snapshotDescendantPids ?? snapshotDescendantPids;
	const filterSurviving = dependencies.listSurvivingPids ?? listSurvivingPids;
	const probeAlive = dependencies.isProcessAlive ?? isProcessAlive;

	const reclaimPtyTerminalSession = async (
		request: AgentSessionReclamationRequest,
	): Promise<RuntimeAgentSessionReclamationOutcome> => {
		const outcome = buildBaseOutcome(request, "pty_terminal");
		const terminalManager = dependencies.getTerminalManager(request.workspaceId);
		if (!terminalManager) {
			// 该 workspace 的终端管理器已经不在了 ⇒ 进程随之而去，没有可回收的东西。
			return {
				...outcome,
				completedAt: now(),
				rootProcessExitConfirmed: true,
				descendantProcessesExitConfirmed: true,
			};
		}
		const rootPid = request.summary.pid;
		// 杀之前先快照后代 pid：进程一死，父子关系就查不到了，事后无从复核。
		const descendantPidsBeforeKill = rootPid !== null ? await inspectDescendants(rootPid) : [];

		// forceStopTaskSession 已有 SIGTERM →（graceful 窗口）→ SIGKILL → 轮询的升级逻辑，
		// 且 PTY 侧的信号本来就发给整个进程组（pty-session.ts 的 terminatePtyProcess）。
		await terminalManager.forceStopTaskSession(request.record.taskId, gracefulTimeoutMs);

		const rootProcessExitConfirmed = rootPid === null ? true : !probeAlive(rootPid);
		const survivingDescendantPids = filterSurviving(descendantPidsBeforeKill, { isProcessAlive: probeAlive });
		const failureReason = rootProcessExitConfirmed
			? survivingDescendantPids.length > 0
				? `SIGKILL 后仍有 ${survivingDescendantPids.length} 个后代进程存活`
				: null
			: `根进程 pid=${rootPid} 在 SIGKILL 后仍存活`;
		return {
			...outcome,
			completedAt: now(),
			rootProcessExitConfirmed,
			descendantProcessesExitConfirmed: survivingDescendantPids.length === 0,
			survivingDescendantPids,
			usedForcefulEscalation: true,
			releasedResources: ["pty", "terminal_state_mirror"],
			failureReason,
		};
	};

	const reclaimAcpSubprocessSession = async (
		request: AgentSessionReclamationRequest,
	): Promise<RuntimeAgentSessionReclamationOutcome> => {
		const outcome = buildBaseOutcome(request, "acp_stdio_subprocess");
		const service = dependencies.getAcpTaskSessionService(request.workspaceId);
		if (!service) {
			return {
				...outcome,
				completedAt: now(),
				rootProcessExitConfirmed: true,
				descendantProcessesExitConfirmed: true,
			};
		}
		const rootPid = request.summary.pid;
		const descendantPidsBeforeKill = rootPid !== null ? await inspectDescendants(rootPid) : [];
		const exitConfirmation = await service.stopTaskSessionForReclamation(request.record.taskId, {
			gracefulTimeoutMs,
			forcefulTimeoutMs,
		});
		const survivingDescendantPids = filterSurviving(descendantPidsBeforeKill, { isProcessAlive: probeAlive });
		const failureReason = exitConfirmation.rootProcessExitConfirmed
			? survivingDescendantPids.length > 0
				? `SIGKILL 后仍有 ${survivingDescendantPids.length} 个后代进程存活`
				: null
			: `ACP 子进程 pid=${exitConfirmation.rootPid ?? rootPid} 在 SIGKILL 后仍存活`;
		return {
			...outcome,
			completedAt: now(),
			rootProcessExitConfirmed: exitConfirmation.rootProcessExitConfirmed,
			descendantProcessesExitConfirmed: survivingDescendantPids.length === 0,
			survivingDescendantPids,
			usedForcefulEscalation: exitConfirmation.usedForcefulEscalation,
			releasedResources: ["acp_connection", "acp_agent_subprocess"],
			failureReason,
		};
	};

	return async (request: AgentSessionReclamationRequest): Promise<RuntimeAgentSessionReclamationOutcome> => {
		switch (request.record.sessionTransport) {
			case "pty_terminal":
				return await reclaimPtyTerminalSession(request);
			case "in_process_cline_sdk":
				return {
					...buildBaseOutcome(request, "in_process_cline_sdk"),
					completedAt: now(),
					failureReason: "Cline agent 已退役，无可回收的执行通道。",
				};
			case "acp_stdio_subprocess":
				return await reclaimAcpSubprocessSession(request);
			case "codex_app_server_subprocess":
				return {
					...buildBaseOutcome(request, "codex_app_server_subprocess"),
					completedAt: now(),
					failureReason: "Codex App Server 比较原型由独立隔离宿主持有，生产回收器未取得其执行所有权。",
				};
		}
	};
}
