import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { afterEach, expect, it, vi } from "vitest";
import {
	type RvfAutomaticCloseoutRecord,
	rvfAutomaticCloseoutStatusResponseSchema,
} from "../../src/core/rvf-automatic-closeout-contract";
import { taskRvfHistoryResponseSchema } from "../../src/core/task-rvf-history-contract";
import { computeRvfTextSha256 } from "../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { createRvfAutomaticCloseoutRuntimeService } from "../../src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service";
import {
	getRvfAutomaticCloseoutStorePath,
	updateRvfAutomaticCloseoutRecords,
} from "../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import {
	getPersistedWorkspaceBoardFilePathById,
	loadWorkspaceContext,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { type RuntimeAppRouter, type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createSupplementalCompletionVerificationProtocolFixture } from "../utilities/rvf-supplemental-completion-verification-protocol-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const requireFromHere = createRequire(import.meta.url);
afterEach(() => vi.unstubAllEnvs());

it.each([
	{ executableSelection: "用户默认 shim", useExplicitExecutableOverride: false },
	{ executableSelection: "显式覆盖", useExplicitExecutableOverride: true },
])(
	"自定义 RVF_HOME 时通过$executableSelection直接执行鉴证程序",
	{ timeout: 30_000 },
	async ({ useExplicitExecutableOverride }) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const customRvfDataRoot = join(fixture.fixtureRootDirectoryPath, "custom-rvf-data-root");
		const installedShimPath = join(fixture.isolatedHomeDirectoryPath, ".rvf", "bin", "rvf");
		const explicitlyOverriddenExecutablePath = join(fixture.fixtureRootDirectoryPath, "显式鉴证程序 路径.cjs");
		const producerScript = `#!${process.execPath}
process.stdout.write(JSON.stringify({
  executablePath: process.argv[1],
  arguments: process.argv.slice(2),
  rvfHome: process.env.RVF_HOME,
}));
`;
		await mkdir(customRvfDataRoot, { recursive: true });
		await mkdir(join(fixture.isolatedHomeDirectoryPath, ".rvf", "bin"), { recursive: true });
		for (const executablePath of [installedShimPath, explicitlyOverriddenExecutablePath]) {
			await writeFile(executablePath, producerScript);
			await chmod(executablePath, 0o700);
		}
		const inspectionArguments = [
			"inspect",
			"run-review-evidence",
			"--project-path",
			join(fixture.fixtureRootDirectoryPath, "包含空格 '引号' ; $(字面值) 的项目"),
			"--run-dir",
			join(customRvfDataRoot, "run-logs", "runs", "exact-run"),
			"--json",
		];
		const invocationRunnerPath = join(
			fixture.fixtureRootDirectoryPath,
			"task-rvf-history-producer-invocation-runner.mjs",
		);
		const queryServiceModuleUrl = pathToFileURL(
			resolve("src/rvf-task-review-history/task-rvf-history-query-service.ts"),
		);
		await writeFile(
			invocationRunnerPath,
			`import { queryRvfReadOnlyInspectionProducer } from ${JSON.stringify(queryServiceModuleUrl.href)};
const result = await queryRvfReadOnlyInspectionProducer(${JSON.stringify(inspectionArguments)}, 10_000);
process.stdout.write(JSON.stringify(result));
`,
		);
		const result = await new Promise<unknown>((accept, reject) => {
			const child = execFile(
				process.execPath,
				["--import", pathToFileURL(requireFromHere.resolve("tsx")).href, invocationRunnerPath],
				{
					timeout: 20_000,
					env: fixture.createIsolatedChildProcessEnvironment({
						RVF_HOME: customRvfDataRoot,
						KANBAN_RVF_INSPECTION_EXECUTABLE_PATH: useExplicitExecutableOverride
							? explicitlyOverriddenExecutablePath
							: undefined,
					}),
				},
				(error, stdout, stderr) => {
					if (error) return reject(new Error(`隔离鉴证程序调用失败：${stderr}`));
					try {
						accept(JSON.parse(stdout));
					} catch (failure) {
						reject(failure);
					}
				},
			);
			childProcesses.register(child);
		});
		expect(result).toEqual({
			executablePath: useExplicitExecutableOverride ? explicitlyOverriddenExecutablePath : installedShimPath,
			arguments: inspectionArguments,
			rvfHome: customRvfDataRoot,
		});
	},
);

