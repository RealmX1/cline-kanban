import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationState,
	RuntimeTaskCommitCoverageInCurrentDeployment,
	RuntimeTaskWorkspaceMetadata,
} from "../core/api-contract";
import { runtimePostDeployVerificationStateSchema } from "../core/api-contract";
import { createParsedPersistedJsonFileReadCache } from "../state/parsed-persisted-json-file-read-cache";
import { computeStablePatchIdsOfNonMergeCommitsInRevisionRange, runGit } from "../workspace/git-utils";
import { matchTaskCommitsOneToOneIntoBaseRefCommits } from "../workspace/shared-task-commit-landing-criterion-against-local-base";
import {
	type RetainedTaskCommitCoverageInput,
	readRetainedTaskCommitCoverageInputsByTaskId,
} from "../workspace/task-commit-integration-provenance";
import {
	findActiveDeploymentGroupOfWorkspace,
	getPostDeployVerificationStatePath,
	migrateLegacyPostDeployVerificationStateFileIfNeeded,
} from "./post-deploy-verification-state";

const deploymentStateReadCache = createParsedPersistedJsonFileReadCache<RuntimePostDeployVerificationState | null>();
const reachableCommitsByRepositoryAndDeploymentSha = new Map<string, Promise<Set<string> | null>>();
const patchIdsByRepositoryAndDeploymentRange = new Map<string, Promise<Map<string, string> | null>>();
const limitDeploymentHistoryInspectionConcurrency = pLimit(2);
const MAX_CACHED_IMMUTABLE_DEPLOYMENT_HISTORY_INSPECTIONS = 32;

function cacheImmutableDeploymentHistoryInspection<T>(
	cache: Map<string, Promise<T | null>>,
	key: string,
	inspect: () => Promise<T | null>,
): Promise<T | null> {
	const previous = cache.get(key);
	if (previous) return previous;
	const pending = limitDeploymentHistoryInspectionConcurrency(inspect).catch(() => null);
	cache.set(key, pending);
	void pending.then((result) => {
		if (result === null && cache.get(key) === pending) cache.delete(key);
	});
	while (cache.size > MAX_CACHED_IMMUTABLE_DEPLOYMENT_HISTORY_INSPECTIONS) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return pending;
}

function buildCoverage(
	deployment: RuntimePostDeployVerificationDeploymentGroup | null,
	knownTaskCommitCount: number | null,
	matchedTaskCommitCountInCurrentDeployment: number | null,
	unavailableReason: string | null = null,
): RuntimeTaskCommitCoverageInCurrentDeployment {
	const coverageStatus =
		knownTaskCommitCount === 0
			? "no_known_task_commits"
			: matchedTaskCommitCountInCurrentDeployment === null
				? "unknown"
				: matchedTaskCommitCountInCurrentDeployment === 0
					? "no_known_task_commits_in_current_deployment"
					: matchedTaskCommitCountInCurrentDeployment === knownTaskCommitCount
						? "all_known_task_commits_in_current_deployment"
						: "some_known_task_commits_in_current_deployment";
	const fields = {
		coverageStatus,
		knownTaskCommitCount,
		matchedTaskCommitCountInCurrentDeployment,
		currentDeploymentId: deployment?.deploymentId ?? null,
		currentDeployedSourceCommit: deployment?.deployedSourceCommit ?? null,
		currentDeploymentRecordedAtIso: deployment?.deployedAtIso ?? null,
		unavailableReason,
	} satisfies Omit<RuntimeTaskCommitCoverageInCurrentDeployment, "coverageVersion">;
	return { ...fields, coverageVersion: createHash("sha256").update(JSON.stringify(fields)).digest("hex") };
}

async function readCurrentDeploymentOfWorkspace(
	workspaceId: string,
): Promise<RuntimePostDeployVerificationDeploymentGroup | null> {
	const path = getPostDeployVerificationStatePath();
	try {
		await migrateLegacyPostDeployVerificationStateFileIfNeeded();
		const state = await deploymentStateReadCache.read(path, async () => {
			const parsed = runtimePostDeployVerificationStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
			return parsed.success ? parsed.data : null;
		});
		return state ? findActiveDeploymentGroupOfWorkspace(state, workspaceId) : null;
	} catch {
		return null;
	}
}

