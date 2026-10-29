// 热重启 P4 的 runtime 级集成测试（计划「验证 · 集成 (B)」）：真 runtime（tsx 跑源码 CLI）+ host 模式 + 隔离 HOME。
// 三种停法之后在同一端口重启 runtime，hosted 会话必须是同一个进程、仍能收到输入：
// - 计划内 handover（`kanban runtime handover-restart`）：runtime 以 75 退出；
// - SIGTERM：runtime 被 SIGTERM 结束（supervisor 据 143 停机），会话照常保活；
// - SIGKILL：崩溃路径。
// 收尾用 `kanban runtime stop --terminate-hosted-agent-sessions` 全停：会话被终止、runtime 按 SIGTERM 结束。
//
// 「hosted 会话」是一个替身 shell 脚本（SHELL 指向它）：启动时把自己的 pid 写进文件，读到的每行输入追加到另一个文件，
// 于是不读屏也能判定「同一个进程」与「输入可达」。
// host 由 runtime 以 --daemonize 拉起（ppid=1，不在本测试的子进程表里）：用例结束时按隔离 HOME 下 host 日志里记下的 pid
// 收尾，只认本用例自己的日志，绝不按端口或命令行反查。

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);

const STAND_IN_SHELL_WRITES_PID_FILE_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "替身 shell 在 hosted 会话里启动并写下 pid",
	softDeadlineMsExpectedOnUncontendedHost: 3_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
};
const RUNTIME_PROCESS_EXITS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "runtime 走完退出流程（handover / 信号 / 显式全停）",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 40_000,
};
const CLI_SUBCOMMAND_EXITS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "`kanban runtime …` 子命令（tsx 冷启动）退出",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 40_000,
};
const INPUT_REACHES_ADOPTED_SESSION_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "重启后经新 runtime 写入的输入到达同一个替身 shell",
	softDeadlineMsExpectedOnUncontendedHost: 3_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
};
const HOSTED_SESSION_TERMINATED_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "显式全停后替身 shell 进程退出",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
};
const RUNTIME_HOT_RESTART_INTEGRATION_TEST_TIMEOUT_MS = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 2,
	testBodyTimeoutBudgetMs:
		STAND_IN_SHELL_WRITES_PID_FILE_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
		RUNTIME_PROCESS_EXITS_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression * 2 +
		INPUT_REACHES_ADOPTED_SESSION_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
		HOSTED_SESSION_TERMINATED_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression,
	cliChildProcessSpawns: {
		cliChildProcessSpawnCount: 2,
		cliChildProcessExitTwoTierDeadline: CLI_SUBCOMMAND_EXITS_TWO_TIER_DEADLINE,
	},
});

const STAND_IN_SHELL_TASK_ID = "hot-restart-stand-in-shell";

const childProcessRegistry = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const isolatedFixturesCleanedUpAfterEachTest: IsolatedGitTestWorkspaceFixture[] = [];
// 不在本测试子进程表里、但由本用例产生的进程（daemonize 的 host、替身 shell）：只认本用例记下的 pid。
const processIdsSigkilledAfterEachTest = new Set<number>();

afterEach(async () => {
	await childProcessRegistry.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const processId of processIdsSigkilledAfterEachTest) {
		try {
			process.kill(processId, "SIGKILL");
		} catch {
			// 已退出。
		}
	}
	processIdsSigkilledAfterEachTest.clear();
	for (const fixture of isolatedFixturesCleanedUpAfterEachTest.splice(0)) {
		fixture.cleanup();
	}
});

function isProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch {
		return false;
	}
}

async function findAvailableLoopbackPort(): Promise<number> {
	return await new Promise((resolvePort, rejectPort) => {
		const probe = createServer();
		probe.once("error", rejectPort);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => {
				if (address && typeof address === "object") {
					resolvePort(address.port);
				} else {
					rejectPort(new Error("could not probe a free loopback port"));
				}
			});
		});
	});
}

interface HotRestartTestEnvironment {
	fixture: IsolatedGitTestWorkspaceFixture;
	repositoryPath: string;
	runtimePort: number;
	childProcessEnvironment: NodeJS.ProcessEnv;
	standInShellPidFilePath: string;
	standInShellReceivedInputFilePath: string;
}

