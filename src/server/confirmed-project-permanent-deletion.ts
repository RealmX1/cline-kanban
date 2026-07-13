import { randomUUID } from "node:crypto";
import { lstat, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
	RuntimeBoardData,
	RuntimeProjectManagedWorktreeDeletionResult,
	RuntimeProjectPermanentDeletionFailure,
	RuntimeProjectPermanentDeletionFailureCode,
	RuntimeProjectPermanentDeletionPreview,
	RuntimeProjectPermanentDeletionPreviewRequest,
	RuntimeProjectPermanentDeletionPreviewResponse,
	RuntimeProjectPermanentDeletionRequest,
	RuntimeProjectPermanentDeletionResult,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorktreeMode,
} from "../core/api-contract";
import { isSessionInActiveTurn, resolveSessionFacets } from "../core/session-activity";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import {
	getWorkspaceDirectoryPath,
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	removeWorkspaceIndexEntry,
} from "../state/workspace-state";
import { deleteTaskWorktree, getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import type { ActiveRuntimeSessionShutdownResult } from "./active-runtime-session-shutdown";
import { persistSafelyStoppedRuntimeSessionsByWorkspaceId } from "./safely-stopped-runtime-session-persistence";

interface VerifiedManagedWorktreeTarget {
	taskId: string;
	path: string;
	worktreeMode: RuntimeTaskWorktreeMode | undefined;
}

interface ProjectPermanentDeletionPreviewWithVerifiedTargets {
	preview: RuntimeProjectPermanentDeletionPreview;
	verifiedManagedWorktreeTargets: VerifiedManagedWorktreeTarget[];
}

interface StagedWorkspaceStateDirectoryAndRemovedProjectIndex {
	originalWorkspaceStateDirectoryPath: string;
	stagingWorkspaceStateDirectoryPath: string;
}

class ProjectPermanentDeletionTransactionError extends Error {
	readonly failureCode: RuntimeProjectPermanentDeletionFailureCode;
	readonly retainedPath: string | null;

	constructor(
		failureCode: RuntimeProjectPermanentDeletionFailureCode,
		message: string,
		retainedPath: string | null = null,
	) {
		super(message);
		this.name = "ProjectPermanentDeletionTransactionError";
		this.failureCode = failureCode;
		this.retainedPath = retainedPath;
	}
}

export interface ConfirmedProjectPermanentDeletionServiceDependencies {
	getActiveWorkspaceId: () => string | null;
	setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void>;
	clearActiveWorkspace: () => void;
	listProjectRuntimeSessionSummaries: (workspaceId: string) => RuntimeTaskSessionSummary[];
	stopAndCollectProjectRuntimeSessionsForSafePersistence: (
		workspaceId: string,
	) => Promise<ActiveRuntimeSessionShutdownResult>;
	disposeProjectRuntime: (workspaceId: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	warn: (message: string) => void;
	listWorkspaceIndexEntries?: typeof listWorkspaceIndexEntries;
	loadPersistedWorkspaceStateById?: typeof loadPersistedWorkspaceStateById;
	getTaskWorkspacePathInfo?: typeof getTaskWorkspacePathInfo;
	deleteTaskWorktree?: typeof deleteTaskWorktree;
	persistSafelyStoppedRuntimeSessionsByWorkspaceId?: typeof persistSafelyStoppedRuntimeSessionsByWorkspaceId;
	removeWorkspaceIndexEntry?: typeof removeWorkspaceIndexEntry;
	isWorkspaceStateDirectorySafeForPermanentDeletion?: (workspaceId: string) => Promise<boolean>;
	stageWorkspaceStateDirectoryAndRemoveProjectIndex?: (
		workspaceId: string,
		expectedWorkspaceStateRevision: number,
	) => Promise<StagedWorkspaceStateDirectoryAndRemovedProjectIndex>;
	removeStagedWorkspaceStateDirectory?: (stagingWorkspaceStateDirectoryPath: string) => Promise<void>;
}

export interface ConfirmedProjectPermanentDeletionService {
	getPermanentDeletionPreview: (
		input: RuntimeProjectPermanentDeletionPreviewRequest,
	) => Promise<RuntimeProjectPermanentDeletionPreviewResponse>;
	permanentlyDeleteProjectData: (
		input: RuntimeProjectPermanentDeletionRequest,
	) => Promise<RuntimeProjectPermanentDeletionResult>;
}

function createWorkspaceDirectoryLockRequest(workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDirectoryPath(workspaceId),
		type: "directory",
		lockfilePath: join(getWorkspacesRootPath(), `${workspaceId}.lock`),
	};
}

function createWorkspacesRootLockRequest(): LockRequest {
	return {
		path: getWorkspacesRootPath(),
		type: "directory",
		lockfileName: ".workspaces.lock",
	};
}

function getProjectNameFromPath(projectPath: string): string {
	const normalizedPath = projectPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const pathSegments = normalizedPath.split("/").filter((pathSegment) => pathSegment.length > 0);
	return pathSegments[pathSegments.length - 1] ?? normalizedPath;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function isWorkspaceStateDirectorySafeForPermanentDeletion(workspaceId: string): Promise<boolean> {
	const workspacesRootPath = resolve(getWorkspacesRootPath());
	const workspaceStateDirectoryPath = resolve(getWorkspaceDirectoryPath(workspaceId));
	if (dirname(workspaceStateDirectoryPath) !== workspacesRootPath) {
		return false;
	}
	try {
		const workspaceStateDirectoryMetadata = await lstat(workspaceStateDirectoryPath);
		return workspaceStateDirectoryMetadata.isDirectory() && !workspaceStateDirectoryMetadata.isSymbolicLink();
	} catch (error) {
		return isNodeErrorWithCode(error, "ENOENT");
	}
}

function countUniqueProjectTasks(board: RuntimeBoardData): number {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds.size;
}

function collectUniqueManagedWorktreeTaskCandidates(
	board: RuntimeBoardData,
): Array<{ taskId: string; baseRef: string; worktreeMode: RuntimeTaskWorktreeMode | undefined }> {
	const candidates: Array<{
		taskId: string;
		baseRef: string;
		worktreeMode: RuntimeTaskWorktreeMode | undefined;
	}> = [];
	const seenTaskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (seenTaskIds.has(card.id) || card.worktreeMode === "inplace") {
				continue;
			}
			seenTaskIds.add(card.id);
			candidates.push({
				taskId: card.id,
				baseRef: card.baseRef,
				worktreeMode: card.worktreeMode,
			});
		}
	}
	return candidates;
}