async function loadReachableDeploymentCommits(repositoryPath: string, sha: string): Promise<Set<string> | null> {
	return await cacheImmutableDeploymentHistoryInspection(
		reachableCommitsByRepositoryAndDeploymentSha,
		`${repositoryPath}\0${sha}`,
		async () => {
			if (!/^[a-f0-9]{40,64}$/.test(sha)) return null;
			const shallow = await runGit(repositoryPath, ["rev-parse", "--is-shallow-repository"], { timeoutMs: 10_000 });
			if (!shallow.ok || shallow.stdout !== "false") return null;
			const history = await runGit(repositoryPath, ["rev-list", sha, "--"], { timeoutMs: 10_000 });
			return history.ok ? new Set(history.stdout.split("\n").filter(Boolean)) : null;
		},
	);
}

async function loadDeploymentPatchIdsAfterTaskProvenanceFloors(
	repositoryPath: string,
	deployedSha: string,
	input: RetainedTaskCommitCoverageInput,
): Promise<Map<string, string> | null> {
	const floors = [...new Set(input.provenanceFloorCommits)].sort();
	if (floors.length === 0 || floors.some((sha) => !/^[a-f0-9]{40,64}$/.test(sha))) return null;
	const key = `${repositoryPath}\0${deployedSha}\0${floors.join(":")}`;
	return await cacheImmutableDeploymentHistoryInspection(patchIdsByRepositoryAndDeploymentRange, key, async () => {
		// 只取该任务锚点与当前部署的共同祖先；其他任务不能扩大其匹配范围或使其历史检查失败。
		const floor = await runGit(repositoryPath, ["merge-base", "--octopus", deployedSha, ...floors], {
			timeoutMs: 10_000,
		});
		if (!floor.ok || !/^[a-f0-9]{40,64}$/.test(floor.stdout)) return null;
		return await computeStablePatchIdsOfNonMergeCommitsInRevisionRange(
			repositoryPath,
			`${floor.stdout}..${deployedSha}`,
		);
	});
}

interface WorkspaceTaskCommitCoverageReadRequest {
	workspaceId: string;
	repositoryPath: string;
	taskIds: readonly string[];
}

async function computeTaskCommitCoverageInCurrentDeploymentForWorkspace(
	input: WorkspaceTaskCommitCoverageReadRequest,
): Promise<Map<string, RuntimeTaskCommitCoverageInCurrentDeployment>> {
	const [deployment, retainedByTaskId] = await Promise.all([
		readCurrentDeploymentOfWorkspace(input.workspaceId),
		readRetainedTaskCommitCoverageInputsByTaskId(input.workspaceId).catch(
			() => new Map<string, RetainedTaskCommitCoverageInput>(),
		),
	]);
	const results = new Map<string, RuntimeTaskCommitCoverageInCurrentDeployment>();
	const candidates = new Map<string, RetainedTaskCommitCoverageInput>();
	for (const taskId of input.taskIds) {
		const retained = retainedByTaskId.get(taskId);
		const knownCount = retained?.knownTaskCommits?.length ?? null;
		if (knownCount === 0) results.set(taskId, buildCoverage(deployment, 0, 0));
		else if (knownCount === null)
			results.set(taskId, buildCoverage(deployment, null, null, "task_commit_history_unavailable"));
		else if (!deployment)
			results.set(taskId, buildCoverage(null, knownCount, null, "current_deployment_record_unavailable"));
		else if (retained) candidates.set(taskId, retained);
	}
	if (!deployment || candidates.size === 0) return results;
	const reachable = await loadReachableDeploymentCommits(input.repositoryPath, deployment.deployedSourceCommit);
	const patchIdsByTaskId = new Map(
		await Promise.all(
			[...candidates].map(async ([taskId, retained]) => {
				const needsPatchMatching = retained.knownTaskCommits?.some(
					(commit) => !reachable?.has(commit.commitSha) && commit.stablePatchId !== null,
				);
				const patchIds =
					reachable && needsPatchMatching
						? await loadDeploymentPatchIdsAfterTaskProvenanceFloors(
								input.repositoryPath,
								deployment.deployedSourceCommit,
								retained,
							)
						: new Map<string, string>();
				return [taskId, patchIds] as const;
			}),
		),
	);
	for (const [taskId, retained] of candidates) {
		const commits = retained.knownTaskCommits ?? [];
		const patchIds = patchIdsByTaskId.get(taskId);
		if (!reachable || patchIds === null) {
			results.set(taskId, buildCoverage(deployment, commits.length, null, "deployment_git_history_unavailable"));
			continue;
		}
		const matchingDeploymentCommits = new Map(
			commits.filter((commit) => reachable.has(commit.commitSha)).map((commit) => [commit.commitSha, commit]),
		);
		const requestedPatchIds = new Set(commits.map((commit) => commit.stablePatchId));
		for (const [commitSha, stablePatchId] of patchIds ?? []) {
			if (requestedPatchIds.has(stablePatchId))
				matchingDeploymentCommits.set(commitSha, { commitSha, stablePatchId });
		}
		const matched = matchTaskCommitsOneToOneIntoBaseRefCommits({
			taskCommits: commits,
			baseRefCommits: [...matchingDeploymentCommits.values()],
		});
		results.set(taskId, buildCoverage(deployment, commits.length, matched.taskCommitsIntegratedIntoBaseRef.length));
	}
	return results;
}

