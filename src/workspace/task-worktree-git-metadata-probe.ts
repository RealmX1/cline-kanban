import pLimit from "p-limit";
import type { RuntimeBoardColumnId, RuntimeTaskWorkspaceMetadata, RuntimeTaskWorktreeMode } from "../core/api-contract";
import { computeWorktreeGitChangeToken } from "./git-change-token";
import { getGitSyncSummary, probeGitWorkspaceState } from "./git-sync";
import { runGit } from "./git-utils";
import { refreshTaskCommitIntegrationProvenance } from "./task-commit-integration-provenance";
import { getTaskWorkspacePathInfo } from "./task-worktree";

// 单个任务 worktree 的 git 元数据探针（ahead/behind、未提交改动统计、fork-point、集成溯源）。
// 两个调用方共用这一份，不各写一遍：
//   - src/server/workspace-metadata-monitor.ts：有浏览器连着的项目，每 3 秒按 board 轮一遍，推流给该项目。
//   - src/server/cross-project-task-worktree-git-metadata-cache.ts：跨项目切换面板里「其他项目」的行，按需请求。
// 两者也共用同一个 git spawn 并发上限（见下）。

/**
 * 兜底全量刷新窗口（热档）：即使廉价变更 token 未变，距上次真探针超过此时长也强制跑一次 `probeGitWorkspaceState`，
 * 以补上廉价 token 捕获不到的「就地未暂存编辑」。看板 git 元数据可接受这点最坏延迟，换取每 poll 不再无条件 spawn git。
 * 用于项目主仓库，以及可能有人正在改的 task worktree（见 resolveGitMetadataFullRefreshIntervalForTaskWorktreeMs）。
 */
export const GIT_METADATA_FULL_REFRESH_INTERVAL_FOR_HOME_REPOSITORY_AND_ACTIVE_TASK_WORKTREE_MS = 10_000;

/**
 * 兜底全量刷新窗口（冷档）：闲置 task worktree 的兜底间隔下限。实际间隔再加上按 taskId 算出的确定性抖动，
 * 让几百个闲置任务的到期时刻散开，不在同一个 poll tick 里成阵 spawn git。
 * 冷档只放宽「就地未暂存编辑」这一种最坏延迟：提交、暂存、base 推进仍由廉价 token 与 base tip 门控在 3 秒内发现。
 * 2026-10-12 实测：455 个闲置 worktree 按 10 秒热档兜底时，kanban 每秒约 50 个 git 子进程、常驻约 40% 个核。
 */
// EXPERIMENT_NODE: 闲置 task worktree 兜底全量刷新的间隔下限（60 秒）
export const GIT_METADATA_FULL_REFRESH_INTERVAL_FOR_IDLE_TASK_WORKTREE_MS = 60_000;
// EXPERIMENT_NODE: 闲置 task worktree 兜底刷新的抖动跨度（[0, 30 秒)，按 taskId 哈希确定）
const GIT_METADATA_FULL_REFRESH_JITTER_SPAN_FOR_IDLE_TASK_WORKTREE_MS = 30_000;

/**
 * 最近一次观察到 task worktree 有 git 层面的变化（廉价 token 或 stateToken 变了）后，这段时间内仍按热档兜底刷新：
 * 刚被人动过的 worktree 很可能接着被改，就地未暂存编辑应当仍在 10 秒内可见。
 */
// EXPERIMENT_NODE: 观察到 worktree 变化后维持热档的时长（10 分钟）
export const TASK_WORKTREE_GIT_ACTIVITY_RECENCY_WINDOW_AFTER_LAST_OBSERVED_CHANGE_MS = 10 * 60_000;

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

// 探针需要的卡片字段（取自 board 卡片）。
export interface TaskWorktreeGitMetadataProbeTarget {
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
	// 卡片当前所在列与 auto-review 开关：决定兜底全量刷新走热档还是冷档。
	taskCardBoardColumnId: RuntimeBoardColumnId;
	taskCardAutoReviewEnabled: boolean;
}

export interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
	cheapChangeToken: string | null;
	// 上次算出这份数据时 base 分支的 tip commit。**门控必读**：廉价 fs-stat token 与 probe 的 stateToken
	// 都只反映 worktree 自身，捕获不到 base 分支单方面推进；不比对这一项，commitsBehindBaseRef 会被永久冻结。
	baseRefTipCommit: string | null;
	lastFullRefreshAtMs: number;
	// 最近一次观察到 worktree 有 git 层面变化的时刻（与上次缓存相比廉价 token 或 stateToken 变了）；首轮探测没有
	// 比较基准，不算变化，记 null。决定兜底刷新是否仍在热档。
	lastObservedTaskWorktreeGitChangeAtMs: number | null;
}

