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
// 不是 provenance 内容哈希。读失败时用它把单飞与「文件里本来就没有该任务」分开。
const UNREADABLE_TASK_COMMIT_INTEGRATION_PROVENANCE_VERSION = "unreadable";

interface TaskWorkspaceGitStatusQueryCacheEntry {
	cachedTaskWorkspaceMetadata: CachedTaskWorkspaceMetadata | null;
	inFlightTaskWorkspaceMetadataProbe: Promise<CachedTaskWorkspaceMetadata | null> | null;
	lastRequestedAtMs: number;
	workspaceId: string;
	workspacePath: string;
}

function taskWorkspaceGitStatusQueryIdentity(card: RuntimeBoardCard): string {
	return JSON.stringify([card.id, card.createdAt, card.baseRef, card.worktreeMode ?? "worktree"]);
}

function taskWorkspaceGitStatusQueryCacheKey(
	scope: { workspaceId: string; workspacePath: string },
	identity: string,
	provenanceVersion: string | null,
): string {
	return JSON.stringify([scope.workspaceId, scope.workspacePath, identity, provenanceVersion]);
}

function cacheableTaskWorkspaceMetadata(
	metadata: CachedTaskWorkspaceMetadata | null,
): CachedTaskWorkspaceMetadata | null {
	if (metadata === null) return null;
	return metadata.data.workspaceGitStatus.taskCommitIntegrationTrackingStatus === "git_probe_unavailable"
		? null
		: metadata;
}