export async function readTaskCommitCoverageInCurrentDeploymentForWorkspace(
	input: WorkspaceTaskCommitCoverageReadRequest,
): Promise<Map<string, RuntimeTaskCommitCoverageInCurrentDeployment>> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const results = await computeTaskCommitCoverageInCurrentDeploymentForWorkspace(input);
		const latestDeployment = await readCurrentDeploymentOfWorkspace(input.workspaceId);
		if (
			[...results.values()].every(
				(coverage) => coverage.currentDeploymentId === (latestDeployment?.deploymentId ?? null),
			)
		)
			return results;
	}
	// Git 检查期间又发生部署时，不把迟到的旧版本覆盖结果作为当前结果发出。
	const latestDeployment = await readCurrentDeploymentOfWorkspace(input.workspaceId);
	return new Map(
		input.taskIds.map((taskId) => [
			taskId,
			buildCoverage(latestDeployment, null, null, "current_deployment_changed_during_inspection"),
		]),
	);
}

// 独立于 worktree 的缓存命中路径，每轮仍核对部署与保留提交版本。多个视图共享同一批不可变 Git 检查。
export async function attachTaskCommitCoverageInCurrentDeploymentToMetadata(input: {
	workspaceId: string;
	repositoryPath: string;
	taskMetadata: readonly RuntimeTaskWorkspaceMetadata[];
}): Promise<RuntimeTaskWorkspaceMetadata[]> {
	const coverage = await readTaskCommitCoverageInCurrentDeploymentForWorkspace({
		...input,
		taskIds: input.taskMetadata.map((task) => task.taskId),
	});
	return input.taskMetadata.map((metadata) => {
		let summary = coverage.get(metadata.taskId);
		const trackingStatus = metadata.workspaceGitStatus.taskCommitIntegrationTrackingStatus;
		if (summary && trackingStatus !== "complete") {
			// 保留明细只证明上次的集合；最新归属不完整时，旧分母不能继续代表当前任务。
			const unavailableReason =
				trackingStatus === "git_probe_unavailable" ? "task_git_observation_unavailable" : trackingStatus;
			summary = {
				...summary,
				coverageStatus: "unknown",
				knownTaskCommitCount: null,
				matchedTaskCommitCountInCurrentDeployment: null,
				unavailableReason,
				coverageVersion: `${summary.coverageVersion}:${unavailableReason}`,
			};
		}
		return { ...metadata, taskCommitCoverageInCurrentDeployment: summary };
	});
}