// FNV-1a 32 位：同一个 taskId 每次得到同一个抖动，到期时刻在进程内稳定散开。
function computeDeterministicFullRefreshJitterForIdleTaskWorktreeMs(taskId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < taskId.length; index += 1) {
		hash ^= taskId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % GIT_METADATA_FULL_REFRESH_JITTER_SPAN_FOR_IDLE_TASK_WORKTREE_MS;
}

/**
 * 一个 task worktree 当前该用的兜底全量刷新间隔。热档（10 秒）给可能有人正在改的 worktree：
 *   - 卡在 In Progress 列（agent 在跑）；
 *   - 卡在 Review 列且开了 auto-review（自动提交 / 自动 PR 要及时看到未提交改动）；
 *   - 最近一段时间内观察到过 worktree 变化。
 * 其余为冷档：60 秒 + 按 taskId 的确定性抖动。
 */
export function resolveGitMetadataFullRefreshIntervalForTaskWorktreeMs(input: {
	task: TaskWorktreeGitMetadataProbeTarget;
	lastObservedTaskWorktreeGitChangeAtMs: number | null;
	nowMs: number;
}): number {
	const isTaskCardWithAgentPossiblyEditingWorktree = input.task.taskCardBoardColumnId === "in_progress";
	const isAutoReviewTaskCardInReviewColumn =
		input.task.taskCardBoardColumnId === "review" && input.task.taskCardAutoReviewEnabled;
	const hasRecentlyObservedTaskWorktreeGitChange =
		input.lastObservedTaskWorktreeGitChangeAtMs !== null &&
		input.nowMs - input.lastObservedTaskWorktreeGitChangeAtMs <
			TASK_WORKTREE_GIT_ACTIVITY_RECENCY_WINDOW_AFTER_LAST_OBSERVED_CHANGE_MS;
	if (
		isTaskCardWithAgentPossiblyEditingWorktree ||
		isAutoReviewTaskCardInReviewColumn ||
		hasRecentlyObservedTaskWorktreeGitChange
	) {
		return GIT_METADATA_FULL_REFRESH_INTERVAL_FOR_HOME_REPOSITORY_AND_ACTIVE_TASK_WORKTREE_MS;
	}
	return (
		GIT_METADATA_FULL_REFRESH_INTERVAL_FOR_IDLE_TASK_WORKTREE_MS +
		computeDeterministicFullRefreshJitterForIdleTaskWorktreeMs(input.task.taskId)
	);
}

/**
 * stateToken 变了，但 HEAD、分支与 base tip 都没变（只是工作树里的文件变了）时，fork-point、ahead/behind 与提交集成
 * 溯源的全部输入都不变：`merge-base HEAD <baseRef>` 与 `rev-list <baseRef>...HEAD` 只取决于 HEAD 和 base tip，
 * 溯源与落地观测的输入也只是这几项（落地观测的幂等键只含 workspace / task / incarnation / 已集成提交集合）。
 * 这时沿用缓存里这几项，只重算未提交改动统计，省掉 merge-base、rev-list 与溯源的 3–5 个 git spawn。
 * 上次结果不完整（git 探测失败、分叉点或分歧没算出来）时不复用，让下一次变化重试完整链路。
 */