function mergeProjectSessionSummaries(
	persistedSessions: Record<string, RuntimeTaskSessionSummary>,
	runtimeSessions: RuntimeTaskSessionSummary[],
): RuntimeTaskSessionSummary[] {
	const mergedSessionsByTaskId = new Map<string, RuntimeTaskSessionSummary>(Object.entries(persistedSessions));
	for (const runtimeSession of runtimeSessions) {
		mergedSessionsByTaskId.set(runtimeSession.taskId, runtimeSession);
	}
	return Array.from(mergedSessionsByTaskId.values());
}

function createAbortedPermanentDeletionResult(
	projectId: string,
	failureCode: RuntimeProjectPermanentDeletionFailureCode,
	failure: RuntimeProjectPermanentDeletionFailure,
	input: {
		stoppedSessionCount?: number;
		worktreeDeletionResults?: RuntimeProjectManagedWorktreeDeletionResult[];
		retainedPaths?: string[];
	} = {},
): RuntimeProjectPermanentDeletionResult {
	return {
		status: "aborted_before_project_data_deletion",
		failureCode,
		projectId,
		stoppedSessionCount: input.stoppedSessionCount ?? 0,
		worktreeDeletionResults: input.worktreeDeletionResults ?? [],
		projectIndexDeleted: false,
		workspaceStateDirectoryDeleted: false,
		failures: [failure],
		retainedPaths: input.retainedPaths ?? [],
		newCurrentProjectId: null,
	};
}

