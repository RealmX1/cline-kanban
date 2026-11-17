import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as waitBetweenRequests } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeCodexConfigurationSyncDatabase } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	loadWorkspaceContext,
	loadWorkspaceState,
	savePersistedWorkspaceSessionsById,
} from "../../src/state/workspace-state";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { prepareCodexConfigurationRecoveryScaleFixture } from "../utilities/prepare-codex-configuration-recovery-scale-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
let fixture: IsolatedGitTestWorkspaceFixture | undefined;
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
	fixture?.cleanup();
	fixture = undefined;
});
const coverageResultSchema = z.object({
	result: z.array(
		z.object({
			url: z.string(),
			functions: z.array(z.object({ functionName: z.string(), ranges: z.array(z.object({ count: z.number() })) })),
		}),
	),
});

it.for(["source", "packaged"] as const)(
	"真实 runtime（%s）在 1041 会话、3878 配置目标下使用定向接线，周期恢复期间仍响应 HTTP",
	{ timeout: 120_000 },
	async (variant, context) => {
		const packagedCliPath = process.env.KANBAN_CONFIGURATION_RECOVERY_PACKAGED_CLI_PATH;
		if (variant === "packaged" && !packagedCliPath) context.skip();
		fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "configuration-recovery-runtime-",
		});
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "configuration-recovery-runtime" });
		const sourceHome = join(fixture.isolatedHomeDirectoryPath, "isolated-codex-source");
		const sqliteHome = join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite");
		const relationsRoot = join(fixture.isolatedHomeDirectoryPath, "isolated-relations");
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CODEX_HOME", sourceHome);
		vi.stubEnv("CODEX_SQLITE_HOME", sqliteHome);
		vi.stubEnv("KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT", relationsRoot);
		const workspace = await loadWorkspaceContext(repository.repositoryPath);
		const state = await loadWorkspaceState(repository.repositoryPath);
		const { sessionCount, targetCount, sessionsByWorkspace } = await prepareCodexConfigurationRecoveryScaleFixture(
			[{ workspaceId: workspace.workspaceId, workspacePath: repository.repositoryPath }],
			sourceHome,
		);
		await savePersistedWorkspaceSessionsById(
			workspace.workspaceId,
			sessionsByWorkspace[workspace.workspaceId],
			state.revision,
		);
		await closeCodexConfigurationSyncDatabase();
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		environment.CODEX_HOME = sourceHome;
		environment.CODEX_SQLITE_HOME = sqliteHome;
		environment.KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT = relationsRoot;
		const coverageDirectory = join(fixture.fixtureRootDirectoryPath, "runtime-v8-coverage");
		environment.NODE_V8_COVERAGE = coverageDirectory;
		const child = children.register(
			spawn(
				process.execPath,
				[
					"--require",
					resolve("test/integration/shutdown-ipc-hook.cjs"),
					...(variant === "source"
						? [
								"--import",
								pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
								resolve("src/cli.ts"),
							]
						: [resolve(packagedCliPath ?? "")]),
					"--port",
					"auto",
					"--no-open",
					"--no-passcode",
				],
				{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
			),
		);
		let runtimeOutput = "";
		const retainOutput = (chunk: Buffer) => {
			runtimeOutput = `${runtimeOutput}${String(chunk)}`.slice(-16_384);
		};
		child.stdout?.on("data", retainOutput);
		child.stderr?.on("data", retainOutput);
		const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
		const requests: Array<{ startedAtEpochMs: number; elapsedMs: number }> = [];
		const observationStartedAt = performance.now();
		do {
			const startedAt = performance.now();
			const startedAtEpochMs = Date.now();
			const response = await fetch(new URL("/api/passcode/status", runtimeUrl), {
				signal: AbortSignal.timeout(10_000),
			});
			expect(response.status).toBe(200);
			await response.json();
			requests.push({ elapsedMs: performance.now() - startedAt, startedAtEpochMs });
			await waitBetweenRequests(10);
		} while (performance.now() - observationStartedAt < 8000);
		child.send({ type: "kanban.shutdown" });
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, child, {
			waitedForDescription: "隔离 runtime 优雅退出并写出原生 V8 coverage",
			softDeadlineMsExpectedOnUncontendedHost: 15_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
		});
		const coverageResults: z.infer<typeof coverageResultSchema>["result"] = [];
		for (const name of await readdir(coverageDirectory)) {
			if (!name.endsWith(".json")) continue;
			const parsed = coverageResultSchema.parse(JSON.parse(await readFile(join(coverageDirectory, name), "utf8")));
			coverageResults.push(
				...parsed.result.filter((script) =>
					/\/(?:src\/(?:server\/runtime-server|terminal\/session-manager)\.ts|dist\/cli\.js)$/.test(script.url),
				),
			);
		}
		const invocationCount = (fileSuffix: string, functionName: string) =>
			coverageResults
				.filter((script) => script.url.endsWith(fileSuffix))
				.flatMap((script) => script.functions)
				.filter((fn) => fn.functionName === functionName)
				.reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
		const measurements = {
			managerTargetedLookupCount: invocationCount(
				variant === "source" ? "/terminal/session-manager.ts" : "/dist/cli.js",
				"getSummary",
			),
			summaryCloneCount: invocationCount(
				variant === "source" ? "/terminal/session-manager.ts" : "/dist/cli.js",
				"cloneSummary",
			),
			enumerationCount: invocationCount(
				variant === "source" ? "/terminal/session-manager.ts" : "/dist/cli.js",
				"listSummaries",
			),
		};
		const maximumHttpResponseMs = Math.max(...requests.map((request) => request.elapsedMs));
		const evidenceDirectory = process.env.KANBAN_CONFIGURATION_RECOVERY_BENCHMARK_EVIDENCE_DIRECTORY;
		if (evidenceDirectory) {
			await mkdir(evidenceDirectory, { recursive: true });
			await writeFile(
				join(evidenceDirectory, `runtime-${variant}-function-coverage.json`),
				JSON.stringify(coverageResults, null, 2),
			);
			await writeFile(
				join(evidenceDirectory, `runtime-${variant}-integration.json`),
				JSON.stringify(
					{ sessionCount, targetCount, measurements, maximumHttpResponseMs, requests, runtimeOutput },
					null,
					2,
				),
			);
		}
		expect(measurements.enumerationCount).toBeLessThan(100);
		expect(measurements.managerTargetedLookupCount).toBeGreaterThanOrEqual(targetCount * 4);
		expect(measurements.summaryCloneCount).toBeLessThan(sessionCount * 100);
		expect(requests.length).toBeGreaterThan(1);
		await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "真实规模周期配置恢复期间的最大回环 HTTP 响应时间",
				softDeadlineMsExpectedOnUncontendedHost: 500,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 5000,
				strictAtSoftDeadlineWhenRunningInContinuousIntegration: true,
			},
			maximumHttpResponseMs,
		);
	},
);
