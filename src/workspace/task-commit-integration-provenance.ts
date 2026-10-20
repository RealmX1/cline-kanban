import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pLimit from "p-limit";
import { z } from "zod";

import type {
	RuntimeTaskCommitIntegrationTrackingStatus,
	RuntimeTaskRetainedCommittedLineChangeHistory,
	RuntimeTaskRetainedCommittedLineChangeSummary,
	RuntimeTaskWorkspaceGitStatus,
	RuntimeTaskWorktreeMode,
} from "../core/api-contract";
import { runtimeTaskRetainedCommittedLineChangeHistorySchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "../state/workspace-state";
import { computeStablePatchId, readGitHeadInfo, runGit } from "./git-utils";
import {
	evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits,
	matchTaskCommitsOneToOneIntoBaseRefCommits,
	type TaskCommitIntegrationIntoBaseRefMatchKind,
} from "./shared-task-commit-landing-criterion-against-local-base";
import {
	type LastKnownTaskHeadObservationSourceForSharedLandingCriterion,
	reportSharedTaskCommitLandingCriterionSatisfiedObservation,
} from "./shared-task-commit-landing-criterion-satisfied-observation-port";
import {
	cachedTaskCommitLineChangeStatisticsSchema,
	createUnavailableTaskRetainedCommittedLineChangeHistory,
	refreshTaskRetainedCommittedLineChangeStatistics,
} from "./task-retained-committed-line-change-statistics";
import { proveTaskWorktreeHeadMovedOnlyByFastForwardSinceCreation } from "./task-worktree-head-reflog-fast-forward-only-evidence";

const TASK_COMMIT_INTEGRATION_PROVENANCE_FILENAME = "task-commit-integration-provenance.json";
const TASK_COMMIT_INTEGRATION_PROVENANCE_SCHEMA_VERSION = 1;
const TASK_COMMIT_INTEGRATION_GIT_CONCURRENCY_LIMIT = 4;
const TASK_COMMIT_IDENTITY_CACHE_MAX_ENTRIES = 10_000;
const BASE_REF_COMMIT_IDENTITY_RANGE_CACHE_MAX_ENTRIES = 128;

const taskCommitIntegrationGitConcurrencyLimiter = pLimit(TASK_COMMIT_INTEGRATION_GIT_CONCURRENCY_LIMIT);

const observedTaskCommitSchema = z.object({
	commitSha: z.string(),
	stablePatchId: z.string().nullable(),
});
export type ObservedTaskCommit = z.infer<typeof observedTaskCommitSchema>;

const taskCommitProvenanceIncarnationSchema = z.object({
	incarnationId: z.string(),
	initialBaseCommit: z.string(),
	// 复制来源时，initialBaseCommit 是继承提交的排除锚点，未必属于 base 历史；探测下界单独保存。
	baseRefCommitHistoryProbeFloorCommit: z.string().optional(),
	captureSource: z.enum(["worktree_creation", "live_pre_handback_backfill"]),
	startedAt: z.number(),
	observedTaskCommits: z.array(observedTaskCommitSchema),
});
type TaskCommitProvenanceIncarnation = z.infer<typeof taskCommitProvenanceIncarnationSchema>;

const persistedTaskWorkspaceGitSnapshotSchema = z.object({
	path: z.string(),
	headCommit: z.string(),
	baseRefTipCommit: z.string(),
	commitsAheadOfBaseRef: z.number().int().nonnegative(),
	commitsBehindBaseRef: z.number().int().nonnegative(),
	taskCommitsIntegratedIntoBaseRef: z.number().int().nonnegative(),
	isDetached: z.boolean(),
	// dd2db 1a 落地数据保全（§R3 Y-PHASE-3）：每次探测都记下「从最后已知 HEAD 可达的非 merge 自有提交」，
	// 共享落地判据（exact SHA → patch-id 一对一进 base）在 1c 求值。可达集合必须在探测时采集，worktree 删掉后
	// 就再也算不出来。旧文件没有这个字段（optional）。
	// 「自有」= 最新一世观测到的 task 提交（旧世提交经 base 被新一世吸收时不属于新一世）；「可达」= 从 HEAD 可达、
	// 且不可从最新一世的创建锚点到达。1c 之前的代码误取了 `baseRef..HEAD`，提交一旦以 merge 方式进了 base，
	// 下一次探测就把它清空——persisted 分支会按需重算纠正。
	taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: z.array(observedTaskCommitSchema).optional(),
	observedAt: z.number(),
});
type PersistedTaskWorkspaceGitSnapshot = z.infer<typeof persistedTaskWorkspaceGitSnapshotSchema>;

const taskCommitIntegrationProvenanceEntrySchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	incarnations: z.array(taskCommitProvenanceIncarnationSchema),
	lastWorkspaceGitSnapshot: persistedTaskWorkspaceGitSnapshotSchema.nullable(),
	retainedCommittedLineChangeHistory: runtimeTaskRetainedCommittedLineChangeHistorySchema.optional(),
	committedLineChangeStatisticsByCommitSha: z
		.record(z.string(), cachedTaskCommitLineChangeStatisticsSchema)
		.optional(),
});
type TaskCommitIntegrationProvenanceEntry = z.infer<typeof taskCommitIntegrationProvenanceEntrySchema>;

const taskCommitIntegrationProvenanceFileSchema = z.object({
	schemaVersion: z.literal(TASK_COMMIT_INTEGRATION_PROVENANCE_SCHEMA_VERSION),
	tasks: z.record(z.string(), taskCommitIntegrationProvenanceEntrySchema),
});
type TaskCommitIntegrationProvenanceFile = z.infer<typeof taskCommitIntegrationProvenanceFileSchema>;

function resolvePersistedRetainedCommittedLineChangeHistory(
	previousHistory: RuntimeTaskRetainedCommittedLineChangeHistory | undefined,
	refreshedHistory: RuntimeTaskRetainedCommittedLineChangeHistory,
): RuntimeTaskRetainedCommittedLineChangeHistory {
	// 临时统计失败只影响当前摘要，保留最后完整明细供只读请求展示，并由摘要版本差异标明它不是当前结果。
	return previousHistory?.summary.status === "complete" &&
		refreshedHistory.summary.unavailableReason?.startsWith("commit_statistics_")
		? previousHistory
		: refreshedHistory;
}

export interface TaskCommitIdentity {
	commitSha: string;
	stablePatchId: string | null;
}

export interface CountTaskCommitsIntegratedIntoBaseRefResult {
	integratedTaskCommitCount: number;
	exactHashMatchedTaskCommitShas: string[];
	patchIdMatchedTaskCommitShas: string[];
}

