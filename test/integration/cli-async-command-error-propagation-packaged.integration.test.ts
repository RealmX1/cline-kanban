import { spawn } from "node:child_process";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import type { LoadSensitiveDeadlineAnnotatingTestContext } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const spawnedCliProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const cliExitDeadline = {
	waitedForDescription: "打包 CLI 完整报告异步命令结果并退出",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};
const packagedCliTestTimeoutMs = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 1,
	testBodyTimeoutBudgetMs: 30_000,
	cliChildProcessSpawns: { cliChildProcessSpawnCount: 4, cliChildProcessExitTwoTierDeadline: cliExitDeadline },
});
async function buildPackagedCli(fixture: IsolatedGitTestWorkspaceFixture): Promise<string> {
	const packageDirectory = join(fixture.fixtureRootDirectoryPath, "packaged-cli");
	await mkdir(packageDirectory);
	await symlink(resolve("node_modules"), join(packageDirectory, "node_modules"), "dir");
	// HTTP 只验证 API；页面内容不参与本测试，仍提供真实 server 必需的静态入口与数据库 worker。
	await mkdir(join(packageDirectory, "web-ui/assets"), { recursive: true });
	await writeFile(join(packageDirectory, "web-ui/index.html"), "<!doctype html><title>隔离 CLI 回归</title>");
	for (const worker of [
		"notifications/notification-lifecycle-database-worker.mjs",
		"inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
	]) {
		await copyFile(resolve("src", worker), join(packageDirectory, worker.split("/").at(-1) ?? ""));
	}
	const packagedCliEntrypoint = join(packageDirectory, "cli.js");
	await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
	// 与生产构建相同的真实 CLI 入口、bundle、原生 external 与 CJS shim；不替换命令或 runtime。
	await build({
		entryPoints: [resolve("src/cli.ts")],
		outfile: packagedCliEntrypoint,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"],
		define: { "process.env.NODE_ENV": '"production"' },
		banner: {
			js: 'import { createRequire as __kanban_createRequire } from "node:module"; const require = __kanban_createRequire(import.meta.url);',
		},
	});
	return packagedCliEntrypoint;
}

