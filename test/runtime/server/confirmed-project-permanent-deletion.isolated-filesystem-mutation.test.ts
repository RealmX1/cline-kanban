import { readdir, stat } from "node:fs/promises";
import { basename } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	type ConfirmedProjectPermanentDeletionServiceDependencies,
	createConfirmedProjectPermanentDeletionService,
} from "../../../src/server/confirmed-project-permanent-deletion";
import {
	getWorkspaceDirectoryPath,
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../../src/state/workspace-state";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../../dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture";
import { createProtectedFilesystemMutationTestFixture } from "../../dangerous-capability-test-infrastructure/protected-filesystem-mutation-test-fixture";

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(taskIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: taskIds.slice(0, 1).map(createCard) },
			{ id: "in_progress", title: "In Progress", cards: taskIds.slice(1).map(createCard) },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(taskId: string, state: "running" | "idle"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: state === "running" ? "codex" : null,
		workspacePath: state === "running" ? `/tmp/${taskId}` : null,
		pid: state === "running" ? 1234 : null,
		startedAt: state === "running" ? 1 : null,
		updatedAt: 1,
		lastOutputAt: state === "running" ? 1 : null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function createServiceDependencies(
	overrides: Partial<ConfirmedProjectPermanentDeletionServiceDependencies> = {},
): ConfirmedProjectPermanentDeletionServiceDependencies {
	return {
		getActiveWorkspaceId: vi.fn(() => "project-1"),
		setActiveWorkspace: vi.fn(async () => {}),
		clearActiveWorkspace: vi.fn(),
		listProjectRuntimeSessionSummaries: vi.fn(() => []),
		stopAndCollectProjectRuntimeSessionsForSafePersistence: vi.fn(async () => ({
			stoppedRuntimeSessionSummaries: [],
			runtimeSessionSummariesForSafePersistence: [],
		})),
		disposeProjectRuntime: vi.fn(async () => {}),
		broadcastRuntimeProjectsUpdated: vi.fn(async () => {}),
		warn: vi.fn(),
		isWorkspaceStateDirectorySafeForPermanentDeletion: vi.fn(async () => true),
		...overrides,
	};
}

async function withProtectedFilesystemMutationHome<T>(
	run: (context: { gitFixture: IsolatedGitTestWorkspaceFixture }) => Promise<T>,
): Promise<T> {
	const filesystemFixture = createProtectedFilesystemMutationTestFixture();
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const temporaryHomePath = filesystemFixture.createOwnedMutationDirectory({
		ownedDirectoryName: "permanent-deletion-isolated-home",
	});
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = temporaryHomePath;
	process.env.USERPROFILE = temporaryHomePath;
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
		filesystemFixture.assertProtectedCanariesIntact();
		gitFixture.cleanup();
		filesystemFixture.cleanup();
	}
}

describe.sequential("confirmed project permanent deletion", () => {
	it("builds a revision-bound preview with task, active-session, and verified worktree counts", async () => {
		const board = createBoard(["task-a", "task-b"]);
		const service = createConfirmedProjectPermanentDeletionService(
			createServiceDependencies({
				listWorkspaceIndexEntries: vi.fn(async () => [
					{ workspaceId: "project-1", repoPath: "/missing/project-1" },
				]),
				loadPersistedWorkspaceStateById: vi.fn(async () => ({
					workspaceId: "project-1",
					statePath: "/state/project-1",
					board,
					sessions: {
						"task-a": createSession("task-a", "running"),
						"task-b": createSession("task-b", "idle"),
					},
					revision: 7,
				})),
				getTaskWorkspacePathInfo: vi.fn(async ({ taskId, baseRef }) => ({
					taskId,
					path: `/worktrees/${taskId}`,
					exists: taskId === "task-a",
					baseRef,
				})),
			}),
		);

		const response = await service.getPermanentDeletionPreview({ projectId: "project-1" });
		expect(response.ok).toBe(true);
		if (!response.ok) {
			throw new Error(response.error);
		}
		expect(response.preview).toMatchObject({
			projectId: "project-1",
			projectName: "project-1",
			projectPath: "/missing/project-1",
			workspaceStateRevision: 7,
			totalTaskCount: 2,
			activeSessionCount: 1,
			managedWorktreeCount: 1,
			deletionAllowed: true,
			blockingReasons: [],
			requiredConfirmationProjectName: "project-1",
		});
	});

	it("rejects a mismatched project name and a stale revision before stopping sessions", async () => {
		const stopAndCollectProjectRuntimeSessionsForSafePersistence = vi.fn(async () => ({
			stoppedRuntimeSessionSummaries: [],
			runtimeSessionSummariesForSafePersistence: [],
		}));
		const service = createConfirmedProjectPermanentDeletionService(
			createServiceDependencies({
				stopAndCollectProjectRuntimeSessionsForSafePersistence,
				listWorkspaceIndexEntries: vi.fn(async () => [
					{ workspaceId: "project-1", repoPath: "/projects/project-1" },
				]),
				loadPersistedWorkspaceStateById: vi.fn(async () => ({
					workspaceId: "project-1",
					statePath: "/state/project-1",
					board: createBoard([]),
					sessions: {},
					revision: 7,
				})),
			}),
		);

		const nameMismatch = await service.permanentlyDeleteProjectData({
			projectId: "project-1",
			expectedWorkspaceStateRevision: 7,
			confirmationProjectName: "PROJECT-1",
		});
		expect(nameMismatch.failureCode).toBe("confirmation_project_name_mismatch");

		const stalePreview = await service.permanentlyDeleteProjectData({
			projectId: "project-1",
			expectedWorkspaceStateRevision: 6,
			confirmationProjectName: "project-1",
		});
		expect(stalePreview.failureCode).toBe("preview_stale");
		expect(stopAndCollectProjectRuntimeSessionsForSafePersistence).not.toHaveBeenCalled();
	});

	it("blocks deletion when workspace state or managed worktree impact cannot be verified", async () => {
		const corruptedStateService = createConfirmedProjectPermanentDeletionService(
			createServiceDependencies({
				listWorkspaceIndexEntries: vi.fn(async () => [
					{ workspaceId: "project-1", repoPath: "/projects/project-1" },
				]),
				loadPersistedWorkspaceStateById: vi.fn(async () => {
					throw new Error("malformed board.json");
				}),
			}),
		);
		const corruptedStatePreview = await corruptedStateService.getPermanentDeletionPreview({
			projectId: "project-1",
		});
		expect(corruptedStatePreview).toMatchObject({
			ok: true,
			preview: {
				workspaceStateRevision: null,
				deletionAllowed: false,
				blockingReasons: ["workspace_state_could_not_be_verified"],
			},
		});

		const unverifiedWorktreeService = createConfirmedProjectPermanentDeletionService(
			createServiceDependencies({
				listWorkspaceIndexEntries: vi.fn(async () => [
					{ workspaceId: "project-1", repoPath: "/projects/project-1" },
				]),
				loadPersistedWorkspaceStateById: vi.fn(async () => ({
					workspaceId: "project-1",
					statePath: "/state/project-1",
					board: createBoard(["task-a"]),
					sessions: {},
					revision: 7,
				})),
				getTaskWorkspacePathInfo: vi.fn(async () => {
					throw new Error("worktree path inspection failed");
				}),
			}),
		);
		const unverifiedWorktreePreview = await unverifiedWorktreeService.getPermanentDeletionPreview({
			projectId: "project-1",
		});
		expect(unverifiedWorktreePreview).toMatchObject({
			ok: true,
			preview: {
				workspaceStateRevision: 7,
				deletionAllowed: false,
				blockingReasons: ["managed_worktrees_could_not_be_verified"],
			},
		});
	});

	it("blocks an indexed workspace ID whose state path is not a direct child of the workspaces root", async () => {
		const loadPersistedWorkspaceStateById = vi.fn();
		const service = createConfirmedProjectPermanentDeletionService(
			createServiceDependencies({
				listWorkspaceIndexEntries: vi.fn(async () => [
					{ workspaceId: "../outside", repoPath: "/projects/project-1" },
				]),
				loadPersistedWorkspaceStateById,
				isWorkspaceStateDirectorySafeForPermanentDeletion: vi.fn(async () => false),
			}),
		);

		const response = await service.getPermanentDeletionPreview({ projectId: "../outside" });
		expect(response).toMatchObject({
			ok: true,
			preview: {
				workspaceStateRevision: null,
				deletionAllowed: false,
				blockingReasons: ["workspace_state_directory_path_is_unsafe"],
			},
		});
		expect(loadPersistedWorkspaceStateById).not.toHaveBeenCalled();
	});

	it("retains project state and index when any verified worktree deletion fails", async () => {
		const stageWorkspaceStateDirectoryAndRemoveProjectIndex = vi.fn(async () => ({
			originalWorkspaceStateDirectoryPath: "/state/project-1",
			stagingWorkspaceStateDirectoryPath: "/state/project-1.pending",
		}));
		const service = createConfirmedProjectPermanentDeletionService(
			createServiceDependencies({
				listWorkspaceIndexEntries: vi.fn(async () => [
					{ workspaceId: "project-1", repoPath: "/projects/project-1" },
				]),
				loadPersistedWorkspaceStateById: vi.fn(async () => ({
					workspaceId: "project-1",
					statePath: "/state/project-1",
					board: createBoard(["task-a"]),
					sessions: {},
					revision: 7,
				})),
				getTaskWorkspacePathInfo: vi.fn(async ({ taskId, baseRef }) => ({
					taskId,
					path: `/worktrees/${taskId}`,
					exists: true,
					baseRef,
				})),
				deleteTaskWorktree: vi.fn(async () => ({ ok: false, removed: false, error: "permission denied" })),
				persistSafelyStoppedRuntimeSessionsByWorkspaceId: vi.fn(async () => ({
					persistedSessionCount: 0,
					workspaceStateRevision: 7,
				})),
				stageWorkspaceStateDirectoryAndRemoveProjectIndex,
			}),
		);

		const result = await service.permanentlyDeleteProjectData({
			projectId: "project-1",
			expectedWorkspaceStateRevision: 7,
			confirmationProjectName: "project-1",
		});

		expect(result.status).toBe("aborted_before_project_data_deletion");
		expect(result.failureCode).toBe("managed_worktree_deletion_failed");
		expect(result.projectIndexDeleted).toBe(false);
		expect(result.workspaceStateDirectoryDeleted).toBe(false);
		expect(result.worktreeDeletionResults).toEqual([
			{
				taskId: "task-a",
				path: "/worktrees/task-a",
				ok: false,
				removed: false,
				error: "permission denied",
			},
		]);
		expect(stageWorkspaceStateDirectoryAndRemoveProjectIndex).not.toHaveBeenCalled();
	});

	it("restores the original state directory when the index write fails", { timeout: 30_000 }, async () => {
		await withProtectedFilesystemMutationHome(async ({ gitFixture }) => {
			const projectPath = gitFixture.createNonBareRepository({
				repositoryDirectoryName: "index-rollback-project",
			}).repositoryPath;
			const context = await loadWorkspaceContext(projectPath);
			const initialState = await loadWorkspaceState(projectPath);
			await saveWorkspaceState(projectPath, {
				board: createBoard([]),
				sessions: {},
				expectedRevision: initialState.revision,
			});

			const service = createConfirmedProjectPermanentDeletionService(
				createServiceDependencies({
					getActiveWorkspaceId: vi.fn(() => context.workspaceId),
					getTaskWorkspacePathInfo: vi.fn(async ({ taskId, baseRef }) => ({
						taskId,
						path: `/worktrees/${taskId}`,
						exists: false,
						baseRef,
					})),
					removeWorkspaceIndexEntry: vi.fn(async () => {
						throw new Error("simulated index write failure");
					}),
				}),
			);
			const previewResponse = await service.getPermanentDeletionPreview({ projectId: context.workspaceId });
			if (!previewResponse.ok || previewResponse.preview.workspaceStateRevision === null) {
				throw new Error("Expected a valid deletion preview.");
			}

			const result = await service.permanentlyDeleteProjectData({
				projectId: context.workspaceId,
				expectedWorkspaceStateRevision: previewResponse.preview.workspaceStateRevision,
				confirmationProjectName: basename(projectPath),
			});

			expect(result.failureCode).toBe("workspace_index_deletion_failed");
			expect(await stat(getWorkspaceDirectoryPath(context.workspaceId))).toBeDefined();
			expect((await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toContain(context.workspaceId);
			expect(
				(await readdir(getWorkspacesRootPath())).some((name) => name.includes("pending-permanent-deletion")),
			).toBe(false);
			await expect(loadPersistedWorkspaceStateById(context.workspaceId)).resolves.toBeDefined();
		});
	});

	it(
		"reports a stage-specific stale result after managed worktrees were already deleted",
		{ timeout: 30_000 },
		async () => {
			await withProtectedFilesystemMutationHome(async ({ gitFixture }) => {
				const projectPath = gitFixture.createNonBareRepository({
					repositoryDirectoryName: "post-worktree-stale-project",
				}).repositoryPath;
				const context = await loadWorkspaceContext(projectPath);
				const initialState = await loadWorkspaceState(projectPath);
				await saveWorkspaceState(projectPath, {
					board: createBoard(["task-a"]),
					sessions: {},
					expectedRevision: initialState.revision,
				});
				const deleteTaskWorktree = vi.fn(async () => {
					const concurrentState = await loadWorkspaceState(projectPath);
					await saveWorkspaceState(projectPath, {
						board: concurrentState.board,
						sessions: concurrentState.sessions,
						expectedRevision: concurrentState.revision,
					});
					return { ok: true, removed: true };
				});
				const service = createConfirmedProjectPermanentDeletionService(
					createServiceDependencies({
						getActiveWorkspaceId: vi.fn(() => context.workspaceId),
						getTaskWorkspacePathInfo: vi.fn(async ({ taskId, baseRef }) => ({
							taskId,
							path: `/worktrees/${taskId}`,
							exists: true,
							baseRef,
						})),
						deleteTaskWorktree,
					}),
				);
				const previewResponse = await service.getPermanentDeletionPreview({ projectId: context.workspaceId });
				if (!previewResponse.ok || previewResponse.preview.workspaceStateRevision === null) {
					throw new Error("Expected a valid deletion preview.");
				}

				const result = await service.permanentlyDeleteProjectData({
					projectId: context.workspaceId,
					expectedWorkspaceStateRevision: previewResponse.preview.workspaceStateRevision,
					confirmationProjectName: basename(projectPath),
				});

				expect(result.failureCode).toBe("workspace_state_changed_after_managed_worktree_deletion");
				expect(result.worktreeDeletionResults).toEqual([
					{
						taskId: "task-a",
						path: "/worktrees/task-a",
						ok: true,
						removed: true,
					},
				]);
				expect((await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toContain(
					context.workspaceId,
				);
				await expect(loadPersistedWorkspaceStateById(context.workspaceId)).resolves.toBeDefined();
			});
		},
	);

	it(
		"reports and retains the staging directory when its final recursive removal fails",
		{ timeout: 30_000 },
		async () => {
			await withProtectedFilesystemMutationHome(async ({ gitFixture }) => {
				const projectPath = gitFixture.createNonBareRepository({
					repositoryDirectoryName: "retained-staging-project",
				}).repositoryPath;
				const context = await loadWorkspaceContext(projectPath);
				await loadWorkspaceState(projectPath);
				const service = createConfirmedProjectPermanentDeletionService(
					createServiceDependencies({
						getActiveWorkspaceId: vi.fn(() => context.workspaceId),
						removeStagedWorkspaceStateDirectory: vi.fn(async () => {
							throw new Error("simulated recursive removal failure");
						}),
					}),
				);
				const previewResponse = await service.getPermanentDeletionPreview({ projectId: context.workspaceId });
				if (!previewResponse.ok || previewResponse.preview.workspaceStateRevision === null) {
					throw new Error("Expected a valid deletion preview.");
				}

				const result = await service.permanentlyDeleteProjectData({
					projectId: context.workspaceId,
					expectedWorkspaceStateRevision: previewResponse.preview.workspaceStateRevision,
					confirmationProjectName: basename(projectPath),
				});

				expect(result.status).toBe("completed_with_retained_staging_directory");
				expect(result.projectIndexDeleted).toBe(true);
				expect(result.workspaceStateDirectoryDeleted).toBe(false);
				expect(result.retainedPaths).toHaveLength(1);
				const retainedStagingDirectoryPath = result.retainedPaths[0];
				if (!retainedStagingDirectoryPath) {
					throw new Error("Expected a retained staging directory path.");
				}
				await expect(stat(retainedStagingDirectoryPath)).resolves.toBeDefined();
				expect((await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).not.toContain(
					context.workspaceId,
				);
			});
		},
	);
});
