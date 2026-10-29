import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromCheckout = createRequire(import.meta.url);
const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const sourceModuleImportExitDeadline = {
	waitedForDescription: "真实 Node/tsx ESM 子进程完成 Codex 原生转录预检",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};
const sourceModuleImportTestTimeoutMs = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 0,
	testBodyTimeoutBudgetMs: 10_000,
	cliChildProcessSpawns: {
		cliChildProcessSpawnCount: 1,
		cliChildProcessExitTwoTierDeadline: sourceModuleImportExitDeadline,
	},
});

afterEach(async () => {
	await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe("Codex 原生转录预检的源码 ESM 入口", { timeout: sourceModuleImportTestTimeoutMs }, () => {
	it("真实 Node/tsx 导入后仍只接受身份匹配的持久主会话转录", async (testContext) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const nativeSessionId = "019c889d-e9fa-71c3-98ed-9e6708a7bc57";
		const scenarios = [
			{ directoryName: "persistent-main-conversation", id: nativeSessionId, source: "cli", accepted: true },
			{
				directoryName: "different-native-conversation",
				id: "different-native-session",
				source: "cli",
				accepted: false,
			},
			{
				directoryName: "background-memory-conversation",
				id: nativeSessionId,
				source: "memory_consolidation",
				accepted: false,
			},
		];
		const requests = [];
		const expectedTranscriptPaths = [];
		for (const scenario of scenarios) {
			const codexHomeDirectoryPath = join(fixture.fixtureRootDirectoryPath, scenario.directoryName);
			const sessionsDirectoryPath = join(codexHomeDirectoryPath, "sessions");
			await mkdir(sessionsDirectoryPath, { recursive: true });
			const transcriptPath = join(sessionsDirectoryPath, `rollout-${nativeSessionId}.jsonl`);
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: scenario.id, source: scenario.source } })}\n`,
			);
			requests.push({
				nativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: codexHomeDirectoryPath },
			});
			expectedTranscriptPaths.push(scenario.accepted ? transcriptPath : null);
		}
		const sourceModuleUrl = pathToFileURL(
			resolve("src/agent-session-history/codex-native-conversation-transcript-location-for-resume.ts"),
		).href;
		// 保留真实 ESM 静态导入边界；Vitest 的模块转译不能替代源码 CLI 的 Node 装载行为。
		const childSource = [
			`import { inspectCodexNativeConversationTranscriptBeforeResume } from ${JSON.stringify(sourceModuleUrl)};`,
			"const observedTranscriptPaths = [];",
			`for (const request of ${JSON.stringify(requests)}) {`,
			"  const inspection = await inspectCodexNativeConversationTranscriptBeforeResume(request);",
			"  observedTranscriptPaths.push(inspection.persistedTranscriptPath);",
			"}",
			"process.stdout.write(JSON.stringify(observedTranscriptPaths));",
		].join("\n");
		const child = childProcesses.register(
			spawn(
				process.execPath,
				[
					"--import",
					pathToFileURL(requireFromCheckout.resolve("tsx")).href,
					"--input-type=module",
					"--eval",
					childSource,
				],
				{
					cwd: fixture.fixtureRootDirectoryPath,
					env: fixture.createIsolatedChildProcessEnvironment(),
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
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
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
			testContext,
			child,
			sourceModuleImportExitDeadline,
			{
				describeChildProcessOutputForFailureMessage: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
			},
		);
		await childPipesClosed;
		expect(child.exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual(expectedTranscriptPaths);
	});
});
