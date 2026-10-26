import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import {
	type TaskRvfHistoryIssue,
	type TaskRvfHistoryRequest,
	type TaskRvfHistoryResponse,
	type TaskRvfHistoryRun,
	taskRvfHistoryRequestSchema,
	taskRvfHistoryResponseSchema,
} from "../core/task-rvf-history-contract";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
} from "../rvf-automatic-closeout/rvf-automatic-closeout-store";
import { loadPersistedWorkspaceStateById } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const QUERY_BUDGET_MS = 20_000;
const producerStoragePathsSchema = z.object({
	schema: z.literal("rvf-storage-paths/v1"),
	run_logs_root: z.string(),
	rvf_home: z.string(),
});
const producerRunEvidenceSchema = z.object({
	run_id: z.string().nullish(),
	run_directory: z.string(),
	repository_path: z.string().nullish(),
	kanban_task_id: z.string().nullish(),
	session_id: z.string().nullish(),
	decision_token: z.string().nullish(),
	completed_at: z.union([z.string(), z.number()]).nullish(),
	review_completion_status: z.enum(["completed", "advisory", "in_progress", "failed", "cancelled", "unknown"]),
	completion_evidence_source: z.string().nullish(),
	recorded_finalization_kind: z.string().nullish(),
	handoff_path: z.string().nullish(),
	handoff_sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.nullish(),
	reviewed_candidate_content_manifest_sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.nullish(),
	reason_code: z.string(),
	reason: z.string().nullish(),
	recovery_condition: z.string().nullish(),
	current_candidate_coverage: z
		.object({
			status: z.enum(["covered", "not_covered", "unknown"]),
			reason_code: z.string(),
			current_candidate_content_manifest_sha256: z
				.string()
				.regex(/^[a-f0-9]{64}$/u)
				.nullish(),
		})
		.optional(),
});
const producerInspectionResponseSchema = z.object({
	schema: z.literal("rvf-run-review-evidence/v1"),
	runs: z.array(z.unknown()),
});
const runSummarySchema = z.object({
	run_id: z.string().nullish(),
	repo: z.string().nullish(),
	timestamp: z.union([z.string(), z.number()]).nullish(),
	rvf_scope_contract_path: z.string().nullish(),
	rvf_handoff_path: z.string().nullish(),
	rvf_state: z
		.object({
			artifact_paths: z.object({ scope_contract: z.string().nullish(), handoff: z.string().nullish() }).optional(),
		})
		.nullish(),
});

interface BoundTaskRvfRun {
	runDirectory: string;
	runId: string | null;
	decisionToken: string | null;
	record?: Pick<
		RvfAutomaticCloseoutRecord,
		| "createdAt"
		| "status"
		| "handoffPath"
		| "handoffSha256"
		| "landExecutionResult"
		| "baseBranchSyncExecutionResult"
		| "existingCloseoutGoalCompletionReconciliation"
	> & {
		receipt: Pick<RvfAutomaticCloseoutRecord["receipt"], "session_id"> &
			Partial<Pick<RvfAutomaticCloseoutRecord["receipt"], "worktree" | "kanban_task_id" | "decision_token">>;
	};
}
interface DiscoveredTaskRvfRun {
	runId: string | null;
	startedAt: number | null;
	decisionToken: string | null;
	sessionId: string | null;
	worktreePath?: string;
	bound?: BoundTaskRvfRun;
	ownershipIssue?: TaskRvfHistoryIssue;
	frozenReviewOwnership?: Awaited<ReturnType<typeof recoverRunReviewOwnership>>;
	migrationVerifiedHandoffPath?: string;
	migrationVerifiedHandoffSha256?: string;
}
export interface TaskRvfHistoryContext {
	worktreePath: string;
	historicalWorktreePaths: string[];
	taskCreatedAt: number;
	boundRuns: BoundTaskRvfRun[];
	issues: TaskRvfHistoryIssue[];
	worktreeSharedWithOtherTasks?: boolean;
}
interface TaskRvfHistoryQueryDependencies {
	loadTaskContext: (scope: RuntimeTrpcWorkspaceScope, taskId: string) => Promise<TaskRvfHistoryContext>;
	queryProducer: (arguments_: string[], timeoutMs: number) => Promise<unknown>;
	budgetMs: number;
}

function evidenceIssue(reasonCode: string, reason: string): TaskRvfHistoryIssue {
	return { reasonCode, reason, recoveryCondition: "相关存储、生产方接口或工件恢复且稳定后重新查询；无需重新发起 RVF" };
}

async function readRegularJson(path: string): Promise<unknown> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024)
		throw new Error(`不是可安全读取的常规 JSON 工件：${path}`);
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function observedTime(value: string | number | null | undefined): number | null {
	const time = typeof value === "number" ? value : value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(time) ? time : null;
}

