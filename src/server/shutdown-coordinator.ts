import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { removeTaskWorktreeSetupLock } from "../workspace/task-worktree";
import type { ActiveRuntimeSessionShutdownResult } from "./active-runtime-session-shutdown";
import { persistSafelyStoppedRuntimeSessionsByWorkspaceId } from "./safely-stopped-runtime-session-persistence";

export interface RuntimeShutdownCoordinatorDependencies {
	stopAllActiveRuntimeSessionsForShutdown: () => Promise<
		Array<
			ActiveRuntimeSessionShutdownResult & {
				workspaceId: string;
				workspacePath: string | null;
			}
		>
	>;
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
}

async function cleanupTaskWorktreeSetupLocks(
	repoPaths: Iterable<string>,
	warn: (message: string) => void,
): Promise<void> {
	await Promise.all(
		Array.from(new Set(repoPaths)).map(async (repoPath) => {
			try {
				await removeTaskWorktreeSetupLock(repoPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`Could not remove task worktree setup lock for ${repoPath} during shutdown cleanup. ${message}`);
			}
		}),
	);
}

export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	const managedWorkspacePaths = new Set<string>();
	const runtimeSessionShutdownResults = await deps.stopAllActiveRuntimeSessionsForShutdown();
	for (const {
		workspaceId,
		workspacePath,
		runtimeSessionSummariesForSafePersistence,
	} of runtimeSessionShutdownResults) {
		if (workspacePath) {
			managedWorkspacePaths.add(workspacePath);
		}
		try {
			await persistSafelyStoppedRuntimeSessionsByWorkspaceId(workspaceId, runtimeSessionSummariesForSafePersistence);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not persist safely stopped runtime sessions for ${workspacePath ?? workspaceId}. ${message}`);
		}
	}

	await deps.closeRuntimeServer();

	const indexedWorkspaces = await listWorkspaceIndexEntries();
	await cleanupTaskWorktreeSetupLocks(
		[...managedWorkspacePaths, ...indexedWorkspaces.map((workspace) => workspace.repoPath)],
		deps.warn,
	);
}
