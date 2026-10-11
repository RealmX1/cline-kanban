import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	appendLoadSensitiveMeasurementRecordWhenRequested,
	judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline,
	LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE,
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	sigkillChildProcessAndWaitForExit,
	waitForChildProcessExit,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// runtime 与 CLI 子进程都登记：用例超时或断言失败时 finally 来不及收尾，afterEach 先于 fixture 的
// onTestFinished cleanup 执行，保证「先杀子进程、再删隔离 HOME」。
const spawnedChildProcessRegistrySigkilledAfterEachTest = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

// 命令型 CLI 子进程从 spawn 到退出的两档期限。软档是未过载机器上的正常上限（含 tsx 冷转译）。
// 硬档 45s 从 spawn 起算；产品默认硬超时 35s 从 run() 起算，只有模块求值超过 10s 时测试才会先于 CLI 判失败，
// 这只影响失败时的诊断信息，不影响判定。前提是 env 已钉住（见 createCliChildProcessEnvironmentWithPinnedTimeouts）。
const COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "命令型 CLI 子进程退出（从 spawn 起算）",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};

// task create --preview 等路径加载的模块更多，沿用原来的 20s 作软档。
const HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "加载较重模块图的命令型 CLI 子进程退出（从 spawn 起算）",
	softDeadlineMsExpectedOnUncontendedHost: 20_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};

// server-style 调用（无参数、--agent、--port）没有产品硬超时，这里的硬档是唯一的挂死探测。
// EXPERIMENT_NODE: server-style CLI 退出硬档 45s，待在负载下标定实际退出耗时分布后再定
const SERVER_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "server-style CLI 子进程退出（从 spawn 起算，产品侧无硬超时兜底）",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};

// 准备、runtime 优雅关停（5s + SIGKILL 确认 5s）与 fixture 清理。
const TASK_COMMAND_EXIT_TEST_BODY_TIMEOUT_BUDGET_MS = 30_000;

// 用例超时按累计预算闭合：runtime 冷启动 + 每次 CLI spawn 的两档预算 + 本体。
function computeTaskCommandExitTestTimeoutMs(input: {
	runtimeColdStartCount: number;
	cliChildProcessSpawnCount: number;
	cliChildProcessExitTwoTierDeadline?: LoadSensitiveWallClockTwoTierDeadline;
	additionalTestBodyTimeoutBudgetMs?: number;
}): number {
	return computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
		runtimeColdStartCount: input.runtimeColdStartCount,
		testBodyTimeoutBudgetMs:
			TASK_COMMAND_EXIT_TEST_BODY_TIMEOUT_BUDGET_MS + (input.additionalTestBodyTimeoutBudgetMs ?? 0),
		cliChildProcessSpawns: {
			cliChildProcessSpawnCount: input.cliChildProcessSpawnCount,
			cliChildProcessExitTwoTierDeadline:
				input.cliChildProcessExitTwoTierDeadline ?? COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
		},
	});
}

// 开发者 shell 里若导出了 KANBAN_CLI_*_TIMEOUT_MS / KANBAN_HOOK_INGEST_TIMEOUT_MS，会悄悄改掉 CLI 的产品默认超时，
// 「硬档落在产品默认硬超时之后」的前提随之失效。先剔除继承值，只保留用例显式给的。
const INHERITED_CLI_TIMEOUT_ENVIRONMENT_VARIABLES_REMOVED: NodeJS.ProcessEnv = {
	KANBAN_CLI_HARD_TIMEOUT_MS: undefined,
	KANBAN_CLI_TRPC_TIMEOUT_MS: undefined,
	KANBAN_HOOK_INGEST_TIMEOUT_MS: undefined,
};

function createCliChildProcessEnvironmentWithPinnedTimeouts(
	gitFixture: IsolatedGitTestWorkspaceFixture,
	environmentVariableOverrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return gitFixture.createIsolatedChildProcessEnvironment({
		...INHERITED_CLI_TIMEOUT_ENVIRONMENT_VARIABLES_REMOVED,
		...environmentVariableOverrides,
	});
}

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function commitAllRepositoryFiles(
	repository: IsolatedGitTestRepository,
	workingDirectoryPath: string,
	message: string,
): string {
	repository.runGit(["add", "."], { workingDirectoryPath });
	repository.runGit(["commit", "--quiet", "-m", message], { workingDirectoryPath });
	return repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath }).stdout.trim();
}

interface TaskCommandExitIntegrationFixture {
	gitFixture: IsolatedGitTestWorkspaceFixture;
	homeDirectoryPath: string;
	createRepository(repositoryDirectoryName: string): IsolatedGitTestRepository;
	cleanup(): void;
}

