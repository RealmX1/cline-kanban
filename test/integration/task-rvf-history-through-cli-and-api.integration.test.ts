import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { afterEach, expect, it, vi } from "vitest";
import { queryTaskRvfHistoryForCli } from "../../src/commands/task-rvf-history";
import { createTaskRvfHistoryQueryService } from "../../src/rvf-task-review-history/task-rvf-history-query-service";
import { getWorkspaceDirectoryPath, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { type RuntimeAppRouter, type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

afterEach(() => vi.unstubAllEnvs());

it("旧完成、失败、未完成和缺损记录经 API、CLI 与离线重建只读展示，不调用生产方", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.fixtureRootDirectoryPath, "codex-configuration"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.fixtureRootDirectoryPath, "codex-storage"));
	const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "history-main" });
	const projectPath = repository.repositoryPath;
	await writeFile(join(projectPath, "README.md"), "历史读取隔离测试\n");
	repository.commitAllRepositoryFilesAtDate({
		message: "初始化历史查询项目",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "abc12",
							title: "历史",
							prompt: "只读",
							baseRef: "main",
							startInPlanMode: true,
							worktreeMode: "inplace",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		},
		sessions: {},
	});
	const workspace = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: false });
	const scope = { workspaceId: workspace.workspaceId, workspacePath: projectPath };
	const runRoot = join(fixture.fixtureRootDirectoryPath, "historical-rvf-run-logs");
	vi.stubEnv("CODEX_RVF_LOG_ROOT", runRoot);
	// 若查询尝试调用旧生产方，记录可执行文件必然触发失败；实际查询完全不读取它。
	vi.stubEnv("KANBAN_RVF_INSPECTION_EXECUTABLE_PATH", join(fixture.fixtureRootDirectoryPath, "must-never-execute"));
	const records = [];
	for (const [index, status] of ["completed", "failed", "in_progress"].entries()) {
		const runDirectory = join(runRoot, "runs", `historical-${status}`);
		await mkdir(join(runDirectory, "artifacts", "inputs"), { recursive: true });
		await writeFile(
			join(runDirectory, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({
				run_id: `historical-${status}`,
				repo: projectPath,
				created_at: 10 + index,
				review_candidate_snapshot: {
					kanban_task_id: "abc12",
					worktree: projectPath,
					session_id: "original-session",
					decision_token: status,
				},
			}),
		);
		await writeFile(
			join(runDirectory, "summary.json"),
			JSON.stringify({ run_id: `historical-${status}`, repo: projectPath, status, timestamp: 10 + index }),
		);
		records.push({
			workspaceId: scope.workspaceId,
			taskId: "abc12",
			createdAt: 10 + index,
			status,
			runId: `historical-${status}`,
			runDirectory,
			receipt: {
				session_id: "original-session",
				worktree: projectPath,
				kanban_task_id: "abc12",
				decision_token: status,
			},
			handoffPath: join(runDirectory, "artifacts", "handoff.md"),
			handoffSha256: "a".repeat(64),
			promptDeliveryAttempts: [
				{
					status: status === "completed" ? "delivered_and_submit_confirmed" : "delivery_failed",
					failureDetail: "原始投递事实",
				},
			],
			landExecutionResult: {
				outcome: status === "completed" ? "completed" : "blocked",
				commitSha: "b".repeat(40),
				reportedAt: 20,
			},
			baseBranchSyncExecutionResult: {
				outcome: status === "completed" ? "completed" : "blocked",
				commitSha: "b".repeat(40),
				baseRef: "main",
				reportedAt: 21,
			},
		});
	}
	const storePath = join(
		getWorkspaceDirectoryPath(scope.workspaceId),
		"rvf-automatic-rewind-and-closeout-records.json",
	);
	const original = JSON.stringify(
		[...records, { workspaceId: scope.workspaceId, taskId: "abc12", status: "damaged" }],
		null,
		2,
	);
	await writeFile(storePath, original);
	const digest = () => readFile(storePath).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
	const before = await digest();
	const server = createServer(
		createHTTPHandler({
			router: runtimeAppRouter,
			createContext: () =>
				({
					requestedWorkspaceId: scope.workspaceId,
					workspaceScope: scope,
					kanbanRequestOriginActorEvidence: {
						decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
					},
				}) as RuntimeTrpcContext,
		}),
	);
	await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("未分配端口");
		const client = createTRPCProxyClient<RuntimeAppRouter>({
			links: [httpBatchLink({ url: `http://127.0.0.1:${address.port}` })],
		});
		const viaApi = await client.runtime.getTaskRvfHistory.query({ taskId: "abc12" });
		const viaCli = await queryTaskRvfHistoryForCli({
			taskId: "abc12",
			projectPath,
			queryRuntime: (_id, input) => client.runtime.getTaskRvfHistory.query(input),
		});
		const offline = await queryTaskRvfHistoryForCli({
			taskId: "abc12",
			projectPath,
			queryRuntime: async () => {
				throw new Error("运行时离线");
			},
		});
		const restarted = await createTaskRvfHistoryQueryService()(scope, { taskId: "abc12" });
		for (const result of [viaApi, viaCli, offline, restarted]) {
			expect(result.hasVerifiedCompletedRvf).toBe(true);
			expect(result.discoveryStatus).toBe("partial");
			expect(result.issues.some((issue) => issue.reasonCode === "closeout_record_invalid")).toBe(true);
			expect(result.currentCandidateReviewCoverage.status).toBe("unknown");
			expect(result.recentRuns.map((run) => run.completionStatus).sort()).toEqual(
				["completed", "failed", "in_progress"].sort(),
			);
			expect(
				result.recentRuns.find((run) => run.completionStatus === "failed")?.historicalCloseoutRecord
					?.promptDeliveryAttempts,
			).toEqual(records[1].promptDeliveryAttempts);
		}
		expect(offline.querySource).toBe("durable_filesystem_fallback");
		for (const procedure of [
			"captureRvfReviewStartBoundary",
			"observeRvfReviewStartBoundary",
			"activateRvfAutomaticCloseoutAfterRunBinding",
			"rvfAutomaticCloseoutStatus",
			"reconcileRvfAutomaticCloseoutLateNativePromptAcceptance",
			"claimRvfAutomaticCloseoutExecutionStage",
			"reportRvfAutomaticCloseoutExecutionResult",
		])
			expect(runtimeAppRouter._def.procedures).not.toHaveProperty(`runtime.${procedure}`);
		expect(await digest()).toBe(before);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((accept) => server.close(() => accept()));
	}
});
