import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createTaskRvfHistoryQueryService,
	type TaskRvfHistoryContext,
} from "../../src/rvf-task-review-history/task-rvf-history-query-service";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

async function setup() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const root = await realpath(fixture.fixtureRootDirectoryPath);
	const runsDirectory = join(root, "run-logs", "runs");
	const worktreePath = join(root, "registered-task-worktree");
	await mkdir(worktreePath);
	const context: TaskRvfHistoryContext = {
		worktreePath,
		historicalWorktreePaths: [worktreePath],
		taskCreatedAt: 1,
		boundRuns: [],
		issues: [],
	};
	const scope = { workspaceId: "project-a", workspacePath: join(root, "main-checkout") };
	const records: Record<
		string,
		{
			status: string;
			coverage: string;
			repositoryPath?: string;
			reportedDirectory?: string;
			sessionId?: string;
			decisionToken?: string;
			runId?: string;
			handoffSha256?: string;
		}
	> = {};
	const inspected: string[] = [];
	async function addRun(name: string, repo = worktreePath, status = "completed", coverage = "covered", at = 10) {
		const directory = join(runsDirectory, name);
		await mkdir(directory, { recursive: true });
		await mkdir(join(directory, "artifacts", "inputs"), { recursive: true });
		await writeFile(
			join(directory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({ run_id: name, repo, created_at: at }),
		);
		await writeFile(
			join(directory, "summary.json"),
			JSON.stringify({
				run_id: name,
				repo,
				timestamp: at,
				rvf_scope_contract_path: join(directory, "artifacts/inputs/scope.contract.json"),
			}),
		);
		records[directory] = { status, coverage };
		return directory;
	}
	const query = createTaskRvfHistoryQueryService({
		loadTaskContext: async () => context,
		queryProducer: async (args) => {
			if (args[1] === "storage-paths")
				return {
					schema: "rvf-storage-paths/v1",
					run_logs_root: join(root, "run-logs"),
					rvf_home: join(root, "rvf-home"),
				};
			const directories = args.flatMap((arg, index) => (arg === "--run-dir" ? [args[index + 1]] : []));
			inspected.push(...directories);
			return {
				schema: "rvf-run-review-evidence/v1",
				runs: directories.map((directory) => ({
					run_id: records[directory].runId ?? directory.split("/").at(-1),
					run_directory: records[directory].reportedDirectory ?? directory,
					repository_path: records[directory].repositoryPath ?? worktreePath,
					session_id: records[directory].sessionId,
					decision_token: records[directory].decisionToken,
					review_completion_status: records[directory].status,
					completion_evidence_source: "canonical_review_artifacts",
					handoff_sha256: records[directory].handoffSha256 ?? "a".repeat(64),
					reviewed_candidate_content_manifest_sha256: "b".repeat(64),
					reason_code: "fixture_verified",
					current_candidate_coverage: { status: records[directory].coverage, reason_code: "fixture_coverage" },
				})),
			};
		},
	});
	return { root, runsDirectory, worktreePath, scope, context, query, addRun, inspected, records };
}

