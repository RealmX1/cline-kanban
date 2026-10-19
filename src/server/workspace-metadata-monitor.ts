import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient,
} from "../core/api-contract";
import { computeWorktreeGitChangeToken } from "../workspace/git-change-token";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import {
	type CachedTaskWorkspaceMetadata,
	createBaseRefTipResolver,
	GIT_METADATA_FULL_REFRESH_INTERVAL_FOR_HOME_REPOSITORY_AND_ACTIVE_TASK_WORKTREE_MS,
	loadTaskWorkspaceMetadata,
	type TaskWorktreeGitMetadataProbeTarget,
	workspaceMetadataGitSpawnConcurrencyLimiter,
} from "../workspace/task-worktree-git-metadata-probe";

// 单任务探针与 git spawn 并发上限都在 task-worktree-git-metadata-probe.ts（跨项目切换面板的按需缓存共用同一份）。
export { workspaceMetadataGitSpawnConcurrencyLimiter };

const WORKSPACE_METADATA_POLL_INTERVAL_MS = 3_000;
// 最后一个订阅断开后，缓存再留这么久才删：切回这个项目（或通过范围切换快捷键来回切范围）时，没变的 worktree 只需一条
// git status 复核，不必五条命令重新探。期间不轮询。
// EXPERIMENT_NODE: 最后一个订阅断开后元数据缓存保留多久（5 分钟）
const WORKSPACE_METADATA_CACHE_RETENTION_AFTER_LAST_SUBSCRIBER_DISCONNECTED_MS = 5 * 60_000;

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
	// Review 列里开了 auto-review 的卡（由 board 推出）：按焦点任务探测时也总要探，自动提交 / 自动 PR 要看
	// 它们有没有未提交改动。
	autoReviewTaskIdsInReviewColumn: ReadonlySet<string>;
	// 每个订阅（一个状态流连接）声明的探测范围，键是 hub 分配的订阅 id。实际探测范围取并集。
	probeScopeBySubscriberId: Map<string, RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient>;
	pollTimer: NodeJS.Timeout | null;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	homeGit: CachedHomeGitMetadata;
	// 已跟踪任务的最近一次探测结果，包括当前不在探测范围里的（留着，范围扩大时只需廉价复核）。
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
	// 上一轮刷新结束时的快照，判「这一轮有没有变化、要不要推」的基准。不能在刷新开始时现算：范围刚收窄时现算的
	// 已经是新范围，和这一轮结果一样，收窄就永远推不出去。
	workspaceMetadataSnapshotAsOfLastRefresh: RuntimeWorkspaceMetadata | null;
	evictionTimerAfterLastSubscriberDisconnected: NodeJS.Timeout | null;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
}

export interface WorkspaceMetadataMonitor {
	// 只读缓存，不登记订阅、不启动 git；首帧之后再 connectWorkspace，避免元数据抢在快照之前广播。
	readCachedWorkspaceMetadataSnapshot: (input: {
		workspaceId: string;
		board: RuntimeBoardData;
		probeScope: RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient;
	}) => RuntimeWorkspaceMetadata;
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
		subscriberId: string;
		probeScope: RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient;
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	// 已连接的订阅改了范围：不等结果，探完有变化照常经 onMetadataUpdated 推送。
	updateSubscriberProbeScope: (input: {
		workspaceId: string;
		subscriberId: string;
		probeScope: RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient;
	}) => void;
	disconnectWorkspace: (workspaceId: string, subscriberId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

function collectAutoReviewTaskIdsInReviewColumn(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id !== "review") {
			continue;
		}
		for (const card of column.cards) {
			if (card.autoReviewEnabled === true) {
				taskIds.add(card.id);
			}
		}
	}
	return taskIds;
}

