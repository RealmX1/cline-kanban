import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { resolveAgentSessionPtyHostSocketPath } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	readTestOwnedProcessGeneration,
	reclaimTestOwnedPtyHostLifetime,
	recoverAbandonedTestPtyHostLifetimes,
} from "../utilities/isolated-test-owned-pty-host-lifetime";
import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);
const ownerChildren = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const abandonedLifetimeLeasePathsRecoveredAfterEachTest = new Set<string>();
afterEach(async () => {
	await ownerChildren.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const leasePath of abandonedLifetimeLeasePathsRecoveredAfterEachTest)
		expect(await reclaimTestOwnedPtyHostLifetime(leasePath)).toBe(true);
	abandonedLifetimeLeasePathsRecoveredAfterEachTest.clear();
});

interface ReadyFixtureOwnerResources {
	hostPid: number;
	agentPid: number;
	port: number;
	socketPath: string;
	leasePath: string;
}

async function startFixtureOwnerChild(testContext: LoadSensitiveDeadlineAnnotatingTestContext) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const socketPath = resolveAgentSessionPtyHostSocketPath(
		{ runtimeHomeDirectoryPath: fixture.isolatedHomeDirectoryPath, runtimePort: 41739 },
		"0123456789abcdef",
	);
	const owner = ownerChildren.register(
		spawn(
			process.execPath,
			[
				"--import",
				requireFromHere.resolve("tsx"),
				resolve("test/integration/fixtures/isolated-test-owned-pty-host-lifetime-owner.ts"),
				fixture.fixtureRootDirectoryPath,
				socketPath,
			],
			{ env: fixture.createIsolatedChildProcessEnvironment(), stdio: ["ignore", "pipe", "pipe", "ipc"] },
		),
	);
	let ready: ReadyFixtureOwnerResources | undefined;
	let stderr = "";
	owner.stderr?.on("data", (bytes) => {
		stderr += String(bytes);
	});
	let stdout = "";
	owner.stdout?.on("data", (bytes) => {
		stdout += String(bytes);
		const firstLine = stdout.split("\n")[0];
		if (stdout.includes("\n") && firstLine) ready = JSON.parse(firstLine) as ReadyFixtureOwnerResources;
	});
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		{
			waitedForDescription: "独立 fixture owner、daemonized host 与假 Agent 的 TCP 监听就绪",
			softDeadlineMsExpectedOnUncontendedHost: 5_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
		},
		() => {
			if (hasChildProcessExited(owner)) throw new Error(`fixture owner 提前退出: ${stderr}`);
			return ready !== undefined;
		},
	);
	if (!ready) throw new Error("fixture owner 无就绪记录");
	abandonedLifetimeLeasePathsRecoveredAfterEachTest.add(ready.leasePath);
	return { owner, ready, fixture };
}

async function expectFixtureResourcesReleased(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	resources: ReadyFixtureOwnerResources,
) {
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		{
			waitedForDescription: "host、假 Agent 及 Unix socket 的真实释放",
			softDeadlineMsExpectedOnUncontendedHost: 8_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 40_000,
		},
		() =>
			readTestOwnedProcessGeneration(resources.hostPid) === null &&
			readTestOwnedProcessGeneration(resources.agentPid) === null &&
			!existsSync(resources.socketPath),
		{ pollIntervalMs: 200 },
	);
	const listener = createServer();
	await new Promise<void>((resolveListen, reject) => {
		listener.once("error", reject);
		listener.listen(resources.port, "127.0.0.1", resolveListen);
	});
	await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
	const lease = JSON.parse(readFileSync(resources.leasePath, "utf8")) as { ownerSocketPath: string };
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		{
			waitedForDescription: "回收控制器确认退出并释放 owner socket",
			softDeadlineMsExpectedOnUncontendedHost: 3_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
		},
		() => {
			const hostRecordPath = readdirSync(dirname(resources.leasePath)).find((name) => /^host-.*\.json$/.test(name));
			if (!hostRecordPath) return false;
			const record = JSON.parse(readFileSync(join(dirname(resources.leasePath), hostRecordPath), "utf8")) as {
				outcome: string;
			};
			return record.outcome === "completed" && !existsSync(lease.ownerSocketPath);
		},
	);
}

