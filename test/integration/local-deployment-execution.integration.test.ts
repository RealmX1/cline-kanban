import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { fingerprintLocalDeploymentDistribution } from "../../src/deployment/local-deployment-distribution-manifest";
import type { LocalDeploymentExecutionManifest } from "../../src/deployment/local-deployment-execution-contract";
import { LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER } from "../../src/deployment/local-deployment-execution-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

describe("独立部署执行器真实子进程恢复", { timeout: 100_000 }, () => {
	const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
	afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

	it("发布接受后执行器退出，新进程通过真实文件摘要接续，评论失败不重启或重复登记", async (testContext) => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "isolated-deployment-source" });
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const ignoredTestResults = join(repositoryRoot, "test-results", "local-deployment-execution");
		mkdirSync(ignoredTestResults, { recursive: true });
		const executionDirectory = mkdtempSync(join(ignoredTestResults, "isolated-process-recovery-"));
		onTestFinished(() => rmSync(executionDirectory, { recursive: true, force: true }));
		const executable = join(executionDirectory, "local-deployment-execution.mjs");
		buildSync({
			entryPoints: [join(repositoryRoot, "src/deployment/local-deployment-execution-command-line.ts")],
			outfile: executable,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			external: ["better-sqlite3", "node-pty", "@napi-rs/keyring", "sharp"],
			logLevel: "silent",
			banner: {
				js: 'import { createRequire as createBundledRequire } from "node:module"; const require = createBundledRequire(import.meta.url);',
			},
		});
		const candidate = join(executionDirectory, "candidate-distribution");
		const published = join(executionDirectory, "published-distribution");
		mkdirSync(join(candidate, "web-ui/assets"), { recursive: true });
		writeFileSync(join(candidate, "cli.js"), "候选入口");
		copyFileSync(executable, join(candidate, "local-deployment-execution.js"));
		writeFileSync(join(candidate, "web-ui/assets/verified-build.js"), "候选资源");
		mkdirSync(published);
		const digest = (await fingerprintLocalDeploymentDistribution(candidate)).candidateDistributionSha256;
		const manifestPath = join(executionDirectory, "manifest.json");
		const stageProgram = join(repository.repositoryPath, "isolated-deployment-stage.cjs");
		const manifest: LocalDeploymentExecutionManifest = {
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "isolated-workspace",
			taskId: "isolated-deployment",
			originatingTaskWorktreePath: repository.repositoryPath,
			sourceCheckoutPath: repository.repositoryPath,
			deploymentNodeBinaryPath: process.execPath,
			candidateSourceCommit: "a".repeat(40),
			previousDeployedSourceCommit: null,
			candidateDistributionSha256: digest,
			candidateDistributionDirectoryPath: candidate,
			distributionDirectoryPath: published,
			runtimeIdentity: {
				runtimeHomeDirectoryPath: join(gitFixture.isolatedHomeDirectoryPath, ".cline/kanban"),
				runtimeHost: "127.0.0.1",
				runtimePort: 39884,
			},
			runtimeBefore: { processId: 100, processStartTimeText: "isolated-runtime" },
			authorization: {
				sourceReference: "test:isolated-process-only",
				userRequestQuote: "只执行隔离部署夹具，不访问生产实例",
			},
			stages: LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.map((stage) => ({
				stage,
				command: [process.execPath, stageProgram, stage],
				...(["build_publication", "runtime_restart", "deployment_record"].includes(stage)
					? {
							effectVerificationCommand:
								stage === "build_publication"
									? [
											process.execPath,
											executable,
											"verify-publication",
											"--execution-directory",
											executionDirectory,
										]
									: [process.execPath, stageProgram, "bound-effect-proof"],
						}
					: {}),
			})),
		};
		writeFileSync(manifestPath, JSON.stringify(manifest));
		writeFileSync(
			stageProgram,
			`const fs = require('node:fs'); const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, 'utf8'));
const stage = process.argv[2];
if (stage === 'bound-effect-proof') {
 process.stdout.write(JSON.stringify({ok:true,executionId:manifest.executionId,candidateSourceCommit:manifest.candidateSourceCommit,candidateDistributionSha256:manifest.candidateDistributionSha256}));
} else {
 fs.appendFileSync(${JSON.stringify(join(executionDirectory, "executed-stages.txt"))}, stage + '\\n');
 if (stage === 'build_publication') {
  fs.cpSync(manifest.candidateDistributionDirectoryPath, manifest.distributionDirectoryPath, { recursive: true });
  process.kill(process.ppid, 'SIGKILL');
 }
 if (stage === 'task_comment') process.exitCode = 1;
}
`,
		);
		async function invoke(arguments_: string[]) {
			const child = children.register(
				spawn(process.execPath, [executable, ...arguments_], {
					cwd: repository.repositoryPath,
					stdio: ["ignore", "pipe", "pipe"],
					env: gitFixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: join(gitFixture.isolatedHomeDirectoryPath, ".codex"),
						CODEX_SQLITE_HOME: join(gitFixture.isolatedHomeDirectoryPath, ".codex"),
					}),
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const closed = new Promise<void>((resolveClosed, reject) => {
				child.once("close", () => resolveClosed());
				child.once("error", reject);
			});
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
				testContext,
				child,
				{
					softDeadlineMsExpectedOnUncontendedHost: 10_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
					waitedForDescription: "部署隔离 CLI 子进程退出",
				},
				{ describeChildProcessOutputForFailureMessage: () => `${stdout}\n${stderr}` },
			);
			await closed;
			return { exitCode: child.exitCode, signal: child.signalCode, stdout, stderr };
		}
		const initialized = await invoke([
			"initialize",
			"--execution-directory",
			executionDirectory,
			"--manifest-file",
			manifestPath,
		]);
		expect(initialized.exitCode, JSON.stringify(initialized)).toBe(0);
		expect((await invoke(["prepare-owned-command", "--execution-directory", executionDirectory])).exitCode).toBe(0);
		const ownedSpecification = JSON.parse(
			readFileSync(join(executionDirectory, "owned-command-specification.json"), "utf8"),
		);
		expect(ownedSpecification.resumeCommandPreservesBusinessSingleFlight).toBe(true);
		expect(ownedSpecification.command).toEqual(ownedSpecification.resumeCommand);
		expect(ownedSpecification.command[1]).toBe(join(executionDirectory, "frozen-local-deployment-executor.mjs"));
		expect(ownedSpecification.readOnlyRecoveryEvidenceObservationCommand).toEqual([
			process.execPath,
			join(executionDirectory, "frozen-local-deployment-executor.mjs"),
			"observe-recovery-evidence",
			"--execution-directory",
			executionDirectory,
		]);
		const first = await invoke(["run", "--execution-directory", executionDirectory]);
		expect(first.signal).toBe("SIGKILL");
		// 旧执行器已经退出，内核锁由操作系统释放；不修改不存在的旧租约目录。
		const resumed = await invoke(["run", "--execution-directory", executionDirectory]);
		expect(resumed.stderr).not.toContain("Error");
		expect(resumed.exitCode).toBe(0);
		expect(JSON.parse(resumed.stdout)).toMatchObject({
			deploymentOutcome: "succeeded",
			ancillaryFailures: ["task_comment"],
			retrospective: { status: "pending" },
		});
		const stageExecutions = readFileSync(join(executionDirectory, "executed-stages.txt"), "utf8").trim().split("\n");
		for (const stage of ["build_publication", "runtime_restart", "deployment_record"])
			expect(stageExecutions.filter((item) => item === stage)).toHaveLength(1);
		const original = readFileSync(join(executionDirectory, "local-deployment-execution.json"), "utf8");
		const analysis = await invoke(["analyze", "--execution-directory", executionDirectory]);
		expect(analysis.exitCode).toBe(0);
		expect(JSON.parse(analysis.stdout).executions[0].metrics.recoveredEffects).toBe(1);
		expect(JSON.parse(analysis.stdout).executions[0].metrics.verifiedStageEffects).toBe(3);
		expect(readFileSync(join(executionDirectory, "local-deployment-execution.json"), "utf8")).toBe(original);
		// 多余旧顶层文件不妨碍核对候选；候选中的任何真实内容变化均须被检测。
		writeFileSync(join(published, "unrelated-existing-file.txt"), "原有文件");
		expect((await invoke(["verify-publication", "--execution-directory", executionDirectory])).exitCode).toBe(0);
		writeFileSync(join(published, "web-ui/assets/stale-owned-build.js"), "陈旧构建资源");
		expect((await invoke(["verify-publication", "--execution-directory", executionDirectory])).exitCode).toBe(2);
		rmSync(join(published, "web-ui/assets/stale-owned-build.js"));
		const registeredGroup = {
			deploymentId: manifest.executionId,
			workspaceId: manifest.workspaceId,
			deployedSourceCommit: manifest.candidateSourceCommit,
			previousDeployedSourceCommit: manifest.previousDeployedSourceCommit,
			deployedAtIso: "2026-10-31T12:00:00Z",
			foldedAtIso: null,
		};
		const laterAcceptedGroup = {
			deploymentId: "cf2574ad-9e8a-496c-b842-9cab57aa815a",
			workspaceId: "another-isolated-workspace",
			deployedSourceCommit: "d".repeat(40),
			previousDeployedSourceCommit: manifest.candidateSourceCommit,
			deployedAtIso: "2026-10-31T11:00:00Z",
			foldedAtIso: null,
		};
		writeFileSync(
			join(manifest.runtimeIdentity.runtimeHomeDirectoryPath, "post-deploy-verification-state.json"),
			JSON.stringify({ deploymentGroups: [laterAcceptedGroup, registeredGroup] }),
		);
		writeFileSync(
			join(manifest.runtimeIdentity.runtimeHomeDirectoryPath, "last-deployed-source-commit.json"),
			JSON.stringify(laterAcceptedGroup),
		);
		expect((await invoke(["verify-deployment-record", "--execution-directory", executionDirectory])).exitCode).toBe(
			0,
		);
		expect(
			JSON.parse(readFileSync(join(executionDirectory, "owned-command-business-result.json"), "utf8")),
		).toMatchObject({ disposition: "agent_review_ready", deploymentExecutionId: manifest.executionId });
		const recoveredRestartDirectory = join(executionDirectory, "restart-accepted-before-worker-exit");
		mkdirSync(recoveredRestartDirectory);
		const recoveredManifest = {
			...manifest,
			schemaVersion: 2,
			runtimeStartingState: "verified_online",
			runtimeStartingStateEvidenceFilePath: join(recoveredRestartDirectory, "runtime-baseline.json"),
			redeploymentRequestSha256: "b".repeat(64),
		};
		const recoveredManifestPath = join(recoveredRestartDirectory, "manifest.json");
		writeFileSync(recoveredManifestPath, JSON.stringify(recoveredManifest));
		mkdirSync(join(repository.repositoryPath, "scripts"));
		const readinessPath = join(
			repository.repositoryPath,
			"scripts/verify-agent-session-pty-host-runtime-readiness.mjs",
		);
		const readiness = {
			ok: true,
			runtimeIdentity: manifest.runtimeIdentity,
			runtimeProcessId: 200,
			runtimeProcessStartTimeText: "已核验后继进程",
			runtimeLoadedEntrypointSha256: createHash("sha256")
				.update(readFileSync(join(candidate, "cli.js")))
				.digest("hex"),
			validatedHostedSessions: [{ conversationSessionId: "原会话接受证据" }],
		};
		writeFileSync(readinessPath, `process.stdout.write(JSON.stringify(${JSON.stringify(readiness)}));`);
		expect(
			(
				await invoke([
					"initialize",
					"--execution-directory",
					recoveredRestartDirectory,
					"--manifest-file",
					recoveredManifestPath,
				])
			).exitCode,
		).toBe(0);
		const verifyRestart = () =>
			invoke(["verify-runtime-restart", "--execution-directory", recoveredRestartDirectory]);
		expect((await verifyRestart()).exitCode).toBe(0);
		const acceptancePath = join(recoveredRestartDirectory, "runtime-restart-acceptance.json");
		const recoveredAcceptance = readFileSync(acceptancePath, "utf8");
		expect(JSON.parse(recoveredAcceptance)).toMatchObject({
			executionId: manifest.executionId,
			candidateDistributionSha256: manifest.candidateDistributionSha256,
			runtime: readiness,
		});
		// 当前已回收的会话不能覆盖首次补证取得的真实接受快照。
		writeFileSync(
			readinessPath,
			`process.stdout.write(JSON.stringify(${JSON.stringify({ ...readiness, validatedHostedSessions: [] })}));`,
		);
		expect((await verifyRestart()).exitCode).toBe(0);
		expect(readFileSync(acceptancePath, "utf8")).toBe(recoveredAcceptance);
		const recoveredRecordPath = join(recoveredRestartDirectory, "local-deployment-execution.json");
		const recoveredRecord = JSON.parse(readFileSync(recoveredRecordPath, "utf8"));
		const restartIntentAtEpochMs = recoveredRecord.createdAtEpochMs;
		recoveredRecord.observations.push({
			sequence: recoveredRecord.observations.length + 1,
			stage: "runtime_restart",
			kind: "command_execution_intent_persisted",
			observedAtEpochMs: restartIntentAtEpochMs,
			attemptNumber: 1,
			recoveryEvidenceSha256: "d".repeat(64),
			exitCode: null,
			commandOutputDirectory: join(recoveredRestartDirectory, "interrupted-runtime-restart-stage"),
			detail: "模拟 readiness 已成功而接受快照尚未写入时执行器退出",
		});
		writeFileSync(recoveredRecordPath, JSON.stringify(recoveredRecord));
		writeFileSync(
			join(recoveredRestartDirectory, "runtime-restart-target-baseline.json"),
			JSON.stringify({
				state: "verified_online",
				runtimeBefore: { processId: 150, processStartTimeText: "实际 交接前 代际" },
			}),
		);
		const readinessIntent = {
			requestSha256: recoveredManifest.redeploymentRequestSha256,
			command: [process.execPath, readinessPath, "--candidate-source-commit", manifest.candidateSourceCommit],
			cwd: manifest.sourceCheckoutPath,
			startedAtEpochMs: restartIntentAtEpochMs + 10,
		};
		const readinessResult = { ...readinessIntent, exitCode: 0, finishedAtEpochMs: restartIntentAtEpochMs + 20 };
		const immutableReadinessOriginals = new Map<string, string>();
		const createReadinessOriginal = (
			name: string,
			{
				intentOverrides = {},
				resultOverrides = {},
				runtimeOverrides = {},
			}: {
				intentOverrides?: Partial<typeof readinessIntent>;
				resultOverrides?: Partial<typeof readinessResult>;
				runtimeOverrides?: Partial<typeof readiness>;
			} = {},
		) => {
			const originalDirectory = join(
				recoveredRestartDirectory,
				"standard-command-originals",
				`current-runtime-readiness-${name}`,
			);
			mkdirSync(originalDirectory, { recursive: true });
			for (const [filename, value] of Object.entries({
				"intent.json": { ...readinessIntent, ...intentOverrides },
				"result.json": { ...readinessResult, ...resultOverrides },
				"stdout.txt": { ...readiness, ...runtimeOverrides },
			})) {
				const originalPath = join(originalDirectory, filename);
				const originalBytes = JSON.stringify(value);
				writeFileSync(originalPath, originalBytes);
				immutableReadinessOriginals.set(originalPath, originalBytes);
			}
			return originalDirectory;
		};
		createReadinessOriginal("wrong-intent-request", { intentOverrides: { requestSha256: "e".repeat(64) } });
		createReadinessOriginal("wrong-result-request", { resultOverrides: { requestSha256: "e".repeat(64) } });
		const wrongCandidateCommand = [...readinessIntent.command.slice(0, 3), "e".repeat(40)];
		createReadinessOriginal("wrong-command-candidate", {
			intentOverrides: { command: wrongCandidateCommand },
			resultOverrides: { command: wrongCandidateCommand },
		});
		createReadinessOriginal("wrong-loaded-candidate", {
			runtimeOverrides: { runtimeLoadedEntrypointSha256: "e".repeat(64) },
		});
		createReadinessOriginal("wrong-node", {
			intentOverrides: { command: ["/another/node", ...readinessIntent.command.slice(1)] },
			resultOverrides: { command: ["/another/node", ...readinessIntent.command.slice(1)] },
		});
		createReadinessOriginal("wrong-cwd", {
			intentOverrides: { cwd: recoveredRestartDirectory },
			resultOverrides: { cwd: recoveredRestartDirectory },
		});
		createReadinessOriginal("before-restart-intent", {
			intentOverrides: { startedAtEpochMs: restartIntentAtEpochMs - 2 },
			resultOverrides: {
				startedAtEpochMs: restartIntentAtEpochMs - 2,
				finishedAtEpochMs: restartIntentAtEpochMs - 1,
			},
		});
		createReadinessOriginal("invalid-finish-time", {
			resultOverrides: { finishedAtEpochMs: restartIntentAtEpochMs + 5 },
		});
		createReadinessOriginal("failed-command", { resultOverrides: { exitCode: 1 } });
		createReadinessOriginal("candidate-loaded-but-target-runtime-not-restarted", {
			runtimeOverrides: { runtimeProcessId: 150, runtimeProcessStartTimeText: "  实际   交接前 代际  " },
		});
		rmSync(acceptancePath);
		expect((await verifyRestart()).exitCode).toBe(0);
		const currentOnlyAcceptance = JSON.parse(readFileSync(acceptancePath, "utf8"));
		expect(currentOnlyAcceptance.runtime.validatedHostedSessions).toEqual([]);
		expect(currentOnlyAcceptance.readinessCommandOriginalDirectoryPath).toBeUndefined();
		// 模拟同一 crash 窗口：尚无接受快照，当前会话已回收，成功原件仍完整保留。
		const earliestOriginalDirectory = createReadinessOriginal("earliest-valid-success");
		createReadinessOriginal("later-valid-success", {
			intentOverrides: { startedAtEpochMs: restartIntentAtEpochMs + 30 },
			resultOverrides: {
				startedAtEpochMs: restartIntentAtEpochMs + 30,
				finishedAtEpochMs: restartIntentAtEpochMs + 40,
			},
			runtimeOverrides: { validatedHostedSessions: [] },
		});
		rmSync(acceptancePath);
		expect((await verifyRestart()).exitCode).toBe(0);
		const recoveredHistoricalAcceptance = readFileSync(acceptancePath, "utf8");
		expect(JSON.parse(recoveredHistoricalAcceptance)).toMatchObject({
			readinessCommandOriginalDirectoryPath: earliestOriginalDirectory,
			observedAtEpochMs: readinessResult.finishedAtEpochMs,
			runtime: readiness,
		});
		expect((await verifyRestart()).exitCode).toBe(0);
		expect(readFileSync(acceptancePath, "utf8")).toBe(recoveredHistoricalAcceptance);
		for (const [originalPath, originalBytes] of immutableReadinessOriginals)
			expect(readFileSync(originalPath, "utf8")).toBe(originalBytes);
		writeFileSync(acceptancePath, JSON.stringify({ ...JSON.parse(recoveredAcceptance), executionId: "另一执行" }));
		expect((await verifyRestart()).exitCode).toBe(1);
		expect(JSON.parse(readFileSync(acceptancePath, "utf8")).executionId).toBe("另一执行");
	});
});
