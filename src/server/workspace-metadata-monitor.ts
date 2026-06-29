import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000;

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
}

interface WorkspaceMetadataEntry {
	workspacePath: string;
	trackedTasks: TrackedTaskWorkspace[];
	subscriberCount: number;
	pollTimer: NodeJS.Timeout | null;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
}

export interface WorkspaceMetadataMonitor {
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	disconnectWorkspace: (workspaceId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorkspace[] {
	const tracked: TrackedTaskWorkspace[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need git metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
				...(card.worktreeMode ? { worktreeMode: card.worktreeMode } : {}),
			});
		}
	}
	return tracked;
}

function areGitSummariesEqual(a: RuntimeGitSyncSummary | null, b: RuntimeGitSyncSummary | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.currentBranch === b.currentBranch &&
		a.upstreamBranch === b.upstreamBranch &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.aheadCount === b.aheadCount &&
		a.behindCount === b.behindCount
	);
}

function areTaskMetadataEqual(a: RuntimeTaskWorkspaceMetadata, b: RuntimeTaskWorkspaceMetadata): boolean {
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.baseCommit === b.baseCommit &&
		a.commitsSinceFork === b.commitsSinceFork &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.stateVersion === b.stateVersion
	);
}

function areWorkspaceMetadataEqual(a: RuntimeWorkspaceMetadata, b: RuntimeWorkspaceMetadata): boolean {
	if (!areGitSummariesEqual(a.homeGitSummary, b.homeGitSummary)) {
		return false;
	}
	if (a.homeGitStateVersion !== b.homeGitStateVersion) {
		return false;
	}
	if (a.taskWorkspaces.length !== b.taskWorkspaces.length) {
		return false;
	}
	for (let index = 0; index < a.taskWorkspaces.length; index += 1) {
		const left = a.taskWorkspaces[index];
		const right = b.taskWorkspaces[index];
		if (!left || !right || !areTaskMetadataEqual(left, right)) {
			return false;
		}
	}
	return true;
}

function createEmptyWorkspaceMetadata(): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: [],
	};
}

function createWorkspaceEntry(workspacePath: string): WorkspaceMetadataEntry {
	return {
		workspacePath,
		trackedTasks: [],
		subscriberCount: 0,
		pollTimer: null,
		refreshPromise: null,
		homeGit: {
			summary: null,
			stateToken: null,
			stateVersion: 0,
		},
		taskMetadataByTaskId: new Map<string, CachedTaskWorkspaceMetadata>(),
	};
}

function buildWorkspaceMetadataSnapshot(entry: WorkspaceMetadataEntry): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		taskWorkspaces: entry.trackedTasks
			.map((task) => entry.taskMetadataByTaskId.get(task.taskId)?.data ?? null)
			.filter((task): task is RuntimeTaskWorkspaceMetadata => task !== null),
	};
}

async function loadHomeGitMetadata(entry: WorkspaceMetadataEntry): Promise<CachedHomeGitMetadata> {
	try {
		const probe = await probeGitWorkspaceState(entry.workspacePath);
		if (entry.homeGit.stateToken === probe.stateToken) {
			return entry.homeGit;
		}
		const summary = await getGitSyncSummary(entry.workspacePath, { probe });
		return {
			summary,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
		};
	} catch {
		return entry.homeGit;
	}
}

/**
 * 任务从 base 分叉时的提交（fork-point）。`git merge-base HEAD <baseRef>` 在任务 worktree 内现算：
 * 该提交稳定不随 base 分支推进而变（base 前进时公共祖先不变）。inplace 任务 HEAD 即在 base 上，
 * merge-base 退化为当前 HEAD，符合预期。任何失败（baseRef 不可解析、git 出错）→ null，优雅降级。
 */
async function loadTaskForkPointCommit(workspacePath: string, baseRef: string): Promise<string | null> {
	const result = await runGit(workspacePath, ["merge-base", "HEAD", baseRef]);
	return result.ok && result.stdout ? result.stdout : null;
}

