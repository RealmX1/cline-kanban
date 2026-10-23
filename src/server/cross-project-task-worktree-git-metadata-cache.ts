import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeCrossProjectTaskWorktreeGitMetadata,
	RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest,
} from "../core/api-contract";
import { buildCrossProjectTaskSwitcherEntryKey } from "../core/cross-project-recently-active-task-switcher-section-assignment";
import { attachTaskCommitCoverageInCurrentDeploymentToMetadata } from "../deployment/task-commit-coverage-in-current-deployment";
import {
	type CachedTaskWorkspaceMetadata,
	createBaseRefTipResolver,
	loadTaskWorkspaceMetadata,
} from "../workspace/task-worktree-git-metadata-probe";

// 跨项目切换面板里「其他项目」那些行的 git 元数据（ahead/behind、未提交改动），由浏览器按需轮询。
//
// 为什么是「按需 + 服务端缓存」，而不是推流：
//   - workspace-metadata-monitor 只为有浏览器连着的项目跑，推给那个项目的客户端；其他项目没人算。
//   - 并入 projects_updated 广播：未提交改动在 agent 写文件时几秒一变，会让 100 KB 级的整份广播变频繁。
//   - 新建订阅式 monitor：要管面板挂载计数与条目滑出窗口后的清理，生命周期复杂。
// 按需轮询 + 这里按 (workspaceId, taskId) 缓存：多个标签页的请求在服务端去重；条目不再被请求就自然淘汰。
//
// 每个键复用 workspace-metadata-monitor 的同一个探针（loadTaskWorkspaceMetadata）：先用 fs-stat 门控，token
// 与 base tip 不变且未超兜底窗口（按卡片所在列与近期活跃度分热 / 冷两档）就 0 次 git spawn；真要跑 git 时走同一个
// 全局 spawn 并发上限。

// EXPERIMENT_NODE: 跨项目 git 元数据缓存键多久没被请求就淘汰（5 分钟）；面板收起或条目滑出窗口后释放内存。
const CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_CACHE_ENTRY_EVICTION_AFTER_UNREQUESTED_MS = 5 * 60_000;

export interface CrossProjectTaskWorktreeGitMetadataCacheDependencies {
	// 已注册项目的仓库路径；未注册的 workspaceId 一律答「不可用」，绝不按客户端给的 id 凭空探路径。
	listRegisteredWorkspacePathsById: () => Promise<ReadonlyMap<string, string>>;
	// baseRef / worktreeMode 以服务端 board 为准，不信任客户端传入（它们会进 git 命令行）。
	loadWorkspaceBoardById: (workspaceId: string) => Promise<RuntimeBoardData>;
	// 测试注入用；缺省 Date.now。
	now?: () => number;
}

export interface CrossProjectTaskWorktreeGitMetadataCache {
	readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries: (
		request: RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest,
	) => Promise<RuntimeCrossProjectTaskWorktreeGitMetadata[]>;
}

interface CrossProjectTaskWorktreeGitMetadataCacheEntry {
	cachedProbeResult: CachedTaskWorkspaceMetadata | null;
	lastRequestedAtMs: number;
	// 同一个键的单飞：并发请求（多个标签页、上一轮还没回来）共用同一次探针。
	inFlightProbe: Promise<CachedTaskWorkspaceMetadata | null> | null;
}

function indexBoardCardsByTaskId(
	board: RuntimeBoardData,
): Map<string, { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const cardsByTaskId = new Map<string, { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId }>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			cardsByTaskId.set(card.id, { card, columnId: column.id });
		}
	}
	return cardsByTaskId;
}

