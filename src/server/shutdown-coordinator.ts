import type { HostedAgentSessionDispositionForRuntimeShutdown } from "../core/runtime-shutdown-trigger";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { removeTaskWorktreeSetupLock } from "../workspace/task-worktree";
import type { ActiveRuntimeSessionShutdownResult } from "./active-runtime-session-shutdown";
import { persistSafelyStoppedRuntimeSessionsByWorkspaceId } from "./safely-stopped-runtime-session-persistence";

export interface RuntimeShutdownCoordinatorDependencies {
	stopAllActiveRuntimeSessionsForShutdown: (
		hostedAgentSessionDisposition: HostedAgentSessionDispositionForRuntimeShutdown,
	) => Promise<
		Array<
			ActiveRuntimeSessionShutdownResult & {
				workspaceId: string;
				workspacePath: string | null;
			}
		>
	>;
	// 缺省终止（旧语义）。runtime 退出时由触发决定（见 src/core/runtime-shutdown-trigger.ts）。
	hostedAgentSessionDisposition?: HostedAgentSessionDispositionForRuntimeShutdown;
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
}

export interface RuntimeShutdownOutcome {
	// 留在 agent session PTY host 里、等下一个 runtime 接管的会话数（停止时据此提示「还有 N 个会话在跑」）。
	detachedHostedAgentSessionCount: number;
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

export async function shutdownRuntimeServer(
	deps: RuntimeShutdownCoordinatorDependencies,
): Promise<RuntimeShutdownOutcome> {
	const managedWorkspacePaths = new Set<string>();
	let detachedHostedAgentSessionCount = 0;
	const runtimeSessionShutdownResults = await deps.stopAllActiveRuntimeSessionsForShutdown(
		deps.hostedAgentSessionDisposition ?? "terminate_hosted_agent_sessions",
	);
	for (const {
		workspaceId,
		workspacePath,
		runtimeSessionSummariesForSafePersistence,
		detachedHostedAgentSessionSummaries,
	} of runtimeSessionShutdownResults) {
		detachedHostedAgentSessionCount += detachedHostedAgentSessionSummaries?.length ?? 0;
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
	return { detachedHostedAgentSessionCount };
}