async function stageWorkspaceStateDirectoryAndRemoveProjectIndex(
	workspaceId: string,
	expectedWorkspaceStateRevision: number,
	loadWorkspaceStateById: typeof loadPersistedWorkspaceStateById,
	removeProjectIndexEntry: typeof removeWorkspaceIndexEntry,
): Promise<StagedWorkspaceStateDirectoryAndRemovedProjectIndex> {
	const originalWorkspaceStateDirectoryPath = getWorkspaceDirectoryPath(workspaceId);
	const stagingWorkspaceStateDirectoryPath = join(
		getWorkspacesRootPath(),
		`${workspaceId}.pending-permanent-deletion-${randomUUID()}`,
	);

	return await lockedFileSystem.withLocks(
		[createWorkspacesRootLockRequest(), createWorkspaceDirectoryLockRequest(workspaceId)],
		async () => {
			if (!(await isWorkspaceStateDirectorySafeForPermanentDeletion(workspaceId))) {
				throw new ProjectPermanentDeletionTransactionError(
					"workspace_state_directory_path_is_unsafe",
					"Workspace state directory is no longer a safe direct child of the workspaces root.",
				);
			}
			const workspaceState = await loadWorkspaceStateById(workspaceId);
			if (workspaceState.revision !== expectedWorkspaceStateRevision) {
				throw new ProjectPermanentDeletionTransactionError(
					"preview_stale",
					`Workspace state changed from revision ${expectedWorkspaceStateRevision} to ${workspaceState.revision}.`,
				);
			}

			try {
				await rename(originalWorkspaceStateDirectoryPath, stagingWorkspaceStateDirectoryPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new ProjectPermanentDeletionTransactionError(
					"workspace_state_staging_failed",
					`Could not stage workspace state for permanent deletion. ${message}`,
				);
			}

			try {
				const projectIndexDeleted = await removeProjectIndexEntry(workspaceId);
				if (!projectIndexDeleted) {
					throw new Error(`Project index entry "${workspaceId}" was not found.`);
				}
			} catch (indexError) {
				const indexErrorMessage = indexError instanceof Error ? indexError.message : String(indexError);
				try {
					await rename(stagingWorkspaceStateDirectoryPath, originalWorkspaceStateDirectoryPath);
				} catch (rollbackError) {
					const rollbackErrorMessage =
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
					throw new ProjectPermanentDeletionTransactionError(
						"workspace_state_staging_rollback_failed",
						`Project index deletion failed and the staged workspace state could not be restored. Index error: ${indexErrorMessage} Rollback error: ${rollbackErrorMessage}`,
						stagingWorkspaceStateDirectoryPath,
					);
				}
				throw new ProjectPermanentDeletionTransactionError(
					"workspace_index_deletion_failed",
					`Project index deletion failed; workspace state was restored. ${indexErrorMessage}`,
				);
			}

			return {
				originalWorkspaceStateDirectoryPath,
				stagingWorkspaceStateDirectoryPath,
			};
		},
	);
}

async function removeStagedWorkspaceStateDirectory(stagingWorkspaceStateDirectoryPath: string): Promise<void> {
	await rm(stagingWorkspaceStateDirectoryPath, {
		recursive: true,
		force: false,
	});
}

export function createConfirmedProjectPermanentDeletionService(
	dependencies: ConfirmedProjectPermanentDeletionServiceDependencies,
): ConfirmedProjectPermanentDeletionService {
	const listIndexedProjects = dependencies.listWorkspaceIndexEntries ?? listWorkspaceIndexEntries;
	const loadWorkspaceStateById = dependencies.loadPersistedWorkspaceStateById ?? loadPersistedWorkspaceStateById;
	const inspectTaskWorkspacePath = dependencies.getTaskWorkspacePathInfo ?? getTaskWorkspacePathInfo;
	const removeTaskWorktree = dependencies.deleteTaskWorktree ?? deleteTaskWorktree;
	const persistStoppedSessions =
		dependencies.persistSafelyStoppedRuntimeSessionsByWorkspaceId ?? persistSafelyStoppedRuntimeSessionsByWorkspaceId;
	const removeProjectIndexEntry = dependencies.removeWorkspaceIndexEntry ?? removeWorkspaceIndexEntry;
	const verifyWorkspaceStateDirectorySafety =
		dependencies.isWorkspaceStateDirectorySafeForPermanentDeletion ??
		isWorkspaceStateDirectorySafeForPermanentDeletion;
	const stageStateAndRemoveIndex =
		dependencies.stageWorkspaceStateDirectoryAndRemoveProjectIndex ??
		(async (workspaceId: string, expectedRevision: number) =>
			await stageWorkspaceStateDirectoryAndRemoveProjectIndex(
				workspaceId,
				expectedRevision,
				loadWorkspaceStateById,
				removeProjectIndexEntry,
			));
	const removeStagedState = dependencies.removeStagedWorkspaceStateDirectory ?? removeStagedWorkspaceStateDirectory;

	const buildPreviewWithVerifiedTargets = async (
		projectId: string,
	): Promise<ProjectPermanentDeletionPreviewWithVerifiedTargets | null> => {
		const indexedProjects = await listIndexedProjects();
		const indexedProject = indexedProjects.find((project) => project.workspaceId === projectId);
		if (!indexedProject) {
			return null;
		}

		const projectName = getProjectNameFromPath(indexedProject.repoPath);
		const previewBase = {
			projectId,
			projectName,
			projectPath: indexedProject.repoPath,
			workspaceStateDirectoryPath: getWorkspaceDirectoryPath(projectId),
			requiredConfirmationProjectName: projectName,
		};
		if (!projectName) {
			return {
				preview: {
					...previewBase,
					workspaceStateRevision: null,
					totalTaskCount: 0,
					activeSessionCount: 0,
					managedWorktreeCount: 0,
					deletionAllowed: false,
					blockingReasons: ["confirmation_project_name_could_not_be_derived"],
				},
				verifiedManagedWorktreeTargets: [],
			};
		}
		if (!(await verifyWorkspaceStateDirectorySafety(projectId))) {
			return {
				preview: {
					...previewBase,
					workspaceStateRevision: null,
					totalTaskCount: 0,
					activeSessionCount: 0,
					managedWorktreeCount: 0,
					deletionAllowed: false,
					blockingReasons: ["workspace_state_directory_path_is_unsafe"],
				},
				verifiedManagedWorktreeTargets: [],
			};
		}

		let workspaceState: Awaited<ReturnType<typeof loadPersistedWorkspaceStateById>>;
		try {
			workspaceState = await loadWorkspaceStateById(projectId);
		} catch {
			return {
				preview: {
					...previewBase,
					workspaceStateRevision: null,
					totalTaskCount: 0,
					activeSessionCount: 0,
					managedWorktreeCount: 0,
					deletionAllowed: false,
					blockingReasons: ["workspace_state_could_not_be_verified"],
				},
				verifiedManagedWorktreeTargets: [],
			};
		}

		let mergedProjectSessionSummaries: RuntimeTaskSessionSummary[];
		try {
			mergedProjectSessionSummaries = mergeProjectSessionSummaries(
				workspaceState.sessions,
				dependencies.listProjectRuntimeSessionSummaries(projectId),
			);
		} catch {
			return {
				preview: {
					...previewBase,
					workspaceStateRevision: workspaceState.revision,
					totalTaskCount: countUniqueProjectTasks(workspaceState.board),
					activeSessionCount: 0,
					managedWorktreeCount: 0,
					deletionAllowed: false,
					blockingReasons: ["runtime_sessions_could_not_be_verified"],
				},
				verifiedManagedWorktreeTargets: [],
			};
		}

		const verifiedManagedWorktreeTargets: VerifiedManagedWorktreeTarget[] = [];
		try {
			for (const candidate of collectUniqueManagedWorktreeTaskCandidates(workspaceState.board)) {
				const workspacePathInfo = await inspectTaskWorkspacePath({
					cwd: indexedProject.repoPath,
					taskId: candidate.taskId,
					baseRef: candidate.baseRef,
					...(candidate.worktreeMode ? { worktreeMode: candidate.worktreeMode } : {}),
				});
				if (workspacePathInfo.exists) {
					verifiedManagedWorktreeTargets.push({
						taskId: candidate.taskId,
						path: workspacePathInfo.path,
						worktreeMode: candidate.worktreeMode,
					});
				}
			}
		} catch {
			return {
				preview: {
					...previewBase,
					workspaceStateRevision: workspaceState.revision,
					totalTaskCount: countUniqueProjectTasks(workspaceState.board),
					activeSessionCount: mergedProjectSessionSummaries.filter((summary) =>
						isSessionInActiveTurn(resolveSessionFacets(summary)),
					).length,
					managedWorktreeCount: 0,
					deletionAllowed: false,
					blockingReasons: ["managed_worktrees_could_not_be_verified"],
				},
				verifiedManagedWorktreeTargets: [],
			};
		}

		const activeSessionCount = mergedProjectSessionSummaries.filter((summary) =>
			isSessionInActiveTurn(resolveSessionFacets(summary)),
		).length;
		return {
			preview: {
				...previewBase,
				workspaceStateRevision: workspaceState.revision,
				totalTaskCount: countUniqueProjectTasks(workspaceState.board),
				activeSessionCount,
				managedWorktreeCount: verifiedManagedWorktreeTargets.length,
				deletionAllowed: true,
				blockingReasons: [],
			},
			verifiedManagedWorktreeTargets,
		};
	};

	return {
		getPermanentDeletionPreview: async (input) => {
			const previewWithTargets = await buildPreviewWithVerifiedTargets(input.projectId);
			if (!previewWithTargets) {
				return {
					ok: false,
					preview: null,
					error: `Unknown project ID: ${input.projectId}`,
				};
			}
			return {
				ok: true,
				preview: previewWithTargets.preview,
			};
		},

		permanentlyDeleteProjectData: async (input) => {
			const previewWithTargets = await buildPreviewWithVerifiedTargets(input.projectId);
			if (!previewWithTargets) {
				return createAbortedPermanentDeletionResult(input.projectId, "project_not_registered", {
					code: "project_not_registered",
					message: `Unknown project ID: ${input.projectId}`,
				});
			}

			const { preview, verifiedManagedWorktreeTargets } = previewWithTargets;
			if (!preview.deletionAllowed || preview.workspaceStateRevision === null) {
				return createAbortedPermanentDeletionResult(input.projectId, "deletion_not_allowed", {
					code: "deletion_not_allowed",
					message: `Permanent deletion is blocked: ${preview.blockingReasons.join(", ") || "preview could not be verified"}.`,
					path: preview.workspaceStateDirectoryPath,
				});
			}

			if (input.confirmationProjectName !== preview.requiredConfirmationProjectName) {
				return createAbortedPermanentDeletionResult(input.projectId, "confirmation_project_name_mismatch", {
					code: "confirmation_project_name_mismatch",
					message: "The confirmation project name does not exactly match the current project name.",
				});
			}

			if (input.expectedWorkspaceStateRevision !== preview.workspaceStateRevision) {
				return createAbortedPermanentDeletionResult(input.projectId, "preview_stale", {
					code: "preview_stale",
					message: `The deletion preview is stale. Expected revision ${input.expectedWorkspaceStateRevision}, current revision ${preview.workspaceStateRevision}.`,
				});
			}

			let stoppedRuntimeSessionSummaries: RuntimeTaskSessionSummary[] = [];
			let workspaceStateRevisionAfterStoppingSessions: number;
			try {
				const shutdownResult = await dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence(
					input.projectId,
				);
				stoppedRuntimeSessionSummaries = shutdownResult.stoppedRuntimeSessionSummaries;
				const persistenceResult = await persistStoppedSessions(
					input.projectId,
					shutdownResult.runtimeSessionSummariesForSafePersistence,
				);
				workspaceStateRevisionAfterStoppingSessions = persistenceResult.workspaceStateRevision;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return createAbortedPermanentDeletionResult(
					input.projectId,
					"runtime_session_stop_or_persistence_failed",
					{
						code: "runtime_session_stop_or_persistence_failed",
						message: `Could not safely stop and persist project sessions. ${message}`,
					},
					{
						stoppedSessionCount: stoppedRuntimeSessionSummaries.length,
						retainedPaths: [preview.workspaceStateDirectoryPath, preview.projectPath],
					},
				);
			}

			const worktreeDeletionResults = await Promise.all(
				verifiedManagedWorktreeTargets.map(async (target): Promise<RuntimeProjectManagedWorktreeDeletionResult> => {
					try {
						const deletionResult = await removeTaskWorktree({
							repoPath: preview.projectPath,
							taskId: target.taskId,
							...(target.worktreeMode ? { worktreeMode: target.worktreeMode } : {}),
						});
						return {
							taskId: target.taskId,
							path: target.path,
							ok: deletionResult.ok,
							removed: deletionResult.removed,
							...(deletionResult.error ? { error: deletionResult.error } : {}),
						};
					} catch (error) {
						return {
							taskId: target.taskId,
							path: target.path,
							ok: false,
							removed: false,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);
			const failedWorktreeDeletions = worktreeDeletionResults.filter((result) => !result.ok);
			if (failedWorktreeDeletions.length > 0) {
				return {
					...createAbortedPermanentDeletionResult(
						input.projectId,
						"managed_worktree_deletion_failed",
						{
							code: "managed_worktree_deletion_failed",
							message:
								"At least one managed worktree could not be deleted; project index and state were retained.",
						},
						{
							stoppedSessionCount: stoppedRuntimeSessionSummaries.length,
							worktreeDeletionResults,
							retainedPaths: [preview.workspaceStateDirectoryPath, preview.projectPath],
						},
					),
					failures: failedWorktreeDeletions.map((result) => ({
						code: "managed_worktree_deletion_failed" as const,
						message: result.error ?? `Managed worktree for task "${result.taskId}" was not removed.`,
						path: result.path,
						taskId: result.taskId,
					})),
				};
			}

			let stagedState: StagedWorkspaceStateDirectoryAndRemovedProjectIndex;
			try {
				stagedState = await stageStateAndRemoveIndex(input.projectId, workspaceStateRevisionAfterStoppingSessions);
			} catch (error) {
				const transactionError =
					error instanceof ProjectPermanentDeletionTransactionError
						? error
						: new ProjectPermanentDeletionTransactionError(
								"workspace_state_staging_failed",
								error instanceof Error ? error.message : String(error),
							);
				const failureCode: RuntimeProjectPermanentDeletionFailureCode =
					transactionError.failureCode === "preview_stale"
						? "workspace_state_changed_after_managed_worktree_deletion"
						: transactionError.failureCode;
				const failureMessage =
					failureCode === "workspace_state_changed_after_managed_worktree_deletion"
						? `Workspace state changed after managed worktree deletion. Project index and workspace state were retained. ${transactionError.message}`
						: transactionError.message;
				return createAbortedPermanentDeletionResult(
					input.projectId,
					failureCode,
					{
						code: failureCode,
						message: failureMessage,
						...(transactionError.retainedPath ? { path: transactionError.retainedPath } : {}),
					},
					{
						stoppedSessionCount: stoppedRuntimeSessionSummaries.length,
						worktreeDeletionResults,
						retainedPaths: transactionError.retainedPath
							? [transactionError.retainedPath, preview.projectPath]
							: [preview.workspaceStateDirectoryPath, preview.projectPath],
					},
				);
			}

			const failures: RuntimeProjectPermanentDeletionFailure[] = [];
			let workspaceStateDirectoryDeleted = false;
			try {
				await removeStagedState(stagedState.stagingWorkspaceStateDirectoryPath);
				workspaceStateDirectoryDeleted = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push({
					code: "staging_directory_removal_failed",
					message: `Project index was deleted, but the staged workspace state directory was retained. ${message}`,
					path: stagedState.stagingWorkspaceStateDirectoryPath,
				});
			}

			try {
				await dependencies.disposeProjectRuntime(input.projectId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push({
					code: "workspace_runtime_disposal_failed",
					message: `Project data was deleted, but runtime disposal failed. ${message}`,
				});
			}

			let newCurrentProjectId = dependencies.getActiveWorkspaceId();
			if (newCurrentProjectId === input.projectId) {
				try {
					const remainingProjects = await listIndexedProjects();
					const fallbackProject = remainingProjects[0];
					if (fallbackProject) {
						await dependencies.setActiveWorkspace(fallbackProject.workspaceId, fallbackProject.repoPath);
						newCurrentProjectId = fallbackProject.workspaceId;
					} else {
						dependencies.clearActiveWorkspace();
						newCurrentProjectId = null;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failures.push({
						code: "fallback_project_selection_failed",
						message: `Project data was deleted, but fallback project selection failed. ${message}`,
					});
				}
			}

			try {
				await dependencies.broadcastRuntimeProjectsUpdated(newCurrentProjectId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push({
					code: "projects_broadcast_failed",
					message: `Project data was deleted, but the projects update broadcast failed. ${message}`,
				});
			}

			for (const failure of failures) {
				dependencies.warn(failure.message);
			}

			return {
				status: workspaceStateDirectoryDeleted ? "completed" : "completed_with_retained_staging_directory",
				...(workspaceStateDirectoryDeleted ? {} : { failureCode: "staging_directory_removal_failed" as const }),
				projectId: input.projectId,
				stoppedSessionCount: stoppedRuntimeSessionSummaries.length,
				worktreeDeletionResults,
				projectIndexDeleted: true,
				workspaceStateDirectoryDeleted,
				failures,
				retainedPaths: workspaceStateDirectoryDeleted ? [] : [stagedState.stagingWorkspaceStateDirectoryPath],
				newCurrentProjectId,
			};
		},
	};
}