// 所有订阅声明的范围的并集。任一订阅要整个项目（含不声明的旧客户端）就探整个项目；没有订阅时（只剩保留的缓存）
// 也按整个项目算——此时不轮询，只用来拼快照。
function resolveTrackedTasksInProbeScope(entry: WorkspaceMetadataEntry): TaskWorktreeGitMetadataProbeTarget[] {
	if (entry.probeScopeBySubscriberId.size === 0) {
		return entry.trackedTasks;
	}
	const taskIdsInProbeScope = new Set<string>(entry.autoReviewTaskIdsInReviewColumn);
	for (const probeScope of entry.probeScopeBySubscriberId.values()) {
		if (probeScope.workspaceMetadataProbeScopeKind === "all_tracked_task_worktrees_of_workspace") {
			return entry.trackedTasks;
		}
		for (const focusedTaskId of probeScope.focusedTaskIds) {
			taskIdsInProbeScope.add(focusedTaskId);
		}
	}
	return entry.trackedTasks.filter((task) => taskIdsInProbeScope.has(task.taskId));
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
				taskCardBoardColumnId: column.id,
				taskCardAutoReviewEnabled: card.autoReviewEnabled === true,
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
		autoReviewTaskIdsInReviewColumn: new Set<string>(),
		probeScopeBySubscriberId: new Map<string, RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient>(),
		evictionTimerAfterLastSubscriberDisconnected: null,
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
		workspaceMetadataSnapshotAsOfLastRefresh: null,
	};
}

