import type {
	RuntimeCrossProjectTaskSwitcherEntry,
	RuntimeProjectSummary,
	RuntimeTaskWorkspaceMetadata,
} from "../src/runtime/types";

export function createRecentTaskWorktreeMetadataTestFixture(
	taskId: string,
	overrides: Partial<RuntimeTaskWorkspaceMetadata> = {},
): RuntimeTaskWorkspaceMetadata {
	return {
		taskId,
		path: `/isolated/worktrees/${taskId}`,
		exists: true,
		baseRef: "main",
		baseCommit: "base-commit",
		commitsAheadOfBaseRef: 0,
		commitsBehindBaseRef: 0,
		workspaceGitStatus: {
			baseRef: "main",
			commitsAheadOfBaseRef: overrides.commitsAheadOfBaseRef ?? 0,
			commitsBehindBaseRef: overrides.commitsBehindBaseRef ?? 0,
			taskCommitsIntegratedIntoBaseRef: 0,
			taskCommitIntegrationTrackingStatus: "complete",
			observationSource: overrides.exists === false ? "persisted_final_snapshot" : "live_worktree",
			observedAt: Date.now(),
		},
		branch: `task-${taskId}`,
		isDetached: false,
		headCommit: "task-commit",
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		stateVersion: 1,
		...overrides,
	};
}

export function createRecentTaskWorktreeUnavailableGitProbeMetadataTestFixture(
	taskId: string,
): RuntimeTaskWorkspaceMetadata {
	return createRecentTaskWorktreeMetadataTestFixture(taskId, {
		baseCommit: null,
		commitsAheadOfBaseRef: null,
		commitsBehindBaseRef: null,
		workspaceGitStatus: {
			baseRef: "main",
			commitsAheadOfBaseRef: null,
			commitsBehindBaseRef: null,
			taskCommitsIntegratedIntoBaseRef: null,
			taskCommitIntegrationTrackingStatus: "git_probe_unavailable",
			observationSource: "unavailable",
			observedAt: null,
		},
		branch: null,
		headCommit: null,
		changedFiles: null,
		additions: null,
		deletions: null,
	});
}

export function createRecentTaskSwitcherEntryTestFixture(
	taskId: string,
	overrides: Partial<RuntimeCrossProjectTaskSwitcherEntry> = {},
): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		taskId,
		title: `测试任务 ${taskId}`,
		agentId: "codex",
		baseRef: "main",
		createdAt: Date.now() - 60_000,
		columnId: "review",
		turnOwner: null,
		liveness: "none",
		userTurnKind: null,
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		taskDescriptionLastUpdatedAt: Date.now() - 60_000,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		...overrides,
	};
}

export function createRecentTaskSwitcherProjectTestFixture(
	id: string,
	entries: RuntimeCrossProjectTaskSwitcherEntry[],
): RuntimeProjectSummary {
	return {
		id,
		name: id,
		path: `/isolated/${id}`,
		availability: { status: "available" },
		taskCounts: { backlog: 0, in_progress: 0, review: entries.length, validation: 0, trash: 0 },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: entries,
	};
}