async function createHotRestartTestEnvironment(): Promise<HotRestartTestEnvironment> {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	isolatedFixturesCleanedUpAfterEachTest.push(fixture);
	const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "hot-restart-project" });
	const standInShellPidFilePath = join(fixture.fixtureRootDirectoryPath, "stand-in-shell.pid");
	const standInShellReceivedInputFilePath = join(
		fixture.fixtureRootDirectoryPath,
		"stand-in-shell-received-input.txt",
	);
	const standInShellScriptPath = join(fixture.fixtureRootDirectoryPath, "stand-in-shell.sh");
	writeFileSync(
		standInShellScriptPath,
		[
			"#!/bin/sh",
			`echo $$ > '${standInShellPidFilePath}'`,
			'echo "stand-in-shell-ready"',
			`while read line; do echo "got:$line"; echo "$line" >> '${standInShellReceivedInputFilePath}'; done`,
			"",
		].join("\n"),
	);
	chmodSync(standInShellScriptPath, 0o755);
	const runtimePort = await findAvailableLoopbackPort();
	const childProcessEnvironment = fixture.createIsolatedChildProcessEnvironment({
		KANBAN_AGENT_SESSION_PTY_HOST_MODE: "enabled",
		KANBAN_RUNTIME_PORT: String(runtimePort),
		SHELL: standInShellScriptPath,
		// 本测试自己可能就跑在一个 hosted 会话里：别让继承来的绑定 / 停止语义覆写混进被测 runtime。
		KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH: undefined,
		KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY: undefined,
		KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS: undefined,
	});
	return {
		fixture,
		repositoryPath: repository.repositoryPath,
		runtimePort,
		childProcessEnvironment,
		standInShellPidFilePath,
		standInShellReceivedInputFilePath,
	};
}

function spawnSourceCli(environment: HotRestartTestEnvironment, cliArguments: string[]): ChildProcess {
	return childProcessRegistry.register(
		spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(requireFromHere.resolve("tsx")).href,
				resolve(process.cwd(), "src/cli.ts"),
				...cliArguments,
			],
			{
				cwd: environment.repositoryPath,
				env: environment.childProcessEnvironment,
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	);
}

async function startRuntime(environment: HotRestartTestEnvironment): Promise<ChildProcess> {
	const runtimeProcess = spawnSourceCli(environment, ["--port", String(environment.runtimePort), "--no-open"]);
	await waitForRuntimeServerStartupBannerOrSigkillChild(runtimeProcess);
	return runtimeProcess;
}

function createRuntimeClient(environment: HotRestartTestEnvironment, workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: `http://127.0.0.1:${environment.runtimePort}/api/trpc`,
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
			}),
		],
	});
}

// daemonize 的 host 不在子进程表里：从本用例隔离 HOME 下的 host 日志读出它的 pid，登记到收尾名单。
function registerDaemonizedHostProcessIdsFromHostLog(environment: HotRestartTestEnvironment): void {
	const hostLogFilePath = join(
		environment.fixture.isolatedHomeDirectoryPath,
		".cline",
		"kanban",
		"agent-session-pty-host",
		"logs",
		`p${environment.runtimePort}-agent-session-pty-host.log`,
	);
	if (!existsSync(hostLogFilePath)) {
		return;
	}
	for (const logLine of readFileSync(hostLogFilePath, "utf8").split("\n")) {
		try {
			const hostProcessId = (JSON.parse(logLine) as { hostProcessId?: unknown }).hostProcessId;
			if (typeof hostProcessId === "number") {
				processIdsSigkilledAfterEachTest.add(hostProcessId);
			}
		} catch {
			// 空行。
		}
	}
}

async function startStandInShellInHostedSession(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	environment: HotRestartTestEnvironment,
): Promise<{ workspaceId: string; standInShellProcessId: number }> {
	const added = await createRuntimeClient(environment, null).projects.add.mutate({ path: environment.repositoryPath });
	const workspaceId = added.project?.id;
	if (!workspaceId) {
		throw new Error(`could not register the test project: ${added.error ?? "unknown error"}`);
	}
	const started = await createRuntimeClient(environment, workspaceId).runtime.startShellSession.mutate({
		taskId: STAND_IN_SHELL_TASK_ID,
		baseRef: "main",
		cols: 80,
		rows: 24,
	});
	expect(started.ok, started.error).toBe(true);
	registerDaemonizedHostProcessIdsFromHostLog(environment);
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		STAND_IN_SHELL_WRITES_PID_FILE_TWO_TIER_DEADLINE,
		() => existsSync(environment.standInShellPidFilePath),
		{ pollIntervalMs: 50 },
	);
	const standInShellProcessId = Number(readFileSync(environment.standInShellPidFilePath, "utf8").trim());
	processIdsSigkilledAfterEachTest.add(standInShellProcessId);
	expect(started.summary?.pid).toBe(standInShellProcessId);
	return { workspaceId, standInShellProcessId };
}

async function runCliSubcommandAndReadJson(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	environment: HotRestartTestEnvironment,
	cliArguments: string[],
): Promise<Record<string, unknown>> {
	const cliProcess = spawnSourceCli(environment, cliArguments);
	let stdout = "";
	cliProcess.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
		testContext,
		cliProcess,
		CLI_SUBCOMMAND_EXITS_TWO_TIER_DEADLINE,
	);
	return JSON.parse(stdout) as Record<string, unknown>;
}