// 只放探测范围里的任务：范围外的缓存可能已经很旧，不发给浏览器。
function buildWorkspaceMetadataSnapshot(entry: WorkspaceMetadataEntry): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		taskWorkspaces: resolveTrackedTasksInProbeScope(entry)
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
			now - cached.lastFullRefreshAtMs <
				GIT_METADATA_FULL_REFRESH_INTERVAL_FOR_HOME_REPOSITORY_AND_ACTIVE_TASK_WORKTREE_MS
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
			const previousSnapshot =
				entry.workspaceMetadataSnapshotAsOfLastRefresh ?? buildWorkspaceMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);

			// 每个刷新周期一个新的解析器：base tip 在周期内保持一致，且同 baseRef 的所有任务共享一次 rev-parse。
			const resolveBaseRefTip = createBaseRefTipResolver(entry.workspacePath);
			const tasksInProbeScope = resolveTrackedTasksInProbeScope(entry);
			const nextTaskEntries = await Promise.all(
				tasksInProbeScope.map(async (task) => {
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(
						workspaceId,
						entry.workspacePath,
						task,
						current,
						resolveBaseRefTip,
					);
					return [task.taskId, next] as const;
				}),
			);

			// 范围外、仍在跟踪的任务保留上次的结果；不再跟踪的任务丢掉。
			const trackedTaskIds = new Set(entry.trackedTasks.map((task) => task.taskId));
			const nextTaskMetadataByTaskId = new Map(
				[...entry.taskMetadataByTaskId].filter(([taskId]) => trackedTaskIds.has(taskId)),
			);
			for (const [taskId, next] of nextTaskEntries) {
				if (next) {
					nextTaskMetadataByTaskId.set(taskId, next);
				} else {
					nextTaskMetadataByTaskId.delete(taskId);
				}
			}
			entry.taskMetadataByTaskId = nextTaskMetadataByTaskId;

			const nextSnapshot = buildWorkspaceMetadataSnapshot(entry);
			entry.workspaceMetadataSnapshotAsOfLastRefresh = nextSnapshot;
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
		existing.autoReviewTaskIdsInReviewColumn = collectAutoReviewTaskIdsInReviewColumn(input.board);
		workspaces.set(input.workspaceId, existing);
		return existing;
	};

	const cancelEvictionAfterLastSubscriberDisconnected = (entry: WorkspaceMetadataEntry) => {
		if (!entry.evictionTimerAfterLastSubscriberDisconnected) {
			return;
		}
		clearTimeout(entry.evictionTimerAfterLastSubscriberDisconnected);
		entry.evictionTimerAfterLastSubscriberDisconnected = null;
	};

	// 范围变了要按新范围再探一次；正在探的那一轮用的是旧范围，等它结束再来（同时到达的请求并进同一轮）。
	const refreshWorkspaceWithLatestProbeScope = async (workspaceId: string): Promise<RuntimeWorkspaceMetadata> => {
		const inFlightRefreshPromise = workspaces.get(workspaceId)?.refreshPromise;
		if (inFlightRefreshPromise) {
			await inFlightRefreshPromise.catch(() => undefined);
		}
		return await refreshWorkspace(workspaceId);
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

	// 摘掉一个订阅；摘完一个不剩就停轮询，缓存保留一段时间后淘汰。连接断开与首轮刷新失败的回滚共用这一份收尾。
	const removeSubscriberAndStopPollingWhenNoSubscriberRemains = (workspaceId: string, subscriberId: string) => {
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return;
		}
		entry.probeScopeBySubscriberId.delete(subscriberId);
		if (entry.probeScopeBySubscriberId.size > 0) {
			return;
		}
		stopWorkspaceTimer(entry);
		cancelEvictionAfterLastSubscriberDisconnected(entry);
		const evictionTimer = setTimeout(() => {
			if (workspaces.get(workspaceId) === entry && entry.probeScopeBySubscriberId.size === 0) {
				workspaces.delete(workspaceId);
			}
		}, WORKSPACE_METADATA_CACHE_RETENTION_AFTER_LAST_SUBSCRIBER_DISCONNECTED_MS);
		evictionTimer.unref();
		entry.evictionTimerAfterLastSubscriberDisconnected = evictionTimer;
	};

	return {
		readCachedWorkspaceMetadataSnapshot: ({ workspaceId, board, probeScope }) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) return createEmptyWorkspaceMetadata();
			return buildWorkspaceMetadataSnapshot({
				...entry,
				trackedTasks: collectTrackedTasks(board),
				autoReviewTaskIdsInReviewColumn: collectAutoReviewTaskIdsInReviewColumn(board),
				// 首帧与后续整包广播都用订阅并集；并集不变时不会补推，不能只给新连接自己的范围。
				probeScopeBySubscriberId: new Map([
					...entry.probeScopeBySubscriberId,
					["initial-stream-snapshot", probeScope],
				]),
			});
		},
		connectWorkspace: async ({ workspaceId, workspacePath, board, subscriberId, probeScope }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			cancelEvictionAfterLastSubscriberDisconnected(entry);
			entry.probeScopeBySubscriberId.set(subscriberId, probeScope);
			ensureWorkspaceTimer(workspaceId, entry);
			try {
				// 别的连接正在探的那一轮可能没覆盖本连接的范围，等它结束按新的并集再探（已探过的只做廉价复核）。
				return await refreshWorkspaceWithLatestProbeScope(workspaceId);
			} catch (error) {
				// 首轮刷新失败：调用方拿不到连接结果，未必登记得上这个订阅去断开它。不在这里摘掉的话它会永远留在范围
				// 并集里（声明整个项目时把同项目其他连接的范围钉在整个项目），轮询也永不停、缓存永不淘汰。
				removeSubscriberAndStopPollingWhenNoSubscriberRemains(workspaceId, subscriberId);
				throw error;
			}
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			if (entry.probeScopeBySubscriberId.size === 0) {
				return buildWorkspaceMetadataSnapshot(entry);
			}
			return await refreshWorkspace(workspaceId);
		},
		updateSubscriberProbeScope: ({ workspaceId, subscriberId, probeScope }) => {
			const entry = workspaces.get(workspaceId);
			if (!entry?.probeScopeBySubscriberId.has(subscriberId)) {
				return;
			}
			entry.probeScopeBySubscriberId.set(subscriberId, probeScope);
			void refreshWorkspaceWithLatestProbeScope(workspaceId);
		},
		disconnectWorkspace: (workspaceId, subscriberId) => {
			removeSubscriberAndStopPollingWhenNoSubscriberRemains(workspaceId, subscriberId);
		},
		disposeWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			stopWorkspaceTimer(entry);
			cancelEvictionAfterLastSubscriberDisconnected(entry);
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopWorkspaceTimer(entry);
				cancelEvictionAfterLastSubscriberDisconnected(entry);
			}
			workspaces.clear();
		},
	};
}
