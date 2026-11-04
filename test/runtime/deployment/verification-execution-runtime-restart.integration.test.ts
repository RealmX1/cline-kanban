import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimePostDeployVerificationChecklistItem } from "../../../src/core/api-contract";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import {
	cancelVerificationExecutionAttempt,
	listVerificationExecutionAttempts,
	verificationExecutionAttemptDirectory,
} from "../../../src/deployment/verification-execution-attempt-store";
import { observeVerificationExecutionAttempt } from "../../../src/deployment/verification-execution-recovery";
import {
	hasSameProcessGeneration,
	readProcessIdentity,
} from "../../../src/task-command-execution/task-command-execution-supervisor";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "../../integration/runtime-integration-test-spawned-child-process-lifecycle";
import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createTempDir } from "../../utilities/temp-dir";
import { seedIsolatedVerificationExecutionTask } from "./verification-execution-isolated-runtime-fixture";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
let sandbox: ReturnType<typeof createTempDir>;
beforeEach(() => {
	sandbox = createTempDir("pdv-runtime-restart-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
});
afterEach(async () => {
	await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const attempt of await listVerificationExecutionAttempts()) {
		await cancelVerificationExecutionAttempt(
			attempt.verificationExecutionAttemptId,
			"isolated_test_cleanup",
			new Date().toISOString(),
		);
		const directory = verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId);
		let nativeProbePath: string | undefined;
		try {
			nativeProbePath = JSON.parse(
				await readFile(join(directory, `launch-materials-${attempt.verificationExecutionAttemptId}.json`), "utf8"),
			).darwinOriginalParentGenerationProbePath;
		} catch {
			/* 未派发。 */
		}
		const identities: { pid: number; startAndCommand: string; nativeProcessGenerationIdentity?: string }[] = [];
		for (const name of [
			`supervisor-progress-${attempt.verificationExecutionAttemptId}.json`,
			`supervisor-identity-${attempt.verificationExecutionAttemptId}.json`,
			`supplemental-owned-process-identities-${attempt.verificationExecutionAttemptId}.json`,
		]) {
			try {
				const record = JSON.parse(await readFile(join(directory, name), "utf8"));
				if (record.ownedProcesses) identities.push(...record.ownedProcesses);
				else identities.push(record);
			} catch {
				/* 尚未派发。 */
			}
		}
		for (const identity of identities) {
			try {
				if (
					hasSameProcessGeneration(
						await readProcessIdentity(
							identity.pid,
							nativeProbePath,
							identity.nativeProcessGenerationIdentity !== undefined,
						),
						identity,
					)
				)
					process.kill(identity.pid, "SIGKILL");
			} catch {
				/* 已退出。 */
			}
		}
	}
	vi.unstubAllEnvs();
	sandbox.cleanup();
});

function spawnIsolatedRuntimeHost(source: string) {
	const child = childProcesses.register(
		spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
			cwd: process.cwd(),
			env: {
				PATH: process.env.PATH,
				HOME: sandbox.path,
				USERPROFILE: sandbox.path,
				CODEX_HOME: sandbox.path,
				CODEX_SQLITE_HOME: sandbox.path,
				NODE_ENV: "production",
			},
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output = (output + String(chunk)).slice(-8000);
	});
	child.stderr?.on("data", (chunk) => {
		output = (output + String(chunk)).slice(-8000);
	});
	return { child, output: () => output };
}
const exitDeadline = {
	waitedForDescription: "隔离 runtime 子进程退出",
	softDeadlineMsExpectedOnUncontendedHost: 5000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};

function runtimeHostRunSource(fixture: Awaited<ReturnType<typeof seedIsolatedVerificationExecutionTask>>) {
	const moduleUrl = pathToFileURL(join(process.cwd(), "src/trpc/deployment-api.ts")).href;
	return `import {createDeploymentApi} from ${JSON.stringify(moduleUrl)};
console.log('ISOLATED_RUNTIME_MODULES_LOADED');
const api=createDeploymentApi({loadBoardTasksForWorkspace:async()=>[{taskId:${JSON.stringify(fixture.taskId)},columnId:'validation',taskIncarnationCreatedAtEpochMs:123}],loadTaskAgentResponsePreview:async()=>null});
console.log(JSON.stringify(await api.runPostDeployVerificationItem(${JSON.stringify(fixture.scope)},${JSON.stringify(fixture.request)})));`;
}
function headlessRecoverySource() {
	return `import {startVerificationExecutionRecoveryLifecycle} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/deployment/verification-execution-recovery.ts")).href)};
console.log('ISOLATED_RUNTIME_MODULES_LOADED');
const lifecycle=startVerificationExecutionRecoveryLifecycle({readCurrentTaskIncarnationCreatedAtEpochMs:async()=>123});const keepAlive=setInterval(()=>{},1000);process.once('SIGTERM',async()=>{clearInterval(keepAlive);await lifecycle.stop();});await lifecycle.reconcileNow();console.log('ISOLATED_RECOVERY_LIFECYCLE_READY');`;
}