/**
 * 对两个已解析的 commit identity 集合做一对一关联（与 dd2db 共享落地判据同一个匹配器，见
 * shared-task-commit-landing-criterion-against-local-base.ts）：先消费 exact SHA，再消费 stable patch-id；
 * base 侧每个 commit 最多消费一次，防止重复 patch 被虚高计数。merge / 空提交没有 patch-id，天然只走 exact。
 */
export function countTaskCommitsIntegratedIntoBaseRef(input: {
	observedTaskCommits: readonly TaskCommitIdentity[];
	baseRefCommits: readonly TaskCommitIdentity[];
}): CountTaskCommitsIntegratedIntoBaseRefResult {
	const { taskCommitsIntegratedIntoBaseRef } = matchTaskCommitsOneToOneIntoBaseRefCommits({
		taskCommits: input.observedTaskCommits,
		baseRefCommits: input.baseRefCommits,
	});
	const shasMatchedBy = (matchKind: TaskCommitIntegrationIntoBaseRefMatchKind): string[] =>
		taskCommitsIntegratedIntoBaseRef
			.filter((match) => match.taskCommitIntegrationIntoBaseRefMatchKind === matchKind)
			.map((match) => match.taskCommitSha);
	return {
		integratedTaskCommitCount: taskCommitsIntegratedIntoBaseRef.length,
		exactHashMatchedTaskCommitShas: shasMatchedBy("exact_commit_sha"),
		patchIdMatchedTaskCommitShas: shasMatchedBy("stable_patch_id_equivalent"),
	};
}

function createEmptyProvenanceFile(): TaskCommitIntegrationProvenanceFile {
	return {
		schemaVersion: TASK_COMMIT_INTEGRATION_PROVENANCE_SCHEMA_VERSION,
		tasks: {},
	};
}

function getTaskCommitIntegrationProvenancePath(workspaceId: string): string {
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing task commit integration provenance access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, TASK_COMMIT_INTEGRATION_PROVENANCE_FILENAME);
}

async function readProvenanceFile(workspaceId: string): Promise<TaskCommitIntegrationProvenanceFile> {
	let raw: string;
	try {
		raw = await readFile(getTaskCommitIntegrationProvenancePath(workspaceId), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return createEmptyProvenanceFile();
		}
		throw error;
	}
	try {
		const parsed = taskCommitIntegrationProvenanceFileSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : createEmptyProvenanceFile();
	} catch {
		// provenance 损坏时保守降级 unknown；绝不能把不可证明的历史解释成 0。
		return createEmptyProvenanceFile();
	}
}

const provenanceWriteQueueByWorkspaceId = new Map<string, Promise<unknown>>();

function enqueueProvenanceMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
	const previous = provenanceWriteQueueByWorkspaceId.get(workspaceId) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	provenanceWriteQueueByWorkspaceId.set(
		workspaceId,
		next.catch(() => undefined),
	);
	return next;
}

async function mutateProvenanceFile<T>(
	workspaceId: string,
	mutator: (file: TaskCommitIntegrationProvenanceFile) => T,
): Promise<T> {
	return await enqueueProvenanceMutation(workspaceId, async () => {
		const provenancePath = getTaskCommitIntegrationProvenancePath(workspaceId);
		return await lockedFileSystem.withLock({ path: provenancePath }, async () => {
			const file = await readProvenanceFile(workspaceId);
			const result = mutator(file);
			await lockedFileSystem.writeJsonFileAtomic(provenancePath, file, { lock: null });
			return result;
		});
	});
}

export async function recordTaskWorktreeCreationCommitProvenance(input: {
	workspaceId: string;
	taskId: string;
	baseRef: string;
	initialBaseCommit: string;
	baseRefCommitHistoryProbeFloorCommit?: string;
	recordedAt?: number;
}): Promise<void> {
	const recordedAt = input.recordedAt ?? Date.now();
	await mutateProvenanceFile(input.workspaceId, (file) => {
		const existing = file.tasks[input.taskId];
		const previousIncarnation = existing?.incarnations.at(-1);
		if (
			previousIncarnation?.initialBaseCommit === input.initialBaseCommit &&
			previousIncarnation.baseRefCommitHistoryProbeFloorCommit === input.baseRefCommitHistoryProbeFloorCommit &&
			previousIncarnation.observedTaskCommits.length === 0 &&
			existing?.baseRef === input.baseRef
		) {
			return;
		}
		const incarnation: TaskCommitProvenanceIncarnation = {
			incarnationId: `${input.initialBaseCommit}:${recordedAt}`,
			initialBaseCommit: input.initialBaseCommit,
			baseRefCommitHistoryProbeFloorCommit: input.baseRefCommitHistoryProbeFloorCommit,
			captureSource: "worktree_creation",
			startedAt: recordedAt,
			observedTaskCommits: [],
		};
		file.tasks[input.taskId] = {
			taskId: input.taskId,
			baseRef: input.baseRef,
			incarnations:
				existing && existing.baseRef === input.baseRef ? [...existing.incarnations, incarnation] : [incarnation],
			lastWorkspaceGitSnapshot:
				existing && existing.baseRef === input.baseRef ? existing.lastWorkspaceGitSnapshot : null,
			retainedCommittedLineChangeHistory:
				existing?.baseRef === input.baseRef ? existing.retainedCommittedLineChangeHistory : undefined,
			committedLineChangeStatisticsByCommitSha:
				existing?.baseRef === input.baseRef ? existing.committedLineChangeStatisticsByCommitSha : undefined,
		};
	});
}

