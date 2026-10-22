import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import {
	prepareCodexNativeSessionControlHostLaunch,
	restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart,
} from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const ownedSupervisors: ChildProcess[] = [];
const deadline = {
	waitedForDescription: "隔离原生控制宿主进程启动或清理",
	softDeadlineMsExpectedOnUncontendedHost: 4_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
};

afterEach(async () => {
	for (const child of ownedSupervisors.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolveExit) => {
				const escalation = setTimeout(() => {
					child.kill("SIGKILL");
					resolveExit();
				}, 5_000);
				child.once("close", () => {
					clearTimeout(escalation);
					resolveExit();
				});
			});
		}
	}
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

async function createFixture() {
	vi.stubEnv("TMPDIR", "/tmp");
	const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kanban-native-host-" });
	const binary = join(fixture.fixtureRootDirectoryPath, "synthetic-codex");
	await copyFile(resolve("test/integration/fixtures/codex-native-control-host-fake-cli.cjs"), binary);
	await chmod(binary, 0o755);
	return { fixture, binary };
}

async function start(
	context: Awaited<ReturnType<typeof createFixture>>,
	taskId: string,
	failureMode?: string,
	conversationArguments = ["resume", "explicit-native-id"],
) {
	const environment = context.fixture.createIsolatedChildProcessEnvironment({
		KANBAN_TASK_ID: taskId,
		KANBAN_HOOK_TASK_ID: taskId,
		KANBAN_TEST_NATIVE_CONTROL_WS_MODULE_PATH: resolve("node_modules/ws"),
		KANBAN_TEST_NATIVE_CONTROL_RECORDS_DIRECTORY: context.fixture.fixtureRootDirectoryPath,
		KANBAN_TEST_NATIVE_CONTROL_FAILURE_MODE: failureMode,
		CODEX_HOME: join(context.fixture.fixtureRootDirectoryPath, "shared-codex-home"),
	});
	const launch = await prepareCodexNativeSessionControlHostLaunch({
		binary: context.binary,
		arguments: ["-c", 'developer_instructions="仅用于隔离测试"', "--model", "test-model", ...conversationArguments],
		workingDirectoryPath: context.fixture.fixtureRootDirectoryPath,
		environment,
		workspaceId: "isolated-workspace",
		conversationSessionId: taskId,
		runtimeSessionIncarnationId: randomUUID(),
	});
	if (!launch) throw new Error("隔离 CLI 应支持原生控制宿主");
	const child = children.register(
		spawn(launch.binary, launch.args, { env: environment, stdio: ["ignore", "pipe", "pipe"] }),
	);
	ownedSupervisors.push(child);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	return { launch, child, output: () => output };
}

async function waitReady(test: TestContext, host: Awaited<ReturnType<typeof start>>) {
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(test, deadline, () =>
		host.output().includes("SYNTHETIC_CODEX_TUI_READY"),
	);
}

