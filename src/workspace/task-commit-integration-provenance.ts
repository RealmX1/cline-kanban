import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pLimit from "p-limit";
import { z } from "zod";

import type {
	RuntimeTaskCommitIntegrationTrackingStatus,
	RuntimeTaskWorkspaceGitStatus,
	RuntimeTaskWorktreeMode,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "../state/workspace-state";
import { computeStablePatchId, readGitHeadInfo, runGit } from "./git-utils";

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
	observedAt: z.number(),
});
type PersistedTaskWorkspaceGitSnapshot = z.infer<typeof persistedTaskWorkspaceGitSnapshotSchema>;

const taskCommitIntegrationProvenanceEntrySchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	incarnations: z.array(taskCommitProvenanceIncarnationSchema),
	lastWorkspaceGitSnapshot: persistedTaskWorkspaceGitSnapshotSchema.nullable(),
});
type TaskCommitIntegrationProvenanceEntry = z.infer<typeof taskCommitIntegrationProvenanceEntrySchema>;

const taskCommitIntegrationProvenanceFileSchema = z.object({
	schemaVersion: z.literal(TASK_COMMIT_INTEGRATION_PROVENANCE_SCHEMA_VERSION),
	tasks: z.record(z.string(), taskCommitIntegrationProvenanceEntrySchema),
});
type TaskCommitIntegrationProvenanceFile = z.infer<typeof taskCommitIntegrationProvenanceFileSchema>;

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
 * 对两个已解析的 commit identity 集合做一对一关联。先消费 exact SHA，再消费 stable patch-id；
 * base 侧每个 commit 最多消费一次，防止重复 patch 被虚高计数。merge / 空提交没有 patch-id，天然只走 exact。
 */