async function setupDeletedSourceRunBindingMigration() {
	const fixture = await setup();
	const runId = "migrated-bound-run";
	const currentDirectory = await fixture.addRun(runId, undefined, "completed", "not_covered");
	const formerDirectory = join(fixture.root, "deleted-former-storage", "runs", runId);
	const handoffText = "已接受的历史审阅与收尾\n";
	const handoffSha256 = createHash("sha256").update(handoffText).digest("hex");
	const frozenOwnership = {
		run_id: runId,
		repo: fixture.worktreePath,
		created_at: 10,
		review_candidate_snapshot: {
			kanban_task_id: "task",
			worktree: fixture.worktreePath,
			session_id: "original-session",
			decision_token: "original-token",
		},
	};
	const record = {
		createdAt: 9,
		status: "completed" as const,
		receipt: {
			session_id: "original-session",
			kanban_task_id: "task",
			worktree: fixture.worktreePath,
			decision_token: "original-token",
		},
		handoffPath: join(formerDirectory, "artifacts", "handoff.md"),
		handoffSha256,
		landExecutionResult: { outcome: "completed" as const, commitSha: "b".repeat(40), reportedAt: 20 },
		baseBranchSyncExecutionResult: {
			outcome: "completed" as const,
			commitSha: "b".repeat(40),
			baseRef: "main",
			reportedAt: 21,
		},
	};
	const source = { runDirectory: formerDirectory, runId, decisionToken: "original-token", record };
	fixture.context.boundRuns.push(source);
	fixture.records[formerDirectory] = { status: "unknown", coverage: "unknown" };
	fixture.records[currentDirectory].handoffSha256 = handoffSha256;
	await writeFile(join(currentDirectory, "artifacts", "handoff.md"), handoffText);
	await writeFile(
		join(currentDirectory, "artifacts", "inputs", "scope.contract.json"),
		JSON.stringify(frozenOwnership),
	);
	await writeFile(
		join(currentDirectory, "summary.json"),
		JSON.stringify({
			run_id: runId,
			repo: fixture.worktreePath,
			timestamp: 100,
			rvf_scope_contract_path: join(formerDirectory, "artifacts", "inputs", "scope.contract.json"),
			rvf_handoff_path: join(formerDirectory, "artifacts", "handoff.md"),
		}),
	);
	return { ...fixture, formerDirectory, currentDirectory, runId, frozenOwnership, source, handoffText, handoffSha256 };
}

