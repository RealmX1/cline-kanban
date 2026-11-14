import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskWorkspaceGitStatusesRequest,
	RuntimeTaskWorkspaceGitStatusesResponse,
} from "../core/api-contract";
import { readTaskCommitIntegrationProvenanceVersionsByTaskId } from "../workspace/task-commit-integration-provenance";
import {
	type CachedTaskWorkspaceMetadata,
	createBaseRefTipResolver,
	loadTaskWorkspaceMetadata,
} from "../workspace/task-worktree-git-metadata-probe";

// EXPERIMENT_NODE: 列表缓存容量2048、闲置保留5分钟，按真实任务规模复测内存与命中率。
const MAX_CACHED_TASK_WORKSPACE_GIT_STATUS_QUERIES = 2_048;
const TASK_WORKSPACE_GIT_STATUS_QUERY_CACHE_RETENTION_MS = 5 * 60_000;

interface TaskWorkspaceGitStatusQueryCacheEntry {
	cachedTaskWorkspaceMetadata: CachedTaskWorkspaceMetadata | null;
	inFlightTaskWorkspaceMetadataProbe: Promise<CachedTaskWorkspaceMetadata | null> | null;
	lastRequestedAtMs: number;
}

function taskWorkspaceGitStatusQueryIdentity(card: RuntimeBoardCard): string {
	return JSON.stringify([card.id, card.createdAt, card.baseRef, card.worktreeMode ?? "worktree"]);
}

export function createTaskWorkspaceGitStatusQueryCache(deps: {
	loadWorkspaceBoardById: (workspaceId: string) => Promise<RuntimeBoardData>;
}) {
	const cacheEntriesByTaskWorkspaceGitStatusQueryKey = new Map<string, TaskWorkspaceGitStatusQueryCacheEntry>();

	return async (
		scope: { workspaceId: string; workspacePath: string },
		input?: RuntimeTaskWorkspaceGitStatusesRequest,
	): Promise<RuntimeTaskWorkspaceGitStatusesResponse> => {
		const board = await deps.loadWorkspaceBoardById(scope.workspaceId);
		const requestedTaskIds = input ? new Set(input.taskIds) : null;
		const tasks = board.columns.flatMap((column) =>
			column.cards
				.filter((card) => requestedTaskIds === null || requestedTaskIds.has(card.id))
				.map((card) => ({ card: { ...card }, columnId: column.id })),
		);
		if (tasks.length === 0) return { taskWorkspaceGitStatuses: {} };
		const provenanceVersions = await readTaskCommitIntegrationProvenanceVersionsByTaskId(
			scope.workspaceId,
			tasks.map(({ card }) => card.id),
		);
		const now = Date.now();
		for (const [key, entry] of cacheEntriesByTaskWorkspaceGitStatusQueryKey) {
			if (
				entry.inFlightTaskWorkspaceMetadataProbe === null &&
				now - entry.lastRequestedAtMs >= TASK_WORKSPACE_GIT_STATUS_QUERY_CACHE_RETENTION_MS
			)
				cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(key);
		}
		const resolveBaseRefTip = createBaseRefTipResolver(scope.workspacePath);
		const results = await Promise.all(
			tasks.map(async ({ card, columnId }) => {
				const identity = taskWorkspaceGitStatusQueryIdentity(card);
				const key = JSON.stringify([
					scope.workspaceId,
					scope.workspacePath,
					identity,
					provenanceVersions.get(card.id),
				]);
				const entry = cacheEntriesByTaskWorkspaceGitStatusQueryKey.get(key) ?? {
					cachedTaskWorkspaceMetadata: null,
					inFlightTaskWorkspaceMetadataProbe: null,
					lastRequestedAtMs: now,
				};
				entry.lastRequestedAtMs = now;
				cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(key);
				cacheEntriesByTaskWorkspaceGitStatusQueryKey.set(key, entry);
				while (cacheEntriesByTaskWorkspaceGitStatusQueryKey.size > MAX_CACHED_TASK_WORKSPACE_GIT_STATUS_QUERIES) {
					const oldest = cacheEntriesByTaskWorkspaceGitStatusQueryKey.keys().next().value;
					if (oldest !== undefined) cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(oldest);
				}
				if (entry.inFlightTaskWorkspaceMetadataProbe === null) {
					entry.inFlightTaskWorkspaceMetadataProbe = loadTaskWorkspaceMetadata(
						scope.workspaceId,
						scope.workspacePath,
						{
							taskId: card.id,
							baseRef: card.baseRef,
							worktreeMode: card.worktreeMode,
							taskCardBoardColumnId: columnId,
							taskCardAutoReviewEnabled: card.autoReviewEnabled === true,
						},
						entry.cachedTaskWorkspaceMetadata,
						resolveBaseRefTip,
					)
						.then((metadata) => {
							entry.cachedTaskWorkspaceMetadata =
								metadata?.data.workspaceGitStatus.taskCommitIntegrationTrackingStatus ===
								"git_probe_unavailable"
									? null
									: metadata;
							return metadata;
						})
						.catch(() => {
							entry.cachedTaskWorkspaceMetadata = null;
							return null;
						})
						.finally(() => {
							entry.inFlightTaskWorkspaceMetadataProbe = null;
						});
				}
				const metadata = await entry.inFlightTaskWorkspaceMetadataProbe;
				return {
					card,
					identity,
					status: metadata?.data.workspaceGitStatus ?? {
						baseRef: card.baseRef,
						commitsAheadOfBaseRef: null,
						commitsBehindBaseRef: null,
						taskCommitsIntegratedIntoBaseRef: null,
						taskCommitIntegrationTrackingStatus: "git_probe_unavailable" as const,
						observationSource: "unavailable" as const,
						observedAt: null,
					},
				};
			}),
		);
		// 删除重建或改 baseRef 期间结束的旧探针，不能把结果归给响应时的另一世任务。
		const latestBoard = await deps.loadWorkspaceBoardById(scope.workspaceId);
		const latestCardsById = new Map(
			latestBoard.columns.flatMap((column) => column.cards.map((card) => [card.id, card])),
		);
		return {
			taskWorkspaceGitStatuses: Object.fromEntries(
				results
					.filter(({ card, identity }) => {
						const latest = latestCardsById.get(card.id);
						return latest !== undefined && taskWorkspaceGitStatusQueryIdentity(latest) === identity;
					})
					.map(({ card, status }) => [card.id, status]),
			),
		};
	};
}
