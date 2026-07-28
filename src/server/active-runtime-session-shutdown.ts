import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import type { TerminalSessionManager } from "../terminal/session-manager";

export interface ActiveTerminalClineAndAcpRuntimeSessionShutdownDependencies {
	terminalManager: Pick<TerminalSessionManager, "listSummaries" | "markInterruptedAndStopAll"> | null;
	clineTaskSessionService: Pick<ClineTaskSessionService, "listSummaries" | "stopTaskSessionForSafeShutdown"> | null;
	// ACP agent（omp 等）是持有 stdio 的真子进程：漏掉它，永久删项目会在 worktree 已被删掉之后
	// 才拆连接，正常关服也会留下还能继续改仓库、并阻塞 Kanban 退出的 agent 进程。
	acpTaskSessionService: Pick<AcpTaskSessionService, "listSummaries" | "stopTaskSession"> | null;
}

export interface ActiveRuntimeSessionShutdownResult {
	stoppedRuntimeSessionSummaries: RuntimeTaskSessionSummary[];
	runtimeSessionSummariesForSafePersistence: RuntimeTaskSessionSummary[];
}

// Cline SDK 与 ACP 都是「会话服务」形态（非 PTY），安全停机的形状完全一致、只有停机方法名不同，
// 所以归一成同一种来源，免得每接一个非 PTY harness 就再抄一遍同样的循环。
interface ConversationRuntimeSessionShutdownSource {
	// 停机失败时用来指认是哪一类 harness 没停干净。
	harnessLabel: string;
	listSummaries(): RuntimeTaskSessionSummary[];
	stopTaskSessionForSafeShutdown(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
}

function isRuntimeSessionBackedByAnActiveProcess(summary: RuntimeTaskSessionSummary): boolean {
	const { liveness } = resolveSessionFacets(summary);
	return liveness === "starting" || liveness === "live" || liveness === "retrying";
}

function collectConversationRuntimeSessionShutdownSources(
	dependencies: ActiveTerminalClineAndAcpRuntimeSessionShutdownDependencies,
): ConversationRuntimeSessionShutdownSource[] {
	const sources: ConversationRuntimeSessionShutdownSource[] = [];
	const { clineTaskSessionService, acpTaskSessionService } = dependencies;
	if (clineTaskSessionService) {
		sources.push({
			harnessLabel: "Cline",
			listSummaries: () => clineTaskSessionService.listSummaries(),
			stopTaskSessionForSafeShutdown: async (taskId) =>
				await clineTaskSessionService.stopTaskSessionForSafeShutdown(taskId),
		});
	}
	if (acpTaskSessionService) {
		sources.push({
			harnessLabel: "ACP",
			listSummaries: () => acpTaskSessionService.listSummaries(),
			stopTaskSessionForSafeShutdown: async (taskId) => await acpTaskSessionService.stopTaskSession(taskId),
		});
	}
	return sources;
}

export async function stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace(
	dependencies: ActiveTerminalClineAndAcpRuntimeSessionShutdownDependencies,
): Promise<ActiveRuntimeSessionShutdownResult> {
	const stoppedRuntimeSessionSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	const runtimeSessionSummariesForSafePersistenceByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	for (const summary of dependencies.terminalManager?.listSummaries() ?? []) {
		runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, summary);
	}
	for (const summary of dependencies.terminalManager?.markInterruptedAndStopAll() ?? []) {
		stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, summary);
	}

	for (const source of collectConversationRuntimeSessionShutdownSources(dependencies)) {
		for (const summary of source.listSummaries()) {
			runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, summary);
			if (!isRuntimeSessionBackedByAnActiveProcess(summary)) {
				continue;
			}
			const safelyStoppedSummary = await source.stopTaskSessionForSafeShutdown(summary.taskId);
			if (!safelyStoppedSummary) {
				throw new Error(
					`Could not safely stop loaded ${source.harnessLabel} runtime session for task ${summary.taskId}.`,
				);
			}
			stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, safelyStoppedSummary);
			runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, safelyStoppedSummary);
		}
	}

	return {
		stoppedRuntimeSessionSummaries: Array.from(stoppedRuntimeSessionSummariesByTaskId.values()),
		runtimeSessionSummariesForSafePersistence: Array.from(runtimeSessionSummariesForSafePersistenceByTaskId.values()),
	};
}