async function waitForIsolatedRuntimeHostModulesLoaded(
	context: LoadSensitiveDeadlineAnnotatingTestContext,
	host: ReturnType<typeof spawnIsolatedRuntimeHost>,
) {
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		context,
		{
			waitedForDescription: "隔离 runtime 导入业务模块，开始受理前的冷启动",
			softDeadlineMsExpectedOnUncontendedHost: 5000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
		},
		() => host.output().includes("ISOLATED_RUNTIME_MODULES_LOADED"),
		{ describeLastObservedStateForFailureMessage: host.output },
	);
}

describe("独立监督跨 runtime 进程恢复", { timeout: 120_000 }, () => {
	it("原 runtime 退出后继续原执行，新的无浏览器 runtime 严格 passed 且不重派", async (context) => {
		const invocationsPath = join(sandbox.path, "script-invocations.txt");
		const releasePath = join(sandbox.path, "script-release.marker");
		const fixture = await seedIsolatedVerificationExecutionTask({
			scriptBody: `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(invocationsPath)},'once\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.exit(0)}},20)`,
		});
		const original = spawnIsolatedRuntimeHost(runtimeHostRunSource(fixture));
		await waitForIsolatedRuntimeHostModulesLoaded(context, original);
		try {
			await vi.waitFor(async () => expect(await readFile(invocationsPath, "utf8")).toBe("once\n"), {
				timeout: 30_000,
			});
		} catch (error) {
			throw new Error(
				`隔离 runtime 尚未派发脚本：${String(error)}；stdout/stderr=${original.output()}；attempts=${JSON.stringify(await listVerificationExecutionAttempts())}；state=${await readFile(getPostDeployVerificationStatePath(), "utf8")}`,
			);
		}
		original.child.kill("SIGKILL");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, original.child, exitDeadline);
		const observerWhileRunning = spawnIsolatedRuntimeHost(headlessRecoverySource());
		await waitForIsolatedRuntimeHostModulesLoaded(context, observerWhileRunning);
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "新的无浏览器 runtime 启动恢复观察器",
				softDeadlineMsExpectedOnUncontendedHost: 5000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
			},
			() => observerWhileRunning.output().includes("ISOLATED_RECOVERY_LIFECYCLE_READY"),
		);
		expect(await readFile(invocationsPath, "utf8")).toBe("once\n");
		await writeFile(releasePath, "release");
		const [attempt] = await listVerificationExecutionAttempts();
		if (!attempt) throw new Error("未持久化 attempt");
		let lastSupervisorProgress: unknown;
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "原独立监督进程保存终结回执",
				softDeadlineMsExpectedOnUncontendedHost: 8000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
			},
			async () => {
				const progress = JSON.parse(
					await readFile(
						join(
							verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId),
							`supervisor-progress-${attempt.verificationExecutionAttemptId}.json`,
						),
						"utf8",
					),
				);
				lastSupervisorProgress = progress;
				return progress.status === "exited";
			},
			{ describeLastObservedStateForFailureMessage: () => JSON.stringify(lastSupervisorProgress) },
		);
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "新 runtime 无浏览器请求时自动应用原 attempt 的成功原件",
				softDeadlineMsExpectedOnUncontendedHost: 20_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
			},
			async () => {
				const state = JSON.parse(await readFile(getPostDeployVerificationStatePath(), "utf8"));
				return state.deploymentGroups[0].tasks[0].checklist[0].run.status === "passed";
			},
		);
		observerWhileRunning.child.kill("SIGTERM");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
			context,
			observerWhileRunning.child,
			exitDeadline,
		);
		expect(observerWhileRunning.child.exitCode, observerWhileRunning.output()).toBe(0);
		const state = JSON.parse(await readFile(getPostDeployVerificationStatePath(), "utf8"));
		const recoveredItem = state.deploymentGroups[0].tasks[0]
			.checklist[0] as RuntimePostDeployVerificationChecklistItem;
		expect(recoveredItem.run?.status).toBe("passed");
		expect(recoveredItem.checked).toBe(true);
		expect(recoveredItem.run?.verificationExecutionAttemptId).toBe(attempt.verificationExecutionAttemptId);
		expect(await readFile(invocationsPath, "utf8")).toBe("once\n");
	});

	it("两个真实 runtime 竞争只受理一个 attempt、只执行一次脚本", async (context) => {
		const invocationsPath = join(sandbox.path, "competing-script-invocations.txt");
		const fixture = await seedIsolatedVerificationExecutionTask({
			timeoutMs: 3000,
			scriptBody: `require('node:fs').appendFileSync(${JSON.stringify(invocationsPath)},'once\\n');setTimeout(()=>process.exit(0),500)`,
		});
		const first = spawnIsolatedRuntimeHost(runtimeHostRunSource(fixture));
		const second = spawnIsolatedRuntimeHost(runtimeHostRunSource(fixture));
		for (const host of [first, second]) {
			await waitForIsolatedRuntimeHostModulesLoaded(context, host);
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, host.child, exitDeadline);
		}
		expect(first.child.exitCode, first.output()).toBe(0);
		expect(second.child.exitCode, second.output()).toBe(0);
		expect([first.output(), second.output()].filter((output) => output.includes('"ok":true'))).toHaveLength(1);
		expect(await readFile(invocationsPath, "utf8")).toBe("once\n");
		expect(await listVerificationExecutionAttempts()).toHaveLength(1);
	});
	it("监督者硬退出后补查原生标记，终止未登记后代且不把缺少回执冒充成功", async (context) => {
		const descendantPidPath = join(sandbox.path, "owner-crash-descendant-pid.txt");
		const descendantWritesPath = join(sandbox.path, "owner-crash-descendant-writes.txt");
		const descendantSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(descendantWritesPath)},'x'),20)`;
		const fixture = await seedIsolatedVerificationExecutionTask({
			timeoutMs: 5000,
			scriptBody: `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`,
		});
		const host = spawnIsolatedRuntimeHost(runtimeHostRunSource(fixture));
		await waitForIsolatedRuntimeHostModulesLoaded(context, host);
		try {
			await vi.waitFor(
				async () => expect((await readFile(descendantWritesPath, "utf8")).length).toBeGreaterThan(0),
				{
					timeout: 30_000,
				},
			);
		} catch (error) {
			throw new Error(`隔离 runtime 未观察到后代写入：${String(error)}；stdout/stderr=${host.output()}`);
		}
		const [attempt] = await listVerificationExecutionAttempts();
		if (!attempt) throw new Error("缺少 attempt");
		const directory = verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId);
		const identity = JSON.parse(
			await readFile(join(directory, `supervisor-identity-${attempt.verificationExecutionAttemptId}.json`), "utf8"),
		);
		const materials = JSON.parse(
			await readFile(join(directory, `launch-materials-${attempt.verificationExecutionAttemptId}.json`), "utf8"),
		);
		expect(
			hasSameProcessGeneration(
				await readProcessIdentity(identity.pid, materials.darwinOriginalParentGenerationProbePath, true),
				identity,
			),
		).toBe(true);
		process.kill(identity.pid, "SIGKILL");
		host.child.kill("SIGKILL");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, host.child, exitDeadline);
		await writeFile(
			join(directory, `supervisor-progress-${attempt.verificationExecutionAttemptId}.json`),
			JSON.stringify({
				launchNonce: attempt.verificationExecutionAttemptId,
				status: "running",
				ownedProcesses: [],
				updatedAtEpochMs: Date.now(),
			}),
		);
		const run = await observeVerificationExecutionAttempt(
			attempt.verificationExecutionAttemptId,
			attempt.deadlineAtEpochMs + 1,
		);
		expect(run.status).toBe("running");
		expect(run.recoveryObservation).toBeDefined();
		const writesAfterCancellation = await readFile(descendantWritesPath, "utf8");
		await delay(200);
		expect(await readFile(descendantWritesPath, "utf8")).toBe(writesAfterCancellation);
		const supplemental = JSON.parse(
			await readFile(
				join(directory, `supplemental-owned-process-identities-${attempt.verificationExecutionAttemptId}.json`),
				"utf8",
			),
		);
		expect(supplemental.ownedProcesses.map((entry: { pid: number }) => entry.pid)).toContain(
			Number(await readFile(descendantPidPath, "utf8")),
		);
	});
});