describe.skipIf(process.platform === "win32")("隔离测试拥有的 PTY 宿主寿命", { timeout: 120_000 }, () => {
	it("fixture 清理等待宿主、忽略 SIGTERM 的假 Agent 和 socket 全部释放", async (testContext) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const socketPath = resolveAgentSessionPtyHostSocketPath(
			{ runtimeHomeDirectoryPath: fixture.isolatedHomeDirectoryPath, runtimePort: 41739 },
			"0123456789abcdef",
		);
		const host = spawn(
			process.execPath,
			[
				"--import",
				requireFromHere.resolve("tsx"),
				resolve("src/agent-session-pty-host/host-process/agent-session-pty-host-process-entry.ts"),
				"--socket-path",
				socketPath,
				"--host-build-identity",
				"0123456789abcdef",
			],
			{ env: fixture.createIsolatedChildProcessEnvironment(), stdio: "ignore" },
		);
		let agentPid: number | undefined;
		try {
			let controller: AgentSessionPtyHostControllerConnection | undefined;
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				{
					waitedForDescription: "测试 host 接受连接",
					softDeadlineMsExpectedOnUncontendedHost: 5_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
				},
				async () => {
					try {
						controller = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
						return true;
					} catch {
						return false;
					}
				},
			);
			if (!controller) throw new Error("测试 host 未就绪");
			const spawned = await controller.requestSpawnHostedSession({
				hostedSessionKey: "stubborn-test-agent",
				hostedSessionDescriptor: {
					workspaceId: "test-workspace",
					taskId: "stubborn-test-agent",
					hostedSessionKind: "task_agent_session",
				},
				binary: process.execPath,
				args: ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
				cwd: fixture.fixtureRootDirectoryPath,
				env: { PATH: "/usr/bin:/bin" },
				terminalName: "xterm",
				cols: 80,
				rows: 24,
			});
			if (spawned.kind !== "spawned") throw new Error(spawned.errorMessage);
			agentPid = spawned.pid;
			await controller.closeAfterFlushingPendingFrames();
			fixture.cleanup();
			expect(await waitForChildProcessExit(host, 3_000)).toBe(true);
			expect(readTestOwnedProcessGeneration(agentPid)).toBeNull();
			expect(existsSync(socketPath)).toBe(false);
		} finally {
			if (!hasChildProcessExited(host)) {
				const cleanupController = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
				cleanupController.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
				await cleanupController.closeAfterFlushingPendingFrames();
				expect(await waitForChildProcessExit(host, 15_000)).toBe(true);
			}
		}
	});

	it.for(["normal", "assertion-failure", "SIGINT", "SIGTERM", "SIGKILL", "timeout"] as const)(
		"%s 后独立宿主、假 Agent、socket 和 TCP 端口释放",
		async (mode, testContext) => {
			const { owner, ready } = await startFixtureOwnerChild(testContext);
			if (mode === "normal" || mode === "assertion-failure") owner.send(mode);
			else if (mode === "timeout") setTimeout(() => owner.kill("SIGKILL"), 50);
			else owner.kill(mode);
			expect(await waitForChildProcessExit(owner, 40_000)).toBe(true);
			if (mode === "normal" || mode === "assertion-failure") expect(owner.exitCode).toBe(mode === "normal" ? 0 : 1);
			else if (mode === "SIGINT" || mode === "SIGTERM") expect(owner.exitCode).toBe(mode === "SIGINT" ? 130 : 143);
			else expect(owner.signalCode).toBe("SIGKILL");
			await expectFixtureResourcesReleased(testContext, ready);
		},
	);

	it("回收控制器被 SIGKILL 后从持久记录补证，重复恢复幂等", async (testContext) => {
		const { owner, ready } = await startFixtureOwnerChild(testContext);
		owner.kill("SIGKILL");
		await waitForChildProcessExit(owner, 5_000);
		const attemptPath = join(dirname(ready.leasePath), "last-recovery-attempt.json");
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			testContext,
			{
				waitedForDescription: "自动回收控制器登记原生世代",
				softDeadlineMsExpectedOnUncontendedHost: 3_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
			},
			() => existsSync(attemptPath),
		);
		const attempt = JSON.parse(readFileSync(attemptPath, "utf8")) as {
			controller: { pid: number; startedAt: string };
		};
		if (readTestOwnedProcessGeneration(attempt.controller.pid)?.startedAt === attempt.controller.startedAt)
			process.kill(attempt.controller.pid, "SIGKILL");
		await recoverAbandonedTestPtyHostLifetimes(dirname(dirname(ready.leasePath)));
		await expectFixtureResourcesReleased(testContext, ready);
		expect(await reclaimTestOwnedPtyHostLifetime(ready.leasePath)).toBe(true);
		expect(await reclaimTestOwnedPtyHostLifetime(ready.leasePath)).toBe(true);
	});

	it("三轮 fixture 循环均回到零活体资源，controller 重接不会结束测试寿命", async (testContext) => {
		for (let round = 0; round < 3; round++) {
			const { owner, ready } = await startFixtureOwnerChild(testContext);
			expect(await reclaimTestOwnedPtyHostLifetime(ready.leasePath)).toBe(true);
			expect(readTestOwnedProcessGeneration(ready.hostPid)).not.toBeNull();
			for (let reconnect = 0; reconnect < 2; reconnect++) {
				const controller = await AgentSessionPtyHostControllerConnection.connectAsController(ready.socketPath);
				expect((await controller.requestListHostedSessions())[0]?.pid).toBe(ready.agentPid);
				await controller.closeAfterFlushingPendingFrames();
			}
			owner.send("normal");
			expect(await waitForChildProcessExit(owner, 40_000)).toBe(true);
			await expectFixtureResourcesReleased(testContext, ready);
		}
	});

	it("fixture 已结束时拒绝晚到的宿主启动，不遗留 socket", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const environment = fixture.createIsolatedChildProcessEnvironment();
		const socketPath = resolveAgentSessionPtyHostSocketPath(
			{ runtimeHomeDirectoryPath: fixture.isolatedHomeDirectoryPath, runtimePort: 41739 },
			"0123456789abcdef",
		);
		fixture.cleanup();
		const lateHost = ownerChildren.register(
			spawn(
				process.execPath,
				[
					"--import",
					requireFromHere.resolve("tsx"),
					resolve("src/agent-session-pty-host/host-process/agent-session-pty-host-process-entry.ts"),
					"--socket-path",
					socketPath,
					"--host-build-identity",
					"0123456789abcdef",
				],
				{ env: environment, stdio: "ignore" },
			),
		);
		expect(await waitForChildProcessExit(lateHost, 15_000)).toBe(true);
		expect(lateHost.exitCode).toBe(1);
		expect(existsSync(socketPath)).toBe(false);
	});
});