async function listCommitShas(cwd: string, revisionRange: string, firstParent = false): Promise<string[] | null> {
	const result = await runGit(cwd, [
		"rev-list",
		"--reverse",
		...(firstParent ? ["--first-parent"] : []),
		revisionRange,
	]);
	if (!result.ok) {
		return null;
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

// 同一次 rev-list 里用 --parents 顺带判定 merge，不为「非 merge」多起一个 git 进程。
async function listCommitShasWithMergeCommitFlag(
	cwd: string,
	revisionRange: string,
	commitsReachableFromExcludedCommit?: string,
): Promise<Array<{ commitSha: string; isMergeCommit: boolean }> | null> {
	const result = await runGit(cwd, [
		"rev-list",
		"--reverse",
		"--parents",
		...(commitsReachableFromExcludedCommit ? [`^${commitsReachableFromExcludedCommit}`] : []),
		revisionRange,
	]);
	if (!result.ok) {
		return null;
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [commitSha = "", ...parentShas] = line.split(/\s+/);
			return { commitSha, isMergeCommit: parentShas.length > 1 };
		});
}

const commitIdentityPromiseByRepositoryPathAndCommitSha = new Map<string, Promise<TaskCommitIdentity>>();

function rememberCommitIdentityPromise(cacheKey: string, identityPromise: Promise<TaskCommitIdentity>): void {
	commitIdentityPromiseByRepositoryPathAndCommitSha.set(cacheKey, identityPromise);
	while (commitIdentityPromiseByRepositoryPathAndCommitSha.size > TASK_COMMIT_IDENTITY_CACHE_MAX_ENTRIES) {
		const oldestCacheKey = commitIdentityPromiseByRepositoryPathAndCommitSha.keys().next().value;
		if (typeof oldestCacheKey !== "string") {
			break;
		}
		commitIdentityPromiseByRepositoryPathAndCommitSha.delete(oldestCacheKey);
	}
}

async function resolveCommitIdentity(cwd: string, commitSha: string): Promise<TaskCommitIdentity> {
	const cacheKey = `${resolve(cwd)}\0${commitSha}`;
	const cached = commitIdentityPromiseByRepositoryPathAndCommitSha.get(cacheKey);
	if (cached) {
		return await cached;
	}
	const pending = taskCommitIntegrationGitConcurrencyLimiter(async () => ({
		commitSha,
		stablePatchId: await computeStablePatchId(cwd, commitSha),
	}));
	rememberCommitIdentityPromise(cacheKey, pending);
	return await pending;
}

async function resolveCommitIdentities(cwd: string, commitShas: readonly string[]): Promise<TaskCommitIdentity[]> {
	return await Promise.all(commitShas.map(async (commitSha) => await resolveCommitIdentity(cwd, commitSha)));
}

function deduplicateObservedTaskCommits(
	incarnations: readonly TaskCommitProvenanceIncarnation[],
): ObservedTaskCommit[] {
	const commitsBySha = new Map<string, ObservedTaskCommit>();
	for (const incarnation of incarnations) {
		for (const commit of incarnation.observedTaskCommits) {
			commitsBySha.set(commit.commitSha, commit);
		}
	}
	return [...commitsBySha.values()];
}

function resolveRetainedTaskCommitShasForCommittedLineChangeStatistics(input: {
	observedTaskCommits: readonly ObservedTaskCommit[];
	taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: readonly ObservedTaskCommit[];
	baseRefCommits: readonly TaskCommitIdentity[];
}): string[] {
	const reachableTaskCommitShaSet = new Set(
		input.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead.map((commit) => commit.commitSha),
	);
	// 仅为累计投影优先匹配仍可达的版本，避免旧 amend/rebase 版本抢占同一个等价落地提交。
	// 匹配器仍优先消费 exact SHA，保留已经独立落地的提交；原集成计数与 landing/deploy 判据不变。
	const integration = countTaskCommitsIntegratedIntoBaseRef({
		observedTaskCommits: [
			...input.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
			...input.observedTaskCommits.filter((commit) => !reachableTaskCommitShaSet.has(commit.commitSha)),
		],
		baseRefCommits: input.baseRefCommits,
	});
	const retainedTaskCommitShaSet = new Set([
		...reachableTaskCommitShaSet,
		...integration.exactHashMatchedTaskCommitShas,
		...integration.patchIdMatchedTaskCommitShas,
	]);
	return input.observedTaskCommits
		.filter((commit) => retainedTaskCommitShaSet.has(commit.commitSha))
		.map((commit) => commit.commitSha);
}

/**
 * 共享落地判据的 S：**最新一世**观测到的自有提交里，从 task HEAD 可达、不可从最新一世创建锚点到达、且非 merge 的那些。
 * 不取各世累积：旧世提交若经 base 被新一世吸收，HEAD 可达它、锚点又不可达它，会被误算进新一世的 S（新一世没有自有提交
 * 也被判「全部落地」）。跨世累积只用于集成计数 `countTaskCommitsIntegratedIntoBaseRef`。
 * 不能用 `baseRef..HEAD`：提交以 merge 方式进了 base 之后它就是空的，判据会把「已落地」看成「没产出提交」。
 * 已知可达集合（本次探测的 `baseRef..HEAD`）覆盖全部自有提交时不再起 git；否则补一次 `<锚点>..HEAD`。
 * 返回 null 表示 git 读不出（HEAD 或锚点对象不在了）。
 */
async function resolveTaskOwnedNonMergeCommitsReachableFromTaskHead(input: {
	gitCwd: string;
	taskHeadCommit: string;
	latestTaskCommitProvenanceIncarnationInitialBaseCommit: string;
	taskOwnedCommitsObservedInLatestIncarnation: readonly ObservedTaskCommit[];
	commitsAlreadyKnownReachableFromTaskHeadWithMergeCommitFlag: ReadonlyArray<{
		commitSha: string;
		isMergeCommit: boolean;
	}>;
}): Promise<ObservedTaskCommit[] | null> {
	let isMergeCommitByReachableCommitSha = new Map(
		input.commitsAlreadyKnownReachableFromTaskHeadWithMergeCommitFlag.map((commit) => [
			commit.commitSha,
			commit.isMergeCommit,
		]),
	);
	const someOwnedCommitOutsideKnownReachableSet = input.taskOwnedCommitsObservedInLatestIncarnation.some(
		(commit) => !isMergeCommitByReachableCommitSha.has(commit.commitSha),
	);
	if (someOwnedCommitOutsideKnownReachableSet) {
		const reachableSinceLatestIncarnationAnchor = await listCommitShasWithMergeCommitFlag(
			input.gitCwd,
			`${input.latestTaskCommitProvenanceIncarnationInitialBaseCommit}..${input.taskHeadCommit}`,
		);
		if (reachableSinceLatestIncarnationAnchor === null) {
			return null;
		}
		isMergeCommitByReachableCommitSha = new Map(
			reachableSinceLatestIncarnationAnchor.map((commit) => [commit.commitSha, commit.isMergeCommit]),
		);
	}
	return input.taskOwnedCommitsObservedInLatestIncarnation.filter(
		(commit) => isMergeCommitByReachableCommitSha.get(commit.commitSha) === false,
	);
}

// 判据满足才上报（经端口交给 runtime 的账本记录；未注册的进程不记账）。不满足的结局留给阶段 3 的门评估器按需求值。
function reportSharedTaskCommitLandingCriterionSatisfiedObservationWhenSatisfied(input: {
	workspaceId: string;
	taskId: string;
	taskCommitProvenanceIncarnationId: string;
	localBaseRef: string;
	localBaseRefTipCommitAtObservation: string;
	localBaseRefCommits: readonly TaskCommitIdentity[];
	lastKnownTaskHeadCommit: string;
	lastTaskWorktreeGitSnapshotObservedAt: number;
	lastKnownTaskHeadObservationSource: LastKnownTaskHeadObservationSourceForSharedLandingCriterion;
	taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: readonly ObservedTaskCommit[];
}): void {
	const evaluation = evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits({
		taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead:
			input.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
		localBaseRefCommits: input.localBaseRefCommits,
	});
	if (
		evaluation.sharedTaskCommitLandingCriterionOutcome !==
		"all_task_owned_non_merge_commits_integrated_into_local_base"
	) {
		return;
	}
	reportSharedTaskCommitLandingCriterionSatisfiedObservation({
		workspaceId: input.workspaceId,
		taskId: input.taskId,
		taskCommitProvenanceIncarnationId: input.taskCommitProvenanceIncarnationId,
		localBaseRef: input.localBaseRef,
		localBaseRefTipCommitAtObservation: input.localBaseRefTipCommitAtObservation,
		lastKnownTaskHeadCommit: input.lastKnownTaskHeadCommit,
		lastTaskWorktreeGitSnapshotObservedAt: input.lastTaskWorktreeGitSnapshotObservedAt,
		lastKnownTaskHeadObservationSource: input.lastKnownTaskHeadObservationSource,
		taskOwnedNonMergeCommitsIntegratedIntoLocalBase: evaluation.taskCommitsIntegratedIntoBaseRef,
	});
}

const baseRefCommitIdentityCache = new Map<string, Promise<TaskCommitIdentity[] | null>>();

async function loadBaseRefCommitIdentities(input: {
	repoPath: string;
	baseRef: string;
	baseRefTipCommit: string;
	provenanceFloorCommit: string;
}): Promise<TaskCommitIdentity[] | null> {
	const cacheKey = [input.repoPath, input.baseRef, input.baseRefTipCommit, input.provenanceFloorCommit].join("\0");
	const cached = baseRefCommitIdentityCache.get(cacheKey);
	if (cached) {
		return await cached;
	}
	const pending = (async () => {
		const floorIsBaseTipAncestor = await runGit(input.repoPath, [
			"merge-base",
			"--is-ancestor",
			input.provenanceFloorCommit,
			input.baseRefTipCommit,
		]);
		if (!floorIsBaseTipAncestor.ok) {
			return null;
		}
		const commitShas = await listCommitShas(
			input.repoPath,
			`${input.provenanceFloorCommit}..${input.baseRefTipCommit}`,
		);
		return commitShas === null ? null : await resolveCommitIdentities(input.repoPath, commitShas);
	})();
	baseRefCommitIdentityCache.set(cacheKey, pending);
	while (baseRefCommitIdentityCache.size > BASE_REF_COMMIT_IDENTITY_RANGE_CACHE_MAX_ENTRIES) {
		const oldestCacheKey = baseRefCommitIdentityCache.keys().next().value;
		if (typeof oldestCacheKey !== "string") {
			break;
		}
		baseRefCommitIdentityCache.delete(oldestCacheKey);
	}
	return await pending;
}

function createUnavailableWorkspaceGitStatus(
	baseRef: string,
	trackingStatus: RuntimeTaskCommitIntegrationTrackingStatus,
	knownDivergence?: {
		commitsAheadOfBaseRef: number;
		commitsBehindBaseRef: number;
	},
): RuntimeTaskWorkspaceGitStatus {
	return {
		baseRef,
		commitsAheadOfBaseRef: knownDivergence?.commitsAheadOfBaseRef ?? null,
		commitsBehindBaseRef: knownDivergence?.commitsBehindBaseRef ?? null,
		taskCommitsIntegratedIntoBaseRef: null,
		taskCommitIntegrationTrackingStatus: trackingStatus,
		observationSource: knownDivergence ? "live_worktree" : "unavailable",
		observedAt: knownDivergence ? Date.now() : null,
	};
}

function snapshotFactsEqual(
	left: PersistedTaskWorkspaceGitSnapshot | null,
	right: Omit<PersistedTaskWorkspaceGitSnapshot, "observedAt">,
): boolean {
	return (
		left !== null &&
		left.path === right.path &&
		left.headCommit === right.headCommit &&
		left.baseRefTipCommit === right.baseRefTipCommit &&
		left.commitsAheadOfBaseRef === right.commitsAheadOfBaseRef &&
		left.commitsBehindBaseRef === right.commitsBehindBaseRef &&
		left.taskCommitsIntegratedIntoBaseRef === right.taskCommitsIntegratedIntoBaseRef &&
		left.isDetached === right.isDetached &&
		describeObservedTaskCommitsForEquality(left.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead) ===
			describeObservedTaskCommitsForEquality(right.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead)
	);
}

function describeObservedTaskCommitsForEquality(commits: readonly ObservedTaskCommit[] | undefined): string {
	return (commits ?? []).map((commit) => `${commit.commitSha}:${commit.stablePatchId ?? ""}`).join(",");
}

export interface RefreshTaskCommitIntegrationProvenanceInput {
	workspaceId: string;
	taskId: string;
	repoPath: string;
	worktreePath: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
	worktreeExists: boolean;
	headCommit: string | null;
	baseRefTipCommit: string | null;
	commitsAheadOfBaseRef: number | null;
	commitsBehindBaseRef: number | null;
	isDetached: boolean;
	observedAt?: number;
	// 探针复用本次已读/已写的统计，避免为卡片摘要再读一遍整个 provenance 文件。
	onTaskRetainedCommittedLineChangeSummary?: (summary: RuntimeTaskRetainedCommittedLineChangeSummary) => void;
}

/**
 * 合并 live Git 事实、持久 task commit provenance 与最后快照，返回 UI/CLI 共用的状态投影。
 * 新 task 从 worktree 创建锚点获得完整覆盖；legacy task 只有仍在 handback 前且 ahead>0 时才允许证据回填。
 */
export async function refreshTaskCommitIntegrationProvenance(
	input: RefreshTaskCommitIntegrationProvenanceInput,
): Promise<RuntimeTaskWorkspaceGitStatus> {
	const liveObservationTimestamp = input.observedAt ?? Date.now();
	if (input.worktreeMode === "inplace") {
		return {
			baseRef: input.baseRef,
			commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
			commitsBehindBaseRef: input.commitsBehindBaseRef,
			taskCommitsIntegratedIntoBaseRef: null,
			taskCommitIntegrationTrackingStatus: "inplace_task_commit_ownership_unavailable",
			observationSource:
				input.commitsAheadOfBaseRef === null || input.commitsBehindBaseRef === null
					? "unavailable"
					: "live_worktree",
			observedAt:
				input.commitsAheadOfBaseRef === null || input.commitsBehindBaseRef === null
					? null
					: liveObservationTimestamp,
		};
	}

	const file = await readProvenanceFile(input.workspaceId);
	let entry: TaskCommitIntegrationProvenanceEntry | null = file.tasks[input.taskId] ?? null;
	if (entry !== null && entry.baseRef !== input.baseRef) {
		await removeTaskCommitIntegrationProvenance(input.workspaceId, input.taskId);
		entry = null;
	}
	if (!input.worktreeExists) {
		if (entry?.lastWorkspaceGitSnapshot === null || entry === null) {
			return createUnavailableWorkspaceGitStatus(input.baseRef, "legacy_history_unavailable");
		}
		let snapshot = entry.lastWorkspaceGitSnapshot;
		let retainedCommittedLineChangeHistory = entry.retainedCommittedLineChangeHistory;
		const firstIncarnation = entry.incarnations[0];
		const provenanceFloorCommit =
			firstIncarnation?.baseRefCommitHistoryProbeFloorCommit ?? firstIncarnation?.initialBaseCommit;
		if (input.baseRefTipCommit !== null && provenanceFloorCommit) {
			const baseRefCommits = await loadBaseRefCommitIdentities({
				repoPath: input.repoPath,
				baseRef: input.baseRef,
				baseRefTipCommit: input.baseRefTipCommit,
				provenanceFloorCommit,
			});
			if (baseRefCommits !== null) {
				const taskOwnedCommitsObservedAcrossIncarnations = deduplicateObservedTaskCommits(entry.incarnations);
				const integration = countTaskCommitsIntegratedIntoBaseRef({
					observedTaskCommits: taskOwnedCommitsObservedAcrossIncarnations,
					baseRefCommits,
				});
				const latestIncarnation = entry.incarnations.at(-1);
				const lastTaskWorktreeGitSnapshotObservedAtBeforeThisRefresh = snapshot.observedAt;
				let taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead =
					snapshot.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead;
				// 1c 之前的探测按 `baseRef..HEAD` 取值，merge 落地后被清成空；最新一世有自有提交却记成空的，用仓库里的对象重算一次
				// （只看最新一世：旧世提交经 base 被吸收进本世时不属于本世，不得因此触发重算）。
				if (
					taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead?.length === 0 &&
					latestIncarnation &&
					latestIncarnation.observedTaskCommits.length > 0
				) {
					taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead =
						(await resolveTaskOwnedNonMergeCommitsReachableFromTaskHead({
							gitCwd: input.repoPath,
							taskHeadCommit: snapshot.headCommit,
							latestTaskCommitProvenanceIncarnationInitialBaseCommit: latestIncarnation.initialBaseCommit,
							taskOwnedCommitsObservedInLatestIncarnation: latestIncarnation.observedTaskCommits,
							commitsAlreadyKnownReachableFromTaskHeadWithMergeCommitFlag: [],
						})) ?? taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead;
				}
				const retainedLineStatistics =
					taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead === undefined
						? {
								history: createUnavailableTaskRetainedCommittedLineChangeHistory(
									"task_commit_ownership_history_incomplete",
								),
								cachedStatisticsByCommitSha: entry.committedLineChangeStatisticsByCommitSha ?? {},
							}
						: await refreshTaskRetainedCommittedLineChangeStatistics({
								repoPath: input.repoPath,
								retainedCommitShas: resolveRetainedTaskCommitShasForCommittedLineChangeStatistics({
									observedTaskCommits: taskOwnedCommitsObservedAcrossIncarnations,
									taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
									baseRefCommits,
								}),
								cachedStatisticsByCommitSha: entry.committedLineChangeStatisticsByCommitSha ?? {},
							});
				retainedCommittedLineChangeHistory = retainedLineStatistics.history;
				const nextSnapshotFacts: Omit<PersistedTaskWorkspaceGitSnapshot, "observedAt"> = {
					...snapshot,
					baseRefTipCommit: input.baseRefTipCommit,
					taskCommitsIntegratedIntoBaseRef: Math.max(
						snapshot.taskCommitsIntegratedIntoBaseRef,
						integration.integratedTaskCommitCount,
					),
					taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
				};
				const observedAt = snapshotFactsEqual(snapshot, nextSnapshotFacts)
					? snapshot.observedAt
					: (input.observedAt ?? Date.now());
				snapshot = { ...nextSnapshotFacts, observedAt };
				await mutateProvenanceFile(input.workspaceId, (nextFile) => {
					const nextEntry = nextFile.tasks[input.taskId];
					if (nextEntry) {
						nextEntry.retainedCommittedLineChangeHistory = resolvePersistedRetainedCommittedLineChangeHistory(
							nextEntry.retainedCommittedLineChangeHistory,
							retainedLineStatistics.history,
						);
						nextEntry.committedLineChangeStatisticsByCommitSha =
							retainedLineStatistics.cachedStatisticsByCommitSha;
						nextEntry.baseRef = input.baseRef;
						nextEntry.lastWorkspaceGitSnapshot = {
							...snapshot,
							taskCommitsIntegratedIntoBaseRef: Math.max(
								snapshot.taskCommitsIntegratedIntoBaseRef,
								nextEntry.lastWorkspaceGitSnapshot?.taskCommitsIntegratedIntoBaseRef ?? 0,
							),
						};
					}
				});
				// 没有该字段的快照来自 1a 之前的探测，S 无从得知：不求值（激活补发扫描也不覆盖它们，留给 2b 回填）。
				if (taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead !== undefined && latestIncarnation) {
					reportSharedTaskCommitLandingCriterionSatisfiedObservationWhenSatisfied({
						workspaceId: input.workspaceId,
						taskId: input.taskId,
						taskCommitProvenanceIncarnationId: latestIncarnation.incarnationId,
						localBaseRef: input.baseRef,
						localBaseRefTipCommitAtObservation: input.baseRefTipCommit,
						localBaseRefCommits: baseRefCommits,
						lastKnownTaskHeadCommit: snapshot.headCommit,
						lastTaskWorktreeGitSnapshotObservedAt: lastTaskWorktreeGitSnapshotObservedAtBeforeThisRefresh,
						lastKnownTaskHeadObservationSource: "persisted_last_task_worktree_snapshot_after_worktree_removal",
						taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
					});
				}
			}
		}
		input.onTaskRetainedCommittedLineChangeSummary?.(
			(
				retainedCommittedLineChangeHistory ??
				createUnavailableTaskRetainedCommittedLineChangeHistory("task_commit_history_unavailable")
			).summary,
		);
		return {
			baseRef: input.baseRef,
			commitsAheadOfBaseRef: snapshot.commitsAheadOfBaseRef,
			commitsBehindBaseRef: snapshot.commitsBehindBaseRef,
			taskCommitsIntegratedIntoBaseRef: snapshot.taskCommitsIntegratedIntoBaseRef,
			taskCommitIntegrationTrackingStatus: "complete",
			observationSource: "persisted_final_snapshot",
			observedAt: snapshot.observedAt,
		};
	}

	if (
		input.headCommit === null ||
		input.baseRefTipCommit === null ||
		input.commitsAheadOfBaseRef === null ||
		input.commitsBehindBaseRef === null
	) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable");
	}

	if (entry === null) {
		if (input.commitsAheadOfBaseRef === 0) {
			return createUnavailableWorkspaceGitStatus(input.baseRef, "legacy_history_unavailable", {
				commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
				commitsBehindBaseRef: input.commitsBehindBaseRef,
			});
		}
		const mergeBaseResult = await runGit(input.worktreePath, ["merge-base", "HEAD", input.baseRef]);
		if (!mergeBaseResult.ok || !mergeBaseResult.stdout) {
			return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable");
		}
		const observedCommitShas = await listCommitShas(input.worktreePath, `${input.baseRef}..HEAD`);
		if (observedCommitShas === null) {
			return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable");
		}
		const observedTaskCommits = await resolveCommitIdentities(input.worktreePath, observedCommitShas);
		const observedAt = input.observedAt ?? Date.now();
		entry = {
			taskId: input.taskId,
			baseRef: input.baseRef,
			incarnations: [
				{
					incarnationId: `${mergeBaseResult.stdout}:${observedAt}`,
					initialBaseCommit: mergeBaseResult.stdout,
					captureSource: "live_pre_handback_backfill",
					startedAt: observedAt,
					observedTaskCommits,
				},
			],
			lastWorkspaceGitSnapshot: null,
		};
		await mutateProvenanceFile(input.workspaceId, (nextFile) => {
			nextFile.tasks[input.taskId] = entry as TaskCommitIntegrationProvenanceEntry;
		});
	}

	const activeIncarnation = entry.incarnations.at(-1);
	if (!activeIncarnation) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "task_commit_ownership_history_incomplete");
	}

	const observedTaskCommitsBySha = new Map(
		deduplicateObservedTaskCommits(entry.incarnations).map((commit) => [commit.commitSha, commit]),
	);
	const candidateCommitsWithMergeFlag = await listCommitShasWithMergeCommitFlag(
		input.worktreePath,
		`${input.baseRef}..HEAD`,
		activeIncarnation.initialBaseCommit,
	);
	if (candidateCommitsWithMergeFlag === null) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable");
	}
	const candidateCommitShas = candidateCommitsWithMergeFlag.map((commit) => commit.commitSha);
	// 从未观察到 task commit 时，baseRef..HEAD 为空无法区分「task commits 已 handback」与
	// 「worktree 只是 fast-forward 吸收了 base」。creation floor 只能证明提交在何时出现，不能证明所有权；
	// 唯有「单一创建 incarnation + HEAD reflog 自创建起只有 fast-forward」能证明是后者，回流计数如实为 0。
	if (
		candidateCommitShas.length === 0 &&
		observedTaskCommitsBySha.size === 0 &&
		input.headCommit !== activeIncarnation.initialBaseCommit
	) {
		const worktreeHeadMovedOnlyByFastForwardSinceCreation =
			entry.incarnations.length === 1 &&
			activeIncarnation.captureSource === "worktree_creation" &&
			(await proveTaskWorktreeHeadMovedOnlyByFastForwardSinceCreation({
				worktreePath: input.worktreePath,
				initialBaseCommit: activeIncarnation.initialBaseCommit,
				headCommit: input.headCommit,
			}));
		if (!worktreeHeadMovedOnlyByFastForwardSinceCreation) {
			return createUnavailableWorkspaceGitStatus(input.baseRef, "task_commit_ownership_history_incomplete", {
				commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
				commitsBehindBaseRef: input.commitsBehindBaseRef,
			});
		}
	}
	const newCommitShas = candidateCommitShas.filter((commitSha) => !observedTaskCommitsBySha.has(commitSha));
	const newCommitIdentities = await resolveCommitIdentities(input.worktreePath, newCommitShas);
	for (const commit of newCommitIdentities) {
		observedTaskCommitsBySha.set(commit.commitSha, commit);
	}
	// 本次探测排除创建锚点可达历史后，`baseRef..HEAD` 的全部候选都归当前活动世（含旧世已观测过、又出现在本世的，例如复用了旧分支），身份复用
	// 已有观测、不重算 patch-id。从 base 吸收进来的提交从不出现在 `baseRef..HEAD`，因此不会被记成任何一世的自有提交。
	const candidateCommitIdentities = candidateCommitShas.flatMap((commitSha) => {
		const identity = observedTaskCommitsBySha.get(commitSha);
		return identity ? [identity] : [];
	});
	const taskOwnedCommitsObservedInActiveIncarnationBySha = new Map(
		[...activeIncarnation.observedTaskCommits, ...candidateCommitIdentities].map((commit) => [
			commit.commitSha,
			commit,
		]),
	);

	const firstIncarnation = entry.incarnations[0];
	const provenanceFloorCommit =
		firstIncarnation?.baseRefCommitHistoryProbeFloorCommit ?? firstIncarnation?.initialBaseCommit;
	if (!provenanceFloorCommit) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "task_commit_ownership_history_incomplete");
	}
	const baseRefCommits = await loadBaseRefCommitIdentities({
		repoPath: input.repoPath,
		baseRef: input.baseRef,
		baseRefTipCommit: input.baseRefTipCommit,
		provenanceFloorCommit,
	});
	if (baseRefCommits === null) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable", {
			commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
			commitsBehindBaseRef: input.commitsBehindBaseRef,
		});
	}
	const integration = countTaskCommitsIntegratedIntoBaseRef({
		observedTaskCommits: [...observedTaskCommitsBySha.values()],
		baseRefCommits,
	});
	const candidateTaskCommitsIntegratedIntoBaseRef = Math.max(
		entry.lastWorkspaceGitSnapshot?.taskCommitsIntegratedIntoBaseRef ?? 0,
		integration.integratedTaskCommitCount,
	);
	const taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead =
		await resolveTaskOwnedNonMergeCommitsReachableFromTaskHead({
			gitCwd: input.worktreePath,
			taskHeadCommit: input.headCommit,
			latestTaskCommitProvenanceIncarnationInitialBaseCommit: activeIncarnation.initialBaseCommit,
			taskOwnedCommitsObservedInLatestIncarnation: [...taskOwnedCommitsObservedInActiveIncarnationBySha.values()],
			commitsAlreadyKnownReachableFromTaskHeadWithMergeCommitFlag: candidateCommitsWithMergeFlag,
		});
	if (taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead === null) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable", {
			commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
			commitsBehindBaseRef: input.commitsBehindBaseRef,
		});
	}
	// 此投影只选择仍可达或已落地的自有提交，不删除 provenance 的历史观测，避免改变部署/关系账本的判据。
	const retainedLineStatistics = await refreshTaskRetainedCommittedLineChangeStatistics({
		repoPath: input.repoPath,
		retainedCommitShas: resolveRetainedTaskCommitShasForCommittedLineChangeStatistics({
			observedTaskCommits: [...observedTaskCommitsBySha.values()],
			taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
			baseRefCommits,
		}),
		cachedStatisticsByCommitSha: entry.committedLineChangeStatisticsByCommitSha ?? {},
	});
	const candidateSnapshotFacts: Omit<PersistedTaskWorkspaceGitSnapshot, "observedAt"> = {
		taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
		path: input.worktreePath,
		headCommit: input.headCommit,
		baseRefTipCommit: input.baseRefTipCommit,
		commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
		commitsBehindBaseRef: input.commitsBehindBaseRef,
		taskCommitsIntegratedIntoBaseRef: candidateTaskCommitsIntegratedIntoBaseRef,
		isDetached: input.isDetached,
	};
	const candidateObservedAt = snapshotFactsEqual(entry.lastWorkspaceGitSnapshot, candidateSnapshotFacts)
		? (entry.lastWorkspaceGitSnapshot?.observedAt ?? liveObservationTimestamp)
		: liveObservationTimestamp;

	const persistedSnapshot = await mutateProvenanceFile(input.workspaceId, (nextFile) => {
		const nextEntry = nextFile.tasks[input.taskId] ?? entry;
		const nextActiveIncarnation = nextEntry.incarnations.at(-1);
		if (nextActiveIncarnation) {
			const freshObservedTaskCommitsBySha = new Map(
				nextActiveIncarnation.observedTaskCommits.map((commit) => [commit.commitSha, commit]),
			);
			for (const commit of candidateCommitIdentities) {
				freshObservedTaskCommitsBySha.set(commit.commitSha, commit);
			}
			nextActiveIncarnation.observedTaskCommits = [...freshObservedTaskCommitsBySha.values()];
		}
		nextEntry.baseRef = input.baseRef;
		const existingSnapshot = nextEntry.lastWorkspaceGitSnapshot;
		const candidateIsOlderThanPersistedSnapshot =
			existingSnapshot !== null && candidateObservedAt < existingSnapshot.observedAt;
		if (!candidateIsOlderThanPersistedSnapshot) {
			nextEntry.retainedCommittedLineChangeHistory = resolvePersistedRetainedCommittedLineChangeHistory(
				nextEntry.retainedCommittedLineChangeHistory,
				retainedLineStatistics.history,
			);
		}
		nextEntry.committedLineChangeStatisticsByCommitSha = {
			...nextEntry.committedLineChangeStatisticsByCommitSha,
			...retainedLineStatistics.cachedStatisticsByCommitSha,
		};
		const chronologicallyPreferredSnapshotFacts = candidateIsOlderThanPersistedSnapshot
			? existingSnapshot
			: candidateSnapshotFacts;
		const mergedSnapshotFacts: Omit<PersistedTaskWorkspaceGitSnapshot, "observedAt"> = {
			...chronologicallyPreferredSnapshotFacts,
			taskCommitsIntegratedIntoBaseRef: Math.max(
				candidateTaskCommitsIntegratedIntoBaseRef,
				existingSnapshot?.taskCommitsIntegratedIntoBaseRef ?? 0,
			),
		};
		const mergedObservedAt = snapshotFactsEqual(existingSnapshot, mergedSnapshotFacts)
			? (existingSnapshot?.observedAt ?? candidateObservedAt)
			: Math.max(candidateObservedAt, existingSnapshot?.observedAt ?? candidateObservedAt);
		nextEntry.lastWorkspaceGitSnapshot = { ...mergedSnapshotFacts, observedAt: mergedObservedAt };
		nextFile.tasks[input.taskId] = nextEntry;
		input.onTaskRetainedCommittedLineChangeSummary?.(
			(candidateIsOlderThanPersistedSnapshot
				? (nextEntry.retainedCommittedLineChangeHistory ?? retainedLineStatistics.history)
				: retainedLineStatistics.history
			).summary,
		);
		return nextEntry.lastWorkspaceGitSnapshot;
	});
	// 按本次探测读到的事实求值（不按合并后的持久快照）：观测就是「此刻在 worktree 上看到的」，与快照的时序取舍无关。
	reportSharedTaskCommitLandingCriterionSatisfiedObservationWhenSatisfied({
		workspaceId: input.workspaceId,
		taskId: input.taskId,
		taskCommitProvenanceIncarnationId: activeIncarnation.incarnationId,
		localBaseRef: input.baseRef,
		localBaseRefTipCommitAtObservation: input.baseRefTipCommit,
		localBaseRefCommits: baseRefCommits,
		lastKnownTaskHeadCommit: input.headCommit,
		lastTaskWorktreeGitSnapshotObservedAt: liveObservationTimestamp,
		lastKnownTaskHeadObservationSource: "live_task_worktree_probe",
		taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead,
	});

	return {
		baseRef: input.baseRef,
		commitsAheadOfBaseRef: persistedSnapshot.commitsAheadOfBaseRef,
		commitsBehindBaseRef: persistedSnapshot.commitsBehindBaseRef,
		taskCommitsIntegratedIntoBaseRef: persistedSnapshot.taskCommitsIntegratedIntoBaseRef,
		taskCommitIntegrationTrackingStatus: "complete",
		observationSource: "live_worktree",
		observedAt: persistedSnapshot.observedAt,
	};
}

