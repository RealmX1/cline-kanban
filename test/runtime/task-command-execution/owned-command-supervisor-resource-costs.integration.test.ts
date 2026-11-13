import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelOwnedCommandProcesses } from "../../../src/task-command-execution/task-command-execution-supervisor";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "../../integration/runtime-integration-test-spawned-child-process-lifecycle";
import {
	judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline,
	type LoadSensitiveDeadlineAnnotatingTestContext,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createTempDir } from "../../utilities/temp-dir";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
let isolatedHome: ReturnType<typeof createTempDir>;
let isolatedResourceMeasurementChildProcessEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
	isolatedHome = createTempDir("command-supervision-resource-regression-");
	isolatedResourceMeasurementChildProcessEnvironment = {
		PATH: process.env.PATH,
		HOME: isolatedHome.path,
		USERPROFILE: isolatedHome.path,
		CODEX_HOME: isolatedHome.path,
		CODEX_SQLITE_HOME: isolatedHome.path,
		TMPDIR: isolatedHome.path,
		LC_ALL: "C",
	};
});
afterEach(async () => {
	await cancelOwnedCommandProcesses(
		{
			workspaceId: "isolated",
			executionId: "isolated",
			launchNonce: "latency-measurement",
			previousLaunchNonces: [],
			revocationFile: join(isolatedHome.path, "cancel.json"),
			specification: { workingDirectory: isolatedHome.path },
		},
		{ artifactDirectory: isolatedHome.path, skipProducerCancelCommand: true },
	);
	await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.restoreAllMocks();
	isolatedHome.cleanup();
});

it.for(["completed", "cancelled"] as const)(
	"真实命令 %s 的完成与撤销发现延迟有界",
	{ timeout: 30_000 },
	async (scenario, context) => {
		const sourceFile = await readFile("src/task-command-execution/task-command-execution-supervisor.ts", "utf8");
		const source = sourceFile.split("const supervisorSource = String.raw`")[1]?.split("`;\n")[0];
		if (!source) throw new Error("未找到真实监督入口");
		const entrypoint = join(isolatedHome.path, "supervisor.mjs");
		const materialsFile = join(isolatedHome.path, "materials.json");
		const readyFile = join(isolatedHome.path, "ready.json");
		const eventFile = join(isolatedHome.path, "command-event.json");
		const revocationFile = join(isolatedHome.path, "cancel.json");
		const childSource = `const fs=require('node:fs');const event=()=>fs.writeFileSync(process.argv[2],String(Date.now()));fs.writeFileSync(process.argv[1],'ready');${scenario === "completed" ? "setTimeout(()=>{event();process.exit(0)},1000);" : "process.on('SIGTERM',event);setInterval(()=>{},1000);"}`;
		await writeFile(entrypoint, source);
		await writeFile(
			materialsFile,
			JSON.stringify({
				directory: isolatedHome.path,
				launchNonce: "latency-measurement",
				executionId: "latency-measurement",
				revocationFile,
				workingDirectory: isolatedHome.path,
				command: [process.execPath, "-e", childSource, readyFile, eventFile],
			}),
		);
		const child = childProcesses.register(
			spawn(process.execPath, [entrypoint, materialsFile], {
				cwd: isolatedHome.path,
				env: isolatedResourceMeasurementChildProcessEnvironment,
				stdio: "ignore",
			}),
		);
		const eventExists = async (path: string) => {
			try {
				await readFile(path);
				return true;
			} catch {
				return false;
			}
		};
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "隔离命令就绪",
				softDeadlineMsExpectedOnUncontendedHost: 1000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 5000,
			},
			() => eventExists(readyFile),
		);
		const revokedAt = Date.now();
		if (scenario === "cancelled") {
			await writeFile(revocationFile, "cancel isolated measurement");
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				context,
				{
					waitedForDescription: "持久撤销至命令收到 SIGTERM",
					softDeadlineMsExpectedOnUncontendedHost: 1000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 5000,
				},
				() => eventExists(eventFile),
			);
		}
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, child, {
			waitedForDescription: "所属命令及监督者退出",
			softDeadlineMsExpectedOnUncontendedHost: 3000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 10_000,
		});
		expect(child.exitCode).toBe(0);
		const progress = JSON.parse(
			await readFile(join(isolatedHome.path, "supervisor-progress-latency-measurement.json"), "utf8"),
		);
		expect(progress.status).toBe(scenario === "completed" ? "exited" : "cancelled");
		const commandEventAt = Number(await readFile(eventFile, "utf8"));
		await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription:
					scenario === "completed" ? "正文退出至监督者终结原件" : "撤销至强制终止并完成退出确认",
				softDeadlineMsExpectedOnUncontendedHost: scenario === "completed" ? 1000 : 3000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: scenario === "completed" ? 5000 : 10_000,
			},
			progress.updatedAtEpochMs - (scenario === "completed" ? commandEventAt : revokedAt),
		);
	},
);

async function runResourceMeasurement(
	context: LoadSensitiveDeadlineAnnotatingTestContext,
	executable: string,
	args: string[],
	hardDeadlineMs: number,
) {
	const child = childProcesses.register(
		spawn(executable, args, {
			cwd: process.cwd(),
			env: isolatedResourceMeasurementChildProcessEnvironment,
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
		context,
		child,
		{
			waitedForDescription: "有界隔离资源测量进程退出",
			softDeadlineMsExpectedOnUncontendedHost: hardDeadlineMs - 20_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: hardDeadlineMs,
		},
		{ describeChildProcessOutputForFailureMessage: () => output },
	);
	expect(child.exitCode, output).toBe(0);
	const measured = output.split("\n").find((line) => line.startsWith("{"));
	if (!measured) throw new Error(`资源测量未返回结构化证据：${output}`);
	return JSON.parse(measured) as Record<string, unknown>;
}

it("15 万轮等待的强制 GC 保留内存不超过 2 MiB", async (context) => {
	const result = await runResourceMeasurement(
		context,
		process.execPath,
		[
			"--expose-gc",
			join(
				"scripts",
				"task-command-supervision-resource-regression-measurements",
				"measure-pending-command-wait-retained-heap.mjs",
			),
		],
		30_000,
	);
	expect(result.retainedHeapBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
}, 40_000);

it.skipIf(process.platform === "win32")(
	"1,582 条历史和三个活体等待 60 秒的进程树 CPU 在预算内",
	async (context) => {
		const result = await runResourceMeasurement(
			context,
			"python3",
			[
				"-B",
				join(
					"scripts",
					"task-command-supervision-resource-regression-measurements",
					"measure-stable-supervisor-process-tree-cpu.py",
				),
			],
			110_000,
		);
		expect(result.status).toBe("exited");
		expect(result.historicalProcesses).toBe(1582);
		const cpuSeconds = result.supervisorAndQueryChildrenCpuSeconds;
		if (typeof cpuSeconds !== "number") throw new Error("缺少监管进程树 CPU 样本");
		await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "60 秒稳定等待消耗的进程树 CPU 毫秒",
				softDeadlineMsExpectedOnUncontendedHost: 2000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 6000,
			},
			cpuSeconds * 1000,
		);
	},
	140_000,
);