export function countTaskCommitsIntegratedIntoBaseRef(input: {
	observedTaskCommits: readonly TaskCommitIdentity[];
	baseRefCommits: readonly TaskCommitIdentity[];
}): CountTaskCommitsIntegratedIntoBaseRefResult {
	const unconsumedBaseCommitIndexes = new Set(input.baseRefCommits.map((_commit, index) => index));
	const exactHashMatchedTaskCommitShas: string[] = [];
	const patchIdMatchedTaskCommitShas: string[] = [];
	const unmatchedTaskCommits: TaskCommitIdentity[] = [];

	for (const taskCommit of input.observedTaskCommits) {
		const exactBaseCommitIndex = input.baseRefCommits.findIndex(
			(baseCommit, index) => unconsumedBaseCommitIndexes.has(index) && baseCommit.commitSha === taskCommit.commitSha,
		);
		if (exactBaseCommitIndex >= 0) {
			unconsumedBaseCommitIndexes.delete(exactBaseCommitIndex);
			exactHashMatchedTaskCommitShas.push(taskCommit.commitSha);
		} else {
			unmatchedTaskCommits.push(taskCommit);
		}
	}

	for (const taskCommit of unmatchedTaskCommits) {
		if (taskCommit.stablePatchId === null) {
			continue;
		}
		const patchEquivalentBaseCommitIndex = input.baseRefCommits.findIndex(
			(baseCommit, index) =>
				unconsumedBaseCommitIndexes.has(index) && baseCommit.stablePatchId === taskCommit.stablePatchId,
		);
		if (patchEquivalentBaseCommitIndex >= 0) {
			unconsumedBaseCommitIndexes.delete(patchEquivalentBaseCommitIndex);
			patchIdMatchedTaskCommitShas.push(taskCommit.commitSha);
		}
	}

	return {
		integratedTaskCommitCount: exactHashMatchedTaskCommitShas.length + patchIdMatchedTaskCommitShas.length,
		exactHashMatchedTaskCommitShas,
		patchIdMatchedTaskCommitShas,
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
	recordedAt?: number;
}): Promise<void> {
	const recordedAt = input.recordedAt ?? Date.now();
	await mutateProvenanceFile(input.workspaceId, (file) => {
		const existing = file.tasks[input.taskId];
		const previousIncarnation = existing?.incarnations.at(-1);
		if (
			previousIncarnation?.initialBaseCommit === input.initialBaseCommit &&
			previousIncarnation.observedTaskCommits.length === 0 &&
			existing?.baseRef === input.baseRef
		) {
			return;
		}
		const incarnation: TaskCommitProvenanceIncarnation = {
			incarnationId: `${input.initialBaseCommit}:${recordedAt}`,
			initialBaseCommit: input.initialBaseCommit,
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
		left.isDetached === right.isDetached
	);
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
		const provenanceFloorCommit = entry.incarnations[0]?.initialBaseCommit;
		if (input.baseRefTipCommit !== null && provenanceFloorCommit) {
			const baseRefCommits = await loadBaseRefCommitIdentities({
				repoPath: input.repoPath,
				baseRef: input.baseRef,
				baseRefTipCommit: input.baseRefTipCommit,
				provenanceFloorCommit,
			});
			if (baseRefCommits !== null) {
				const integration = countTaskCommitsIntegratedIntoBaseRef({
					observedTaskCommits: deduplicateObservedTaskCommits(entry.incarnations),
					baseRefCommits,
				});
				const nextSnapshotFacts: Omit<PersistedTaskWorkspaceGitSnapshot, "observedAt"> = {
					...snapshot,
					baseRefTipCommit: input.baseRefTipCommit,
					taskCommitsIntegratedIntoBaseRef: Math.max(
						snapshot.taskCommitsIntegratedIntoBaseRef,
						integration.integratedTaskCommitCount,
					),
				};
				const observedAt = snapshotFactsEqual(snapshot, nextSnapshotFacts)
					? snapshot.observedAt
					: (input.observedAt ?? Date.now());
				snapshot = { ...nextSnapshotFacts, observedAt };
				await mutateProvenanceFile(input.workspaceId, (nextFile) => {
					const nextEntry = nextFile.tasks[input.taskId];
					if (nextEntry) {
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
			}
		}
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
		return createUnavailableWorkspaceGitStatus(input.baseRef, "legacy_history_unavailable");
	}

	const observedTaskCommitsBySha = new Map(
		deduplicateObservedTaskCommits(entry.incarnations).map((commit) => [commit.commitSha, commit]),
	);
	const candidateCommitShas = await listCommitShas(input.worktreePath, `${input.baseRef}..HEAD`);
	if (candidateCommitShas === null) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "git_probe_unavailable");
	}
	// 从未观察到 task commit 时，baseRef..HEAD 为空无法区分「task commits 已 handback」与
	// 「worktree 只是 fast-forward 吸收了 base」。creation floor 只能证明提交在何时出现，不能证明所有权。
	if (
		candidateCommitShas.length === 0 &&
		observedTaskCommitsBySha.size === 0 &&
		input.headCommit !== activeIncarnation.initialBaseCommit
	) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "legacy_history_unavailable", {
			commitsAheadOfBaseRef: input.commitsAheadOfBaseRef,
			commitsBehindBaseRef: input.commitsBehindBaseRef,
		});
	}
	const newCommitShas = candidateCommitShas.filter((commitSha) => !observedTaskCommitsBySha.has(commitSha));
	const newCommitIdentities = await resolveCommitIdentities(input.worktreePath, newCommitShas);
	for (const commit of newCommitIdentities) {
		observedTaskCommitsBySha.set(commit.commitSha, commit);
	}

	const provenanceFloorCommit = entry.incarnations[0]?.initialBaseCommit;
	if (!provenanceFloorCommit) {
		return createUnavailableWorkspaceGitStatus(input.baseRef, "legacy_history_unavailable");
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
	const candidateSnapshotFacts: Omit<PersistedTaskWorkspaceGitSnapshot, "observedAt"> = {
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
			for (const commit of newCommitIdentities) {
				freshObservedTaskCommitsBySha.set(commit.commitSha, commit);
			}
			nextActiveIncarnation.observedTaskCommits = [...freshObservedTaskCommitsBySha.values()];
		}
		nextEntry.baseRef = input.baseRef;
		const existingSnapshot = nextEntry.lastWorkspaceGitSnapshot;
		const candidateIsOlderThanPersistedSnapshot =
			existingSnapshot !== null && candidateObservedAt < existingSnapshot.observedAt;
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
		return nextEntry.lastWorkspaceGitSnapshot;
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

export async function removeTaskCommitIntegrationProvenance(workspaceId: string, taskId: string): Promise<boolean> {
	return await mutateProvenanceFile(workspaceId, (file) => {
		if (!(taskId in file.tasks)) {
			return false;
		}
		delete file.tasks[taskId];
		return true;
	});
}
