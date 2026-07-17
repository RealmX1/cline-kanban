import pLimit from "p-limit";
import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { computeWorktreeGitChangeToken } from "../workspace/git-change-token";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const WORKSPACE_METADATA_POLL_INTERVAL_MS = 3_000;

/**
 * 兜底全量刷新窗口：即使廉价变更 token 未变，距上次真探针超过此时长也强制跑一次 `probeGitWorkspaceState`，
 * 以补上廉价 token 捕获不到的「就地未暂存编辑」。看板 git 元数据可接受这点最坏延迟，换取每 poll 不再无条件 spawn git。
 */
const GIT_METADATA_FULL_REFRESH_INTERVAL_MS = 10_000;

/**
 * 周期性后台 git 探针的**并发 spawn 上限**（保守小常数，可调）。
 *
 * 动机：`refreshWorkspace` 每个 poll 周期用 `Promise.all(trackedTasks.map(loadTaskWorkspaceMetadata))`
 * 对所有被追踪任务并发跑元数据加载。当廉价 fs-stat 门控放行（首次连接全部缓存为 null、或所有任务的兜底窗口
 * 同一 poll tick 同步到期）时，`probeGitWorkspaceState → runGit → execFileAsync('git', ...)` 会在同一 tick
 * 里同步 spawn，且并发数**随任务数/工作区数线性增长**。`spawn` 的 fork/exec syscall + env 复制 + stdio 管道
 * 建立都同步跑在 Node 单事件循环主线程，这种线性放大的周期性 burst 会短时占满事件循环，退化为 Agent TUI 键盘卡顿。
 *
 * 参照 `src/workspace/git-concurrency.ts` 的模式：把真正 spawn git 的探针工作钳进一个**跨所有工作区共享的
 * 模块级 p-limit 单例**，使热路径 git spawn 并发恒为常数、不再随任务/工作区数增长。共享是关键——即便多个工作区
 * 各自的定时器 burst 叠加，总并发 git spawn 也被钳成 WORKSPACE_METADATA_GIT_SPAWN_CONCURRENCY_LIMIT。
 * 廉价 fs-stat 门控（computeWorktreeGitChangeToken）留在限流器**之外**，只有门控判定需要真探针后才入队。
 */
const WORKSPACE_METADATA_GIT_SPAWN_CONCURRENCY_LIMIT = 4;

export const workspaceMetadataGitSpawnConcurrencyLimiter = pLimit(WORKSPACE_METADATA_GIT_SPAWN_CONCURRENCY_LIMIT);

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
	// 廉价 fs 变更 token（见 git-change-token）：与它相等且未超兜底窗口时，跳过真探针、0 git spawn。
	cheapChangeToken: string | null;
	// 上次真正跑 probeGitWorkspaceState 的时刻（ms）。用于兜底窗口判定。
	lastFullRefreshAtMs: number;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
	cheapChangeToken: string | null;
	lastFullRefreshAtMs: number;
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
			cheapChangeToken: null,
			lastFullRefreshAtMs: 0,
		};
	}

	try {
		const now = Date.now();
		// 第一层门控（不 spawn git）：廉价 token 未变、路径/baseRef 一致且未超兜底窗口 → 复用缓存。
		const cheapTokenBeforeProbe = await computeWorktreeGitChangeToken(pathInfo.path);
		if (
			current &&
			current.cheapChangeToken !== null &&
			current.cheapChangeToken === cheapTokenBeforeProbe &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef &&
			now - current.lastFullRefreshAtMs < GIT_METADATA_FULL_REFRESH_INTERVAL_MS
		) {
			return current;
		}
		// 门控放行后才进入限流器：真正 spawn git 的探针工作（probe + getGitSyncSummary +
		// loadTaskForkPointCommit + loadCommitsSinceFork）钳进共享并发上限。
		return await workspaceMetadataGitSpawnConcurrencyLimiter(async () => {
			const probe = await probeGitWorkspaceState(pathInfo.path, { knownRepoRoot: pathInfo.path });
			// 真探针可能刷新 index 的 stat 缓存，故其后重算 token 存下，保证后续跳过判定稳定。
			const cheapTokenAfterProbe = await computeWorktreeGitChangeToken(pathInfo.path);
			if (
				current &&
				current.stateToken === probe.stateToken &&
				current.data.path === pathInfo.path &&
				current.data.baseRef === pathInfo.baseRef
			) {
				return {
					...current,
					cheapChangeToken: cheapTokenAfterProbe,
					lastFullRefreshAtMs: now,
				};
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
				cheapChangeToken: cheapTokenAfterProbe,
				lastFullRefreshAtMs: now,
			};
		});
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
			cheapChangeToken: null,
			lastFullRefreshAtMs: 0,
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
