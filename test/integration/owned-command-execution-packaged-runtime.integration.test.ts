import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());
const cli = process.env.KANBAN_OWNED_COMMAND_PACKAGED_CLI_PATH;

it.skipIf(!cli)(
	"打包 CLI 经真实 runtime 托管、幂等、取消，并跨重启保留撤销",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 120_000,
		}),
	},
	async () => {
		if (!cli) throw new Error("需要本任务的隔离构建 CLI");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const project = fixture.createNonBareRepository({ repositoryDirectoryName: "owned-command-project" });
		writeFileSync(join(project.repositoryPath, "README.md"), "所属执行隔离验证\n");
		project.commitAllRepositoryFilesAtDate({
			message: "初始化隔离项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("未取得隔离端口");
		const port = address.port;
		await new Promise<void>((done) => reservation.close(() => done()));
		expect(port).not.toBe(3484);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex-sqlite"),
		});
		const shutdownHook = resolve(import.meta.dirname, "shutdown-ipc-hook.cjs");
		const artifacts = process.env.KANBAN_OWNED_COMMAND_EVIDENCE_DIRECTORY ?? fixture.fixtureRootDirectoryPath;
		mkdirSync(artifacts, { recursive: true });
		const runCli = async (arguments_: string[]) => {
			const child = children.register(
				spawn(process.execPath, [cli, ...arguments_], {
					cwd: project.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			if (!(await waitForChildProcessExit(child, 45_000)) || child.exitCode !== 0)
				throw new Error(`隔离 CLI 失败：${stderr}\n${stdout}`);
			return JSON.parse(stdout) as {
				ok: boolean;
				task?: { id: string };
				execution?: {
					executionId: string;
					launchAttemptCount: number;
					revokedAtEpochMs: number | null;
					businessDisposition: string | null;
					specification: { readOnlyRecoveryEvidenceObservationCommand?: string[] };
				};
			};
		};
		const startRuntime = async (name: string) => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", shutdownHook, cli, "--port", String(port), "--no-open", "--no-passcode"],
					{ cwd: project.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.once("exit", () => writeFileSync(join(artifacts, `${name}.log`), output));
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `http://127.0.0.1:${port}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		let runtime = await startRuntime("owned-command-before-restart");
		try {
			const created = await runCli([
				"task",
				"create",
				"--start-in-plan-mode",
				"false",
				"--title",
				"所属执行隔离验证",
				"--prompt",
				"只测试通用命令托管，不启动真实模型",
				"--worktree-mode",
				"inplace",
				"--project-path",
				project.repositoryPath,
			]);
			const taskId = created.task?.id;
			const workspaceId = (await client().projects.list.query()).projects.find(
				(entry) => entry.path === project.repositoryPath,
			)?.id;
			if (!taskId || !workspaceId) throw new Error("隔离任务或工作区未登记");
			const scoped = client(workspaceId);
			const state = await scoped.workspace.getState.query();
			state.sessions[taskId] = runtimeTaskSessionSummarySchema.parse({
				taskId,
				agentId: "codex",
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				workspacePath: project.repositoryPath,
				pid: null,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: "hook",
				exitCode: 0,
				lastHookAt: null,
				latestHookActivity: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "isolated-native-owner",
					observedAt: 1,
					transcriptPath: null,
				},
			});
			await scoped.workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const resultFile = join(fixture.fixtureRootDirectoryPath, "business-result.json");
			const specificationFile = join(fixture.fixtureRootDirectoryPath, "owned-command-specification.json");
			const command = [
				process.execPath,
				"-e",
				`require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({disposition:'machine_evidence_pending',recovery:{trigger:'fixture_changed',action:'resume_same_run',maximum_unchanged_retries:1}}))`,
			];
			const readOnlyRecoveryEvidenceObservationCommand = [
				process.execPath,
				"-e",
				`process.stdout.write(JSON.stringify({evidenceSha256:'${"b".repeat(64)}'}))`,
			];
			writeFileSync(
				specificationFile,
				JSON.stringify({
					command,
					resumeCommand: command,
					readOnlyRecoveryEvidenceObservationCommand,
					workingDirectory: project.repositoryPath,
					resultFile,
					materialSha256: "a".repeat(64),
					label: "通用机器待证",
				}),
			);
			const startArguments = [
				"task",
				"command-execution",
				"start",
				"--task-id",
				taskId,
				"--project-path",
				project.repositoryPath,
				"--idempotency-key",
				"same-work",
				"--spec-file",
				specificationFile,
			];
			const first = await runCli(startArguments);
			const second = await runCli(startArguments);
			expect(first.execution?.executionId).toBe(second.execution?.executionId);
			expect(second.execution?.launchAttemptCount).toBe(1);
			expect(second.execution?.specification.readOnlyRecoveryEvidenceObservationCommand).toEqual(
				readOnlyRecoveryEvidenceObservationCommand,
			);
			const executionId = first.execution?.executionId;
			if (!executionId) throw new Error("所属执行未受理");
			const cancelled = await runCli([
				"task",
				"command-execution",
				"cancel",
				"--task-id",
				taskId,
				"--project-path",
				project.repositoryPath,
				"--execution-id",
				executionId,
			]);
			expect(cancelled.execution?.revokedAtEpochMs).toBeTypeOf("number");
			runtime.send?.({ type: "kanban.shutdown" });
			if (!(await waitForChildProcessExit(runtime, 15_000))) throw new Error("旧隔离 runtime 没有退出");
			runtime = await startRuntime("owned-command-after-restart");
			const restored = await runCli([
				"task",
				"command-execution",
				"inspect",
				"--task-id",
				taskId,
				"--project-path",
				project.repositoryPath,
				"--execution-id",
				executionId,
			]);
			expect(restored.execution?.businessDisposition).toBe("cancelled");
			expect(restored.execution?.launchAttemptCount).toBe(1);
			expect(restored.execution?.specification.readOnlyRecoveryEvidenceObservationCommand).toEqual(
				readOnlyRecoveryEvidenceObservationCommand,
			);
			writeFileSync(
				join(artifacts, "packaged-command-execution-receipts.json"),
				JSON.stringify({ first, second, cancelled, restored }, null, 2),
			);
			const recordPath = join(
				fixture.isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"workspaces",
				workspaceId,
				"task-command-executions.json",
			);
			writeFileSync(join(artifacts, "packaged-command-execution-records.json"), readFileSync(recordPath));
		} finally {
			runtime.send?.({ type: "kanban.shutdown" });
			await waitForChildProcessExit(runtime, 15_000);
		}
	},
);