export async function probeAndRefreshTaskCommitIntegrationProvenance(input: {
	workspaceId: string;
	taskId: string;
	repoPath: string;
	worktreePath: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
	worktreeExists: boolean;
	knownBaseRefTipCommit?: string | null;
	observedAt?: number;
}): Promise<RuntimeTaskWorkspaceGitStatus> {
	if (!input.worktreeExists) {
		const baseRefTipCommit =
			input.knownBaseRefTipCommit !== undefined
				? input.knownBaseRefTipCommit
				: await resolveBaseRefTipCommit(input.repoPath, input.baseRef);
		return await refreshTaskCommitIntegrationProvenance({
			...input,
			headCommit: null,
			baseRefTipCommit,
			commitsAheadOfBaseRef: null,
			commitsBehindBaseRef: null,
			isDetached: false,
		});
	}

	const [headInfo, baseRefTipCommit, divergenceResult] = await Promise.all([
		readGitHeadInfo(input.worktreePath),
		input.knownBaseRefTipCommit !== undefined
			? Promise.resolve(input.knownBaseRefTipCommit)
			: resolveBaseRefTipCommit(input.repoPath, input.baseRef),
		runGit(input.worktreePath, ["rev-list", "--left-right", "--count", `${input.baseRef}...HEAD`]),
	]);
	const [behindText, aheadText] = divergenceResult.stdout.split(/\s+/);
	const commitsBehindBaseRef = Number.parseInt(behindText ?? "", 10);
	const commitsAheadOfBaseRef = Number.parseInt(aheadText ?? "", 10);
	return await refreshTaskCommitIntegrationProvenance({
		...input,
		headCommit: headInfo.headCommit,
		baseRefTipCommit,
		commitsAheadOfBaseRef:
			divergenceResult.ok && Number.isFinite(commitsAheadOfBaseRef) ? commitsAheadOfBaseRef : null,
		commitsBehindBaseRef: divergenceResult.ok && Number.isFinite(commitsBehindBaseRef) ? commitsBehindBaseRef : null,
		isDetached: headInfo.isDetached,
	});
}

