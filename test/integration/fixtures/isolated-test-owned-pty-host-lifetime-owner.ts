import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSessionPtyHostControllerConnection } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import {
	bindTestPtyLifetimeToChildEnvironment,
	createIsolatedTestOwnedPtyHostLifetime,
	TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE,
} from "../../utilities/isolated-test-owned-pty-host-lifetime";

// 模拟独立测试 worker；只派生隔离 host 和本地假 Agent，不读写 Git 或真实服务。
const fixtureDirectory = process.argv[2];
const socketPath = process.argv[3];
if (!fixtureDirectory || !socketPath) throw new Error("测试 owner 缺少隔离路径");
const lifetime = createIsolatedTestOwnedPtyHostLifetime(fixtureDirectory);
const requireFromHere = createRequire(import.meta.url);
const stubExecutable = join(fixtureDirectory, "isolated-stubborn-agent.cjs");
const stubReadyRecordPath = join(fixtureDirectory, "isolated-stubborn-agent-ready.json");
writeFileSync(
	stubExecutable,
	`
const fs = require('node:fs');
const net = require('node:net');
process.on('SIGTERM', () => {});
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
 fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: server.address().port }));
});
`,
);
const hostLauncher = spawn(
	process.execPath,
	[
		"--import",
		requireFromHere.resolve("tsx"),
		resolve("src/agent-session-pty-host/host-process/agent-session-pty-host-process-entry.ts"),
		"--daemonize",
		"--socket-path",
		socketPath,
		"--host-build-identity",
		"0123456789abcdef",
	],
	{ env: bindTestPtyLifetimeToChildEnvironment({ PATH: "/usr/bin:/bin" }, lifetime), stdio: "ignore" },
);
hostLauncher.on("error", (error) => {
	throw error;
});

async function runFixtureOwner(): Promise<void> {
	let controller: AgentSessionPtyHostControllerConnection | undefined;
	const deadline = Date.now() + 30_000;
	while (!controller && Date.now() < deadline) {
		try {
			controller = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
		} catch {
			await delay(50);
		}
	}
	if (!controller) throw new Error("测试 host 启动超时");
	const spawned = await controller.requestSpawnHostedSession({
		hostedSessionKey: "fixture-agent",
		hostedSessionDescriptor: {
			workspaceId: "isolated-lifetime-workspace",
			taskId: "fixture-agent",
			hostedSessionKind: "task_agent_session",
		},
		binary: process.execPath,
		args: [stubExecutable, stubReadyRecordPath],
		cwd: fixtureDirectory,
		env: { PATH: "/usr/bin:/bin" },
		terminalName: "xterm",
		cols: 80,
		rows: 24,
	});
	if (spawned.kind !== "spawned") throw new Error(spawned.errorMessage);
	let ready: { pid: number; port: number } | undefined;
	while (!ready && Date.now() < deadline) {
		try {
			ready = JSON.parse(readFileSync(stubReadyRecordPath, "utf8")) as typeof ready;
		} catch {
			await delay(50);
		}
	}
	if (!ready) throw new Error("假 Agent 启动超时");
	const hostPid = controller.hostHello.hostProcessId;
	await controller.closeAfterFlushingPendingFrames();
	process.stdout.write(
		`${JSON.stringify({
			hostPid,
			agentPid: ready.pid,
			port: ready.port,
			socketPath,
			leasePath: lifetime.environmentVariables[TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE],
		})}\n`,
	);
	for (const [signal, exitCode] of [
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const) {
		process.on(signal, () => {
			lifetime.closeAndVerifyOwnedHostExit();
			process.exit(exitCode);
		});
	}
	process.on("message", (mode) => {
		try {
			assert.notEqual(mode, "assertion-failure", "模拟断言失败");
		} finally {
			lifetime.closeAndVerifyOwnedHostExit();
		}
		process.exit(0);
	});
	setInterval(() => {}, 1_000);
}
void runFixtureOwner().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	try {
		lifetime.closeAndVerifyOwnedHostExit();
	} finally {
		process.exit(1);
	}
});