afterEach(async () => {
	await spawnedCliProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

async function runPackagedCli(input: {
	testContext: LoadSensitiveDeadlineAnnotatingTestContext;
	fixture: IsolatedGitTestWorkspaceFixture;
	projectPath: string;
	args: string[];
	packagedCliEntrypoint: string;
	runtimePort?: string;
	environmentVariableOverrides?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const child = spawnedCliProcesses.register(
		spawn(process.execPath, [input.packagedCliEntrypoint, ...input.args], {
			cwd: input.projectPath,
			env: input.fixture.createIsolatedChildProcessEnvironment({
				KANBAN_RUNTIME_HOST: "127.0.0.1",
				KANBAN_RUNTIME_PORT: input.runtimePort,
				KANBAN_CLI_HARD_TIMEOUT_MS: undefined,
				KANBAN_CLI_TRPC_TIMEOUT_MS: undefined,
				...input.environmentVariableOverrides,
			}),
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	let stdout = "";
	let stderr = "";
	const childPipesClosed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(input.testContext, child, cliExitDeadline, {
		describeChildProcessOutputForFailureMessage: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
	});
	await childPipesClosed;
	return { exitCode: child.exitCode, stdout, stderr };
}

describe("真实打包 CLI 的异步异常传播", { timeout: packagedCliTestTimeoutMs }, () => {
	it("未注册项目的 capture 命令保留错误正文并以 1 退出", async (testContext) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const packagedCliEntrypoint = await buildPackagedCli(fixture);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "unregistered-project" });
		const result = await runPackagedCli({
			testContext,
			fixture,
			packagedCliEntrypoint,
			projectPath: repository.repositoryPath,
			args: [
				"task",
				"capture-rvf-review-start-boundary",
				"--project-path",
				repository.repositoryPath,
				"--task-id",
				"isolated-missing-task",
				"--decision-token",
				"0123456789abcdef",
			],
		});
		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Kanban 执行失败：");
		expect(result.stderr).toContain(repository.repositoryPath);
	});

	it("真实 runtime 的 capture 拒绝不假成功，正常大 JSON 输出不截断，server 保持运行", async (testContext) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const packagedCliEntrypoint = await buildPackagedCli(fixture);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "runtime-capture-rejection" });
		await writeFile(join(repository.repositoryPath, "README.md"), "# 隔离 CLI 回归\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const server = spawnedCliProcesses.register(
			spawn(process.execPath, [packagedCliEntrypoint, "--port", "auto", "--no-open"], {
				cwd: repository.repositoryPath,
				env: fixture.createIsolatedChildProcessEnvironment({
					KANBAN_RUNTIME_HOST: "127.0.0.1",
					KANBAN_RUNTIME_PORT: undefined,
					// server 调用不能安装命令型硬超时。
					KANBAN_CLI_HARD_TIMEOUT_MS: "1",
				}),
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(server);
		const runtimePort = new URL(runtimeUrl).port;
		const command = (args: string[]) =>
			runPackagedCli({
				testContext,
				fixture,
				packagedCliEntrypoint,
				projectPath: repository.repositoryPath,
				args,
				runtimePort,
			});
		const rejectedCapture = await command([
			"task",
			"capture-rvf-review-start-boundary",
			"--project-path",
			repository.repositoryPath,
			"--task-id",
			"isolated-missing-task",
			"--decision-token",
			"0123456789abcdef",
		]);
		expect(rejectedCapture.exitCode, rejectedCapture.stderr).toBe(1);
		expect(rejectedCapture.stdout).toBe("");
		expect(rejectedCapture.stderr).toContain("任务已删除或结案，自动收尾已暂停。");
		expect(rejectedCapture.stderr.match(/Kanban 执行失败：/g)).toHaveLength(1);

		const completePrompt = `大输出验证 ${"边界验证".repeat(8_000)} 末尾完整标记`;
		const created = await command([
			"task",
			"create",
			"--title",
			"隔离 CLI 输出回归",
			"--prompt",
			completePrompt,
			"--project-path",
			repository.repositoryPath,
		]);
		expect(created.exitCode, created.stdout + created.stderr).toBe(0);
		expect(JSON.parse(created.stdout).task.prompt).toBe(completePrompt);
		const listed = await command(["task", "list", "--project-path", repository.repositoryPath]);
		expect(listed.exitCode, listed.stderr).toBe(0);
		expect(JSON.parse(listed.stdout).tasks[0].prompt).toBe(completePrompt);
		expect(server.exitCode).toBeNull();
		expect(server.signalCode).toBeNull();

		let hangingRuntimeReceivedRequest = false;
		const hangingRuntime = createServer(() => {
			hangingRuntimeReceivedRequest = true;
			// 保持请求未完成，让真实 CLI 的硬超时而非 tRPC 超时结束进程。
		});
		try {
			await new Promise<void>((resolveListening) => hangingRuntime.listen(0, "127.0.0.1", resolveListening));
			const address = hangingRuntime.address();
			if (!address || typeof address === "string") throw new Error("挂起的 HTTP 测试端点没有端口。");
			const timedOut = await runPackagedCli({
				testContext,
				fixture,
				packagedCliEntrypoint,
				projectPath: repository.repositoryPath,
				args: ["task", "list", "--project-path", repository.repositoryPath],
				runtimePort: String(address.port),
				environmentVariableOverrides: { KANBAN_CLI_HARD_TIMEOUT_MS: "1500", KANBAN_CLI_TRPC_TIMEOUT_MS: "60000" },
			});
			expect(hangingRuntimeReceivedRequest).toBe(true);
			expect(timedOut.exitCode).toBe(124);
			expect(timedOut.stderr).toContain("command timed out after 1500ms");
		} finally {
			hangingRuntime.closeAllConnections();
			await new Promise<void>((resolveClosed) => hangingRuntime.close(() => resolveClosed()));
		}
	});
});