async function verifyHistoricalCompletionThroughCliAndTrpc(completionProofKind: string) {
	const baseIntegrationPending = completionProofKind === "supplemental_base_pending";
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const projectPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "rvf-history-project");
	await mkdir(projectPath, { recursive: true });
	const repository = fixture.createNonBareRepositoryAtOwnedPath({
		repositoryPath: projectPath,
		initialBranchName: "main",
	});
	await writeFile(join(projectPath, "implementation.txt"), "已审阅的候选\n");
	repository.commitAllRepositoryFilesAtDate({
		message: "测试候选",
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
							title: "查询历史",
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
	const runRoot = join(fixture.fixtureRootDirectoryPath, "rvf-run-logs");
	const runDirectory = join(runRoot, "runs", "completed-run");
	await mkdir(join(runDirectory, "inputs"), { recursive: true });
	await mkdir(join(runDirectory, "artifacts", "inputs"), { recursive: true });
	await writeFile(
		join(runDirectory, "artifacts", "inputs", "scope.contract.json"),
		JSON.stringify({ run_id: "completed-run", repo: projectPath, created_at: 10, base_ref: "main" }),
	);
	await writeFile(
		join(runDirectory, "summary.json"),
		JSON.stringify({
			run_id: "completed-run",
			repo: projectPath,
			timestamp: 10,
			rvf_scope_contract_path: join(runDirectory, "artifacts/inputs/scope.contract.json"),
		}),
	);
	await writeFile(
		join(runDirectory, "inputs", "automatic-closeout-review-start-receipt.json"),
		JSON.stringify({ kanban_task_id: "abc12" }),
	);
	const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-home");
	vi.stubEnv("RVF_HOME", rvfHome);
	const head = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
	const gitDirectory = repository.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
	const token = "0123456789abcdef";
	const handoffPath = join(runDirectory, "artifacts", "handoff.md");
	await writeFile(handoffPath, "已完成的历史 RVF\n");
	const handoffSha256 = computeRvfTextSha256(await readFile(handoffPath));
	const receipt: RvfAutomaticCloseoutRecord["receipt"] = {
		schema: "rvf-independent-user-turn-boundary/v1",
		decision_token: token,
		session_id: "historical-native",
		worktree: projectPath,
		native_user_message_id: "boundary-message",
		native_turn_id: "boundary-turn",
		transcript_path: join(fixture.fixtureRootDirectoryPath, "historical.jsonl"),
		boundary_message_sha256: "a".repeat(64),
		candidate_fingerprint: "historical-candidate",
		worktree_head_commit_sha: head,
		checkpoint_commit: head,
		checkpoint_tree: repository.runGit(["rev-parse", "HEAD^{tree}"]).stdout.trim(),
		comparison_base_tip: head,
		comparison_base_ref: "main",
		comparison_base_ref_tip: head,
		source: "explicit_user_command",
		kanban_task_id: "abc12",
		idempotency_key: "historical-closeout-boundary",
	};
	const record: RvfAutomaticCloseoutRecord = {
		workspaceId: workspace.workspaceId,
		taskId: "abc12",
		conversationSessionId: "abc12",
		receipt,
		preReviewTurnIds: ["implementation"],
		status: "paused",
		createdAt: 10,
		updatedAt: 20,
		runId: "completed-run",
		runDirectory,
		handoffPath,
		handoffSha256,
		restoredNativeSessionId: "restored-native",
		restoredTranscriptPath: null,
		restoreWorkspaceStateSha256: null,
		nativeIdentitySwitchStartedAt: null,
		nativeForkAttemptStartedAt: null,
		pauseReason: "收尾投递失败：submit_confirmation_budget_exhausted",
		promptDeliveryIdempotencyKey: "historical-closeout-delivery",
		baseBranchSyncExecutionResult: { outcome: "blocked", reason: "旧未分类结果", reportedAt: 15 },
	};
	await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(workspace.workspaceId), () => ({
		records: [record],
		value: undefined,
	}));
	const notificationDirectory = join(rvfHome, "automatic-closeout-completion-notifications");
	const bindingDirectory = join(rvfHome, "review-start-independent-user-turn-boundary-receipts");
	await mkdir(notificationDirectory, { recursive: true });
	await mkdir(bindingDirectory, { recursive: true });
	await writeFile(
		join(notificationDirectory, `${token}.json`),
		JSON.stringify({
			schema: "rvf-automatic-closeout-completion/v1",
			decision_token: token,
			session_id: receipt.session_id,
			worktree: projectPath,
			run_id: record.runId,
			run_dir: runDirectory,
			handoff_path: handoffPath,
			handoff_sha256: handoffSha256,
		}),
	);
	await writeFile(
		join(bindingDirectory, `${token}.run-binding.json`),
		JSON.stringify({
			run_id: record.runId,
			run_dir: runDirectory,
			receipt_sha256: computeRvfTextSha256(
				JSON.stringify(
					Object.fromEntries(
						Object.entries(receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
					),
				),
			),
		}),
	);
	await writeFile(
		join(runDirectory, "artifacts", ".finalize.lock"),
		JSON.stringify({
			run_id: record.runId,
			run_dir: runDirectory,
			repo: projectPath,
			decision_kind: "handoff",
			completed_at: "2026-01-01T00:00:01Z",
			errors: [],
		}),
	);
	const candidatePath = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
	await mkdir(join(gitDirectory, "rvf", "evidence"), { recursive: true });
	const candidate = JSON.stringify({
		subject: { head_oid: head, worktree_realpath: projectPath, git_common_dir_realpath: gitDirectory },
		review: { run_id: record.runId, protocol_valid: true },
	});
	await writeFile(candidatePath, candidate);
	await writeFile(`${candidatePath}.sha256`, computeRvfTextSha256(candidate));
	const canonical = JSON.stringify({
		run_id: record.runId,
		run_dir: runDirectory,
		repo_root: projectPath,
		head_oid_after_commit: head,
		result: {
			exit_code: 0,
			commit_oid: head,
			candidate_evidence: { status: "written", candidate_evidence_sha256: computeRvfTextSha256(candidate) },
			round_baseline_seal: { sealed: true },
		},
	});
	await writeFile(join(runDirectory, "artifacts", "rvf-land-commit-result.json"), canonical);
	await mkdir(join(runDirectory, "artifacts", "rvf-land-commit-execution-results"));
	await writeFile(
		join(runDirectory, "artifacts", "rvf-land-commit-execution-results", `${computeRvfTextSha256(canonical)}.json`),
		canonical,
	);
	const supplementalProtocol =
		completionProofKind !== "canonical"
			? await createSupplementalCompletionVerificationProtocolFixture({
					record,
					targetCommitSha: head,
					targetTreeSha: repository.runGit(["rev-parse", "HEAD^{tree}"]).stdout.trim(),
					gitCommonDirectoryRealpath: gitDirectory,
					fixtureRootDirectoryPath: fixture.fixtureRootDirectoryPath,
				})
			: null;
	if (supplementalProtocol) {
		await rm(join(runDirectory, "artifacts", "rvf-land-commit-result.json"));
		await rm(candidatePath);
		await rm(`${candidatePath}.sha256`);
	}
	// 本用例验证进程与 HTTP 契约；canonical 完成判据在 RVF 的真实 Python 回归中验证。
	const producer = join(fixture.fixtureRootDirectoryPath, "rvf-read-only-inspection-protocol-fixture.cjs");
	await writeFile(
		producer,
		`#!${process.execPath}
const args=process.argv.slice(2);
${supplementalProtocol?.protocolScriptBody ?? ""}
const result=args[1]==='storage-paths'?{schema:'rvf-storage-paths/v1',run_logs_root:${JSON.stringify(runRoot)},rvf_home:${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "rvf-home"))}}:{schema:'rvf-run-review-evidence/v1',runs:[{run_id:'completed-run',run_directory:${JSON.stringify(runDirectory)},repository_path:${JSON.stringify(projectPath)},kanban_task_id:'abc12',review_completion_status:'completed',completion_evidence_source:'canonical_review_artifacts',handoff_sha256:'a'.repeat(64),reviewed_candidate_content_manifest_sha256:'b'.repeat(64),reason_code:'canonical_review_completed',current_candidate_coverage:{status:'covered',reason_code:'candidate_evidence_eligible'}}]};
process.stdout.write(JSON.stringify(result));
`,
	);
	await chmod(producer, 0o700);
	vi.stubEnv("KANBAN_RVF_INSPECTION_EXECUTABLE_PATH", producer);
	if (baseIntegrationPending) repository.runGit(["branch", "--move", "historical-task-target"]);
	const originalBoard = await readFile(getPersistedWorkspaceBoardFilePathById(workspace.workspaceId));
	const originalSummary = await readFile(join(runDirectory, "summary.json"));
	const originalGit = repository.runGit(["status", "--porcelain=v2"]).stdout;
	const originalRefs = repository.runGit(["show-ref"]).stdout;
	const rejectUnexpectedSessionOperation = vi.fn((): never => {
		throw new Error("暂无会话的历史查询不能操作 Agent");
	});
	const getManager = vi.fn(async () => {
		// base 未完成时允许读取“暂无会话”的摘要，不创建或恢复进程。
		if (baseIntegrationPending)
			return {
				listSummaries: () => [],
				getSummary: rejectUnexpectedSessionOperation,
				isTaskSessionAutomaticContinuationSuppressed: rejectUnexpectedSessionOperation,
				getAwaitingDispatchedBackgroundWork: rejectUnexpectedSessionOperation,
				resolveTaskTerminalInputBoxOccupancy: rejectUnexpectedSessionOperation,
				getTaskTerminalInputSideMutationSnapshot: rejectUnexpectedSessionOperation,
				forceStopTaskSession: rejectUnexpectedSessionOperation,
				applyAgentNativeConversationSessionIdentity: rejectUnexpectedSessionOperation,
				publishRvfAutomaticCloseoutPaused: vi.fn(),
				publishRvfAutomaticCloseoutWaiting: vi.fn(),
			};
		throw new Error("已完成状态无需恢复 Agent");
	});
	function makeServer() {
		const closeout = createRvfAutomaticCloseoutRuntimeService({
			getManager,
			runtimeApi: {} as Parameters<typeof createRvfAutomaticCloseoutRuntimeService>[0]["runtimeApi"],
			listWorkspaces: async () => [{ workspaceId: workspace.workspaceId, workspacePath: projectPath }],
			warn: () => undefined,
		});
		return createServer(
			createHTTPHandler({
				basePath: "/api/trpc/",
				router: runtimeAppRouter,
				createContext: ({ req }) =>
					({
						requestedWorkspaceId: req.headers["x-kanban-workspace-id"] ?? null,
						workspaceScope: { workspaceId: workspace.workspaceId, workspacePath: projectPath },
						rvfAutomaticCloseoutApi: closeout,
						kanbanRequestOriginActorEvidence: {
							decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
						},
					}) as unknown as RuntimeTrpcContext,
			}),
		);
	}
	let server = makeServer();
	async function listen() {
		await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("隔离 HTTP 未分配端口。");
		return address.port;
	}
	async function runCli(port: number, command = "rvf-history") {
		return await new Promise<unknown>((accept, reject) => {
			const child = execFile(
				process.execPath,
				[
					"--import",
					pathToFileURL(requireFromHere.resolve("tsx")).href,
					resolve("src/cli.ts"),
					"task",
					command,
					"--task-id",
					"abc12",
					"--project-path",
					projectPath,
				],
				{
					timeout: 35_000,
					env: fixture.createIsolatedChildProcessEnvironment({
						KANBAN_RUNTIME_HOST: "127.0.0.1",
						KANBAN_RUNTIME_PORT: String(port),
						KANBAN_TASK_ID: "abc12",
						KANBAN_PROJECT_PATH: projectPath,
						KANBAN_RVF_INSPECTION_EXECUTABLE_PATH: producer,
						KANBAN_CLI_HARD_TIMEOUT_MS: "35000",
					}),
				},
				(error, stdout, stderr) => {
					if (error) return reject(new Error(`隔离 CLI 失败：${stderr}`));
					try {
						accept(JSON.parse(stdout));
					} catch (failure) {
						reject(failure);
					}
				},
			);
			childProcesses.register(child);
		});
	}
	try {
		const port = await listen();
		const status = rvfAutomaticCloseoutStatusResponseSchema.parse(
			await runCli(port, "rvf-automatic-closeout-status"),
		);
		expect(status.records[0]?.status).toBe(baseIntegrationPending ? "paused" : "completed");
		expect(status.records[0]?.executionResultReportHistory?.map((entry) => entry.outcome)).toEqual(
			baseIntegrationPending ? ["blocked", "completed"] : ["blocked", "completed", "completed"],
		);
		const client = createTRPCProxyClient<RuntimeAppRouter>({
			links: [
				httpBatchLink({
					url: `http://127.0.0.1:${port}/api/trpc`,
					headers: { "x-kanban-workspace-id": workspace.workspaceId },
				}),
			],
		});
		const api = await client.runtime.getTaskRvfHistory.query({ taskId: "abc12" });
		expect(api.hasVerifiedCompletedRvf).toBe(true);
		expect(api.currentCandidateReviewCoverage.status).toBe(supplementalProtocol ? "unknown" : "covered");
		if (supplementalProtocol) {
			expect(api.mostRecentVerifiedCompletedRun?.completedAt).toBe(
				status.records[0]?.landExecutionResult?.reportedAt,
			);
			expect(status.records[0]?.landExecutionResult?.verificationBasis).toBe(
				"verified_supplemental_land_completion",
			);
			expect(api.mostRecentVerifiedCompletedRun?.completionEvidenceSource).toBe(
				"kanban_server_verified_supplemental_land_completion",
			);
			expect(api.mostRecentVerifiedCompletedRun?.landExecutionResult).toEqual(
				status.records[0]?.landExecutionResult,
			);
		}
		expect(api.mostRecentVerifiedCompletedRun?.baseBranchSyncExecutionResult).toEqual(
			status.records[0]?.baseBranchSyncExecutionResult,
		);
		expect(taskRvfHistoryResponseSchema.parse(await runCli(port)).querySource).toBe("runtime");
		await new Promise<void>((accept) => server.close(() => accept()));
		const offline = taskRvfHistoryResponseSchema.parse(await runCli(port));
		expect(offline.querySource).toBe("durable_filesystem_fallback");
		expect(offline.hasVerifiedCompletedRvf).toBe(true);
		server = makeServer();
		const restarted = taskRvfHistoryResponseSchema.parse(await runCli(await listen()));
		expect(restarted.mostRecentVerifiedCompletedRun?.runId).toBe("completed-run");
		expect(restarted.mostRecentVerifiedCompletedRun?.baseBranchSyncExecutionResult).toEqual(
			status.records[0]?.baseBranchSyncExecutionResult,
		);
		if (!baseIntegrationPending) expect(getManager).not.toHaveBeenCalled();
		expect(rejectUnexpectedSessionOperation).not.toHaveBeenCalled();
		expect(await readFile(getPersistedWorkspaceBoardFilePathById(workspace.workspaceId))).toEqual(originalBoard);
		expect(await readFile(join(runDirectory, "summary.json"))).toEqual(originalSummary);
		expect(repository.runGit(["status", "--porcelain=v2"]).stdout).toBe(originalGit);
		expect(repository.runGit(["show-ref"]).stdout).toBe(originalRefs);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((accept) => server.close(() => accept()));
	}
}

const historicalCompletionProofKinds = ["canonical", "supplemental", "supplemental_base_pending"];
it.each(historicalCompletionProofKinds)(
	"CLI/tRPC 持久消费 %s 完成事实",
	verifyHistoricalCompletionThroughCliAndTrpc,
	100_000,
);
