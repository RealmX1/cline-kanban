import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { applySessionFacets, projectLegacyState } from "../../src/core/session-activity";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture";

async function withIsolatedGitWorkspaceHome<T>(
	run: (context: { gitFixture: IsolatedGitTestWorkspaceFixture }) => Promise<T>,
): Promise<T> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const tempHome = gitFixture.isolatedHomeDirectoryPath;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run({ gitFixture });
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		gitFixture.cleanup();
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(taskId: string, state: "running" | "awaiting_review" | "idle"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe.sequential("shutdown coordinator integration", () => {
	it("preserves every board and leaves unloaded indexed workspaces untouched on shutdown", async () => {
		await withIsolatedGitWorkspaceHome(async ({ gitFixture }) => {
			const managedProjectPath = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "managed-project",
			}).repositoryPath;
			const indexedProjectPath = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "indexed-project",
			}).repositoryPath;

			const managedInitial = await loadWorkspaceState(managedProjectPath);
			await saveWorkspaceState(managedProjectPath, {
				board: createBoard({
					inProgress: ["managed-running", "managed-missing-session"],
					review: ["managed-idle"],
				}),
				sessions: {
					"managed-running": createSession("managed-running", "running"),
					"managed-idle": createSession("managed-idle", "idle"),
				},
				expectedRevision: managedInitial.revision,
			});

			const indexedInitial = await loadWorkspaceState(indexedProjectPath);
			await saveWorkspaceState(indexedProjectPath, {
				board: createBoard({
					inProgress: ["indexed-missing-session"],
					review: ["indexed-awaiting-review"],
				}),
				sessions: {
					"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
				},
				expectedRevision: indexedInitial.revision,
			});
			const managedStateBeforeShutdown = await loadWorkspaceState(managedProjectPath);
			const indexedStateBeforeShutdown = await loadWorkspaceState(indexedProjectPath);

			let didCloseRuntimeServer = false;
			const managedRunningSummary = createSession("managed-running", "running");
			const stopAllActiveRuntimeSessionsForShutdown = vi.fn(async () => [
				{
					workspaceId: "managed-project",
					workspacePath: managedProjectPath,
					stoppedRuntimeSessionSummaries: [managedRunningSummary],
					runtimeSessionSummariesForSafePersistence: [managedRunningSummary],
				},
			]);
			await shutdownRuntimeServer({
				stopAllActiveRuntimeSessionsForShutdown,
				warn: () => {},
				closeRuntimeServer: async () => {
					didCloseRuntimeServer = true;
				},
			});

			expect(didCloseRuntimeServer).toBe(true);
			expect(stopAllActiveRuntimeSessionsForShutdown).toHaveBeenCalledTimes(1);

			const managedAfter = await loadWorkspaceState(managedProjectPath);
			expect(managedAfter.board).toEqual(managedStateBeforeShutdown.board);
			expect(managedAfter.sessions["managed-running"]?.state).toBe("interrupted");
			expect(managedAfter.sessions["managed-idle"]?.state).toBe("idle");
			expect(managedAfter.sessions["managed-missing-session"]).toBeUndefined();

			const indexedAfter = await loadWorkspaceState(indexedProjectPath);
			expect(indexedAfter.board).toEqual(indexedStateBeforeShutdown.board);
			expect(indexedAfter.sessions).toEqual(indexedStateBeforeShutdown.sessions);
			expect(indexedAfter.revision).toBe(indexedStateBeforeShutdown.revision);
			expect(indexedAfter.sessions["indexed-missing-session"]).toBeUndefined();
		});
	}, 30_000);

	it("projects stopped live PTYs without changing card columns or user-owned turn meaning", async () => {
		await withIsolatedGitWorkspaceHome(async ({ gitFixture }) => {
			const projectPath = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "facet-project",
			}).repositoryPath;

			const initial = await loadWorkspaceState(projectPath);
			const runningSummary = applySessionFacets(createSession("running-task", "running"));
			const awaitingUserSummary = applySessionFacets(createSession("awaiting-user-task", "awaiting_review"));
			const idleSummary = applySessionFacets(createSession("idle-task", "idle"));
			await saveWorkspaceState(projectPath, {
				board: createBoard({
					inProgress: ["running-task"],
					review: ["awaiting-user-task", "idle-task"],
				}),
				sessions: {
					"running-task": runningSummary,
					"awaiting-user-task": awaitingUserSummary,
					"idle-task": idleSummary,
				},
				expectedRevision: initial.revision,
			});
			const stateBeforeShutdown = await loadWorkspaceState(projectPath);

			await shutdownRuntimeServer({
				stopAllActiveRuntimeSessionsForShutdown: async () => [
					{
						workspaceId: "facet-project",
						workspacePath: projectPath,
						stoppedRuntimeSessionSummaries: [runningSummary],
						runtimeSessionSummariesForSafePersistence: [runningSummary, awaitingUserSummary, idleSummary],
					},
				],
				warn: () => {},
				closeRuntimeServer: async () => {},
			});

			const after = await loadWorkspaceState(projectPath);
			expect(after.board).toEqual(stateBeforeShutdown.board);
			expect(after.sessions["running-task"]).toEqual(
				expect.objectContaining({
					state: "interrupted",
					turnOwner: "user",
					liveness: "interrupted",
					userTurnKind: "interrupted",
					pid: null,
				}),
			);
			expect(after.sessions["awaiting-user-task"]).toEqual(
				expect.objectContaining({
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: awaitingUserSummary.userTurnKind,
					reviewReason: awaitingUserSummary.reviewReason,
					pid: null,
				}),
			);
			expect(after.sessions["idle-task"]).toEqual(idleSummary);
			for (const taskId of ["running-task", "awaiting-user-task", "idle-task"]) {
				const persisted = after.sessions[taskId];
				expect(persisted).toBeDefined();
				if (persisted) {
					expect(
						projectLegacyState({
							turnOwner: persisted.turnOwner ?? null,
							liveness: persisted.liveness ?? "none",
							userTurnKind: persisted.userTurnKind ?? null,
						}),
					).toBe(persisted.state);
				}
			}
		});
	}, 30_000);
});
