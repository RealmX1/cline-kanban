import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import type { TerminalSessionManager } from "../terminal/session-manager";

export interface ActiveTerminalAndClineRuntimeSessionShutdownDependencies {
	terminalManager: Pick<TerminalSessionManager, "listSummaries" | "markInterruptedAndStopAll"> | null;
	clineTaskSessionService: Pick<ClineTaskSessionService, "listSummaries" | "stopTaskSessionForSafeShutdown"> | null;
}

export interface ActiveRuntimeSessionShutdownResult {
	stoppedRuntimeSessionSummaries: RuntimeTaskSessionSummary[];
	runtimeSessionSummariesForSafePersistence: RuntimeTaskSessionSummary[];
}

function isRuntimeSessionBackedByAnActiveProcess(summary: RuntimeTaskSessionSummary): boolean {
	const { liveness } = resolveSessionFacets(summary);
	return liveness === "starting" || liveness === "live" || liveness === "retrying";
}

export async function stopActiveTerminalAndClineRuntimeSessionsForWorkspace(
	dependencies: ActiveTerminalAndClineRuntimeSessionShutdownDependencies,
): Promise<ActiveRuntimeSessionShutdownResult> {
	const stoppedRuntimeSessionSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	const runtimeSessionSummariesForSafePersistenceByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	for (const summary of dependencies.terminalManager?.listSummaries() ?? []) {
		runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, summary);
	}
	for (const summary of dependencies.terminalManager?.markInterruptedAndStopAll() ?? []) {
		stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, summary);
	}

	for (const summary of dependencies.clineTaskSessionService?.listSummaries() ?? []) {
		runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, summary);
		if (!isRuntimeSessionBackedByAnActiveProcess(summary)) {
			continue;
		}
		const safelyStoppedSummary = await dependencies.clineTaskSessionService?.stopTaskSessionForSafeShutdown(
			summary.taskId,
		);
		if (!safelyStoppedSummary) {
			throw new Error(`Could not safely stop loaded Cline runtime session for task ${summary.taskId}.`);
		}
		stoppedRuntimeSessionSummariesByTaskId.set(summary.taskId, safelyStoppedSummary);
		runtimeSessionSummariesForSafePersistenceByTaskId.set(summary.taskId, safelyStoppedSummary);
	}

	return {
		stoppedRuntimeSessionSummaries: Array.from(stoppedRuntimeSessionSummariesByTaskId.values()),
		runtimeSessionSummariesForSafePersistence: Array.from(runtimeSessionSummariesForSafePersistenceByTaskId.values()),
	};
}
