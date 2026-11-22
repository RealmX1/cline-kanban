import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import type { AuthorizedUnretainableHandoverSession, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { HostedAgentSessionDispositionForRuntimeShutdown } from "../core/runtime-shutdown-trigger";
import { nonPtySessionWouldEndWhenRuntimeExits } from "../core/session-activity";
import type { TerminalSessionManager } from "../terminal/session-manager";

export interface ActiveTerminalAndAcpRuntimeSessionShutdownDependencies {
	terminalManager:
		| (Pick<
				TerminalSessionManager,
				"listSummaries" | "markInterruptedAndStopAll" | "detachHostedPtySessionsForRuntimeHandover"
		  > &
				Partial<Pick<TerminalSessionManager, "flushAutomaticFailureContinuationPersistence">>)
		| null;
	// ACP agent（omp 等）是持有 stdio 的真子进程：漏掉它，永久删项目会在 worktree 已被删掉之后
	// 才拆连接，正常关服也会留下还能继续改仓库、并阻塞 Kanban 退出的 agent 进程。
	acpTaskSessionService:
		| (ConversationRuntimeExitSessionSource & Pick<AcpTaskSessionService, "stopTaskSession">)
		| null;
	// runtime 退出时 agent session PTY host 里的会话怎么办。缺省终止：永久删项目、整体重置之类的路径
	// （worktree 都要删了）必须把会话停掉；只有 runtime 退出（handover / 信号停止）才传 detach。
	// Cline SDK 与 ACP 会话不在 host 里，无论哪种都照旧安全停止。
	hostedAgentSessionDisposition?: HostedAgentSessionDispositionForRuntimeShutdown;
	// detach 时每条 hosted 会话的孤儿回收期限（runtime 迟迟不回来时 host 按它回收）；缺省一律不回收。
	readHostedSessionOrphanReclamationEligibleAtEpochMs?: (summary: RuntimeTaskSessionSummary) => number | null;
}

export interface ActiveRuntimeSessionShutdownResult {
	stoppedRuntimeSessionSummaries: RuntimeTaskSessionSummary[];
	runtimeSessionSummariesForSafePersistence: RuntimeTaskSessionSummary[];
	// detach 时留给下一个 runtime 接管的 hosted 会话（停止时据此打印保留数量）。
	detachedHostedAgentSessionSummaries?: RuntimeTaskSessionSummary[];
}

export type ConversationRuntimeExitSessionSource = Pick<AcpTaskSessionService, "listSummaries"> &
	Partial<Pick<AcpTaskSessionService, "hasLiveTaskSession" | "getStartingTaskSessionProcessOwnership">>;

function readConversationSessionRuntimeExitImpact(
	source: ConversationRuntimeExitSessionSource,
	summary: RuntimeTaskSessionSummary,
): Pick<
	AuthorizedUnretainableHandoverSession,
	"processId" | "runtimeSessionIncarnationId" | "nativeConversationSessionId"
> | null {
	// 重开可先发布新摘要，再创建进程。握手中的 PID 与代际必须来自同一条连接。
	const startingProcessOwnership = source.getStartingTaskSessionProcessOwnership?.(summary.taskId);
	if (startingProcessOwnership) return startingProcessOwnership;
	return nonPtySessionWouldEndWhenRuntimeExits(summary, {
		hasLiveConnection: source.hasLiveTaskSession?.(summary.taskId) ?? null,
	})
		? {
				processId: summary.pid,
				runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
				nativeConversationSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
			}
		: null;
}

export function listConversationSessionsInterruptedByRuntimeExit(
	workspaceId: string,
	source: ConversationRuntimeExitSessionSource,
) {
	return source.listSummaries().flatMap((summary) => {
		const sessionKind = summary.sessionTransport;
		if (sessionKind !== "acp_stdio_subprocess" && sessionKind !== "in_process_cline_sdk") return [];
		const runtimeExitImpact = readConversationSessionRuntimeExitImpact(source, summary);
		if (!runtimeExitImpact) return [];
		return [
			{
				workspaceId,
				conversationSessionId: summary.taskId,
				...runtimeExitImpact,
				sessionKind,
			},
		];
	});
}

export function countAcpTaskSessionsInterruptedByRuntimeExit(
	acpTaskSessionServices: Iterable<ConversationRuntimeExitSessionSource>,
): number {
	let interruptedAcpTaskSessionCount = 0;
	for (const source of acpTaskSessionServices) {
		interruptedAcpTaskSessionCount += source
			.listSummaries()
			.filter((summary) => readConversationSessionRuntimeExitImpact(source, summary) !== null).length;
	}
	return interruptedAcpTaskSessionCount;
}

export async function stopActiveTerminalAndAcpRuntimeSessionsForWorkspace(
	dependencies: ActiveTerminalAndAcpRuntimeSessionShutdownDependencies,
): Promise<ActiveRuntimeSessionShutdownResult> {
	const stoppedRuntimeSessionSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	const runtimeSessionSummariesForSafePersistenceByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	let detachedHostedAgentSessionSummaries: RuntimeTaskSessionSummary[] | undefined;
	for (const summary of dependencies.terminalManager?.listSummaries() ?? []) {
		runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, summary);
	}
	if (dependencies.hostedAgentSessionDisposition === "detach_hosted_agent_sessions_for_successor_runtime") {
		const detachResult = await dependencies.terminalManager?.detachHostedPtySessionsForRuntimeHandover({
			readHostedSessionOrphanReclamationEligibleAtEpochMs:
				dependencies.readHostedSessionOrphanReclamationEligibleAtEpochMs ?? (() => null),
		});
		for (const summary of detachResult?.interruptedInProcessSessionSummaries ?? []) {
			stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, summary);
		}
		detachedHostedAgentSessionSummaries = detachResult?.detachedHostedSessionSummaries ?? [];
	} else {
		for (const summary of dependencies.terminalManager?.markInterruptedAndStopAll() ?? []) {
			stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, summary);
		}
	}
	await dependencies.terminalManager?.flushAutomaticFailureContinuationPersistence?.();

	const { acpTaskSessionService } = dependencies;
	if (acpTaskSessionService) {
		for (const summary of acpTaskSessionService.listSummaries()) {
			runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, summary);
			if (!readConversationSessionRuntimeExitImpact(acpTaskSessionService, summary)) {
				continue;
			}
			const safelyStoppedSummary = await acpTaskSessionService.stopTaskSession(summary.taskId);
			if (!safelyStoppedSummary) {
				throw new Error(`Could not safely stop loaded ACP runtime session for task ${summary.taskId}.`);
			}
			stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, safelyStoppedSummary);
			runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, safelyStoppedSummary);
		}
	}

	return {
		stoppedRuntimeSessionSummaries: Array.from(stoppedRuntimeSessionSummariesByTaskId.values()),
		runtimeSessionSummariesForSafePersistence: Array.from(runtimeSessionSummariesForSafePersistenceByTaskId.values()),
		...(detachedHostedAgentSessionSummaries !== undefined ? { detachedHostedAgentSessionSummaries } : {}),
	};
}