/** fork-point..HEAD 的 commit 数；无 fork/HEAD 或 git 失败 → null。 */
async function loadCommitsSinceFork(workspacePath: string, baseCommit: string | null): Promise<number | null> {
	if (!baseCommit) {
		return null;
	}
	const result = await runGit(workspacePath, ["rev-list", "--count", `${baseCommit}..HEAD`]);
	if (!result.ok || !result.stdout) {
		return null;
	}
	const parsed = Number.parseInt(result.stdout, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

async function loadTaskWorkspaceMetadata(
	workspacePath: string,
	task: TrackedTaskWorkspace,
	current: CachedTaskWorkspaceMetadata | null,
): Promise<CachedTaskWorkspaceMetadata | null> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: workspacePath,
		taskId: task.taskId,
		baseRef: task.baseRef,
		...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
	});

	if (!pathInfo.exists) {
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				baseCommit: null,
				commitsSinceFork: null,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}

	try {
		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		const summary = await getGitSyncSummary(pathInfo.path, { probe });
		const baseCommit = await loadTaskForkPointCommit(pathInfo.path, pathInfo.baseRef);
		const commitsSinceFork = await loadCommitsSinceFork(pathInfo.path, baseCommit);
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				baseCommit,
				commitsSinceFork,
				branch: probe.currentBranch,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				headCommit: probe.headCommit,
				changedFiles: summary.changedFiles,
				additions: summary.additions,
				deletions: summary.deletions,
				stateVersion: Date.now(),
			},
			stateToken: probe.stateToken,
		};
	} catch {
		if (current) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				baseCommit: null,
				commitsSinceFork: null,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	const workspaces = new Map<string, WorkspaceMetadataEntry>();

	const stopWorkspaceTimer = (entry: WorkspaceMetadataEntry) => {
		if (!entry.pollTimer) {
			return;
		}
		clearInterval(entry.pollTimer);
		entry.pollTimer = null;
	};

	const refreshWorkspace = async (workspaceId: string): Promise<RuntimeWorkspaceMetadata> => {
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return createEmptyWorkspaceMetadata();
		}
		if (entry.refreshPromise) {
			return await entry.refreshPromise;
		}

		entry.refreshPromise = (async () => {
			const previousSnapshot = buildWorkspaceMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);

			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map(async (task) => {
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
					return next ? [task.taskId, next] : null;
				}),
			);

			entry.taskMetadataByTaskId = new Map(
				nextTaskEntries.filter(
					(candidate): candidate is [string, CachedTaskWorkspaceMetadata] => candidate !== null,
				),
			);

			const nextSnapshot = buildWorkspaceMetadataSnapshot(entry);
			if (!areWorkspaceMetadataEqual(previousSnapshot, nextSnapshot)) {
				deps.onMetadataUpdated(workspaceId, nextSnapshot);
			}
			return nextSnapshot;
		})().finally(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.refreshPromise = null;
			}
		});

		return await entry.refreshPromise;
	};

	const updateWorkspaceEntry = (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}): WorkspaceMetadataEntry => {
		const existing = workspaces.get(input.workspaceId) ?? createWorkspaceEntry(input.workspacePath);
		existing.workspacePath = input.workspacePath;
		existing.trackedTasks = collectTrackedTasks(input.board);
		workspaces.set(input.workspaceId, existing);
		return existing;
	};

	const ensureWorkspaceTimer = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		if (entry.pollTimer) {
			return;
		}
		const timer = setInterval(() => {
			void refreshWorkspace(workspaceId);
		}, WORKSPACE_METADATA_POLL_INTERVAL_MS);
		timer.unref();
		entry.pollTimer = timer;
	};

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			entry.subscriberCount += 1;
			ensureWorkspaceTimer(workspaceId, entry);
			return await refreshWorkspace(workspaceId);
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			if (entry.subscriberCount === 0) {
				return buildWorkspaceMetadataSnapshot(entry);
			}
			return await refreshWorkspace(workspaceId);
		},
		disconnectWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
			if (entry.subscriberCount > 0) {
				return;
			}
			stopWorkspaceTimer(entry);
			workspaces.delete(workspaceId);
		},
		disposeWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			stopWorkspaceTimer(entry);
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopWorkspaceTimer(entry);
			}
			workspaces.clear();
		},
	};
}
