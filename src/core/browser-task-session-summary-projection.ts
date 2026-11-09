import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "./api-contract";

export function projectTaskSessionSummaryForBrowser(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	const {
		agentSessionForkReplayLaunchArguments: _launchArguments,
		codexNativeSessionControlEndpoint: _controlEndpoint,
		...browserSummary
	} = summary;
	return browserSummary;
}

export function projectWorkspaceStateForBrowser(state: RuntimeWorkspaceStateResponse): RuntimeWorkspaceStateResponse {
	return {
		...state,
		sessions: Object.fromEntries(
			Object.entries(state.sessions).map(([key, summary]) => [key, projectTaskSessionSummaryForBrowser(summary)]),
		),
	};
}

export function preserveRuntimeOnlySessionFieldsFromSameGeneration(
	persisted: RuntimeTaskSessionSummary,
	incoming: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	const sameGeneration = persisted.runtimeSessionIncarnationId
		? persisted.runtimeSessionIncarnationId === incoming.runtimeSessionIncarnationId
		: !incoming.runtimeSessionIncarnationId &&
			persisted.taskId === incoming.taskId &&
			persisted.workspacePath === incoming.workspacePath &&
			persisted.startedAt !== null &&
			persisted.startedAt === incoming.startedAt &&
			persisted.agentId === incoming.agentId;
	if (!sameGeneration) return incoming;
	return {
		...incoming,
		agentSessionForkReplayLaunchArguments: persisted.agentSessionForkReplayLaunchArguments,
		codexNativeSessionControlEndpoint: persisted.codexNativeSessionControlEndpoint,
	};
}