export function createTaskWorkspaceGitStatusQueryCache(deps: {
	loadWorkspaceBoardById: (workspaceId: string) => Promise<RuntimeBoardData>;
}) {
	const cacheEntriesByTaskWorkspaceGitStatusQueryKey = new Map<string, TaskWorkspaceGitStatusQueryCacheEntry>();
	let admittedProbeCount = 0;
	const admissionWaiters: Array<() => void> = [];

	function acquireTaskWorkspaceGitStatusProbeAdmission(): Promise<void> {
		if (admittedProbeCount < MAX_CACHED_TASK_WORKSPACE_GIT_STATUS_QUERIES) {
			admittedProbeCount += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			admissionWaiters.push(resolve);
		});
	}

	// 等待者继承名额，避免先减再加把并发上限瞬时让出去。
	function releaseTaskWorkspaceGitStatusProbeAdmission(): void {
		const resume = admissionWaiters.shift();
		if (resume !== undefined) resume();
		else admittedProbeCount -= 1;
	}

	function evictIdleTaskWorkspaceGitStatusQueryCacheEntriesOverCapacity(): void {
		while (cacheEntriesByTaskWorkspaceGitStatusQueryKey.size > MAX_CACHED_TASK_WORKSPACE_GIT_STATUS_QUERIES) {
			let oldestIdleKey: string | undefined;
			for (const [key, entry] of cacheEntriesByTaskWorkspaceGitStatusQueryKey) {
				if (entry.inFlightTaskWorkspaceMetadataProbe === null) {
					oldestIdleKey = key;
					break;
				}
			}
			if (oldestIdleKey === undefined) break;
			cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(oldestIdleKey);
		}
	}

	function invalidateIdleTaskWorkspaceGitStatusQueryCache(scope: {
		workspaceId: string;
		workspacePath: string;
	}): void {
		for (const [key, entry] of cacheEntriesByTaskWorkspaceGitStatusQueryKey) {
			if (
				entry.inFlightTaskWorkspaceMetadataProbe === null &&
				entry.workspaceId === scope.workspaceId &&
				entry.workspacePath === scope.workspacePath
			)
				cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(key);
		}
	}

	function retainProbedTaskWorkspaceMetadataForProvenanceVersion(input: {
		metadata: CachedTaskWorkspaceMetadata | null;
		cachedBeforeProbe: CachedTaskWorkspaceMetadata | null;
		provenanceVersionReadFailed: boolean;
		provenanceVersion: string | null;
		entry: TaskWorkspaceGitStatusQueryCacheEntry;
		scope: { workspaceId: string; workspacePath: string };
		identity: string;
	}): void {
		try {
			retainProbedTaskWorkspaceMetadataForProvenanceVersionUnchecked(input);
		} catch {
			input.entry.cachedTaskWorkspaceMetadata = null;
		}
	}

	function retainProbedTaskWorkspaceMetadataForProvenanceVersionUnchecked(input: {
		metadata: CachedTaskWorkspaceMetadata | null;
		cachedBeforeProbe: CachedTaskWorkspaceMetadata | null;
		provenanceVersionReadFailed: boolean;
		provenanceVersion: string | null;
		entry: TaskWorkspaceGitStatusQueryCacheEntry;
		scope: { workspaceId: string; workspacePath: string };
		identity: string;
	}): void {
		const cacheable = cacheableTaskWorkspaceMetadata(input.metadata);
		if (cacheable === null || input.provenanceVersionReadFailed) {
			input.entry.cachedTaskWorkspaceMetadata = null;
			return;
		}
		// 廉价门控原样返回探针前的对象时，这次探针没有回写 provenance。
		if (cacheable === input.cachedBeforeProbe) return;
		// 未声明版本表示探针没有读/写 provenance，结果仍只属于请求开始时的键。不得在探针返回后重读文件：
		// 那次读取可能已经是其他写入者恢复的历史。
		const boundVersion = cacheable.boundTaskCommitIntegrationProvenanceVersion;
		if (boundVersion === undefined || boundVersion === input.provenanceVersion) {
			input.entry.cachedTaskWorkspaceMetadata = cacheable;
			return;
		}
		// 新状态若留在预镜像键上，文件回到旧字节时会在热/冷窗口内直接命中这份回写结果。
		input.entry.cachedTaskWorkspaceMetadata = null;
		const rekeyedKey = taskWorkspaceGitStatusQueryCacheKey(input.scope, input.identity, boundVersion);
		const existing = cacheEntriesByTaskWorkspaceGitStatusQueryKey.get(rekeyedKey);
		if (existing === input.entry) {
			input.entry.cachedTaskWorkspaceMetadata = cacheable;
			return;
		}
		if (existing !== undefined && existing.inFlightTaskWorkspaceMetadataProbe !== null) return;
		const destination = existing ?? {
			cachedTaskWorkspaceMetadata: null,
			inFlightTaskWorkspaceMetadataProbe: null,
			lastRequestedAtMs: Date.now(),
			workspaceId: input.scope.workspaceId,
			workspacePath: input.scope.workspacePath,
		};
		destination.cachedTaskWorkspaceMetadata = cacheable;
		destination.lastRequestedAtMs = Date.now();
		cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(rekeyedKey);
		cacheEntriesByTaskWorkspaceGitStatusQueryKey.set(rekeyedKey, destination);
		evictIdleTaskWorkspaceGitStatusQueryCacheEntriesOverCapacity();
	}

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
		let provenanceVersions = new Map<string, string>();
		let provenanceVersionReadFailed = false;
		try {
			provenanceVersions = await readTaskCommitIntegrationProvenanceVersionsByTaskId(
				scope.workspaceId,
				tasks.map(({ card }) => card.id),
			);
		} catch {
			// 版本读失败不能拒绝整批列表。失效本工作区的空闲成功缓存，探测仍继续；inplace 不读该文件。
			provenanceVersionReadFailed = true;
			invalidateIdleTaskWorkspaceGitStatusQueryCache(scope);
		}
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
				const provenanceVersion = provenanceVersionReadFailed
					? UNREADABLE_TASK_COMMIT_INTEGRATION_PROVENANCE_VERSION
					: (provenanceVersions.get(card.id) ?? null);
				const key = taskWorkspaceGitStatusQueryCacheKey(scope, identity, provenanceVersion);
				const entry = cacheEntriesByTaskWorkspaceGitStatusQueryKey.get(key) ?? {
					cachedTaskWorkspaceMetadata: null,
					inFlightTaskWorkspaceMetadataProbe: null,
					lastRequestedAtMs: now,
					workspaceId: scope.workspaceId,
					workspacePath: scope.workspacePath,
				};
				entry.lastRequestedAtMs = now;
				cacheEntriesByTaskWorkspaceGitStatusQueryKey.delete(key);
				cacheEntriesByTaskWorkspaceGitStatusQueryKey.set(key, entry);
				if (entry.inFlightTaskWorkspaceMetadataProbe === null) {
					const cachedBeforeProbe = entry.cachedTaskWorkspaceMetadata;
					entry.inFlightTaskWorkspaceMetadataProbe = acquireTaskWorkspaceGitStatusProbeAdmission()
						.then(() =>
							loadTaskWorkspaceMetadata(
								scope.workspaceId,
								scope.workspacePath,
								{
									taskId: card.id,
									baseRef: card.baseRef,
									worktreeMode: card.worktreeMode,
									taskCardBoardColumnId: columnId,
									taskCardAutoReviewEnabled: card.autoReviewEnabled === true,
								},
								cachedBeforeProbe,
								resolveBaseRefTip,
							),
						)
						.then(
							(metadata) => {
								retainProbedTaskWorkspaceMetadataForProvenanceVersion({
									metadata,
									cachedBeforeProbe,
									provenanceVersionReadFailed,
									provenanceVersion,
									entry,
									scope,
									identity,
								});
								return metadata;
							},
							() => {
								entry.cachedTaskWorkspaceMetadata = null;
								return null;
							},
						)
						.finally(() => {
							entry.inFlightTaskWorkspaceMetadataProbe = null;
							releaseTaskWorkspaceGitStatusProbeAdmission();
							evictIdleTaskWorkspaceGitStatusQueryCacheEntriesOverCapacity();
						});
				}
				evictIdleTaskWorkspaceGitStatusQueryCacheEntriesOverCapacity();
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