describe("按 Task 聚合 RVF 历史与当前覆盖", () => {
	it.each(["completed", "unknown"])(
		"已删除旧根的精确绑定归并到唯一新目录，生产方 %s 不拆开历史事实",
		async (producerStatus) => {
			const fixture = await setupDeletedSourceRunBindingMigration();
			fixture.records[fixture.currentDirectory].status = producerStatus;
			fixture.context.worktreeSharedWithOtherTasks = true;
			const scopePath = join(fixture.currentDirectory, "artifacts", "inputs", "scope.contract.json");
			const originalScope = await readFile(scopePath);
			const originalRecord = JSON.stringify(fixture.source.record);
			const response = await fixture.query(fixture.scope, { taskId: "task" });
			expect(fixture.inspected).toEqual([fixture.currentDirectory]);
			expect(response.recentRuns).toHaveLength(1);
			expect(response.recentRuns[0]).toMatchObject({
				runId: fixture.runId,
				runDirectory: fixture.currentDirectory,
				automaticCloseoutStatus: "completed",
				landExecutionResult: fixture.source.record.landExecutionResult,
				baseBranchSyncExecutionResult: fixture.source.record.baseBranchSyncExecutionResult,
				handoffPath: join(fixture.currentDirectory, "artifacts", "handoff.md"),
			});
			expect(response.hasVerifiedCompletedRvf).toBe(true);
			expect(response.currentCandidateReviewCoverage.status).toBe(
				producerStatus === "completed" ? "not_covered" : "unknown",
			);
			expect(response.issues).toEqual([]);
			expect(await readFile(scopePath)).toEqual(originalScope);
			expect(JSON.stringify(fixture.source.record)).toBe(originalRecord);
		},
	);
	it("服务端登记晚于冻结开审时间仍可在同一 Task 世代安全归并", async () => {
		const fixture = await setupDeletedSourceRunBindingMigration();
		fixture.source.record.createdAt = 11;
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(fixture.inspected).toEqual([fixture.currentDirectory]);
		expect(response.recentRuns).toHaveLength(1);
		expect(response.recentRuns[0].startedAt).toBe(10);
		expect(response.currentCandidateReviewCoverage.status).toBe("not_covered");
		expect(response.issues).toEqual([]);
	});
	it("归并后的生产方 handoff 摘要冲突不撤销旧接受事实，也不认定当前覆盖", async () => {
		const fixture = await setupDeletedSourceRunBindingMigration();
		fixture.records[fixture.currentDirectory].handoffSha256 = "c".repeat(64);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(fixture.inspected).toEqual([fixture.currentDirectory]);
		expect(response.recentRuns).toHaveLength(1);
		expect(response.recentRuns[0].completionEvidenceSource).toBe("kanban_server_accepted_closeout_record");
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.issues.some((issue) => issue.reasonCode === "producer_run_identity_invalid")).toBe(true);
	});
	it("不同 runId 即使目录名复用也不归并历史收尾绑定", async () => {
		const fixture = await setupDeletedSourceRunBindingMigration();
		const otherRunId = "independent-new-run";
		await writeFile(
			join(fixture.currentDirectory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({ ...fixture.frozenOwnership, run_id: otherRunId }),
		);
		await writeFile(
			join(fixture.currentDirectory, "summary.json"),
			JSON.stringify({
				run_id: otherRunId,
				repo: fixture.worktreePath,
				rvf_scope_contract_path: join(fixture.currentDirectory, "artifacts", "inputs", "scope.contract.json"),
			}),
		);
		fixture.records[fixture.currentDirectory].runId = otherRunId;
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns).toHaveLength(2);
		expect(response.recentRuns.find((run) => run.runId === otherRunId)?.automaticCloseoutStatus).toBeNull();
		expect(response.recentRuns.find((run) => run.runDirectory === fixture.formerDirectory)?.completionStatus).toBe(
			"completed",
		);
		expect(fixture.inspected).toContain(fixture.formerDirectory);
	});
	it.each([
		"session",
		"token",
		"task",
		"worktree",
		"time",
		"hash",
		"missing_session",
		"missing_time",
		"missing_handoff",
		"missing_source_worktree",
	])("迁移的 %s 冲突或缺证保留旧接受事实与明确未知", async (failure) => {
		const fixture = await setupDeletedSourceRunBindingMigration();
		if (failure === "session") fixture.frozenOwnership.review_candidate_snapshot.session_id = "foreign-session";
		if (failure === "token") fixture.frozenOwnership.review_candidate_snapshot.decision_token = "foreign-token";
		if (failure === "task") fixture.frozenOwnership.review_candidate_snapshot.kanban_task_id = "foreign-task";
		if (failure === "worktree")
			fixture.frozenOwnership.review_candidate_snapshot.worktree = join(fixture.root, "foreign-worktree");
		if (failure === "time") fixture.frozenOwnership.created_at = 22;
		if (failure === "missing_session") fixture.frozenOwnership.review_candidate_snapshot.session_id = "";
		if (failure === "missing_source_worktree") fixture.source.record.receipt.worktree = "";
		await writeFile(
			join(fixture.currentDirectory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({ ...fixture.frozenOwnership, ...(failure === "missing_time" ? { created_at: null } : {}) }),
		);
		if (failure === "hash")
			await writeFile(join(fixture.currentDirectory, "artifacts", "handoff.md"), "已发生冲突的 handoff\n");
		if (failure === "missing_handoff") {
			await rm(join(fixture.currentDirectory, "artifacts", "handoff.md"));
			await writeFile(
				join(fixture.currentDirectory, "summary.json"),
				JSON.stringify({
					run_id: fixture.runId,
					repo: fixture.worktreePath,
					rvf_scope_contract_path: join(fixture.currentDirectory, "artifacts", "inputs", "scope.contract.json"),
				}),
			);
		}
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		const originalAcceptedRun = response.recentRuns.find((run) => run.runDirectory === fixture.formerDirectory);
		expect(originalAcceptedRun?.completionEvidenceSource).toBe("kanban_server_accepted_closeout_record");
		expect(originalAcceptedRun?.landExecutionResult).toEqual(fixture.source.record.landExecutionResult);
		expect(response.hasVerifiedCompletedRvf).toBe(true);
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.issues.some((issue) => issue.reasonCode.startsWith("run_storage_migration_"))).toBe(true);
	});
	it("多个新目录声明相同 runId 时不猜测归并目标", async () => {
		const fixture = await setupDeletedSourceRunBindingMigration();
		const duplicate = await fixture.addRun(
			"another-physical-directory-with-same-run-id",
			undefined,
			"completed",
			"not_covered",
		);
		await writeFile(
			join(duplicate, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify(fixture.frozenOwnership),
		);
		await writeFile(join(duplicate, "artifacts", "handoff.md"), fixture.handoffText);
		await writeFile(
			join(duplicate, "summary.json"),
			JSON.stringify({
				run_id: fixture.runId,
				repo: fixture.worktreePath,
				rvf_scope_contract_path: join(duplicate, "artifacts", "inputs", "scope.contract.json"),
			}),
		);
		fixture.records[duplicate].runId = fixture.runId;
		fixture.records[duplicate].handoffSha256 = fixture.handoffSha256;
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns).toHaveLength(3);
		expect(response.recentRuns.find((run) => run.runDirectory === fixture.formerDirectory)?.completionStatus).toBe(
			"completed",
		);
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.issues.some((issue) => issue.reasonCode === "run_storage_migration_identity_ambiguous")).toBe(
			true,
		);
	});
	it("旧物理目录仍存在时保留两份来源并报告冲突", async () => {
		const fixture = await setupDeletedSourceRunBindingMigration();
		await mkdir(fixture.formerDirectory, { recursive: true });
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns).toHaveLength(2);
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.issues.some((issue) => issue.reasonCode === "run_storage_migration_source_still_exists")).toBe(
			true,
		);
	});
	it.each(["completed", "failed"])("精确绑定且生产方可鉴证时，缺失 summary 不把 %s 降级", async (status) => {
		const fixture = await setup();
		const directory = await fixture.addRun("bound-without-summary", undefined, status, "not_covered");
		fixture.context.boundRuns.push({
			runDirectory: directory,
			runId: "bound-without-summary",
			decisionToken: "token",
		});
		await rm(join(directory, "summary.json"));
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.discoveryStatus).toBe("complete");
		expect(response.issues).toEqual([]);
		expect(response.hasVerifiedCompletedRvf).toBe(status === "completed");
		expect(response.currentCandidateReviewCoverage.status).toBe("not_covered");
	});
	it.each([false, true])("路径别名在正常与恢复分支均只鉴证一轮（summary 损坏：%s）", async (damaged) => {
		const fixture = await setup();
		const directory = await fixture.addRun("path-alias");
		const aliasRoot = join(fixture.root, "equivalent-evidence-path");
		await symlink(fixture.root, aliasRoot, "dir");
		const aliasDirectory = join(aliasRoot, "run-logs", "runs", "path-alias");
		fixture.context.worktreePath = join(aliasRoot, "registered-task-worktree");
		fixture.context.historicalWorktreePaths = [fixture.context.worktreePath];
		fixture.context.boundRuns.push({ runDirectory: aliasDirectory, runId: "path-alias", decisionToken: "token" });
		fixture.records[directory].reportedDirectory = aliasDirectory;
		fixture.records[directory].repositoryPath = fixture.context.worktreePath;
		await writeFile(
			join(directory, "summary.json"),
			damaged
				? "{incomplete"
				: JSON.stringify({
						run_id: "path-alias",
						repo: fixture.context.worktreePath,
						timestamp: 10,
						rvf_scope_contract_path: join(aliasDirectory, "artifacts", "inputs", "scope.contract.json"),
					}),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns.map((run) => run.runDirectory)).toEqual([directory]);
		expect(fixture.inspected).toEqual([directory]);
		expect(response.issues).toEqual([]);
		expect(response.currentCandidateReviewCoverage.status).toBe("covered");
	});
	it("迁移存储根后按本轮工件身份发现，仍排除指向父 run 的子日志", async () => {
		const fixture = await setup();
		const directory = await fixture.addRun("migrated-run");
		const formerDirectory = join(fixture.root, "former-storage", ".claude", "rvf", "runs", "migrated-run");
		await writeFile(join(directory, "artifacts", "handoff.md"), "历史 handoff\n");
		await writeFile(
			join(directory, "summary.json"),
			JSON.stringify({
				run_id: "migrated-run",
				repo: fixture.worktreePath,
				timestamp: 10,
				rvf_scope_contract_path: join(formerDirectory, "artifacts", "inputs", "scope.contract.json"),
				rvf_handoff_path: join(formerDirectory, "artifacts", "handoff.md"),
			}),
		);
		const child = await fixture.addRun("migrated-child-log");
		await writeFile(
			join(child, "summary.json"),
			JSON.stringify({
				run_id: "migrated-child-log",
				repo: fixture.worktreePath,
				timestamp: 20,
				rvf_scope_contract_path: join(formerDirectory, "artifacts", "inputs", "scope.contract.json"),
			}),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns.map((run) => run.runId)).toEqual(["migrated-run"]);
		expect(fixture.inspected).toEqual([directory]);
		expect(response.discoveryStatus).toBe("complete");
	});
	it.each(["candidate", "boundary", "canonical_scope", "nested_native_boundary"])(
		"inplace 的冻结 %s 可独立提供 Task、session 与 token",
		async (bindingLocation) => {
			const fixture = await setup();
			fixture.context.worktreeSharedWithOtherTasks = true;
			const directory = await fixture.addRun("native-snapshot-owned");
			const identity = {
				kanban_task_id: "task",
				worktree: fixture.worktreePath,
				session_id: "frozen-native-session",
				decision_token: "frozen-token",
			};
			const frozenBinding =
				bindingLocation === "candidate"
					? { review_candidate_snapshot: identity }
					: bindingLocation === "boundary"
						? { review_start_boundary_receipt: identity }
						: bindingLocation === "canonical_scope"
							? { canonical_scope: { review_candidate_snapshot: identity } }
							: { review_candidate_snapshot: { native_review_start_boundary_receipt: identity } };
			await writeFile(
				join(directory, "artifacts", "inputs", "scope.contract.json"),
				JSON.stringify({
					run_id: "native-snapshot-owned",
					repo: fixture.worktreePath,
					created_at: 10,
					...frozenBinding,
				}),
			);
			const response = await fixture.query(fixture.scope, { taskId: "task" });
			expect(response.recentRuns).toHaveLength(1);
			expect(response.recentRuns[0]).toMatchObject({
				sessionId: "frozen-native-session",
				decisionToken: "frozen-token",
			});
			expect(response.currentCandidateReviewCoverage.status).toBe("covered");
			expect(response.issues).toEqual([]);
		},
	);
	it.each(["session_id", "decision_token"])("冻结候选与原生边界的 %s 冲突保持未知", async (conflictingField) => {
		const fixture = await setup();
		const directory = await fixture.addRun("conflicting-frozen-native-identity");
		const identity = { kanban_task_id: "task", session_id: "original-session", decision_token: "original-token" };
		await writeFile(
			join(directory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({
				run_id: "conflicting-frozen-native-identity",
				repo: fixture.worktreePath,
				created_at: 10,
				review_candidate_snapshot: {
					...identity,
					native_review_start_boundary_receipt: { ...identity, [conflictingField]: "conflicting-value" },
				},
			}),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.issues.some((issue) => issue.reasonCode === "run_ownership_binding_mismatch")).toBe(true);
	});
	it.each(["sessionId", "decisionToken"] as const)("生产方 %s 必须匹配本轮冻结身份", async (conflictingField) => {
		const fixture = await setup();
		const directory = await fixture.addRun("producer-conflicting-native-identity");
		await writeFile(
			join(directory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({
				run_id: "producer-conflicting-native-identity",
				repo: fixture.worktreePath,
				created_at: 10,
				review_candidate_snapshot: {
					kanban_task_id: "task",
					session_id: "original-session",
					decision_token: "original-token",
				},
			}),
		);
		fixture.records[directory][conflictingField] = "conflicting-value";
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.issues.some((issue) => issue.reasonCode === "producer_run_identity_invalid")).toBe(true);
	});
	it("已删除历史 worktree 的父目录别名仍可归属，历史完成与当前覆盖独立", async () => {
		const fixture = await setup();
		const historicalWorktree = join(fixture.root, "removed-task-worktree");
		const directory = await fixture.addRun("removed-historical-worktree", historicalWorktree, "completed", "unknown");
		const aliasRoot = join(fixture.root, "historical-parent-directory-alias");
		await symlink(fixture.root, aliasRoot, "dir");
		fixture.context.historicalWorktreePaths.push(join(aliasRoot, "removed-task-worktree"));
		fixture.records[directory].repositoryPath = join(aliasRoot, "removed-task-worktree");
		const originalScope = await readFile(join(directory, "artifacts", "inputs", "scope.contract.json"));
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBe(true);
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.discoveryStatus).toBe("complete");
		expect(await readFile(join(directory, "artifacts", "inputs", "scope.contract.json"))).toEqual(originalScope);
	});
	it("精确 run 绑定不能掩盖本轮冻结仓库已指向其他项目", async () => {
		const fixture = await setup();
		const directory = await fixture.addRun("bound-foreign-frozen-repository", join(fixture.root, "foreign-project"));
		fixture.context.boundRuns.push({
			runDirectory: directory,
			runId: "bound-foreign-frozen-repository",
			decisionToken: "token",
		});
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.issues.some((issue) => issue.reasonCode === "run_ownership_binding_mismatch")).toBe(true);
	});
	it("生产方 worktree 必须匹配该 run 的冻结路径，不能只匹配 Task 的其他历史路径", async () => {
		const fixture = await setup();
		const directory = await fixture.addRun("producer-other-known-task-worktree");
		const otherTaskWorktree = join(fixture.root, "other-historical-task-worktree");
		fixture.context.historicalWorktreePaths.push(otherTaskWorktree);
		fixture.records[directory].repositoryPath = otherTaskWorktree;
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.issues.some((issue) => issue.reasonCode === "producer_run_identity_invalid")).toBe(true);
	});
	it("冻结快照与独立 receipt 的 Task 冲突保留未知，不能静默遗漏", async () => {
		const fixture = await setup();
		fixture.context.worktreeSharedWithOtherTasks = true;
		const directory = await fixture.addRun("conflicting-task-bindings");
		await writeFile(
			join(directory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({
				run_id: "conflicting-task-bindings",
				repo: fixture.worktreePath,
				created_at: 10,
				review_candidate_snapshot: { kanban_task_id: "task", worktree: fixture.worktreePath },
			}),
		);
		await mkdir(join(directory, "inputs"));
		await writeFile(
			join(directory, "inputs", "automatic-closeout-review-start-receipt.json"),
			JSON.stringify({ kanban_task_id: "another-task", worktree: fixture.worktreePath }),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.issues.some((issue) => issue.reasonCode === "run_ownership_binding_mismatch")).toBe(true);
	});
	it("summary 仓库陈旧但冻结 scope 属于本 Task 时进入冲突鉴证", async () => {
		const fixture = await setup();
		const directory = await fixture.addRun("stale-summary-repository");
		await writeFile(
			join(directory, "summary.json"),
			JSON.stringify({
				run_id: "stale-summary-repository",
				repo: join(fixture.root, "unrelated-repository"),
				timestamp: 10,
				rvf_scope_contract_path: join(directory, "artifacts", "inputs", "scope.contract.json"),
			}),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(fixture.inspected).toEqual([directory]);
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.discoveryStatus).toBe("partial");
		expect(response.issues.some((issue) => issue.reasonCode === "run_ownership_binding_mismatch")).toBe(true);
	});
	it("冻结开审时间隔离重建 Task，并且不按被重写的 summary 时间排序", async () => {
		const fixture = await setup();
		fixture.context.taskCreatedAt = 100;
		for (const [name, openedAt, touchedAt] of [
			["old-incarnation", 10, 1000],
			["newer-opening", 300, 101],
			["earlier-opening", 200, 900],
		] as const) {
			const directory = await fixture.addRun(name, undefined, "completed", "covered", openedAt);
			await writeFile(
				join(directory, "summary.json"),
				JSON.stringify({
					run_id: name,
					repo: fixture.worktreePath,
					timestamp: touchedAt,
					rvf_scope_contract_path: join(directory, "artifacts", "inputs", "scope.contract.json"),
				}),
			);
		}
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns.map((run) => [run.runId, run.startedAt])).toEqual([
			["newer-opening", 300],
			["earlier-opening", 200],
		]);
		expect(fixture.inspected).not.toContain(join(fixture.runsDirectory, "old-incarnation"));
	});
	it("没有稳定开审时间时不能用新 summary 证明属于本代 Task", async () => {
		const fixture = await setup();
		fixture.context.taskCreatedAt = 100;
		const directory = await fixture.addRun("unknown-incarnation", undefined, "completed", "covered", 1000);
		await writeFile(
			join(directory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({ run_id: "unknown-incarnation", repo: fixture.worktreePath }),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		expect(response.issues.some((issue) => issue.reasonCode === "run_start_time_unavailable")).toBe(true);
	});
	it("旧 summary 缺失 repo 时自动读取 scope 归属，其他项目与辅助日志不污染结果", async () => {
		const fixture = await setup();
		const own = await fixture.addRun("legacy-owned");
		await writeFile(join(own, "summary.json"), JSON.stringify({ run_id: "legacy-owned", repo: null }));
		const foreign = await fixture.addRun("legacy-foreign", join(fixture.root, "other-project"));
		await writeFile(join(foreign, "summary.json"), JSON.stringify({ run_id: "legacy-foreign", repo: null }));
		const auxiliary = join(fixture.runsDirectory, "reviewer-log-without-subject");
		await mkdir(auxiliary);
		await writeFile(join(auxiliary, "summary.json"), JSON.stringify({ run_id: "auxiliary", repo: null }));
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns.map((run) => run.runId)).toEqual(["legacy-owned"]);
		expect(response.discoveryStatus).toBe("complete");
		expect(response.issues).toEqual([]);
	});
	it("当前鉴证缺失不撤销服务端以前接受的两阶段完成事实", async () => {
		const fixture = await setup();
		const directory = await fixture.addRun("previously-accepted", undefined, "unknown", "unknown");
		fixture.context.boundRuns.push({
			runDirectory: directory,
			runId: "previously-accepted",
			decisionToken: "token",
			record: {
				createdAt: 10,
				status: "completed",
				receipt: { session_id: "original-session" },
				handoffPath: join(directory, "artifacts/handoff.md"),
				handoffSha256: "a".repeat(64),
				landExecutionResult: { outcome: "completed", commitSha: "b".repeat(40), reportedAt: 20 },
				baseBranchSyncExecutionResult: {
					outcome: "completed",
					commitSha: "b".repeat(40),
					baseRef: "main",
					reportedAt: 21,
				},
			},
		});
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBe(true);
		expect(response.mostRecentVerifiedCompletedRun?.completionEvidenceSource).toBe(
			"kanban_server_accepted_closeout_record",
		);
		expect(response.currentCandidateReviewCoverage.status).toBe("unknown");
		fixture.context.taskCreatedAt = 100;
		const reusedTaskId = await fixture.query(fixture.scope, { taskId: "task" });
		expect(reusedTaskId.hasVerifiedCompletedRvf).toBe(false);
		expect(reusedTaskId.recentRuns).toEqual([]);
	});
	it("普通 run 无收尾记录也可发现，旧完成轮次不被分页或新运行遮蔽", async () => {
		const fixture = await setup();
		const oldRun = await fixture.addRun("old-completed", undefined, "completed", "covered", 10);
		await fixture.addRun("new-running", undefined, "in_progress", "unknown", 20);
		const first = await fixture.query(fixture.scope, { taskId: "task", limit: 1 });
		expect(first.hasVerifiedCompletedRvf).toBe(true);
		expect(first.mostRecentVerifiedCompletedRun?.runDirectory).toBe(oldRun);
		expect(first.recentRuns.map((run) => run.runId)).toEqual(["new-running"]);
		expect(first.currentCandidateReviewCoverage.status).toBe("covered");
		const second = await fixture.query(fixture.scope, { taskId: "task", cursor: first.nextCursor, limit: 1 });
		expect(second.recentRuns.map((run) => run.runId)).toEqual(["old-completed"]);
	});
	it("隔离其他项目、reviewer 子运行和错误 Task receipt", async () => {
		const fixture = await setup();
		await fixture.addRun("ours");
		await fixture.addRun("foreign", join(fixture.root, "foreign-task-worktree"));
		await fixture.addRun("reviewer-child", join(fixture.root, "reviewer-worktree"));
		const child = await fixture.addRun("same-worktree-reviewer");
		await writeFile(
			join(child, "summary.json"),
			JSON.stringify({
				run_id: "child",
				repo: fixture.worktreePath,
				rvf_scope_contract_path: join(fixture.runsDirectory, "ours", "artifacts/inputs/scope.contract.json"),
			}),
		);
		const wrongReceipt = await fixture.addRun("wrong-task-receipt");
		await mkdir(join(wrongReceipt, "inputs"));
		await writeFile(
			join(wrongReceipt, "inputs", "automatic-closeout-review-start-receipt.json"),
			JSON.stringify({ kanban_task_id: "another-task" }),
		);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.recentRuns.map((run) => run.runId)).toEqual(["ours"]);
		expect(fixture.inspected).toHaveLength(1);
	});
	it("工件未知不能写成没有 RVF，历史完成与当前内容改变分别返回", async () => {
		const fixture = await setup();
		await fixture.addRun("missing-evidence", undefined, "unknown", "unknown");
		const unknown = await fixture.query(fixture.scope, { taskId: "task" });
		expect(unknown.hasVerifiedCompletedRvf).toBeNull();
		expect(unknown.currentCandidateReviewCoverage.status).toBe("unknown");
		await fixture.addRun("completed-old-content", undefined, "completed", "not_covered", 20);
		const changed = await fixture.query(fixture.scope, { taskId: "task" });
		expect(changed.hasVerifiedCompletedRvf).toBe(true);
		expect(changed.currentCandidateReviewCoverage.status).toBe("unknown");
	});
	it("只有完整发现才能返回 false，分页 cursor 不能跨项目复用", async () => {
		const fixture = await setup();
		await mkdir(fixture.runsDirectory, { recursive: true });
		await mkdir(join(fixture.runsDirectory, "old-hook-event-only", "artifacts"), { recursive: true });
		await writeFile(join(fixture.runsDirectory, "old-hook-event-only", "events.jsonl"), "仅有 hook 诊断事件\n");
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBe(false);
		expect(response.discoveryStatus).toBe("complete");
		expect(response.issues).toEqual([]);
		await fixture.addRun("one");
		await fixture.addRun("two");
		const page = await fixture.query(fixture.scope, { taskId: "task", limit: 1 });
		await expect(
			fixture.query({ ...fixture.scope, workspaceId: "other-project" }, { taskId: "task", cursor: page.nextCursor }),
		).rejects.toThrow("cursor");
	});
	it("损坏 summary 可恢复归属，未获完成鉴证时保持未知且不改写 run", async () => {
		const fixture = await setup();
		const directory = await fixture.addRun("invalid-summary", undefined, "unknown", "unknown");
		const path = join(directory, "summary.json");
		await writeFile(path, "{incomplete");
		const before = await readFile(path);
		const response = await fixture.query(fixture.scope, { taskId: "task" });
		expect(response.hasVerifiedCompletedRvf).toBeNull();
		expect(await readFile(path)).toEqual(before);
		expect(response.recentRuns[0].recoveryCondition).toBeTruthy();
	});
});