const frozenTaskBindingSchema = z.object({
	worktree: z.string().nullish(),
	kanban_task_id: z.string().nullish(),
	session_id: z.string().nullish(),
	decision_token: z.string().nullish(),
});
const frozenReviewCandidateSchema = frozenTaskBindingSchema.extend({
	native_review_start_boundary_receipt: frozenTaskBindingSchema.nullish(),
});
const frozenScopeBindingSchema = z.object({
	review_candidate_snapshot: frozenReviewCandidateSchema.nullish(),
	review_start_boundary_receipt: frozenTaskBindingSchema.nullish(),
});
const runOwnershipMetadataSchema = frozenTaskBindingSchema.extend({
	repo: z.string().nullish(),
	run_id: z.string().nullish(),
	created_at: z.union([z.string(), z.number()]).nullish(),
	review_candidate_snapshot: frozenReviewCandidateSchema.nullish(),
	review_start_boundary_receipt: frozenTaskBindingSchema.nullish(),
	canonical_scope: frozenScopeBindingSchema.nullish(),
});

function createEvidencePathCanonicalizer() {
	const cachedPaths = new Map<string, Promise<string>>();
	const canonicalize = (path: string): Promise<string> => {
		const absolute = resolve(path);
		const cached = cachedPaths.get(absolute);
		if (cached) return cached;
		const result = realpath(absolute).catch(async (error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
			// 历史 worktree 或迁移前的工件可以已删除；仍规范化尚存的父目录别名。
			const parent = dirname(absolute);
			return parent === absolute ? absolute : join(await canonicalize(parent), basename(absolute));
		});
		cachedPaths.set(absolute, result);
		return result;
	};
	return canonicalize;
}

async function isDeclaredArtifactOwnedByRun(
	declared: string | null | undefined,
	directory: string,
	relative: string,
	canonicalizePath: (path: string) => Promise<string>,
): Promise<boolean> {
	if (!declared) return true;
	const currentArtifact = join(directory, relative);
	if ((await canonicalizePath(declared)) === currentArtifact) return true;
	let declaredRunDirectory = resolve(declared);
	for (const segment of relative.split("/").reverse()) {
		if (basename(declaredRunDirectory) !== segment) return false;
		declaredRunDirectory = dirname(declaredRunDirectory);
	}
	if (basename(declaredRunDirectory) !== basename(directory) || basename(dirname(declaredRunDirectory)) !== "runs")
		return false;
	try {
		const metadata = await lstat(currentArtifact);
		// 仅接受本轮同名标准工件的存储根迁移，不把父 run 的引用当成本轮审阅。
		return metadata.isFile() && !metadata.isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return false;
	}
}