async function expectSameStandInShellAdoptedAndReachableAfterRestart(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	environment: HotRestartTestEnvironment,
	session: { workspaceId: string; standInShellProcessId: number },
): Promise<void> {
	await startRuntime(environment);
	const runtimeClient = createRuntimeClient(environment, session.workspaceId);
	const workspaceState = await runtimeClient.workspace.getState.query();
	expect(workspaceState.sessions[STAND_IN_SHELL_TASK_ID]?.pid).toBe(session.standInShellProcessId);
	const inputSent = await runtimeClient.runtime.sendTaskSessionInput.mutate({
		taskId: STAND_IN_SHELL_TASK_ID,
		text: "typed-after-restart",
		appendNewline: true,
	});
	expect(inputSent.ok, inputSent.error).toBe(true);
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		INPUT_REACHES_ADOPTED_SESSION_TWO_TIER_DEADLINE,
		() =>
			existsSync(environment.standInShellReceivedInputFilePath) &&
			readFileSync(environment.standInShellReceivedInputFilePath, "utf8").includes("typed-after-restart"),
		{ pollIntervalMs: 50 },
	);
	expect(isProcessAlive(session.standInShellProcessId)).toBe(true);
}

async function stopRuntimeTerminatingHostedSessions(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	environment: HotRestartTestEnvironment,
	standInShellProcessId: number,
): Promise<void> {
	const stopResult = await runCliSubcommandAndReadJson(testContext, environment, [
		"runtime",
		"stop",
		"--terminate-hosted-agent-sessions",
	]);
	expect(stopResult).toMatchObject({ ok: true, path: "runtime_online", outcome: "stop_started" });
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		HOSTED_SESSION_TERMINATED_TWO_TIER_DEADLINE,
		() => !isProcessAlive(standInShellProcessId),
		{ pollIntervalMs: 100 },
	);
}

describe.skipIf(process.platform === "win32")("runtime hot restart preserving hosted agent sessions", () => {
	it(
		"hands the hosted session over to the next runtime on a planned handover restart (exit 75)",
		async (testContext) => {
			const environment = await createHotRestartTestEnvironment();
			const previousRuntime = await startRuntime(environment);
			const session = await startStandInShellInHostedSession(testContext, environment);

			const handoverResult = await runCliSubcommandAndReadJson(testContext, environment, [
				"runtime",
				"handover-restart",
				"--wait-for-successor-seconds",
				"0",
			]);
			expect(handoverResult).toMatchObject({ ok: true, outcome: "handover_restart_started" });
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
				testContext,
				previousRuntime,
				RUNTIME_PROCESS_EXITS_TWO_TIER_DEADLINE,
			);
			expect(previousRuntime.exitCode).toBe(75);
			expect(isProcessAlive(session.standInShellProcessId)).toBe(true);

			await expectSameStandInShellAdoptedAndReachableAfterRestart(testContext, environment, session);
			await stopRuntimeTerminatingHostedSessions(testContext, environment, session.standInShellProcessId);
		},
		RUNTIME_HOT_RESTART_INTEGRATION_TEST_TIMEOUT_MS,
	);

	it(
		"keeps the hosted session alive when the runtime is stopped with SIGTERM, which still ends the runtime by SIGTERM",
		async (testContext) => {
			const environment = await createHotRestartTestEnvironment();
			const previousRuntime = await startRuntime(environment);
			const session = await startStandInShellInHostedSession(testContext, environment);

			previousRuntime.kill("SIGTERM");
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
				testContext,
				previousRuntime,
				RUNTIME_PROCESS_EXITS_TWO_TIER_DEADLINE,
			);
			// 重放信号：父进程（supervisor）看到的是「被 SIGTERM 结束」，即 shell 里的 143。
			expect(previousRuntime.signalCode).toBe("SIGTERM");
			expect(isProcessAlive(session.standInShellProcessId)).toBe(true);

			await expectSameStandInShellAdoptedAndReachableAfterRestart(testContext, environment, session);
			await stopRuntimeTerminatingHostedSessions(testContext, environment, session.standInShellProcessId);
		},
		RUNTIME_HOT_RESTART_INTEGRATION_TEST_TIMEOUT_MS,
	);

	it(
		"lets the next runtime adopt the hosted session after the runtime is killed with SIGKILL",
		async (testContext) => {
			const environment = await createHotRestartTestEnvironment();
			const previousRuntime = await startRuntime(environment);
			const session = await startStandInShellInHostedSession(testContext, environment);

			previousRuntime.kill("SIGKILL");
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
				testContext,
				previousRuntime,
				RUNTIME_PROCESS_EXITS_TWO_TIER_DEADLINE,
			);
			expect(isProcessAlive(session.standInShellProcessId)).toBe(true);

			await expectSameStandInShellAdoptedAndReachableAfterRestart(testContext, environment, session);
			await stopRuntimeTerminatingHostedSessions(testContext, environment, session.standInShellProcessId);
		},
		RUNTIME_HOT_RESTART_INTEGRATION_TEST_TIMEOUT_MS,
	);
});
