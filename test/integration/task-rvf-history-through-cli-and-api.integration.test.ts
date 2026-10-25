import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { afterEach, expect, it, vi } from "vitest";
import { taskRvfHistoryResponseSchema } from "../../src/core/task-rvf-history-contract";
import {
	getPersistedWorkspaceBoardFilePathById,
	loadWorkspaceContext,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { type RuntimeAppRouter, type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
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

it("真实 HTTP 与 CLI 共用只读查询，离线和服务重建后仍可重读历史", { timeout: 100_000 }, async () => {
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
		JSON.stringify({ run_id: "completed-run", repo: projectPath, created_at: 10 }),
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
	// 本用例验证进程与 HTTP 契约；canonical 完成判据在 RVF 的真实 Python 回归中验证。
	const producer = join(fixture.fixtureRootDirectoryPath, "rvf-read-only-inspection-protocol-fixture.cjs");
	await writeFile(
		producer,
		`#!${process.execPath}
const args=process.argv.slice(2);
const result=args[1]==='storage-paths'?{schema:'rvf-storage-paths/v1',run_logs_root:${JSON.stringify(runRoot)},rvf_home:${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "rvf-home"))}}:{schema:'rvf-run-review-evidence/v1',runs:[{run_id:'completed-run',run_directory:${JSON.stringify(runDirectory)},repository_path:${JSON.stringify(projectPath)},kanban_task_id:'abc12',review_completion_status:'completed',completion_evidence_source:'canonical_review_artifacts',handoff_sha256:'a'.repeat(64),reviewed_candidate_content_manifest_sha256:'b'.repeat(64),reason_code:'canonical_review_completed',current_candidate_coverage:{status:'covered',reason_code:'candidate_evidence_eligible'}}]};
process.stdout.write(JSON.stringify(result));
`,
	);
	await chmod(producer, 0o700);
	vi.stubEnv("KANBAN_RVF_INSPECTION_EXECUTABLE_PATH", producer);
	const originalBoard = await readFile(getPersistedWorkspaceBoardFilePathById(workspace.workspaceId));
	const originalSummary = await readFile(join(runDirectory, "summary.json"));
	const originalGit = repository.runGit(["status", "--porcelain=v2"]).stdout;
	function makeServer() {
		return createServer(
			createHTTPHandler({
				basePath: "/api/trpc/",
				router: runtimeAppRouter,
				createContext: ({ req }) =>
					({
						requestedWorkspaceId: req.headers["x-kanban-workspace-id"] ?? null,
						workspaceScope: { workspaceId: workspace.workspaceId, workspacePath: projectPath },
						kanbanRequestOriginActorEvidence: {
							decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
						},
					}) as RuntimeTrpcContext,
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
	async function runCli(port: number) {
		return await new Promise<unknown>((accept, reject) => {
			const child = execFile(
				process.execPath,
				[
					"--import",
					pathToFileURL(requireFromHere.resolve("tsx")).href,
					resolve("src/cli.ts"),
					"task",
					"rvf-history",
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
		expect(api.currentCandidateReviewCoverage.status).toBe("covered");
		expect(taskRvfHistoryResponseSchema.parse(await runCli(port)).querySource).toBe("runtime");
		await new Promise<void>((accept) => server.close(() => accept()));
		const offline = taskRvfHistoryResponseSchema.parse(await runCli(port));
		expect(offline.querySource).toBe("durable_filesystem_fallback");
		expect(offline.hasVerifiedCompletedRvf).toBe(true);
		server = makeServer();
		const restarted = taskRvfHistoryResponseSchema.parse(await runCli(await listen()));
		expect(restarted.mostRecentVerifiedCompletedRun?.runId).toBe("completed-run");
		expect(await readFile(getPersistedWorkspaceBoardFilePathById(workspace.workspaceId))).toEqual(originalBoard);
		expect(await readFile(join(runDirectory, "summary.json"))).toEqual(originalSummary);
		expect(repository.runGit(["status", "--porcelain=v2"]).stdout).toBe(originalGit);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((accept) => server.close(() => accept()));
	}
});