async function recoverRunReviewOwnership(directory: string, canonicalizePath: (path: string) => Promise<string>) {
	let hasReviewEvidence = false;
	const worktreePaths = new Set<string>();
	const taskIds = new Set<string>();
	const runIds = new Set<string>();
	const sessionIds = new Set<string>();
	const decisionTokens = new Set<string>();
	let createdAt: number | null = null;
	for (const relative of [
		"artifacts/inputs/scope.contract.json",
		"inputs/automatic-closeout-review-start-receipt.json",
		"artifacts/.finalize.lock",
		"artifacts/review-packet.metadata.json",
		"artifacts/reviewers/reviewer-plan.json",
	]) {
		try {
			const value = await readRegularJson(join(directory, relative));
			hasReviewEvidence = true;
			const metadata = runOwnershipMetadataSchema.parse(value);
			if (metadata.repo) worktreePaths.add(await canonicalizePath(metadata.repo));
			if (metadata.run_id) runIds.add(metadata.run_id);
			if (relative === "artifacts/inputs/scope.contract.json" || relative.startsWith("inputs/"))
				createdAt ??= observedTime(metadata.created_at);
			for (const binding of [
				metadata,
				metadata.review_candidate_snapshot,
				metadata.review_candidate_snapshot?.native_review_start_boundary_receipt,
				metadata.review_start_boundary_receipt,
				metadata.canonical_scope?.review_candidate_snapshot,
				metadata.canonical_scope?.review_candidate_snapshot?.native_review_start_boundary_receipt,
				metadata.canonical_scope?.review_start_boundary_receipt,
			]) {
				if (binding?.worktree) worktreePaths.add(await canonicalizePath(binding.worktree));
				if (binding?.kanban_task_id) taskIds.add(binding.kanban_task_id);
				if (binding?.session_id) sessionIds.add(binding.session_id);
				if (binding?.decision_token) decisionTokens.add(binding.decision_token);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") hasReviewEvidence = true;
		}
	}
	return { hasReviewEvidence, worktreePaths, taskIds, runIds, sessionIds, decisionTokens, createdAt };
}

async function reconcileDeletedStorageRunBindings(
	candidates: Map<string, DiscoveredTaskRvfRun>,
	taskId: string,
	taskCreatedAt: number,
	canonicalizePath: (path: string) => Promise<string>,
	issues: TaskRvfHistoryIssue[],
	remainingBudgetMs: () => number,
) {
	const discoveryWasComplete = issues.length === 0;
	for (const [sourceDirectory, source] of [...candidates].filter(
		([, candidate]) => candidate.bound && candidate.runId,
	)) {
		const targets = [...candidates].filter(
			([directory, candidate]) => directory !== sourceDirectory && candidate.runId === source.runId,
		);
		if (!targets.length) continue;
		const refuseMigration = (reasonCode: string, reason: string) => {
			const issue = evidenceIssue(reasonCode, `${reason}：${sourceDirectory}`);
			issues.push(issue);
			source.ownershipIssue ??= issue;
			for (const [, target] of targets) target.ownershipIssue ??= issue;
		};
		const uniqueStorageMigrationTarget = targets[0];
		if (targets.length !== 1 || !uniqueStorageMigrationTarget || uniqueStorageMigrationTarget[1].bound) {
			refuseMigration("run_storage_migration_identity_ambiguous", "同一 run 有多个物理来源或迁移目标，无法唯一归并");
			continue;
		}
		if (!discoveryWasComplete || !remainingBudgetMs()) {
			refuseMigration("run_storage_migration_discovery_incomplete", "发现尚未完整完成，不能确认迁移目标唯一");
			continue;
		}
		const [targetDirectory, target] = uniqueStorageMigrationTarget;
		try {
			try {
				await lstat(sourceDirectory);
				refuseMigration("run_storage_migration_source_still_exists", "旧物理目录仍存在，不能视为存储迁移");
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const record = source.bound?.record;
			const frozen = target.frozenReviewOwnership;
			const sourceCreatedAt = observedTime(record?.createdAt);
			if (
				!record?.receipt.worktree ||
				!record.receipt.kanban_task_id ||
				!source.sessionId ||
				!source.decisionToken ||
				sourceCreatedAt === null ||
				!frozen ||
				frozen.createdAt === null ||
				!frozen.taskIds.size ||
				!frozen.worktreePaths.size ||
				!frozen.runIds.size ||
				!frozen.sessionIds.size ||
				!frozen.decisionTokens.size
			) {
				refuseMigration(
					"run_storage_migration_binding_incomplete",
					"迁移缺少冻结 Task、worktree、session、token 或稳定时间",
				);
				continue;
			}
			const sourceWorktree = await canonicalizePath(record.receipt.worktree);
			// 服务端登记可晚于 scope 冻结；时间只约束 Task 世代与开审早于已有完成事实。
			const completionTimes = [
				record.landExecutionResult?.reportedAt,
				record.baseBranchSyncExecutionResult?.reportedAt,
			].flatMap((time) => {
				const observed = observedTime(time);
				return observed === null ? [] : [observed];
			});
			if (
				target.ownershipIssue ||
				record.receipt.kanban_task_id !== taskId ||
				(record.receipt.decision_token && record.receipt.decision_token !== source.decisionToken) ||
				frozen.taskIds.size !== 1 ||
				!frozen.taskIds.has(taskId) ||
				frozen.worktreePaths.size !== 1 ||
				!frozen.worktreePaths.has(sourceWorktree) ||
				frozen.runIds.size !== 1 ||
				!frozen.runIds.has(source.runId ?? "") ||
				frozen.sessionIds.size !== 1 ||
				!frozen.sessionIds.has(source.sessionId) ||
				frozen.decisionTokens.size !== 1 ||
				!frozen.decisionTokens.has(source.decisionToken) ||
				sourceCreatedAt < taskCreatedAt ||
				frozen.createdAt < taskCreatedAt ||
				frozen.createdAt > Math.min(...completionTimes)
			) {
				refuseMigration("run_storage_migration_binding_mismatch", "迁移目标与原绑定的冻结身份或时间关系冲突");
				continue;
			}
			const handoffPath = join(targetDirectory, "artifacts", "handoff.md");
			let handoffSha256: string | undefined;
			try {
				const metadata = await lstat(handoffPath);
				if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("迁移 handoff 必须是常规文件。");
				handoffSha256 = createHash("sha256")
					.update(await readFile(handoffPath))
					.digest("hex");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (record.handoffSha256 && (!/^[a-f0-9]{64}$/u.test(record.handoffSha256) || !handoffSha256)) {
				refuseMigration(
					"run_storage_migration_binding_incomplete",
					"原绑定保留 handoff 摘要，但新目录缺少可核对的工件",
				);
				continue;
			}
			if (record.handoffSha256 && record.handoffSha256 !== handoffSha256) {
				refuseMigration("run_storage_migration_binding_mismatch", "迁移 handoff 摘要与原接受记录冲突");
				continue;
			}
			// 只移动查询投影的目录键；原始接受记录及其旧路径保持不变。
			candidates.delete(sourceDirectory);
			candidates.set(targetDirectory, {
				...target,
				bound: source.bound,
				migrationVerifiedHandoffPath: handoffSha256 ? handoffPath : undefined,
				migrationVerifiedHandoffSha256: handoffSha256,
			});
		} catch {
			refuseMigration(
				"run_storage_migration_evidence_unavailable",
				"无法只读核对旧目录或迁移 handoff，保留原历史绑定",
			);
		}
	}
}

async function loadTaskHistoryContext(
	scope: RuntimeTrpcWorkspaceScope,
	taskId: string,
): Promise<TaskRvfHistoryContext> {
	const state = await loadPersistedWorkspaceStateById(scope.workspaceId);
	const card = state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
	if (!card) throw new Error(`当前 workspace 中没有 Task ${taskId}。`);
	const worktree = await getTaskWorkspacePathInfo({
		cwd: scope.workspacePath,
		taskId,
		baseRef: card.baseRef ?? "main",
		worktreeMode: card.worktreeMode,
	});
	const issues: TaskRvfHistoryIssue[] = [];
	let records: RvfAutomaticCloseoutRecord[] = [];
	try {
		records = (await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(scope.workspaceId))).filter(
			(record) =>
				record.workspaceId === scope.workspaceId &&
				record.taskId === taskId &&
				record.createdAt >= (card.createdAt ?? 0),
		);
	} catch {
		issues.push(evidenceIssue("closeout_records_unavailable", "无法完整读取自动收尾记录；普通 run 发现仍继续。"));
	}
	const paths = new Set([resolve(worktree.path), ...records.map((record) => resolve(record.receipt.worktree))]);
	for (const [sessionKey, summary] of Object.entries(state.sessions)) {
		if (
			(sessionKey === taskId || summary.taskConversationSessionMetadata?.workspaceTaskId === taskId) &&
			summary.workspacePath
		)
			paths.add(resolve(summary.workspacePath));
	}
	return {
		worktreePath: resolve(worktree.path),
		historicalWorktreePaths: [...paths],
		taskCreatedAt: card.createdAt ?? 0,
		worktreeSharedWithOtherTasks: card.worktreeMode === "inplace",
		boundRuns: records.flatMap((record) =>
			record.runDirectory
				? [
						{
							runDirectory: record.runDirectory,
							runId: record.runId,
							decisionToken: record.receipt.decision_token,
							record,
						},
					]
				: [],
		),
		issues,
	};
}

export async function queryRvfReadOnlyInspectionProducer(arguments_: string[], timeoutMs: number): Promise<unknown> {
	if (timeoutMs <= 0) throw new Error("RVF 查询预算已耗尽。");
	// RVF_HOME 是数据根；生产方部署的 shim 固定位于用户 home 下。
	const executable =
		process.env.KANBAN_RVF_INSPECTION_EXECUTABLE_PATH?.trim() || join(homedir(), ".rvf", "bin", "rvf");
	return new Promise((accept, reject) => {
		execFile(
			executable,
			arguments_,
			{
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 16 * 1024 * 1024,
				windowsHide: true,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", PYTHONDONTWRITEBYTECODE: "1" },
			},
			(error, stdout) => {
				if (error) return reject(new Error(`RVF 只读鉴证接口不可用：${error.code ?? "execution_failed"}`));
				try {
					accept(JSON.parse(stdout) as unknown);
				} catch {
					reject(new Error("RVF 只读鉴证返回了无效 JSON。"));
				}
			},
		);
	});
}

export function createTaskRvfHistoryQueryService(overrides: Partial<TaskRvfHistoryQueryDependencies> = {}) {
	const dependencies: TaskRvfHistoryQueryDependencies = {
		loadTaskContext: loadTaskHistoryContext,
		queryProducer: queryRvfReadOnlyInspectionProducer,
		budgetMs: QUERY_BUDGET_MS,
		...overrides,
	};
	return async (scope: RuntimeTrpcWorkspaceScope, request: TaskRvfHistoryRequest): Promise<TaskRvfHistoryResponse> => {
		const input = taskRvfHistoryRequestSchema.parse(request);
		const queriedAt = Date.now();
		const remaining = () => Math.max(0, dependencies.budgetMs - (Date.now() - queriedAt));
		const context = await dependencies.loadTaskContext(scope, input.taskId);
		const issues = [...context.issues];
		const canonicalizePath = createEvidencePathCanonicalizer();
		const knownPaths = new Set(
			await Promise.all([context.worktreePath, ...context.historicalWorktreePaths].map(canonicalizePath)),
		);
		const candidates = new Map<string, DiscoveredTaskRvfRun>();
		for (const bound of context.boundRuns) {
			if (bound.record && bound.record.createdAt < context.taskCreatedAt) continue;
			candidates.set(await canonicalizePath(bound.runDirectory), {
				runId: bound.runId,
				startedAt: bound.record?.createdAt ?? null,
				decisionToken: bound.decisionToken,
				sessionId: bound.record?.receipt.session_id ?? null,
				bound,
			});
		}
		const boundRunIds = new Set(
			[...candidates.values()].flatMap((candidate) => (candidate.runId ? [candidate.runId] : [])),
		);
		try {
			const storage = producerStoragePathsSchema.parse(
				await dependencies.queryProducer(["inspect", "storage-paths", "--json"], remaining()),
			);
			const runsRoot = await canonicalizePath(join(storage.run_logs_root, "runs"));
			let entries: string[];
			try {
				entries = await readdir(runsRoot, { encoding: "utf8" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				entries = [];
			}
			// 只读一层 run 的固定归属工件；不递归遍历 reviewer、转录和 fix worktree。
			for (let offset = 0; offset < entries.length; offset += 8) {
				if (!remaining()) {
					issues.push(evidenceIssue("discovery_budget_exhausted", "历史 run 发现未在预算内完成。"));
					break;
				}
				await Promise.all(
					entries.slice(offset, offset + 8).map(async (name) => {
						const directory = join(runsRoot, name);
						try {
							if (!(await lstat(directory)).isDirectory()) return;
							let summary: z.infer<typeof runSummarySchema> | null = null;
							try {
								summary = runSummarySchema.parse(await readRegularJson(join(directory, "summary.json")));
							} catch {
								// summary 可由精确绑定和冻结工件补证，是否完成仍交给生产方鉴证。
							}
							const existing = candidates.get(directory);
							const ownership = await recoverRunReviewOwnership(directory, canonicalizePath);
							const summaryRepo = summary?.repo ? await canonicalizePath(summary.repo) : null;
							const ownerPaths = new Set(ownership.worktreePaths);
							if (summaryRepo) ownerPaths.add(summaryRepo);
							// 同 run ID 只使它成为待核对的迁移声明，不足以直接继承绑定。
							const claimsBoundRunIdentity =
								(summary?.run_id && boundRunIds.has(summary.run_id)) ||
								[...ownership.runIds].some((runId) => boundRunIds.has(runId));
							if (
								!existing &&
								!claimsBoundRunIdentity &&
								![...ownerPaths].some((path) => knownPaths.has(path))
							) {
								if (ownerPaths.size || !ownership.hasReviewEvidence) return;
								issues.push(
									evidenceIssue("run_ownership_unavailable", `无法核对 run 的冻结归属：${directory}`),
								);
								return;
							}
							const declaredScope =
								summary?.rvf_scope_contract_path ?? summary?.rvf_state?.artifact_paths?.scope_contract;
							const declaredHandoff = summary?.rvf_handoff_path ?? summary?.rvf_state?.artifact_paths?.handoff;
							// dispatcher/单腿日志可能复用父 worktree；它们指向其他 run 的审阅工件，不能当作独立 RVF。
							if (
								!(await isDeclaredArtifactOwnedByRun(
									declaredScope,
									directory,
									"artifacts/inputs/scope.contract.json",
									canonicalizePath,
								)) ||
								!(await isDeclaredArtifactOwnedByRun(
									declaredHandoff,
									directory,
									"artifacts/handoff.md",
									canonicalizePath,
								))
							)
								return;
							if (!declaredScope && !existing && !ownership.hasReviewEvidence) return;
							if (
								ownership.taskIds.size === 1 &&
								!ownership.taskIds.has(input.taskId) &&
								!existing &&
								!claimsBoundRunIdentity
							)
								return;
							if (
								context.worktreeSharedWithOtherTasks &&
								!ownership.taskIds.has(input.taskId) &&
								!existing &&
								!claimsBoundRunIdentity
							) {
								issues.push(
									evidenceIssue(
										"shared_worktree_task_binding_unknown",
										"inplace run 缺少独立 Task 绑定，未归入当前 Task。",
									),
								);
								return;
							}
							const runIds = new Set(ownership.runIds);
							const sessionIds = new Set(ownership.sessionIds);
							const decisionTokens = new Set(ownership.decisionTokens);
							if (summary?.run_id) runIds.add(summary.run_id);
							if (existing?.runId) runIds.add(existing.runId);
							if (existing?.sessionId) sessionIds.add(existing.sessionId);
							if (existing?.decisionToken) decisionTokens.add(existing.decisionToken);
							let ownershipIssue: TaskRvfHistoryIssue | undefined;
							if (
								ownerPaths.size > 1 ||
								[...ownerPaths].some((path) => !knownPaths.has(path)) ||
								runIds.size > 1 ||
								sessionIds.size > 1 ||
								decisionTokens.size > 1 ||
								ownership.taskIds.size > 1 ||
								(ownership.taskIds.size > 0 && !ownership.taskIds.has(input.taskId))
							) {
								ownershipIssue = evidenceIssue(
									"run_ownership_binding_mismatch",
									`run 的 summary、冻结工件或精确绑定互相冲突：${directory}`,
								);
							}
							const startedAt = ownership.createdAt ?? existing?.startedAt ?? null;
							if (startedAt !== null && startedAt < context.taskCreatedAt) {
								candidates.delete(directory);
								return;
							}
							if (startedAt === null) {
								// summary 时间只说明最近写入；它早于建卡时可排除，晚于建卡时不能证明开审归属。
								const lastSummaryWrite = observedTime(summary?.timestamp);
								if (lastSummaryWrite !== null && lastSummaryWrite < context.taskCreatedAt) return;
								ownershipIssue ??= evidenceIssue(
									"run_start_time_unavailable",
									`缺少可核对的稳定开审时间，无法确认 Task 世代：${directory}`,
								);
							}
							if (ownershipIssue) issues.push(ownershipIssue);
							candidates.set(directory, {
								runId: existing?.runId ?? ownership.runIds.values().next().value ?? summary?.run_id ?? null,
								startedAt,
								decisionToken:
									existing?.decisionToken ?? ownership.decisionTokens.values().next().value ?? null,
								sessionId: existing?.sessionId ?? ownership.sessionIds.values().next().value ?? null,
								worktreePath: ownership.worktreePaths.values().next().value ?? summaryRepo ?? undefined,
								bound: existing?.bound,
								ownershipIssue,
								frozenReviewOwnership: ownership,
							});
						} catch {
							issues.push(evidenceIssue("run_ownership_unavailable", `无法完整读取 run 归属工件：${directory}`));
						}
					}),
				);
			}
		} catch {
			issues.push(
				evidenceIssue("producer_discovery_unavailable", "生产方存储根查询不可用；仍核验已绑定的精确 run。"),
			);
		}
		await reconcileDeletedStorageRunBindings(
			candidates,
			input.taskId,
			context.taskCreatedAt,
			canonicalizePath,
			issues,
			remaining,
		);
		const orderedCandidates = [...candidates.entries()].sort(
			(left, right) => (right[1].startedAt ?? 0) - (left[1].startedAt ?? 0) || left[0].localeCompare(right[0]),
		);
		const evidenceByDirectory = new Map<string, z.infer<typeof producerRunEvidenceSchema>>();
		if (orderedCandidates.length) {
			try {
				const args = [
					"inspect",
					"run-review-evidence",
					"--project-path",
					scope.workspacePath,
					"--current-worktree",
					context.worktreePath,
					"--json",
					...orderedCandidates.flatMap(([directory]) => ["--run-dir", directory]),
				];
				const inspection = producerInspectionResponseSchema.parse(
					await dependencies.queryProducer(args, remaining()),
				);
				for (const rawEvidence of inspection.runs) {
					const parsed = producerRunEvidenceSchema.safeParse(rawEvidence);
					if (!parsed.success) {
						issues.push(
							evidenceIssue("producer_run_evidence_invalid", "某轮鉴证响应不符合契约，其他轮次继续核验。"),
						);
						continue;
					}
					const evidence = parsed.data;
					const directory = await canonicalizePath(evidence.run_directory);
					const evidenceWorktree = evidence.repository_path
						? await canonicalizePath(evidence.repository_path)
						: null;
					const expected = candidates.get(directory);
					if (!expected || evidenceByDirectory.has(directory)) {
						evidenceByDirectory.delete(directory);
						issues.push(evidenceIssue("producer_run_identity_invalid", "鉴证 run 重复或越出请求范围。"));
						continue;
					}
					if (
						(evidence.run_id && expected.runId && evidence.run_id !== expected.runId) ||
						(evidence.kanban_task_id && evidence.kanban_task_id !== input.taskId) ||
						(evidence.session_id && expected.sessionId && evidence.session_id !== expected.sessionId) ||
						(evidence.decision_token &&
							expected.decisionToken &&
							evidence.decision_token !== expected.decisionToken) ||
						(evidence.handoff_sha256 &&
							expected.migrationVerifiedHandoffSha256 &&
							evidence.handoff_sha256 !== expected.migrationVerifiedHandoffSha256) ||
						(evidenceWorktree &&
							(!knownPaths.has(evidenceWorktree) ||
								(expected.worktreePath && evidenceWorktree !== expected.worktreePath)))
					) {
						issues.push(
							evidenceIssue("producer_run_identity_invalid", "鉴证结果与 Task/run/worktree 绑定不一致。"),
						);
						continue;
					}
					if (expected.ownershipIssue) continue;
					if (
						evidence.review_completion_status === "completed" &&
						(!evidence.run_id ||
							!evidence.repository_path ||
							!evidence.handoff_sha256 ||
							!evidence.reviewed_candidate_content_manifest_sha256 ||
							!evidence.completion_evidence_source)
					) {
						issues.push(
							evidenceIssue("producer_completed_evidence_incomplete", "完成结果缺少身份、handoff 或候选摘要。"),
						);
						continue;
					}
					evidenceByDirectory.set(directory, evidence);
				}
			} catch {
				evidenceByDirectory.clear();
				issues.push(
					evidenceIssue("producer_evidence_unavailable", "无法完整核验 RVF 生产方证据；未推断为未完成。"),
				);
			}
		}
		const runs: TaskRvfHistoryRun[] = orderedCandidates.map(([directory, candidate]) => {
			const evidence = evidenceByDirectory.get(directory);
			const record = candidate.bound?.record;
			const coverage = evidence?.current_candidate_coverage;
			// 两阶段 completed 是服务端当时已核验提交、RVF evidence 和本地 base 祖先关系的接受事实。
			// 当前安装缺失或历史缓存被清理，只影响本次再鉴证，不撤销已有接受事件。
			const previouslyAcceptedCompletion = Boolean(
				candidate.runId &&
					record?.handoffPath &&
					/^[a-f0-9]{64}$/u.test(record.handoffSha256 ?? "") &&
					record.landExecutionResult?.outcome === "completed" &&
					record.landExecutionResult.commitSha &&
					record.baseBranchSyncExecutionResult?.outcome === "completed" &&
					record.baseBranchSyncExecutionResult.commitSha &&
					record.baseBranchSyncExecutionResult.baseRef,
			);
			const acceptedSupplementalCompletion = Boolean(
				record?.landExecutionResult?.outcome === "completed" &&
					record.landExecutionResult.commitSha &&
					record.landExecutionResult.verificationBasis === "verified_supplemental_land_completion" &&
					record.landExecutionResult.supplementalLandCompletionEvidence &&
					record.landExecutionResult.supplementalLandCompletionVerification,
			);
			const useAcceptedHistoricalCompletion =
				acceptedSupplementalCompletion ||
				(previouslyAcceptedCompletion && evidence?.review_completion_status !== "completed");
			return {
				runId: evidence?.run_id ?? candidate.runId,
				runDirectory: directory,
				decisionToken: evidence?.decision_token ?? candidate.decisionToken,
				sessionId: evidence?.session_id ?? candidate.sessionId,
				startedAt: candidate.startedAt,
				completedAt: acceptedSupplementalCompletion
					? (record?.landExecutionResult?.reportedAt ?? null)
					: (observedTime(evidence?.completed_at) ??
						(useAcceptedHistoricalCompletion
							? (record?.baseBranchSyncExecutionResult?.reportedAt ?? null)
							: null)),
				completionStatus: useAcceptedHistoricalCompletion
					? "completed"
					: (evidence?.review_completion_status ?? "unknown"),
				completionEvidenceSource: acceptedSupplementalCompletion
					? "kanban_server_verified_supplemental_land_completion"
					: useAcceptedHistoricalCompletion
						? "kanban_server_accepted_closeout_record"
						: (evidence?.completion_evidence_source ?? null),
				recordedFinalizationKind: evidence?.recorded_finalization_kind ?? null,
				handoffPath:
					evidence?.handoff_path ?? candidate.migrationVerifiedHandoffPath ?? record?.handoffPath ?? null,
				handoffSha256:
					evidence?.handoff_sha256 ?? candidate.migrationVerifiedHandoffSha256 ?? record?.handoffSha256 ?? null,
				reviewedCandidateContentManifestSha256: evidence?.reviewed_candidate_content_manifest_sha256 ?? null,
				reasonCode: acceptedSupplementalCompletion
					? "historical_supplemental_completion_previously_accepted"
					: useAcceptedHistoricalCompletion
						? "historical_completion_previously_accepted"
						: (evidence?.reason_code ?? candidate.ownershipIssue?.reasonCode ?? "producer_evidence_unavailable"),
				reason: evidence?.reason ?? candidate.ownershipIssue?.reason ?? null,
				recoveryCondition:
					evidence?.recovery_condition ??
					(evidence?.review_completion_status === "completed" ? null : "本轮证据恢复后重新查询"),
				currentCandidateReviewCoverage: {
					status: useAcceptedHistoricalCompletion ? "unknown" : (coverage?.status ?? "unknown"),
					reasonCode: useAcceptedHistoricalCompletion
						? "current_coverage_requires_fresh_inspection"
						: (coverage?.reason_code ?? "coverage_evidence_unavailable"),
					verifiedByRunId:
						!useAcceptedHistoricalCompletion && coverage?.status === "covered"
							? (evidence?.run_id ?? candidate.runId)
							: null,
					currentCandidateContentManifestSha256: coverage?.current_candidate_content_manifest_sha256 ?? null,
					recoveryCondition:
						useAcceptedHistoricalCompletion || coverage?.status === "unknown"
							? "当前 worktree 与鉴证能力可用且内容稳定后重新查询"
							: null,
				},
				automaticCloseoutStatus: record?.status ?? null,
				landExecutionResult: record?.landExecutionResult ?? null,
				baseBranchSyncExecutionResult: record?.baseBranchSyncExecutionResult ?? null,
				...(record?.existingCloseoutGoalCompletionReconciliation
					? { existingCloseoutGoalCompletionReconciliation: record.existingCloseoutGoalCompletionReconciliation }
					: {}),
			};
		});
		const completed = runs.filter((run) => run.completionStatus === "completed");
		completed.sort(
			(left, right) => (right.completedAt ?? right.startedAt ?? 0) - (left.completedAt ?? left.startedAt ?? 0),
		);
		const historyUnknown = issues.length > 0 || runs.some((run) => run.completionStatus === "unknown");
		const covered = completed.find((run) => run.currentCandidateReviewCoverage.status === "covered");
		const coverageUnknown =
			historyUnknown || completed.some((run) => run.currentCandidateReviewCoverage.status === "unknown");
		let offset = 0;
		if (input.cursor) {
			const cursor = z
				.object({ workspaceId: z.string(), taskId: z.string(), afterDirectory: z.string() })
				.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
			if (cursor.workspaceId !== scope.workspaceId || cursor.taskId !== input.taskId)
				throw new Error("RVF history cursor 的 Task 归属不一致。");
			const index = runs.findIndex((run) => run.runDirectory === cursor.afterDirectory);
			if (index < 0) throw new Error("RVF history cursor 已失效，请重新查询第一页。");
			offset = index + 1;
		}
		const recentRuns = runs.slice(offset, offset + input.limit);
		const last = recentRuns.at(-1);
		const groupedIssues = new Map<string, TaskRvfHistoryIssue>();
		for (const issue of issues) {
			const previous = groupedIssues.get(issue.reasonCode);
			if (previous) previous.occurrenceCount = (previous.occurrenceCount ?? 1) + (issue.occurrenceCount ?? 1);
			else groupedIssues.set(issue.reasonCode, { ...issue });
		}
		return taskRvfHistoryResponseSchema.parse({
			schemaVersion: "kanban-task-rvf-history/v1",
			workspaceId: scope.workspaceId,
			taskId: input.taskId,
			queriedAt,
			querySource: "runtime",
			discoveryStatus: issues.length ? "partial" : "complete",
			hasVerifiedCompletedRvf: completed.length ? true : historyUnknown ? null : false,
			mostRecentVerifiedCompletedRun: completed[0] ?? null,
			currentCandidateReviewCoverage: covered?.currentCandidateReviewCoverage ?? {
				status: coverageUnknown ? "unknown" : "not_covered",
				reasonCode: coverageUnknown
					? "coverage_evidence_incomplete"
					: completed.length
						? "candidate_not_covered_by_completed_runs"
						: "no_verified_completed_rvf",
				recoveryCondition: coverageUnknown ? "缺失证据或查询能力恢复后重新查询" : null,
			},
			recentRuns,
			nextCursor:
				last && offset + input.limit < runs.length
					? Buffer.from(
							JSON.stringify({
								workspaceId: scope.workspaceId,
								taskId: input.taskId,
								afterDirectory: last.runDirectory,
							}),
						).toString("base64url")
					: null,
			issues: [...groupedIssues.values()],
		});
	};
}

export const getTaskRvfHistory = createTaskRvfHistoryQueryService();