function createTaskCommandExitIntegrationFixture(): TaskCommandExitIntegrationFixture {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	return {
		gitFixture,
		homeDirectoryPath: gitFixture.isolatedHomeDirectoryPath,
		createRepository(repositoryDirectoryName) {
			return gitFixture.createNonBareRepository({ repositoryDirectoryName, initialBranchName: "main" });
		},
		cleanup() {
			gitFixture.cleanup();
		},
	};
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

function installBrowserOpenStub(binDir: string, logPath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`;
	const commandNames = process.platform === "darwin" ? ["open"] : ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

const BROWSER_OPEN_STUB_INVOCATION_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "浏览器打开桩被调用（CLI 退出后起算）",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};

async function waitForBrowserOpenCount(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	logPath: string,
	expectedCount: number,
): Promise<void> {
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		{
			...BROWSER_OPEN_STUB_INVOCATION_TWO_TIER_DEADLINE,
			waitedForDescription: `${BROWSER_OPEN_STUB_INVOCATION_TWO_TIER_DEADLINE.waitedForDescription}：累计 ${expectedCount} 次`,
		},
		() => readBrowserOpenLog(logPath).length >= expectedCount,
		{
			describeLastObservedStateForFailureMessage: () =>
				`browser open log: ${readBrowserOpenLog(logPath).join(", ")}`,
		},
	);
}

async function requestGracefulShutdown(process: ChildProcess): Promise<void> {
	if (typeof process.send !== "function" || !process.connected) {
		process.kill("SIGINT");
		return;
	}

	await new Promise<void>((resolveSend) => {
		process.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	const cliChildProcess = spawn(
		process.execPath,
		["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args],
		{
			cwd: options.cwd,
			env: options.env,
			stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		},
	);
	return spawnedChildProcessRegistrySigkilledAfterEachTest.register(cliChildProcess);
}

interface RunCliCommandAndCollectOutputOptions {
	testContext: LoadSensitiveDeadlineAnnotatingTestContext;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	exitTwoTierDeadline?: LoadSensitiveWallClockTwoTierDeadline;
}

interface CliCommandCollectedOutput {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	// 子进程 exit 事件到达测试进程的时刻（performance.now()），用于以 runtime 收到首个请求为锚点度量。
	exitObservedAtMs: number;
}

// 超过硬档时 SIGKILL 子进程并带着 stdout/stderr 抛错，所以正常返回就意味着子进程已经退出。
async function runCliCommandAndCollectOutput(
	options: RunCliCommandAndCollectOutputOptions,
): Promise<CliCommandCollectedOutput> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	let exitObservedAtMs: number | null = null;
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	process.once("exit", () => {
		exitObservedAtMs = performance.now();
	});

	const exitTwoTierDeadline = options.exitTwoTierDeadline ?? COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE;
	await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
		options.testContext,
		process,
		{
			...exitTwoTierDeadline,
			waitedForDescription: `${exitTwoTierDeadline.waitedForDescription}：kanban ${options.args.length === 0 ? "（无参数）" : options.args.slice(0, 3).join(" ")}`,
		},
		{ describeChildProcessOutputForFailureMessage: () => `stdout:\n${stdout}\nstderr:\n${stderr}` },
	);

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		exitObservedAtMs: exitObservedAtMs ?? performance.now(),
	};
}

// 「CLI 会退出」类用例的护栏超时。硬超时 15s 对 tRPC 3s：两者差 12s，负载下 tRPC 超时仍稳定先于硬超时触发；
// 硬超时窗口里请求之前还有同步 git 调用，5s/800ms 的旧值在负载下会把冷启动本身判成超时。
const CLI_GUARD_TRPC_TIMEOUT_MS = 3_000;
const CLI_GUARD_HARD_TIMEOUT_MS = 15_000;
const CLI_GUARD_HOOK_INGEST_TIMEOUT_MS = 500;

function withCliGuardTimeouts(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		KANBAN_CLI_TRPC_TIMEOUT_MS: String(CLI_GUARD_TRPC_TIMEOUT_MS),
		KANBAN_CLI_HARD_TIMEOUT_MS: String(CLI_GUARD_HARD_TIMEOUT_MS),
		KANBAN_HOOK_INGEST_TIMEOUT_MS: String(CLI_GUARD_HOOK_INGEST_TIMEOUT_MS),
	};
}

interface HangingHttpServerThatRecordsFirstRequest {
	port: number;
	server: Server;
	// 收到第一个请求的时刻（performance.now()）；null 表示 CLI 从未连上——用于证明用例确实走到了联网那一步。
	readFirstRequestReceivedAtMs(): number | null;
}

async function startHangingHttpServer(): Promise<HangingHttpServerThatRecordsFirstRequest> {
	let firstRequestReceivedAtMs: number | null = null;
	const server = createServer(() => {
		firstRequestReceivedAtMs ??= performance.now();
		// Accept connections but never complete a tRPC response.
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	if (!port) {
		server.close();
		throw new Error("Could not start hanging HTTP server.");
	}
	return { port, server, readFirstRequestReceivedAtMs: () => firstRequestReceivedAtMs };
}

async function closeHttpServer(server: Server): Promise<void> {
	// 挂起的请求永远不会完成；不先断开，close 会一直等这些连接。
	server.closeAllConnections();
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
}

// 异步 ps：同步 spawnSync 会在采样期间冻住测试进程的事件循环，连带挂起服务器收不到请求。
async function readProcessRssKb(pid: number): Promise<number | null> {
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
		const parsed = Number.parseInt(stdout.trim(), 10);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		// 进程已退出时 ps 以非零码结束。
		return null;
	}
}

async function bootstrapWorkspaceOnDisk(options: {
	projectPath: string;
	gitFixture: IsolatedGitTestWorkspaceFixture;
}): Promise<string> {
	const port = String(await getAvailablePort());
	const serverProcess = await startRuntimeServerForProject({
		projectPath: options.projectPath,
		gitFixture: options.gitFixture,
		port,
	});
	await stopRuntimeServer(serverProcess);
	return port;
}

interface ChildProcessResidentSetSizeSample {
	// 发起这次 ps 的时刻（performance.now()）：晚于锚点发起的采样一定反映锚点之后的状态。
	sampleStartedAtMs: number;
	rssKb: number;
}

// 一直采样到子进程退出（超过硬档时子进程会被 SIGKILL，循环随之结束）。
async function sampleChildProcessResidentSetSizeUntilExit(
	child: ChildProcess,
	pollIntervalMs: number,
): Promise<ChildProcessResidentSetSizeSample[]> {
	const samples: ChildProcessResidentSetSizeSample[] = [];
	while (!hasChildProcessExited(child)) {
		if (typeof child.pid === "number") {
			const sampleStartedAtMs = performance.now();
			const rssKb = await readProcessRssKb(child.pid);
			if (rssKb !== null && !hasChildProcessExited(child)) {
				samples.push({ sampleStartedAtMs, rssKb });
			}
		}
		await new Promise<void>((resolveSleep) => {
			setTimeout(resolveSleep, pollIntervalMs);
		});
	}
	return samples;
}

function computeMedian(values: readonly number[]): number {
	const sortedValues = [...values].sort((left, right) => left - right);
	const middleIndex = Math.floor(sortedValues.length / 2);
	return sortedValues.length % 2 === 1
		? (sortedValues[middleIndex] ?? 0)
		: ((sortedValues[middleIndex - 1] ?? 0) + (sortedValues[middleIndex] ?? 0)) / 2;
}

interface ResidentSetSizeTwoTierThreshold {
	measuredQuantityDescription: string;
	softThresholdKbExpectedOnUncontendedHost: number;
	hardThresholdKbOnlyExplainedByRealRegression: number;
}

// 资源阈值的两档判定：超过软档只写 annotation，超过硬档才失败。
async function judgeResidentSetSizeKbAgainstTwoTierThreshold(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	threshold: ResidentSetSizeTwoTierThreshold,
	measuredKb: number,
	measurementContextDescription: string,
): Promise<void> {
	const measurementDescription = `${threshold.measuredQuantityDescription}：实测 ${Math.round(measuredKb / 1024)}MiB，软档 ${Math.round(threshold.softThresholdKbExpectedOnUncontendedHost / 1024)}MiB / 硬档 ${Math.round(threshold.hardThresholdKbOnlyExplainedByRealRegression / 1024)}MiB；${measurementContextDescription}`;
	appendLoadSensitiveMeasurementRecordWhenRequested({
		measuredQuantityDescription: threshold.measuredQuantityDescription,
		measuredKb,
		softThresholdKb: threshold.softThresholdKbExpectedOnUncontendedHost,
		hardThresholdKb: threshold.hardThresholdKbOnlyExplainedByRealRegression,
		exceededSoftThreshold: measuredKb > threshold.softThresholdKbExpectedOnUncontendedHost,
		exceededHardThreshold: measuredKb > threshold.hardThresholdKbOnlyExplainedByRealRegression,
		measurementContextDescription,
		loadAverageOneMinute: loadavg()[0] ?? null,
	});
	if (measuredKb > threshold.softThresholdKbExpectedOnUncontendedHost) {
		await testContext.annotate(measurementDescription, LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE);
	}
	expect(measuredKb, `超过硬档：${measurementDescription}`).toBeLessThanOrEqual(
		threshold.hardThresholdKbOnlyExplainedByRealRegression,
	);
}

async function startRuntimeServerForProject(options: {
	projectPath: string;
	gitFixture: IsolatedGitTestWorkspaceFixture;
	port: string;
}): Promise<ChildProcess> {
	const env = createCliChildProcessEnvironmentWithPinnedTimeouts(options.gitFixture, {
		KANBAN_RUNTIME_PORT: options.port,
	});
	const serverProcess = spawn(
		process.execPath,
		[
			"--require",
			resolveShutdownIpcHookPath(),
			"--import",
			resolveTsxLoaderImportSpecifier(),
			resolve(process.cwd(), "src/cli.ts"),
			"--no-open",
		],
		{
			cwd: options.projectPath,
			env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	spawnedChildProcessRegistrySigkilledAfterEachTest.register(serverProcess);
	await waitForRuntimeServerStartupBannerOrSigkillChild(serverProcess);
	return serverProcess;
}

async function stopRuntimeServer(serverProcess: ChildProcess): Promise<void> {
	if (hasChildProcessExited(serverProcess)) {
		return;
	}
	await requestGracefulShutdown(serverProcess);
	const stopped = await waitForChildProcessExit(serverProcess, 5_000);
	if (!stopped) {
		await sigkillChildProcessAndWaitForExit(serverProcess);
	}
}

// 文件级 afterEach：覆盖本文件所有 describe（含之后新增的）。
afterEach(async () => {
	await spawnedChildProcessRegistrySigkilledAfterEachTest.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

// 用例超时挂在 describe 上，取组内累计预算最大的用例：给 it(...) 传计算出来的超时会让 biome 放弃 test-call 排版、
// 重缩进整个用例体。超时只是兜底上限，每次等待自己的两档硬档会先给出带诊断的失败。
// 本组最大：done/trash 别名用例冷启动 1 次 runtime + 9 次 CLI spawn。
const SOURCE_TASK_COMMANDS_TEST_TIMEOUT_MS = computeTaskCommandExitTestTimeoutMs({
	runtimeColdStartCount: 1,
	cliChildProcessSpawnCount: 9,
});

describe("source task commands", { timeout: SOURCE_TASK_COMMANDS_TEST_TIMEOUT_MS }, () => {
	it("exits after creating a task when the runtime server is already running", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-task-exit");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Task Exit Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				const created = await runCliCommandAndCollectOutput({
					testContext,
					args: [
						"task",
						"create",
						"--prompt",
						"Add a demo banner component to the homepage that displays a welcome message and current weather summary",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});

				expect(
					created.exitCode,
					`task create failed.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
				).toBe(0);
				expect(created.stdout).toContain('"ok": true');
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});

	it("opens only for launch invocations", async (testContext) => {
		if (process.platform === "win32") {
			return;
		}

		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-root-launch-open");
		const projectPath = repository.repositoryPath;
		const homeDir = integrationFixture.homeDirectoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath);
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				for (const [args, expectedOpenCount, isServerStyleInvocation] of [
					[[], 1, true],
					[["task", "list", "--project-path", projectPath], 1, false],
					[["--agent", "codex"], 2, true],
					[["--port", port], 3, true],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						testContext,
						args: [...args],
						cwd: projectPath,
						env,
						exitTwoTierDeadline: isServerStyleInvocation
							? SERVER_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE
							: COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
					});
					expect(
						result.exitCode,
						`kanban ${args.join(" ")} exit code.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
					).toBe(0);
					await waitForBrowserOpenCount(testContext, browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});

	it("supports done and trash aliases when moving and deleting tasks", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-task-done-delete");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Task Done Delete Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				const taskIds: string[] = [];
				for (const prompt of [
					"Create a temporary task for done and delete",
					"Create another temporary task for done and delete",
					"Create a legacy trash command task for done and delete",
				]) {
					const created = await runCliCommandAndCollectOutput({
						testContext,
						args: ["task", "create", "--prompt", prompt, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(created.exitCode).toBe(0);

					const createdPayload = JSON.parse(created.stdout) as {
						ok?: boolean;
						task?: { id?: string };
					};
					expect(createdPayload.ok).toBe(true);
					expect(typeof createdPayload.task?.id).toBe("string");
					if (createdPayload.task?.id) {
						taskIds.push(createdPayload.task.id);
					}
				}
				expect(taskIds).toHaveLength(3);

				const movedByDoneAlias = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "done", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(movedByDoneAlias.exitCode).toBe(0);
				expect(movedByDoneAlias.stdout).toContain('"ok": true');

				const movedByTrashCommand = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "trash", "--column", "backlog", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(movedByTrashCommand.exitCode).toBe(0);
				expect(movedByTrashCommand.stdout).toContain('"ok": true');
				expect(movedByTrashCommand.stdout).toContain('"column": "backlog"');
				expect(movedByTrashCommand.stdout).toContain('"count": 2');

				const listedDoneBeforeDelete = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "list", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(listedDoneBeforeDelete.exitCode).toBe(0);
				expect(listedDoneBeforeDelete.stdout).toContain('"count": 3');

				const listedTrashBeforeDelete = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(listedTrashBeforeDelete.exitCode).toBe(0);
				expect(listedTrashBeforeDelete.stdout).toContain('"count": 3');

				const deletedDone = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "delete", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(deletedDone.exitCode).toBe(0);
				expect(deletedDone.stdout).toContain('"ok": true');
				expect(deletedDone.stdout).toContain('"column": "trash"');
				expect(deletedDone.stdout).toContain('"count": 3');

				const listedTrash = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(listedTrash.exitCode).toBe(0);
				expect(listedTrash.stdout).toContain('"count": 0');
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});

	it("looks a single task up by its task ID, worktree path included", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-task-get");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Task Get Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				const created = await runCliCommandAndCollectOutput({
					testContext,
					args: [
						"task",
						"create",
						"--title",
						"Look me up by ID",
						"--prompt",
						"Reference this task from another agent using only its task ID",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(created.exitCode).toBe(0);
				const createdTaskId = (JSON.parse(created.stdout) as { task?: { id?: string } }).task?.id ?? "";
				expect(createdTaskId).not.toBe("");

				const fetched = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "get", "--task-id", createdTaskId, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(fetched.exitCode).toBe(0);

				const fetchedPayload = JSON.parse(fetched.stdout) as {
					ok?: boolean;
					task?: { id?: string; title?: string; column?: string };
					taskWorkspace?: { taskId?: string; path?: string; exists?: boolean };
				};
				expect(fetchedPayload.ok).toBe(true);
				expect(fetchedPayload.task?.id).toBe(createdTaskId);
				expect(fetchedPayload.task?.title).toBe("Look me up by ID");
				expect(fetchedPayload.task?.column).toBe("backlog");
				// 任务连线机制已退役（dd2db 1a）：task get 不再输出 dependencies。
				expect(fetchedPayload).not.toHaveProperty("dependencies");
				// worktree 路径把 task ID 原样嵌在目录层级里，这正是「拿 worktree 路径反推 task ID」赖以成立的前提。
				expect(fetchedPayload.taskWorkspace?.taskId).toBe(createdTaskId);
				expect(fetchedPayload.taskWorkspace?.path).toContain(`/${createdTaskId}/`);
				// 任务尚未启动，工作树还没建出来——调用方需要能据此判断能不能直接进目录。
				expect(fetchedPayload.taskWorkspace?.exists).toBe(false);

				const missing = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "get", "--task-id", "no-such-task", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(missing.exitCode).toBe(1);
				const missingPayload = JSON.parse(missing.stdout) as { ok?: boolean; error?: string };
				expect(missingPayload.ok).toBe(false);
				expect(missingPayload.error).toContain('Task "no-such-task" was not found');
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});

	it("treats create-time reasoning inherit as no explicit override", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-task-cline-reasoning");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Task Cline Reasoning Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				const inheritedCreate = await runCliCommandAndCollectOutput({
					testContext,
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that inherits workspace reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"inherit",
					],
					cwd: projectPath,
					env,
				});
				expect(inheritedCreate.exitCode).toBe(0);

				const inheritedPayload = JSON.parse(inheritedCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(inheritedPayload.ok).toBe(true);
				expect(inheritedPayload.task?.clineSettings).toBeUndefined();

				const defaultCreate = await runCliCommandAndCollectOutput({
					testContext,
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that uses model default reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"default",
					],
					cwd: projectPath,
					env,
				});
				expect(defaultCreate.exitCode).toBe(0);

				const defaultPayload = JSON.parse(defaultCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(defaultPayload.ok).toBe(true);
				expect(defaultPayload.task?.clineSettings).toEqual({});
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});
});

// 12 张卡的 task list 要逐卡算 git 状态，沿用原来的 15s 作软档。
const TASK_LIST_ACROSS_TWELVE_TASKS_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "12 张卡的 task list 子进程退出（从 spawn 起算）",
	softDeadlineMsExpectedOnUncontendedHost: 15_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};

// 124 用例：spawn → 退出的墙钟等待。硬档 30s 低于该用例的 tRPC 60s，硬超时失效时不会被 tRPC 超时「救」成 exit 1。
// EXPERIMENT_NODE: 124 用例 spawn→退出硬档 30s，负载容忍度待验证阶段实测
const CLI_HARD_TIMEOUT_124_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "CLI 硬超时 1500ms 触发后子进程退出（从 spawn 起算，含模块求值）",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};

// 以挂起服务器收到首个请求为锚点度量到退出：硬超时计时器在请求之前就已安装，这个量不含模块求值，
// 与启动负载无关。精确到毫秒的「恰好 1500ms 触发」由假时钟单测 cli-hard-timeout-fires-exit-code-124-with-fake-timers 守护。
// EXPERIMENT_NODE: 首个请求→退出 软 2500ms / 硬 10s，待在负载下标定
const CLI_HARD_TIMEOUT_FROM_FIRST_RUNTIME_REQUEST_TO_EXIT_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "CLI 硬超时：挂起 runtime 收到首个请求 → 子进程退出",
	softDeadlineMsExpectedOnUncontendedHost: 2_500,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 10_000,
};

// RSS 用例（2cc7595e：等待挂起 runtime 时 CLI 孤儿 RSS 涨到数 GB）。锚点之后按阶段采样：
// 基线取锚点后前 3 个样本的中位数，启动阶段的峰值只记 annotation 不参与判定。
const CLI_RESIDENT_SET_SIZE_SAMPLE_POLL_INTERVAL_MS = 50;
const CLI_RESIDENT_SET_SIZE_BASELINE_SAMPLE_COUNT_AFTER_FIRST_REQUEST = 3;
// 样本太少时「最大值」没有意义，按采样饥饿判失败，而不是空转通过。
// EXPERIMENT_NODE: 锚点后最少 10 个有效样本 vs 拉长 tRPC 窗口；负载下 ps 变慢时可能不足
const CLI_RESIDENT_SET_SIZE_MINIMUM_VALID_SAMPLE_COUNT_AFTER_FIRST_REQUEST = 10;
const CLI_RESIDENT_SET_SIZE_GROWTH_AFTER_FIRST_REQUEST_TWO_TIER_THRESHOLD: ResidentSetSizeTwoTierThreshold = {
	measuredQuantityDescription: "等待挂起 runtime 期间 CLI RSS 增长（锚点后基线起算）",
	softThresholdKbExpectedOnUncontendedHost: 64 * 1024,
	hardThresholdKbOnlyExplainedByRealRegression: 256 * 1024,
};
// 绝对值硬档从 512MiB 放宽后，「基线已高 + 中等增长」（例：450→650MiB）不再判失败——这是明文承认的判别力损失，
// 增长判定与 test/README.md 的说明是补偿。
// EXPERIMENT_NODE: RSS 绝对值硬档 768MiB，待在 macOS 与 Linux CI 上标定锚点后稳态 RSS 分布后再定
const CLI_RESIDENT_SET_SIZE_ABSOLUTE_AFTER_FIRST_REQUEST_TWO_TIER_THRESHOLD: ResidentSetSizeTwoTierThreshold = {
	measuredQuantityDescription: "等待挂起 runtime 期间 CLI RSS 绝对值（锚点之后）",
	softThresholdKbExpectedOnUncontendedHost: 512 * 1024,
	hardThresholdKbOnlyExplainedByRealRegression: 768 * 1024,
};

// 本组最大：12 次 task create 按默认两档计，最后一次 task list 按更宽的软档补足。
const CLI_SUBPROCESS_EXIT_GUARANTEES_TEST_TIMEOUT_MS =
	computeTaskCommandExitTestTimeoutMs({ runtimeColdStartCount: 1, cliChildProcessSpawnCount: 12 }) +
	TASK_LIST_ACROSS_TWELVE_TASKS_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE.softDeadlineMsExpectedOnUncontendedHost * 2;

describe("CLI subprocess exit guarantees", { timeout: CLI_SUBPROCESS_EXIT_GUARANTEES_TEST_TIMEOUT_MS }, () => {
	it("exits after task list without --column on a multi-task workspace", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-cli-list-all");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# CLI List All Tasks Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				for (let index = 0; index < 12; index += 1) {
					const created = await runCliCommandAndCollectOutput({
						testContext,
						args: [
							"task",
							"create",
							"--prompt",
							`Create CLI list-all fixture task ${index + 1}`,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(created.exitCode).toBe(0);
				}

				const listed = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
					exitTwoTierDeadline: TASK_LIST_ACROSS_TWELVE_TASKS_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
				});
				expect(listed.exitCode).toBe(0);

				const payload = JSON.parse(listed.stdout) as {
					ok?: boolean;
					count?: number;
					column?: string | null;
					tasks?: Array<{
						workspaceGitStatus?: {
							baseRef?: string;
							commitsAheadOfBaseRef?: number | null;
							commitsBehindBaseRef?: number | null;
							taskCommitsIntegratedIntoBaseRef?: number | null;
							taskCommitIntegrationTrackingStatus?: string;
						};
					}>;
				};
				expect(payload.ok).toBe(true);
				expect(payload.column).toBeNull();
				expect(payload.count).toBe(12);
				expect(payload.tasks).toHaveLength(12);
				for (const task of payload.tasks ?? []) {
					expect(task.workspaceGitStatus).toMatchObject({
						baseRef: "main",
						commitsAheadOfBaseRef: null,
						commitsBehindBaseRef: null,
						taskCommitsIntegratedIntoBaseRef: null,
						taskCommitIntegrationTrackingStatus: "legacy_history_unavailable",
					});
				}
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});

	// 必须先 bootstrap：未注册的项目会在连网之前就以「not added to Kanban yet」exit 1，用例会空转通过。
	it("exits when the runtime server is unreachable", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-cli-unreachable");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# CLI Unreachable Runtime Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");
			await bootstrapWorkspaceOnDisk({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
			});

			const deadPort = String(await getAvailablePort());
			const env = withCliGuardTimeouts(
				createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
					KANBAN_RUNTIME_PORT: deadPort,
				}),
			);

			const result = await runCliCommandAndCollectOutput({
				testContext,
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
			});

			expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
			expect(result.stdout).toContain('"ok": false');
			// 证明走到了联网那一步：失败原因是连不上，而不是项目尚未注册。
			expect(result.stdout).not.toContain("is not added to Kanban yet");
			expect(result.stdout).toContain("fetch failed");
		} finally {
			await integrationFixture.cleanup();
		}
	});

	it("exits when the runtime hangs instead of responding to tRPC", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-cli-hanging");
		const projectPath = repository.repositoryPath;

		let hangingServer: Server | null = null;
		try {
			writeFileSync(join(projectPath, "README.md"), "# CLI Hanging Runtime Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");
			await bootstrapWorkspaceOnDisk({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
			});

			const started = await startHangingHttpServer();
			hangingServer = started.server;
			const env = withCliGuardTimeouts(
				createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
					KANBAN_RUNTIME_PORT: String(started.port),
				}),
			);

			const result = await runCliCommandAndCollectOutput({
				testContext,
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
			});

			expect(
				started.readFirstRequestReceivedAtMs(),
				"CLI 没有向挂起的 runtime 发出任何请求——用例空转",
			).not.toBeNull();
			expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
			expect(result.stdout).toContain('"ok": false');
		} finally {
			if (hangingServer) {
				await closeHttpServer(hangingServer);
			}
			await integrationFixture.cleanup();
		}
	});

	// tRPC 超时必须先于硬超时触发，CLI 以 exit 1 而不是 124 退出。两者差距从 5s 拉大到 12s：
	// 硬超时窗口里请求之前还有同步 git 调用，负载下 5s 的差距会被启动开销吃掉，变成 124 的假失败。
	it(
		"exits with code 1 (not 124) when tRPC times out under production-like timeout margin",
		{ timeout: computeTaskCommandExitTestTimeoutMs({ runtimeColdStartCount: 1, cliChildProcessSpawnCount: 1 }) },
		async (testContext) => {
			const integrationFixture = createTaskCommandExitIntegrationFixture();
			const repository = integrationFixture.createRepository("project-cli-trpc-margin");
			const projectPath = repository.repositoryPath;

			let hangingServer: Server | null = null;
			try {
				writeFileSync(join(projectPath, "README.md"), "# CLI TRPC Margin Test\n", "utf8");
				commitAllRepositoryFiles(repository, projectPath, "init");
				await bootstrapWorkspaceOnDisk({
					projectPath,
					gitFixture: integrationFixture.gitFixture,
				});

				const started = await startHangingHttpServer();
				hangingServer = started.server;
				const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
					KANBAN_RUNTIME_PORT: String(started.port),
					KANBAN_CLI_TRPC_TIMEOUT_MS: "3000",
					KANBAN_CLI_HARD_TIMEOUT_MS: "15000",
				});

				const result = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});

				expect(
					started.readFirstRequestReceivedAtMs(),
					"CLI 没有向挂起的 runtime 发出任何请求——用例空转",
				).not.toBeNull();
				expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
				expect(result.stdout).toContain('"ok": false');
				expect(result.stderr).not.toContain("command timed out");
			} finally {
				if (hangingServer) {
					await closeHttpServer(hangingServer);
				}
				await integrationFixture.cleanup();
			}
		},
	);

	it("enforces the CLI hard timeout with exit code 124", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-cli-hard-timeout");
		const projectPath = repository.repositoryPath;

		let hangingServer: Server | null = null;
		try {
			writeFileSync(join(projectPath, "README.md"), "# CLI Hard Timeout Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");
			await bootstrapWorkspaceOnDisk({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
			});

			const started = await startHangingHttpServer();
			hangingServer = started.server;
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: String(started.port),
				KANBAN_CLI_HARD_TIMEOUT_MS: "1500",
				KANBAN_CLI_TRPC_TIMEOUT_MS: "60000",
			});

			const result = await runCliCommandAndCollectOutput({
				testContext,
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
				exitTwoTierDeadline: CLI_HARD_TIMEOUT_124_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
			});

			// 产品契约特征仍严格断言。
			expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(124);
			expect(result.stderr).toContain("command timed out after 1500ms");

			const firstRequestReceivedAtMs = started.readFirstRequestReceivedAtMs();
			if (firstRequestReceivedAtMs === null) {
				// 负载下 run() 之后、发出请求之前的同步工作就可能耗尽 1500ms：契约照样成立，只是锚点度量不适用。
				await testContext.annotate(
					"CLI 硬超时在发出首个请求之前就已触发，「首个请求 → 退出」锚点度量不适用",
					"notice",
				);
			} else {
				await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
					testContext,
					CLI_HARD_TIMEOUT_FROM_FIRST_RUNTIME_REQUEST_TO_EXIT_TWO_TIER_DEADLINE,
					result.exitObservedAtMs - firstRequestReceivedAtMs,
				);
			}
		} finally {
			if (hangingServer) {
				await closeHttpServer(hangingServer);
			}
			await integrationFixture.cleanup();
		}
	});

	it("does not grow RSS while waiting for a hanging runtime response", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-cli-rss");
		const projectPath = repository.repositoryPath;

		let hangingServer: Server | null = null;
		try {
			writeFileSync(join(projectPath, "README.md"), "# CLI RSS Guard Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");
			await bootstrapWorkspaceOnDisk({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
			});

			const started = await startHangingHttpServer();
			hangingServer = started.server;
			const env = withCliGuardTimeouts(
				createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
					KANBAN_RUNTIME_PORT: String(started.port),
				}),
			);

			const commandProcess = spawnSourceCli(["task", "list", "--project-path", projectPath], {
				cwd: projectPath,
				env,
			});
			let stdout = "";
			let stderr = "";
			commandProcess.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			commandProcess.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const residentSetSizeSamplesUntilExit = sampleChildProcessResidentSetSizeUntilExit(
				commandProcess,
				CLI_RESIDENT_SET_SIZE_SAMPLE_POLL_INTERVAL_MS,
			);
			try {
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					commandProcess,
					COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
					{ describeChildProcessOutputForFailureMessage: () => `stdout:\n${stdout}\nstderr:\n${stderr}` },
				);
			} finally {
				// 超过硬档时子进程已被 SIGKILL，采样循环随之结束；这里只等它收尾，避免悬空的异步 ps。
				await residentSetSizeSamplesUntilExit;
			}
			const residentSetSizeSamples = await residentSetSizeSamplesUntilExit;

			const firstRequestReceivedAtMs = started.readFirstRequestReceivedAtMs();
			expect(firstRequestReceivedAtMs, "CLI 没有向挂起的 runtime 发出任何请求——用例空转").not.toBeNull();
			const samplesAfterFirstRequest = residentSetSizeSamples.filter(
				(sample) => sample.sampleStartedAtMs >= (firstRequestReceivedAtMs ?? Number.POSITIVE_INFINITY),
			);
			const startupPhaseSamples = residentSetSizeSamples.filter(
				(sample) => sample.sampleStartedAtMs < (firstRequestReceivedAtMs ?? Number.POSITIVE_INFINITY),
			);
			expect(
				samplesAfterFirstRequest.length,
				`采样饥饿：首个请求之后只有 ${samplesAfterFirstRequest.length} 个有效 RSS 样本（总样本 ${residentSetSizeSamples.length}），不足以判定增长`,
			).toBeGreaterThanOrEqual(CLI_RESIDENT_SET_SIZE_MINIMUM_VALID_SAMPLE_COUNT_AFTER_FIRST_REQUEST);

			const baselineRssKbAfterFirstRequest = computeMedian(
				samplesAfterFirstRequest
					.slice(0, CLI_RESIDENT_SET_SIZE_BASELINE_SAMPLE_COUNT_AFTER_FIRST_REQUEST)
					.map((sample) => sample.rssKb),
			);
			const maximumRssKbAfterFirstRequest = Math.max(...samplesAfterFirstRequest.map((sample) => sample.rssKb));
			const startupPhasePeakRssKb = Math.max(0, ...startupPhaseSamples.map((sample) => sample.rssKb));
			const measurementContextDescription = `锚点后基线 ${Math.round(baselineRssKbAfterFirstRequest / 1024)}MiB、峰值 ${Math.round(maximumRssKbAfterFirstRequest / 1024)}MiB、样本 ${samplesAfterFirstRequest.length} 个；启动阶段峰值 ${Math.round(startupPhasePeakRssKb / 1024)}MiB（只记录不判定）`;

			await judgeResidentSetSizeKbAgainstTwoTierThreshold(
				testContext,
				CLI_RESIDENT_SET_SIZE_GROWTH_AFTER_FIRST_REQUEST_TWO_TIER_THRESHOLD,
				maximumRssKbAfterFirstRequest - baselineRssKbAfterFirstRequest,
				measurementContextDescription,
			);
			await judgeResidentSetSizeKbAgainstTwoTierThreshold(
				testContext,
				CLI_RESIDENT_SET_SIZE_ABSOLUTE_AFTER_FIRST_REQUEST_TWO_TIER_THRESHOLD,
				maximumRssKbAfterFirstRequest,
				measurementContextDescription,
			);
			expect(commandProcess.exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(1);
		} finally {
			if (hangingServer) {
				await closeHttpServer(hangingServer);
			}
			await integrationFixture.cleanup();
		}
	});

	it("exits hooks ingest when the runtime is unreachable", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-cli-hooks-exit");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# CLI Hooks Exit Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const deadPort = String(await getAvailablePort());
			const env = withCliGuardTimeouts(
				createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
					KANBAN_RUNTIME_PORT: deadPort,
					KANBAN_HOOK_TASK_ID: "task-hooks-exit",
					KANBAN_HOOK_WORKSPACE_ID: "workspace-hooks-exit",
				}),
			);

			const result = await runCliCommandAndCollectOutput({
				testContext,
				args: ["hooks", "ingest", "--event", "activity", "--source", "claude"],
				cwd: projectPath,
				env,
			});

			expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
			// 参数解析失败与联网失败都以「kanban hooks ingest:」开头（hooks.ts 两个 catch 分支）；
			// 断言联网分支特有的错误文案，证明确实走到了投递那一步。
			expect(result.stderr).toMatch(/kanban hooks ingest: (?:fetch failed|.*aborted)/u);
		} finally {
			await integrationFixture.cleanup();
		}
	});
});

// 本组最大：真实建卡用例冷启动 1 次 runtime + 3 次加载较重模块图的 CLI spawn。
const TASK_CREATE_PREVIEW_RECEIPT_TEST_TIMEOUT_MS = computeTaskCommandExitTestTimeoutMs({
	runtimeColdStartCount: 1,
	cliChildProcessSpawnCount: 3,
	cliChildProcessExitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
});

describe("task create 预览与解析回执", { timeout: TASK_CREATE_PREVIEW_RECEIPT_TEST_TIMEOUT_MS }, () => {
	// 预览必须是**真的**只读：它不注册项目、不建卡，因此也完全不需要运行时服务器。这条用例把这三件事
	// 一起钉住——刻意不启动服务器，跑完之后再用 `task list` 证明项目仍未注册。
	it("--preview 不建卡、不注册项目，也不需要运行时服务器", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-task-create-preview");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Preview Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: String(await getAvailablePort()),
			});

			const preview = await runCliCommandAndCollectOutput({
				testContext,
				args: [
					"task",
					"create",
					"--preview",
					"--prompt",
					"Add a demo banner component to the homepage",
					"--project-path",
					projectPath,
				],
				cwd: projectPath,
				env,
				exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
			});

			expect(preview.exitCode).toBe(0);

			const previewPayload = JSON.parse(preview.stdout) as {
				ok: boolean;
				preview: boolean;
				taskCreated: boolean;
				resolvedSettingsFingerprint: string;
				needsAttention: boolean;
				resolvedSettings: Record<string, { value: unknown; source: string }>;
				warnings: { code: string }[];
			};
			expect(previewPayload.ok).toBe(true);
			expect(previewPayload.preview).toBe(true);
			expect(previewPayload.taskCreated).toBe(false);
			expect(previewPayload.resolvedSettingsFingerprint).toMatch(/^[0-9a-f]{32}$/u);
			expect(previewPayload.resolvedSettings.baseRef?.value).toBe("main");
			expect(previewPayload.resolvedSettings.column?.value).toBe("backlog");
			expect(previewPayload.needsAttention).toBe(true);
			expect(previewPayload.warnings.map((warning) => warning.code)).toContain(
				"project_is_not_registered_in_kanban",
			);

			// 预览若偷偷注册了项目，这条命令就会去连（并不存在的）运行时而不是当场报「尚未加入」。
			// 刻意不套 withCliGuardTimeouts：这里要断言的是「项目没被注册」，不是看门狗行为，而机器繁忙时
			// 偏短的硬超时会把 tsx 冷启动本身判成超时，让这条断言变成噪声。
			const listAfterPreview = await runCliCommandAndCollectOutput({
				testContext,
				args: ["task", "list", "--project-path", projectPath],
				cwd: projectPath,
				env,
				exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
			});
			expect(
				listAfterPreview.stdout,
				`task list after preview produced no usable output.\nstderr:\n${listAfterPreview.stderr}`,
			).toContain("is not added to Kanban yet");
		} finally {
			await integrationFixture.cleanup();
		}
	});

	// 回归：workspaceId 一度被算进指纹。未注册项目的预览只能给出 null，而真实建卡会先注册再拿到真 id，
	// 于是「新项目先预览、再带指纹建卡」这条最需要两步确认的路径在毫无漂移时也必然 fail closed。
	it("未注册项目的预览指纹能被随后的真实建卡接受", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-unregistered-preview-fingerprint");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Unregistered Preview\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});

			// 预览在项目注册**之前**跑，且不需要服务器。
			const preview = await runCliCommandAndCollectOutput({
				testContext,
				args: [
					"task",
					"create",
					"--preview",
					"--prompt",
					"First task in a brand new project",
					"--project-path",
					projectPath,
				],
				cwd: projectPath,
				env,
				exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
			});
			expect(preview.exitCode).toBe(0);
			const previewPayload = JSON.parse(preview.stdout) as {
				resolvedSettingsFingerprint: string;
				resolvedSettings: { workspaceId: { value: string | null } };
			};
			expect(previewPayload.resolvedSettings.workspaceId.value).toBeNull();

			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});
			try {
				const created = await runCliCommandAndCollectOutput({
					testContext,
					args: [
						"task",
						"create",
						"--prompt",
						"First task in a brand new project",
						"--project-path",
						projectPath,
						"--expect-resolved-settings-fingerprint",
						previewPayload.resolvedSettingsFingerprint,
					],
					cwd: projectPath,
					env,
					exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
				});
				const createdPayload = JSON.parse(created.stdout) as {
					ok: boolean;
					taskCreated: boolean;
					error?: string;
				};
				expect(
					createdPayload.ok,
					`create rejected a fingerprint from its own preview: ${createdPayload.error ?? ""}`,
				).toBe(true);
				expect(createdPayload.taskCreated).toBe(true);
				expect(created.exitCode).toBe(0);
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});

	// 回归：cline 走 in_process_cline_sdk（进程内 SDK 起会话），catalog 里那个 binary 名只是名义值。
	// 照着它查 PATH 会让「只装了 SDK」这种完全合法的部署收到一条「不装就启动失败」的假告警。
	it("SDK 内置通道的 agent 不因 PATH 上没有同名二进制而误报未安装", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-sdk-agent-binary-probe");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# SDK Agent\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: String(await getAvailablePort()),
			});

			const preview = await runCliCommandAndCollectOutput({
				testContext,
				args: [
					"task",
					"create",
					"--preview",
					"--prompt",
					"Run this on the SDK agent",
					"--project-path",
					projectPath,
					"--agent-id",
					"cline",
				],
				cwd: projectPath,
				env,
				exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
			});

			expect(preview.exitCode).toBe(0);
			const previewPayload = JSON.parse(preview.stdout) as {
				resolvedSettings: { effectiveAgentId: { value: string } };
				warnings: { code: string }[];
			};
			expect(previewPayload.resolvedSettings.effectiveAgentId.value).toBe("cline");
			expect(previewPayload.warnings.map((warning) => warning.code)).not.toContain(
				"resolved_agent_binary_is_not_installed",
			);
		} finally {
			await integrationFixture.cleanup();
		}
	});

	it("真实建卡也回传 resolvedSettings，指纹不匹配时 fail closed", async (testContext) => {
		const integrationFixture = createTaskCommandExitIntegrationFixture();
		const repository = integrationFixture.createRepository("project-task-create-fingerprint");
		const projectPath = repository.repositoryPath;

		try {
			writeFileSync(join(projectPath, "README.md"), "# Fingerprint Test\n", "utf8");
			commitAllRepositoryFiles(repository, projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createCliChildProcessEnvironmentWithPinnedTimeouts(integrationFixture.gitFixture, {
				KANBAN_RUNTIME_PORT: port,
			});
			const serverProcess = await startRuntimeServerForProject({
				projectPath,
				gitFixture: integrationFixture.gitFixture,
				port,
			});

			try {
				const created = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "create", "--prompt", "Ship the pagination endpoint", "--project-path", projectPath],
					cwd: projectPath,
					env,
					exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
				});
				expect(created.exitCode).toBe(0);
				const createdPayload = JSON.parse(created.stdout) as {
					ok: boolean;
					taskCreated: boolean;
					needsAttention: boolean;
					resolvedSettings: Record<string, { value: unknown; source: string }>;
					warnings: { code: string }[];
				};
				expect(createdPayload.ok).toBe(true);
				expect(createdPayload.taskCreated).toBe(true);
				expect(createdPayload.resolvedSettings.baseRef?.value).toBe("main");
				expect(createdPayload.resolvedSettings.effectiveAgentId?.source).toBe("workspace_config_default");
				// 默认权限档就是全放行，这是这条回执最该说出来的事。
				expect(createdPayload.warnings.map((warning) => warning.code)).toContain(
					"task_will_run_with_all_permission_prompts_bypassed",
				);

				const rejected = await runCliCommandAndCollectOutput({
					testContext,
					args: [
						"task",
						"create",
						"--prompt",
						"This one must not be created",
						"--project-path",
						projectPath,
						"--expect-resolved-settings-fingerprint",
						"00000000000000000000000000000000",
					],
					cwd: projectPath,
					env,
					exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
				});
				expect(rejected.exitCode).toBe(1);
				const rejectedPayload = JSON.parse(rejected.stdout) as {
					ok: boolean;
					taskCreated: boolean;
					error: string;
				};
				expect(rejectedPayload.ok).toBe(false);
				expect(rejectedPayload.taskCreated).toBe(false);
				expect(rejectedPayload.error).toContain("Resolved task settings changed since the preview");

				const listed = await runCliCommandAndCollectOutput({
					testContext,
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
					exitTwoTierDeadline: HEAVY_MODULE_GRAPH_COMMAND_STYLE_CLI_EXIT_FROM_SPAWN_TWO_TIER_DEADLINE,
				});
				const listedPayload = JSON.parse(listed.stdout) as { tasks: { prompt: string }[] };
				expect(listedPayload.tasks).toHaveLength(1);
				expect(listedPayload.tasks[0]?.prompt).toBe("Ship the pagination endpoint");
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			await integrationFixture.cleanup();
		}
	});
});