describe.skipIf(process.platform === "win32")("独享原生控制宿主生命周期", { timeout: 80_000 }, () => {
	it("携带 bypass 的真实监督进程先恢复原生 thread，再以无权限覆盖的 TUI 接入", async (test) => {
		const context = await createFixture();
		const host = await start(context, "task-bypass-resume", undefined, [
			"--dangerously-bypass-approvals-and-sandbox",
			"resume",
			"explicit-native-id",
		]);
		await waitReady(test, host);
		const receipt = JSON.parse(
			await readFile(
				join(dirname(host.launch.args.at(-1) ?? ""), "remote-conversation-bootstrap-receipt.json"),
				"utf8",
			),
		);
		expect(receipt).toMatchObject({
			nativeSessionId: "explicit-native-id",
			effectiveApprovalPolicy: "never",
			effectiveSandbox: { type: "dangerFullAccess" },
		});
		expect(host.output()).not.toContain("Permission overrides");
	});
	it("只读 fork 的限制先经 RPC 生效，TUI 恢复新身份并保留正文", async (test) => {
		const context = await createFixture();
		const host = await start(context, "task-read-only-fork", undefined, [
			"--sandbox",
			"read-only",
			"--ask-for-approval",
			"untrusted",
			"fork",
			"source-native-id",
			"只回答问题",
		]);
		await waitReady(test, host);
		const observations = (
			await readFile(join(context.fixture.fixtureRootDirectoryPath, "process-observations.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const tui = observations.find((record) => record.kind === "tui");
		expect(tui.args.slice(-3)).toEqual(["resume", "fork-source-native-id", "只回答问题"]);
		expect(tui.args).not.toContain("--ask-for-approval");
		const requests = (await readFile(join(context.fixture.fixtureRootDirectoryPath, "native-requests.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requests.find((record) => record.method === "thread/fork")?.params).toMatchObject({
			approvalPolicy: "untrusted",
			sandbox: "read-only",
			deferGoalContinuation: true,
		});
		expect(requests.some((record) => record.method === "turn/start")).toBe(false);
	});
	it("latest 遇到原生 provider 为 null 时按 openai 选会话并启动 TUI", async (test) => {
		const context = await createFixture();
		const host = await start(context, "task-null-config-model-provider", "null-config-model-provider", [
			"resume",
			"--last",
		]);
		await waitReady(test, host);
		const requests = (await readFile(join(context.fixture.fixtureRootDirectoryPath, "native-requests.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requests.find((record) => record.method === "thread/list")?.params).toMatchObject({
			cwd: context.fixture.fixtureRootDirectoryPath,
			modelProviders: ["openai"],
			sourceKinds: ["cli", "vscode"],
			useStateDbOnly: true,
		});
		expect(requests.find((record) => record.method === "thread/resume")?.params.threadId).toBe("latest-native-id");
		const receipt = JSON.parse(
			await readFile(
				join(dirname(host.launch.args.at(-1) ?? ""), "remote-conversation-bootstrap-receipt.json"),
				"utf8",
			),
		);
		expect(receipt.nativeSessionId).toBe("latest-native-id");
		expect(host.output()).not.toContain("Kanban 原生控制宿主失败");
		expect(requests.some((record) => record.method === "turn/start" || record.method === "thread/start")).toBe(false);
	});
	it("latest 无目标时不启动 TUI，并清理失败宿主", async (test) => {
		const context = await createFixture();
		const host = await start(context, "task-missing-latest", "no-resume-candidate", ["resume", "--last"]);
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, host.child, deadline);
		expect(host.output()).toContain("没有可接续的 Codex 会话");
		await expect(stat(dirname(host.launch.endpoint.socketPath))).rejects.toThrow();
	});
	it("原生端拒绝收紧权限时不投递正文，清理失败代", async (test) => {
		const context = await createFixture();
		const host = await start(context, "refused-permissions", "refused-permissions", [
			"-s",
			"read-only",
			"resume",
			"source-id",
			"不得在高权限下投递的正文",
		]);
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, host.child, deadline);
		expect(host.output()).toContain("有效权限与任务要求不一致");
		expect(host.output()).not.toContain("SYNTHETIC_CODEX_TUI_READY");
		await expect(stat(dirname(host.launch.endpoint.socketPath))).rejects.toThrow();
		await expect(stat(dirname(host.launch.args.at(-1) ?? ""))).rejects.toThrow();
	});
	it("恢复 RPC 未返回时停止监督进程会取消连接并回收资源", async (test) => {
		const context = await createFixture();
		const host = await start(context, "stalled-resume", "stalled-resume");
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(test, deadline, async () =>
			(
				await readFile(join(context.fixture.fixtureRootDirectoryPath, "native-requests.jsonl"), "utf8").catch(
					() => "",
				)
			).includes('"method":"thread/resume"'),
		);
		host.child.kill("SIGTERM");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, host.child, deadline);
		expect(host.output()).not.toContain("SYNTHETIC_CODEX_TUI_READY");
		await expect(stat(dirname(host.launch.endpoint.socketPath))).rejects.toThrow();
		await expect(stat(dirname(host.launch.args.at(-1) ?? ""))).rejects.toThrow();
	});
	it("prepare 未 spawn 时可幂等清理，重复 incarnation 不覆盖原启动描述", async () => {
		const context = await createFixture();
		const input = {
			binary: context.binary,
			arguments: [],
			workingDirectoryPath: context.fixture.fixtureRootDirectoryPath,
			environment: context.fixture.createIsolatedChildProcessEnvironment(),
			workspaceId: "workspace",
			conversationSessionId: "session",
			runtimeSessionIncarnationId: randomUUID(),
		};
		const prepared = await prepareCodexNativeSessionControlHostLaunch(input);
		if (!prepared) throw new Error("隔离 CLI 应支持原生控制宿主");
		const descriptionPath = prepared.args.at(-1) ?? "";
		const originalDescription = await readFile(descriptionPath, "utf8");
		expect((await stat(descriptionPath)).mode & 0o777).toBe(0o600);
		await expect(prepareCodexNativeSessionControlHostLaunch(input)).rejects.toThrow("EEXIST");
		expect(await readFile(descriptionPath, "utf8")).toBe(originalDescription);
		await prepared.cleanup();
		await prepared.cleanup();
		await expect(stat(dirname(descriptionPath))).rejects.toThrow();
		await expect(stat(dirname(prepared.endpoint.socketPath))).rejects.toThrow();
	});
	it("接管清理重建原代所有权，拒绝跨会话端点及被替换目录", async () => {
		const context = await createFixture();
		const prepared = await prepareCodexNativeSessionControlHostLaunch({
			binary: context.binary,
			arguments: [],
			workingDirectoryPath: context.fixture.fixtureRootDirectoryPath,
			environment: context.fixture.createIsolatedChildProcessEnvironment(),
			workspaceId: "isolated-workspace",
			conversationSessionId: "owned-session",
			runtimeSessionIncarnationId: randomUUID(),
		});
		if (!prepared) throw new Error("隔离 CLI 应支持原生控制宿主");
		await expect(
			restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart({
				...prepared.endpoint,
				conversationSessionId: "another-session",
			}),
		).rejects.toThrow("不匹配");
		const restoredCleanup = await restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart(prepared.endpoint);
		if (!restoredCleanup) throw new Error("接管清理应从持久描述恢复");
		const socketDirectory = dirname(prepared.endpoint.socketPath);
		const displacedSocketDirectory = `${socketDirectory}-original-owner`;
		await rename(socketDirectory, displacedSocketDirectory);
		try {
			await mkdir(socketDirectory);
			await writeFile(join(socketDirectory, "replacement-marker"), "替换目录必须保留");
			await expect(restoredCleanup()).rejects.toThrow("已被替换");
			expect(await readFile(join(socketDirectory, "replacement-marker"), "utf8")).toBe("替换目录必须保留");
		} finally {
			await rm(socketDirectory, { recursive: true, force: true });
			await rename(displacedSocketDirectory, socketDirectory);
			await restoredCleanup();
		}
		await restoredCleanup();
		await expect(stat(dirname(prepared.args.at(-1) ?? ""))).rejects.toThrow();
		expect(await restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart(prepared.endpoint)).toBeNull();
	});
	it("共享 CODEX_HOME 的两会话隔离端点及 hook 环境，停止一方不结束另一方", async (test) => {
		const context = await createFixture();
		const first = await start(context, "task-one");
		const second = await start(context, "task-two");
		await waitReady(test, first);
		await waitReady(test, second);
		expect(first.launch.endpoint.socketPath).not.toBe(second.launch.endpoint.socketPath);
		const records = (
			await readFile(join(context.fixture.fixtureRootDirectoryPath, "process-observations.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; taskId: string; hookTaskId: string; args: string[] });
		for (const taskId of ["task-one", "task-two"]) {
			const owned = records.filter((record) => record.taskId === taskId);
			expect(owned.map((record) => record.kind).sort()).toEqual(["server", "tui"]);
			expect(owned.every((record) => record.hookTaskId === taskId)).toBe(true);
			expect(owned.find((record) => record.kind === "server")?.args).toContain(
				'developer_instructions="仅用于隔离测试"',
			);
			expect(owned.find((record) => record.kind === "tui")?.args.slice(-4)).toEqual([
				"--model",
				"test-model",
				"resume",
				"explicit-native-id",
			]);
		}
		first.child.kill("SIGTERM");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, first.child, deadline);
		await expect(stat(first.launch.endpoint.socketPath)).rejects.toThrow();
		expect(second.child.exitCode).toBeNull();
		expect((await stat(second.launch.endpoint.socketPath)).isSocket()).toBe(true);
		second.child.kill("SIGTERM");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, second.child, deadline);
		await expect(stat(dirname(second.launch.endpoint.socketPath))).rejects.toThrow();
	});
	it.for(["server-startup-failure", "server-active-failure", "tui-failure"])(
		"%s 不留下可查询旧端点或启动目录",
		async (failureMode, test) => {
			const context = await createFixture();
			const host = await start(context, "task-failure", failureMode);
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(test, host.child, deadline);
			expect(host.child.exitCode, host.output()).not.toBe(0);
			await expect(stat(dirname(host.launch.endpoint.socketPath))).rejects.toThrow();
			await expect(stat(dirname(host.launch.args.at(-1) ?? ""))).rejects.toThrow();
		},
	);
});
