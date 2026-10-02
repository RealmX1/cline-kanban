// 只用轻量 `node -e` 子进程验证子进程生命周期收口与 shutdown IPC hook，不启动真实 runtime。
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const spawnedChildProcessRegistrySigkilledAfterEachTest = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

// 轻量子进程只需要 node 本体，显式给空环境，不继承父进程的 process.env。
const LIGHTWEIGHT_NODE_CHILD_PROCESS_ENVIRONMENT_WITHOUT_PARENT_INHERITANCE: NodeJS.ProcessEnv = {};

const KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT = "setInterval(() => {}, 1000);";

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function spawnLightweightNodeChildProcess(input: {
	script: string;
	preloadShutdownIpcHookWithIpcChannel: boolean;
}): ChildProcess {
	const child = spawn(
		process.execPath,
		input.preloadShutdownIpcHookWithIpcChannel
			? ["--require", resolveShutdownIpcHookPath(), "-e", input.script]
			: ["-e", input.script],
		{
			env: LIGHTWEIGHT_NODE_CHILD_PROCESS_ENVIRONMENT_WITHOUT_PARENT_INHERITANCE,
			stdio: input.preloadShutdownIpcHookWithIpcChannel
				? ["ignore", "pipe", "pipe", "ipc"]
				: ["ignore", "pipe", "pipe"],
		},
	);
	spawnedChildProcessRegistrySigkilledAfterEachTest.register(child);
	return child;
}

function collectChildProcessStdout(child: ChildProcess): () => string {
	let collectedStdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		collectedStdout += chunk.toString();
	});
	return () => collectedStdout;
}

async function sendShutdownIpcMessageAndWaitUntilWritten(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolveSend, rejectSend) => {
		child.send({ type: "kanban.shutdown" }, (error) => {
			if (error) {
				rejectSend(error);
				return;
			}
			resolveSend();
		});
	});
}

describe("runtime integration test spawned child process lifecycle", () => {
	afterEach(async () => {
		await spawnedChildProcessRegistrySigkilledAfterEachTest.sigkillEveryStillRunningChildProcessAndWaitForExit();
	});

	it("启动等待超时时先 SIGKILL 子进程并等到退出、摘掉 pipe 监听，再 reject", async () => {
		const child = spawnLightweightNodeChildProcess({
			script: KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT,
			preloadShutdownIpcHookWithIpcChannel: false,
		});

		await expect(waitForRuntimeServerStartupBannerOrSigkillChild(child, 300)).rejects.toThrow(
			/Timed out after 300ms waiting for server start/,
		);

		expect(child.signalCode).toBe("SIGKILL");
		expect(child.stdout?.listenerCount("data")).toBe(0);
		expect(child.stderr?.listenerCount("data")).toBe(0);
	});

	it("子进程在打印启动 banner 前退出时 reject 并带上退出码", async () => {
		const child = spawnLightweightNodeChildProcess({
			script: "process.exit(3);",
			preloadShutdownIpcHookWithIpcChannel: false,
		});

		await expect(waitForRuntimeServerStartupBannerOrSigkillChild(child, 10_000)).rejects.toThrow(
			/exited before startup \(code=3 signal=null\)/,
		);
	});

	it("子进程打印启动 banner 时 resolve 出 runtimeUrl，子进程继续运行", async () => {
		const child = spawnLightweightNodeChildProcess({
			script: `console.log("Cline Kanban running at http://127.0.0.1:43123/demo-project"); ${KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT}`,
			preloadShutdownIpcHookWithIpcChannel: false,
		});

		await expect(waitForRuntimeServerStartupBannerOrSigkillChild(child, 10_000)).resolves.toEqual({
			runtimeUrl: "http://127.0.0.1:43123/demo-project",
		});
		expect(hasChildProcessExited(child)).toBe(false);
	});

	it("登记表 SIGKILL 仍在运行的子进程并等到退出，跳过已自行退出的子进程", async () => {
		const registryUnderTest = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
		const stillRunningChild = registryUnderTest.register(
			spawnLightweightNodeChildProcess({
				script: KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT,
				preloadShutdownIpcHookWithIpcChannel: false,
			}),
		);
		const selfExitingChild = registryUnderTest.register(
			spawnLightweightNodeChildProcess({ script: "process.exit(0);", preloadShutdownIpcHookWithIpcChannel: false }),
		);
		expect(await waitForChildProcessExit(selfExitingChild, 10_000)).toBe(true);

		await registryUnderTest.sigkillEveryStillRunningChildProcessAndWaitForExit();

		expect(stillRunningChild.signalCode).toBe("SIGKILL");
		expect(selfExitingChild.exitCode).toBe(0);
		expect(selfExitingChild.signalCode).toBeNull();
	});

	it("shutdown IPC hook：父进程断开 IPC 且已有 SIGINT 处理器时，走 SIGINT 优雅关停", async () => {
		const child = spawnLightweightNodeChildProcess({
			script: `process.on("SIGINT", () => { console.log("sigint-observed"); setTimeout(() => process.exit(130), 50); }); console.log("sigint-listener-installed"); ${KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT}`,
			preloadShutdownIpcHookWithIpcChannel: true,
		});
		const readCollectedStdout = collectChildProcessStdout(child);
		await expect.poll(readCollectedStdout, { timeout: 10_000 }).toContain("sigint-listener-installed");

		child.disconnect();

		expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
		expect(child.exitCode).toBe(130);
		expect(readCollectedStdout().match(/sigint-observed/g)).toHaveLength(1);
	});

	it("shutdown IPC hook：父进程断开 IPC 时 runtime 尚未装 SIGINT 处理器（仍在启动），立即以 1 退出", async () => {
		const child = spawnLightweightNodeChildProcess({
			script: `console.log("started-without-sigint-listener"); ${KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT}`,
			preloadShutdownIpcHookWithIpcChannel: true,
		});
		const readCollectedStdout = collectChildProcessStdout(child);
		await expect.poll(readCollectedStdout, { timeout: 10_000 }).toContain("started-without-sigint-listener");

		child.disconnect();

		// 远短于 hook 15s 的兜底退出，证明走的是「立即退出」分支。
		expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
		expect(child.exitCode).toBe(1);
	});

	it("shutdown IPC hook：先收到 shutdown 消息再断开 IPC 时，SIGINT 只发一次，不打断优雅关停", async () => {
		const child = spawnLightweightNodeChildProcess({
			script: `let sigintObservedCount = 0; process.on("SIGINT", () => { sigintObservedCount += 1; console.log("sigint-observed-" + sigintObservedCount); setTimeout(() => process.exit(130), 500); }); console.log("sigint-listener-installed"); ${KEEP_CHILD_PROCESS_ALIVE_SCRIPT_STATEMENT}`,
			preloadShutdownIpcHookWithIpcChannel: true,
		});
		const readCollectedStdout = collectChildProcessStdout(child);
		await expect.poll(readCollectedStdout, { timeout: 10_000 }).toContain("sigint-listener-installed");

		await sendShutdownIpcMessageAndWaitUntilWritten(child);
		child.disconnect();

		expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
		expect(child.exitCode).toBe(130);
		expect(readCollectedStdout()).toContain("sigint-observed-1");
		expect(readCollectedStdout()).not.toContain("sigint-observed-2");
	});
});
