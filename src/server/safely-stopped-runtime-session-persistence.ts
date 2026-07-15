import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	deriveSessionFacetsFromLegacyState,
	mergeSummaryWithFacets,
	resolveSessionFacets,
} from "../core/session-activity";
import { loadPersistedWorkspaceStateById, savePersistedWorkspaceSessionsById } from "../state/workspace-state";

export interface SafelyStoppedRuntimeSessionPersistenceResult {
	persistedSessionCount: number;
	workspaceStateRevision: number;
}

export function projectStoppedRuntimeSessionForSafePersistence(
	summary: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	const facets = resolveSessionFacets(summary);
	if (
		facets.turnOwner === "agent" &&
		(facets.liveness === "starting" || facets.liveness === "live" || facets.liveness === "retrying")
	) {
		const interruptedFacets = deriveSessionFacetsFromLegacyState("interrupted", {
			reviewReason: "interrupted",
			pid: null,
			connectionRetryActive: summary.connectionRetry != null,
			agentId: summary.agentId,
		});
		return mergeSummaryWithFacets(summary, {
			reviewReason: "interrupted",
			pid: null,
			updatedAt: Date.now(),
			turnOwner: interruptedFacets.turnOwner,
			liveness: interruptedFacets.liveness,
			userTurnKind: interruptedFacets.userTurnKind,
		});
	}

	if (facets.turnOwner === "user" && facets.liveness === "live") {
		return mergeSummaryWithFacets(summary, {
			pid: null,
			updatedAt: Date.now(),
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: facets.userTurnKind,
		});
	}

	return summary;
}

export async function persistSafelyStoppedRuntimeSessionsByWorkspaceId(
	workspaceId: string,
	runtimeSessionSummariesForSafePersistence: RuntimeTaskSessionSummary[],
): Promise<SafelyStoppedRuntimeSessionPersistenceResult> {
	const workspaceState = await loadPersistedWorkspaceStateById(workspaceId);
	if (runtimeSessionSummariesForSafePersistence.length === 0) {
		return {
			persistedSessionCount: 0,
			workspaceStateRevision: workspaceState.revision,
		};
	}

	const nextSessions = { ...workspaceState.sessions };
	for (const runtimeSessionSummary of runtimeSessionSummariesForSafePersistence) {
		const safelyProjectedSummary = projectStoppedRuntimeSessionForSafePersistence(runtimeSessionSummary);
		nextSessions[runtimeSessionSummary.taskId] = safelyProjectedSummary;
	}

	const workspaceStateRevision = await savePersistedWorkspaceSessionsById(
		workspaceId,
		nextSessions,
		workspaceState.revision,
	);
	return {
		persistedSessionCount: runtimeSessionSummariesForSafePersistence.length,
		workspaceStateRevision,
	};
}