export function createCrossProjectTaskWorktreeGitMetadataCache(
	deps: CrossProjectTaskWorktreeGitMetadataCacheDependencies,
): CrossProjectTaskWorktreeGitMetadataCache {
	const now = deps.now ?? Date.now;
	const cacheEntriesByKey = new Map<string, CrossProjectTaskWorktreeGitMetadataCacheEntry>();

	const evictEntriesNotRequestedRecently = (nowMs: number) => {
		for (const [key, entry] of cacheEntriesByKey) {
			if (
				entry.inFlightProbe === null &&
				nowMs - entry.lastRequestedAtMs >=
					CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_CACHE_ENTRY_EVICTION_AFTER_UNREQUESTED_MS
			) {
				cacheEntriesByKey.delete(key);
			}
		}
	};

	const probeTaskWorktreeThroughSingleFlight = (
		entry: CrossProjectTaskWorktreeGitMetadataCacheEntry,
		startProbe: (current: CachedTaskWorkspaceMetadata | null) => Promise<CachedTaskWorkspaceMetadata | null>,
	): Promise<CachedTaskWorkspaceMetadata | null> => {
		if (entry.inFlightProbe) {
			return entry.inFlightProbe;
		}
		const inFlightProbe = startProbe(entry.cachedProbeResult)
			.then((result) => {
				entry.cachedProbeResult = result;
				return result;
			})
			.finally(() => {
				entry.inFlightProbe = null;
			});
		entry.inFlightProbe = inFlightProbe;
		return inFlightProbe;
	};

	const readTasksInOneWorkspace = async (
		workspaceId: string,
		workspacePath: string | undefined,
		taskIds: string[],
		nowMs: number,
	): Promise<RuntimeCrossProjectTaskWorktreeGitMetadata[]> => {
		const unavailable = (
			taskId: string,
			unavailableReason: Extract<
				RuntimeCrossProjectTaskWorktreeGitMetadata,
				{ availability: "unavailable" }
			>["unavailableReason"],
		): RuntimeCrossProjectTaskWorktreeGitMetadata => ({
			workspaceId,
			taskId,
			availability: "unavailable",
			unavailableReason,
		});
		if (workspacePath === undefined) {
			return taskIds.map((taskId) => unavailable(taskId, "project_not_registered"));
		}
		let cardsByTaskId: Map<string, { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId }>;
		try {
			cardsByTaskId = indexBoardCardsByTaskId(await deps.loadWorkspaceBoardById(workspaceId));
		} catch {
			return taskIds.map((taskId) => unavailable(taskId, "git_metadata_probe_failed"));
		}
		// 每次请求、每个项目一个解析器：同一 baseRef 的所有任务共用一次 rev-parse。
		const resolveBaseRefTip = createBaseRefTipResolver(workspacePath);
		const results = await Promise.all(
			taskIds.map(async (taskId): Promise<RuntimeCrossProjectTaskWorktreeGitMetadata> => {
				const located = cardsByTaskId.get(taskId);
				if (!located) {
					return unavailable(taskId, "task_card_not_found");
				}
				if (located.columnId === "backlog") {
					return unavailable(taskId, "task_card_in_backlog_has_no_worktree");
				}
				const key = buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId);
				const entry = cacheEntriesByKey.get(key) ?? {
					cachedProbeResult: null,
					lastRequestedAtMs: nowMs,
					inFlightProbe: null,
				};
				entry.lastRequestedAtMs = nowMs;
				cacheEntriesByKey.set(key, entry);
				try {
					const probeResult = await probeTaskWorktreeThroughSingleFlight(entry, (current) =>
						loadTaskWorkspaceMetadata(
							workspaceId,
							workspacePath,
							{
								taskId,
								baseRef: located.card.baseRef,
								...(located.card.worktreeMode ? { worktreeMode: located.card.worktreeMode } : {}),
								taskCardBoardColumnId: located.columnId,
								taskCardAutoReviewEnabled: located.card.autoReviewEnabled === true,
							},
							current,
							resolveBaseRefTip,
						),
					);
					return probeResult
						? { workspaceId, taskId, availability: "available", taskWorkspaceMetadata: probeResult.data }
						: unavailable(taskId, "git_metadata_probe_failed");
				} catch {
					return unavailable(taskId, "git_metadata_probe_failed");
				}
			}),
		);
		const enriched = await attachTaskCommitCoverageInCurrentDeploymentToMetadata({
			workspaceId,
			repositoryPath: workspacePath,
			taskMetadata: results.flatMap((result) =>
				result.availability === "available" ? [result.taskWorkspaceMetadata] : [],
			),
		});
		const enrichedByTaskId = new Map(enriched.map((metadata) => [metadata.taskId, metadata]));
		return results.map((result) =>
			result.availability === "available"
				? {
						...result,
						taskWorkspaceMetadata: enrichedByTaskId.get(result.taskId) ?? result.taskWorkspaceMetadata,
					}
				: result,
		);
	};

	return {
		readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries: async (request) => {
			const nowMs = now();
			evictEntriesNotRequestedRecently(nowMs);
			const taskIdsByWorkspaceId = new Map<string, string[]>();
			const requestedKeys = new Set<string>();
			for (const { workspaceId, taskId } of request.tasks) {
				const key = buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId);
				if (requestedKeys.has(key)) {
					continue;
				}
				requestedKeys.add(key);
				const taskIds = taskIdsByWorkspaceId.get(workspaceId) ?? [];
				taskIds.push(taskId);
				taskIdsByWorkspaceId.set(workspaceId, taskIds);
			}
			if (taskIdsByWorkspaceId.size === 0) {
				return [];
			}
			const registeredWorkspacePathsById = await deps.listRegisteredWorkspacePathsById();
			const resultsPerWorkspace = await Promise.all(
				[...taskIdsByWorkspaceId].map(([workspaceId, taskIds]) =>
					readTasksInOneWorkspace(workspaceId, registeredWorkspacePathsById.get(workspaceId), taskIds, nowMs),
				),
			);
			return resultsPerWorkspace.flat();
		},
	};
}
