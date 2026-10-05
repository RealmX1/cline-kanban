import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { computeWorktreeGitChangeToken } from "../workspace/git-change-token";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import {
	type CachedTaskWorkspaceMetadata,
	createBaseRefTipResolver,
	GIT_METADATA_FULL_REFRESH_INTERVAL_MS,
	loadTaskWorkspaceMetadata,
	type TaskWorktreeGitMetadataProbeTarget,
	workspaceMetadataGitSpawnConcurrencyLimiter,
} from "../workspace/task-worktree-git-metadata-probe";

// 单任务探针与 git spawn 并发上限都在 task-worktree-git-metadata-probe.ts（跨项目切换面板的按需缓存共用同一份）。
export { workspaceMetadataGitSpawnConcurrencyLimiter };

const WORKSPACE_METADATA_POLL_INTERVAL_MS = 3_000;

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
	// 廉价 fs 变更 token（见 git-change-token）：与它相等且未超兜底窗口时，跳过真探针、0 git spawn。
	cheapChangeToken: string | null;
	// 上次真正跑 probeGitWorkspaceState 的时刻（ms）。用于兜底窗口判定。
	lastFullRefreshAtMs: number;
}

interface WorkspaceMetadataEntry {
	workspacePath: string;
	trackedTasks: TaskWorktreeGitMetadataProbeTarget[];
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

function collectTrackedTasks(board: RuntimeBoardData): TaskWorktreeGitMetadataProbeTarget[] {
	const tracked: TaskWorktreeGitMetadataProbeTarget[] = [];
	for (const column of board.columns) {
		// Backlog 尚未拥有 task worktree，不需要探针；Done 则必须保留在投影中，以便在
		// worktree 删除后继续展示 handback 前持久化的最后快照。
		if (column.id === "backlog") {
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
		a.commitsAheadOfBaseRef === b.commitsAheadOfBaseRef &&
		a.commitsBehindBaseRef === b.commitsBehindBaseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.workspaceGitStatus.baseRef === b.workspaceGitStatus.baseRef &&
		a.workspaceGitStatus.commitsAheadOfBaseRef === b.workspaceGitStatus.commitsAheadOfBaseRef &&
		a.workspaceGitStatus.commitsBehindBaseRef === b.workspaceGitStatus.commitsBehindBaseRef &&
		a.workspaceGitStatus.taskCommitsIntegratedIntoBaseRef === b.workspaceGitStatus.taskCommitsIntegratedIntoBaseRef &&
		a.workspaceGitStatus.taskCommitIntegrationTrackingStatus ===
			b.workspaceGitStatus.taskCommitIntegrationTrackingStatus &&
		a.workspaceGitStatus.observationSource === b.workspaceGitStatus.observationSource &&
		a.workspaceGitStatus.observedAt === b.workspaceGitStatus.observedAt &&
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
			cheapChangeToken: null,
			lastFullRefreshAtMs: 0,
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
		const now = Date.now();
		const cached = entry.homeGit;
		// 第一层门控（不 spawn git）：廉价 token 未变且未超兜底窗口 → 直接复用缓存。
		const cheapTokenBeforeProbe = await computeWorktreeGitChangeToken(entry.workspacePath);
		if (
			cached.cheapChangeToken !== null &&
			cached.cheapChangeToken === cheapTokenBeforeProbe &&
			now - cached.lastFullRefreshAtMs < GIT_METADATA_FULL_REFRESH_INTERVAL_MS
		) {
			return cached;
		}
		// 门控放行后才进入限流器：真正 spawn git 的探针工作（probe + getGitSyncSummary）钳进共享并发上限。
		return await workspaceMetadataGitSpawnConcurrencyLimiter(async () => {
			const probe = await probeGitWorkspaceState(entry.workspacePath, { knownRepoRoot: entry.workspacePath });
			// 真探针可能刷新 index 的 stat 缓存，故在其后重算 token 存下，保证后续跳过判定稳定。
			const cheapTokenAfterProbe = await computeWorktreeGitChangeToken(entry.workspacePath);
			if (cached.stateToken === probe.stateToken) {
				return {
					...cached,
					cheapChangeToken: cheapTokenAfterProbe,
					lastFullRefreshAtMs: now,
				};
			}
			const summary = await getGitSyncSummary(entry.workspacePath, { probe });
			return {
				summary,
				stateToken: probe.stateToken,
				stateVersion: Date.now(),
				cheapChangeToken: cheapTokenAfterProbe,
				lastFullRefreshAtMs: now,
			};
		});
	} catch {
		return entry.homeGit;
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

			// 每个刷新周期一个新的解析器：base tip 在周期内保持一致，且同 baseRef 的所有任务共享一次 rev-parse。
			const resolveBaseRefTip = createBaseRefTipResolver(entry.workspacePath);
			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map(async (task) => {
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(
						workspaceId,
						entry.workspacePath,
						task,
						current,
						resolveBaseRefTip,
					);
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