async function resolveBaseRefTipCommit(repoPath: string, baseRef: string): Promise<string | null> {
	const result = await runGit(repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
	return result.ok && result.stdout ? result.stdout : null;
}

// 原始落地快照（Y-EVENT-14 PDV 事件、1c 落地判据的输入）：只搬运已持久化的事实，不在这里判定是否已落地。
export async function readRawTaskCommitLandingSnapshotForRelationLedgerEvent(
	workspaceId: string,
	taskId: string,
): Promise<{
	lastKnownTaskHeadCommit: string | null;
	taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: ObservedTaskCommit[] | null;
	lastKnownTaskHeadObservedAt: number | null;
	taskCommitIntegrationProvenanceBaseRef: string | null;
}> {
	const entry = (await readProvenanceFile(workspaceId)).tasks[taskId] ?? null;
	const snapshot = entry?.lastWorkspaceGitSnapshot ?? null;
	return {
		lastKnownTaskHeadCommit: snapshot?.headCommit ?? null,
		taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead:
			snapshot?.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead ?? null,
		lastKnownTaskHeadObservedAt: snapshot?.observedAt ?? null,
		taskCommitIntegrationProvenanceBaseRef: entry?.baseRef ?? null,
	};
}

/** 分出任务的手动启动复用共享落地判据，不读取 ahead 作为结案证明。 */
export async function readSourceTaskCommitLandingReadiness(input: {
	workspaceId: string;
	taskId: string;
	repoPath: string;
	localBaseRef: string;
}): Promise<boolean> {
	const entry = (await readProvenanceFile(input.workspaceId)).tasks[input.taskId];
	const incarnation = entry?.incarnations.at(-1);
	const owned = entry?.lastWorkspaceGitSnapshot?.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead;
	if (!incarnation || !owned || entry.baseRef !== input.localBaseRef) return false;
	const base = await resolveBaseRefTipCommit(input.repoPath, input.localBaseRef);
	if (!base) return false;
	const commits = await loadBaseRefCommitIdentities({
		repoPath: input.repoPath,
		baseRef: input.localBaseRef,
		baseRefTipCommit: base,
		provenanceFloorCommit: incarnation.baseRefCommitHistoryProbeFloorCommit ?? incarnation.initialBaseCommit,
	});
	if (!commits) return false;
	return (
		evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits({
			taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: owned,
			localBaseRefCommits: commits,
		}).sharedTaskCommitLandingCriterionOutcome === "all_task_owned_non_merge_commits_integrated_into_local_base"
	);
}

// 部署归属（src/deployment/task-deployment-attribution-from-commit-integration-provenance.ts）的输入：每个 task 跨全部
// 世累积观测到的自有提交（sha + stable patch-id，按 sha 去重）。只读已持久化的事实、不起 git；没有条目的 task 不在 Map 里。
// 用跨世累积而不是最新一世的 S：部署回答「这个 task 的哪些改动随部署上线了」，旧世已落地的提交同样算数。
export async function readObservedTaskCommitsAcrossIncarnationsByTaskId(
	workspaceId: string,
): Promise<Map<string, ObservedTaskCommit[]>> {
	const file = await readProvenanceFile(workspaceId);
	return new Map(
		Object.values(file.tasks).map((entry) => [entry.taskId, deduplicateObservedTaskCommits(entry.incarnations)]),
	);
}

/** 明细只读持久缓存，不在 hover 请求里扫描 Git 历史或重算 diff。 */
export async function readTaskRetainedCommittedLineChangeHistory(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeTaskRetainedCommittedLineChangeHistory> {
	const file = await readProvenanceFile(workspaceId);
	return (
		file.tasks[taskId]?.retainedCommittedLineChangeHistory ??
		createUnavailableTaskRetainedCommittedLineChangeHistory("task_commit_history_unavailable")
	);
}

// 激活补发扫描的范围（§R3 Y-PHASE-3「对 1a–1c 期间的快照补发」）：快照带自有提交集合字段的条目，即 1a 起被探测过的 task，
// 含已删卡（provenance 不再随删卡、删 worktree 删除）。更早的条目没有 S，交给 2b 回填。
export async function listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(
	workspaceId: string,
): Promise<Array<{ taskId: string; baseRef: string }>> {
	const file = await readProvenanceFile(workspaceId);
	return Object.values(file.tasks)
		.filter(
			(entry) =>
				entry.lastWorkspaceGitSnapshot?.taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead !== undefined,
		)
		.map((entry) => ({ taskId: entry.taskId, baseRef: entry.baseRef }));
}

export async function removeTaskCommitIntegrationProvenance(workspaceId: string, taskId: string): Promise<boolean> {
	return await mutateProvenanceFile(workspaceId, (file) => {
		if (!(taskId in file.tasks)) {
			return false;
		}
		delete file.tasks[taskId];
		return true;
	});
}
