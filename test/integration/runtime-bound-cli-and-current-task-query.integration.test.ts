import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import { saveWorkspaceState } from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32")(
	"运行时绑定入口与当前任务查询集成",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 120_000,
		}),
	},
	() => {
		it("真实 CLI 两次冷启动复用入口，协作会话从其他目录读取宿主卡片", async (testContext) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "runtime-bound-cli-main" });
			await writeFile(join(repository.repositoryPath, "README.md"), "隔离 CLI 集成验证\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化绑定入口验证仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const taskId = "abc12";
			const collaboratorSessionId = "collaborator-session";
			await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					columns: [
						{
							id: "backlog",
							title: "Backlog",
							cards: [
								{
									id: taskId,
									title: "当前任务查询",
									prompt: "只读验证",
									baseRef: "main",
									startInPlanMode: false,
									worktreeMode: "inplace",
									createdAt: 1,
									updatedAt: 1,
								},
							],
						},
					],
				},
				sessions: {
					[collaboratorSessionId]: runtimeTaskSessionSummarySchema.parse({
						taskId: collaboratorSessionId,
						agentId: "codex",
						workspacePath: repository.repositoryPath,
						pid: null,
						startedAt: null,
						updatedAt: 1,
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						turnOwner: null,
						liveness: "none",
						userTurnKind: null,
						taskConversationSessionMetadata: {
							workspaceTaskId: taskId,
							taskConversationSessionRole: "task_collaborator",
							taskConversationSessionContextSource: "started_from_scratch",
							parentTaskConversationSessionId: taskId,
							mainSessionOriginTurnNumber: null,
							mainSessionOriginUserMessagePreview: null,
							latestUserMessagePreview: null,
						},
					}),
				},
			});
			const ambientContextRemoved: NodeJS.ProcessEnv = {};
			for (const name of Object.keys(process.env))
				if (name.startsWith("KANBAN_")) ambientContextRemoved[name] = undefined;
			const environment = fixture.createIsolatedChildProcessEnvironment({
				...ambientContextRemoved,
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-configuration"),
				CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-storage"),
				DO_NOT_TRACK: "1",
				AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB: undefined,
			});
			const commandPrefix = [
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				resolve("src/cli.ts"),
			];
			let previousExecutablePath: string | null = null;
			for (let incarnation = 0; incarnation < 2; incarnation++) {
				const server = children.register(
					spawn(
						process.execPath,
						[...commandPrefix, "--host", "127.0.0.1", "--port", "auto", "--no-open", "--skip-shutdown-cleanup"],
						{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe"] },
					),
				);
				const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(server)).runtimeUrl);
				const executableStorageDirectoryPath = join(
					fixture.isolatedHomeDirectoryPath,
					".cline",
					"kanban",
					"runtime-bound-cli-executables",
				);
				const [bindingDirectoryName] = await readdir(executableStorageDirectoryPath);
				expect(bindingDirectoryName).toBeTruthy();
				const executablePath = join(executableStorageDirectoryPath, bindingDirectoryName ?? "", "kanban");
				if (previousExecutablePath) expect(executablePath).toBe(previousExecutablePath);
				previousExecutablePath = executablePath;
				expect(await readFile(executablePath, "utf8")).toContain(process.execPath);
				const cli = children.register(
					spawn("/bin/sh", ["-lc", '"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" task get-current-task'], {
						cwd: fixture.fixtureRootDirectoryPath,
						env: {
							...environment,
							KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH: executablePath,
							KANBAN_RUNTIME_PORT: origin.port,
							KANBAN_RUNTIME_HOST: origin.hostname,
							KANBAN_TASK_ID: taskId,
							KANBAN_PROJECT_PATH: repository.repositoryPath,
							KANBAN_TASK_CONVERSATION_SESSION_ID: collaboratorSessionId,
						},
						stdio: ["ignore", "pipe", "pipe"],
					}),
				);
				let stdout = "";
				let stderr = "";
				cli.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				cli.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					cli,
					{
						waitedForDescription: "绑定 CLI 查询退出",
						softDeadlineMsExpectedOnUncontendedHost: 8_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
					},
					{ describeChildProcessOutputForFailureMessage: () => `${stdout}\n${stderr}` },
				);
				expect(cli.exitCode, stderr).toBe(0);
				expect(JSON.parse(stdout)).toMatchObject({
					ok: true,
					task: { id: taskId },
					workspacePath: repository.repositoryPath,
				});
				await sigkillChildProcessAndWaitForExit(server);
			}
		});
	},
);