function isCommitDerivedTaskWorktreeGitMetadataInCacheStillValid(input: {
	current: CachedTaskWorkspaceMetadata;
	pathOfTaskWorktree: string;
	baseRef: string;
	headCommit: string | null;
	currentBranch: string | null;
	baseRefTipCommit: string | null;
}): boolean {
	const cached = input.current.data;
	return (
		cached.exists &&
		cached.path === input.pathOfTaskWorktree &&
		cached.baseRef === input.baseRef &&
		input.headCommit !== null &&
		cached.headCommit === input.headCommit &&
		cached.branch === input.currentBranch &&
		input.baseRefTipCommit !== null &&
		input.current.baseRefTipCommit === input.baseRefTipCommit &&
		cached.baseCommit !== null &&
		cached.commitsAheadOfBaseRef !== null &&
		cached.commitsBehindBaseRef !== null &&
		cached.workspaceGitStatus.taskCommitIntegrationTrackingStatus !== "git_probe_unavailable"
	);
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

interface TaskBaseRefDivergence {
	/** HEAD 独有的提交数（任务开工后落在这个 worktree 上的提交）。 */
	commitsAheadOfBaseRef: number | null;
	/** base 分支独有、任务尚未吸收的提交数。 */
	commitsBehindBaseRef: number | null;
}

const UNKNOWN_TASK_BASE_REF_DIVERGENCE: TaskBaseRefDivergence = {
	commitsAheadOfBaseRef: null,
	commitsBehindBaseRef: null,
};

/**
 * 任务 worktree 与 base 分支的双向分歧，一条命令同出：
 * `git rev-list --left-right --count <baseRef>...HEAD`（三个点 = 对称差）输出 `<behind>\t<ahead>`，
 * 左侧为 baseRef 独有、右侧为 HEAD 独有。ahead 与旧的 `merge-base..HEAD` 计数是同一个集合，
 * 所以这条命令**顶替**了原先的 rev-list，per-task git spawn 数不增加。
 * baseRef 不可解析 / git 失败 / 输出不合预期 → 两项皆 null，优雅降级。
 */
async function loadTaskBaseRefDivergence(workspacePath: string, baseRef: string): Promise<TaskBaseRefDivergence> {
	const result = await runGit(workspacePath, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
	if (!result.ok || !result.stdout) {
		return UNKNOWN_TASK_BASE_REF_DIVERGENCE;
	}
	const [behindText, aheadText] = result.stdout.split(/\s+/);
	const behind = Number.parseInt(behindText ?? "", 10);
	const ahead = Number.parseInt(aheadText ?? "", 10);
	if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
		return UNKNOWN_TASK_BASE_REF_DIVERGENCE;
	}
	return { commitsAheadOfBaseRef: ahead, commitsBehindBaseRef: behind };
}

/**
 * 解析 base 分支当前 tip。**按 workspace 去重、每个刷新周期每个 distinct baseRef 只解析一次**，
 * 而不是每个任务各跑一遍——实际几乎总是只有一个 baseRef（如 `main`），于是每 poll tick 每仓库 ≈1 次
 * `rev-parse`，与任务数无关。`rev-parse` 不读 index、不扫工作树，是最廉价的 git 命令之一。
 * 该 tip 只用于门控失效判定（见 CachedTaskWorkspaceMetadata.baseRefTipCommit），不直接下发前端。
 */
export function createBaseRefTipResolver(workspacePath: string): (baseRef: string) => Promise<string | null> {
	const tipByBaseRef = new Map<string, Promise<string | null>>();
	return (baseRef: string) => {
		const cached = tipByBaseRef.get(baseRef);
		if (cached) {
			return cached;
		}
		const pending = workspaceMetadataGitSpawnConcurrencyLimiter(async () => {
			const result = await runGit(workspacePath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
			return result.ok && result.stdout ? result.stdout : null;
		});
		tipByBaseRef.set(baseRef, pending);
		return pending;
	};
}

export async function loadTaskWorkspaceMetadata(
	workspaceId: string,
	workspacePath: string,
	task: TaskWorktreeGitMetadataProbeTarget,
	current: CachedTaskWorkspaceMetadata | null,
	resolveBaseRefTip: (baseRef: string) => Promise<string | null>,
): Promise<CachedTaskWorkspaceMetadata | null> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: workspacePath,
		taskId: task.taskId,
		baseRef: task.baseRef,
		...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
	});

	if (!pathInfo.exists) {
		const baseRefTipCommit = await resolveBaseRefTip(pathInfo.baseRef);
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef &&
			current.baseRefTipCommit === baseRefTipCommit
		) {
			return current;
		}
		const workspaceGitStatus = await refreshTaskCommitIntegrationProvenance({
			workspaceId,
			taskId: task.taskId,
			repoPath: workspacePath,
			worktreePath: pathInfo.path,
			baseRef: pathInfo.baseRef,
			...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
			worktreeExists: false,
			headCommit: null,
			baseRefTipCommit,
			commitsAheadOfBaseRef: null,
			commitsBehindBaseRef: null,
			isDetached: false,
		});
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				baseCommit: null,
				commitsAheadOfBaseRef: workspaceGitStatus.commitsAheadOfBaseRef,
				commitsBehindBaseRef: workspaceGitStatus.commitsBehindBaseRef,
				workspaceGitStatus,
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
			baseRefTipCommit,
			lastFullRefreshAtMs: 0,
			lastObservedTaskWorktreeGitChangeAtMs: null,
		};
	}

	try {
		const now = Date.now();
		// base 分支 tip 必须在两层门控**之前**拿到：worktree 自身的 token 反映不出 base 单方面推进，
		// 不比对 tip 就会把 commitsBehindBaseRef 永久冻结在首次算出的值。按 baseRef 去重后每周期仅 1 次 spawn。
		const baseRefTipCommit = await resolveBaseRefTip(pathInfo.baseRef);
		// 第一层门控（不 spawn git）：廉价 token 与 base tip 均未变、路径/baseRef 一致且未超兜底窗口 → 复用缓存。
		const cheapTokenBeforeProbe = await computeWorktreeGitChangeToken(pathInfo.path);
		const fullRefreshIntervalMs = resolveGitMetadataFullRefreshIntervalForTaskWorktreeMs({
			task,
			lastObservedTaskWorktreeGitChangeAtMs: current?.lastObservedTaskWorktreeGitChangeAtMs ?? null,
			nowMs: now,
		});
		if (
			current &&
			current.cheapChangeToken !== null &&
			current.cheapChangeToken === cheapTokenBeforeProbe &&
			current.baseRefTipCommit === baseRefTipCommit &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef &&
			now - current.lastFullRefreshAtMs < fullRefreshIntervalMs
		) {
			return current;
		}
		const cheapTokenChangedSinceCachedProbe =
			current !== null && current.cheapChangeToken !== null && current.cheapChangeToken !== cheapTokenBeforeProbe;
		// 门控放行后才进入限流器：真正 spawn git 的探针工作（probe + getGitSyncSummary +
		// loadTaskForkPointCommit + loadTaskBaseRefDivergence）钳进共享并发上限。
		return await workspaceMetadataGitSpawnConcurrencyLimiter(async () => {
			const probe = await probeGitWorkspaceState(pathInfo.path, { knownRepoRoot: pathInfo.path });
			// 真探针可能刷新 index 的 stat 缓存，故其后重算 token 存下，保证后续跳过判定稳定。
			const cheapTokenAfterProbe = await computeWorktreeGitChangeToken(pathInfo.path);
			const lastObservedTaskWorktreeGitChangeAtMs =
				current === null
					? null
					: cheapTokenChangedSinceCachedProbe || current.stateToken !== probe.stateToken
						? now
						: current.lastObservedTaskWorktreeGitChangeAtMs;
			if (
				current &&
				current.stateToken === probe.stateToken &&
				current.baseRefTipCommit === baseRefTipCommit &&
				current.data.path === pathInfo.path &&
				current.data.baseRef === pathInfo.baseRef
			) {
				return {
					...current,
					cheapChangeToken: cheapTokenAfterProbe,
					lastFullRefreshAtMs: now,
					lastObservedTaskWorktreeGitChangeAtMs,
				};
			}
			const summary = await getGitSyncSummary(pathInfo.path, { probe });
			if (
				current &&
				isCommitDerivedTaskWorktreeGitMetadataInCacheStillValid({
					current,
					pathOfTaskWorktree: pathInfo.path,
					baseRef: pathInfo.baseRef,
					headCommit: probe.headCommit,
					currentBranch: probe.currentBranch,
					baseRefTipCommit,
				})
			) {
				return {
					data: {
						...current.data,
						changedFiles: summary.changedFiles,
						additions: summary.additions,
						deletions: summary.deletions,
						stateVersion: Date.now(),
					},
					stateToken: probe.stateToken,
					cheapChangeToken: cheapTokenAfterProbe,
					baseRefTipCommit,
					lastFullRefreshAtMs: now,
					lastObservedTaskWorktreeGitChangeAtMs,
				};
			}
			const baseCommit = await loadTaskForkPointCommit(pathInfo.path, pathInfo.baseRef);
			const divergence = await loadTaskBaseRefDivergence(pathInfo.path, pathInfo.baseRef);
			const workspaceGitStatus = await refreshTaskCommitIntegrationProvenance({
				workspaceId,
				taskId: task.taskId,
				repoPath: workspacePath,
				worktreePath: pathInfo.path,
				baseRef: pathInfo.baseRef,
				...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
				worktreeExists: true,
				headCommit: probe.headCommit,
				baseRefTipCommit,
				commitsAheadOfBaseRef: divergence.commitsAheadOfBaseRef,
				commitsBehindBaseRef: divergence.commitsBehindBaseRef,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				observedAt: now,
			});
			return {
				data: {
					taskId: task.taskId,
					path: pathInfo.path,
					exists: true,
					baseRef: pathInfo.baseRef,
					baseCommit,
					commitsAheadOfBaseRef: divergence.commitsAheadOfBaseRef,
					commitsBehindBaseRef: divergence.commitsBehindBaseRef,
					workspaceGitStatus,
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
				baseRefTipCommit,
				lastFullRefreshAtMs: now,
				lastObservedTaskWorktreeGitChangeAtMs,
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
				commitsAheadOfBaseRef: null,
				commitsBehindBaseRef: null,
				workspaceGitStatus: {
					baseRef: pathInfo.baseRef,
					commitsAheadOfBaseRef: null,
					commitsBehindBaseRef: null,
					taskCommitsIntegratedIntoBaseRef: null,
					taskCommitIntegrationTrackingStatus: "git_probe_unavailable",
					observationSource: "unavailable",
					observedAt: null,
				},
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
			baseRefTipCommit: null,
			lastFullRefreshAtMs: 0,
			lastObservedTaskWorktreeGitChangeAtMs: null,
		};
	}
}
