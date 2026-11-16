import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { taskCommandExecutionSpecificationSchema } from "../../src/core/task-command-execution-contract";
import {
	createLocalRedeploymentOwnedCommandSpecification,
	localRedeploymentRequestSchema,
	localRedeploymentSha256,
} from "../../src/deployment/local-redeployment-preparation";
import { recoverOwnedCommandPostProcessExitCleanup } from "../../src/task-command-execution/task-command-execution-post-process-exit-cleanup";
import { taskCommandExecutionArtifactDirectory } from "../../src/task-command-execution/task-command-execution-store";
import {
	cancelOwnedCommandProcesses,
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
} from "../../src/task-command-execution/task-command-execution-supervisor";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

describe("失败尝试清理的真实退出与重启恢复", { timeout: 360_000 }, () => {
	it.for(["failure", "cancellation", "semantic_resume"] as const)(
		"%s后等待子进程退出，单独恢复清理且不重发业务命令",
		async (mode, testContext) => {
			const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
			const parent = join(repositoryRoot, "test-results", "failed-attempt-cleanup-process-recovery");
			await mkdir(parent, { recursive: true });
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "cleanup-",
				fixtureRootParentDirectoryPath: parent,
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const directory = join(await realpath(fixture.fixtureRootDirectoryPath), "persistent-deployment-execution");
			await mkdir(directory);
			const executor = join(directory, "frozen-local-redeployment-executor.mjs");
			const registrationModule = join(directory, "compiled-artifact-registration.mjs");
			const bundleOptions = {
				bundle: true,
				platform: "node" as const,
				format: "esm" as const,
				target: "node22",
				external: ["better-sqlite3", "node-pty", "@napi-rs/keyring", "sharp"],
				banner: {
					js: 'import { createRequire as bundledRequire } from "node:module"; const require = bundledRequire(import.meta.url);',
				},
				logLevel: "silent" as const,
			};
			await build({
				...bundleOptions,
				entryPoints: [join(repositoryRoot, "src/deployment/local-deployment-execution-command-line.ts")],
				outfile: executor,
			});
			await build({
				...bundleOptions,
				entryPoints: [join(repositoryRoot, "src/deployment/local-redeployment-failed-attempt-artifact-cleanup.ts")],
				outfile: registrationModule,
			});
			const request = localRedeploymentRequestSchema.parse({
				schemaVersion: 1,
				executionId: randomUUID(),
				workspaceId: "isolated-cleanup",
				taskId: "isolated-cleanup",
				originatingTaskWorktreePath: directory,
				sourceCheckoutPath: directory,
				candidateSourceCommit: "a".repeat(40),
				deploymentNodeBinaryPath: process.execPath,
				distributionDirectoryPath: join(directory, "distribution"),
				runtimeIdentity: {
					runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline/kanban"),
					runtimeHost: "127.0.0.1",
					runtimePort: 39884,
				},
				serviceLaunch: { command: [process.execPath] },
				authorization: {
					sourceReference: "test:isolated-cleanup-process-recovery",
					userRequestQuote: "仅隔离退出及清理验证",
				},
			});
			await mkdir(request.distributionDirectoryPath);
			const frozen = {
				request,
				requestSha256: localRedeploymentSha256(JSON.stringify(request)),
				executorSha256: localRedeploymentSha256(await readFile(executor)),
				npmCliEntrypointPath: process.execPath,
				serviceExecutableSha256: "b".repeat(64),
				owner: null,
			};
			await writeFile(join(directory, "frozen-redeployment-request.json"), JSON.stringify(frozen));
			const businessScript = join(directory, "isolated-failed-business-command.mjs");
			const cleanupScript = join(directory, "isolated-cleanup-recovery-command.mjs");
			const childReady = join(directory, "child-writer-ready");
			const releaseChild = join(directory, "release-child-writer");
			const releaseBusiness = join(directory, "release-business-command");
			const invocationFile = join(directory, "business-invocations.txt");
			const observationFile = join(directory, "isolated-recovery-observation.json");
			await writeFile(observationFile, JSON.stringify({ evidenceSha256: "1".repeat(64) }));
			const failedCopy = join(directory, "runtime-state-backup-capture-attempts", "incomplete-copy");
			await writeFile(
				businessScript,
				`import {spawn} from 'node:child_process';import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {setTimeout as wait} from 'node:timers/promises';import {registerLocalRedeploymentRebuildableArtifact} from ${JSON.stringify(registrationModule)};
const count=(await readFile(${JSON.stringify(invocationFile)},'utf8').catch(()=>'' )).split('\\n').filter(Boolean).length+1;
await appendFile(${JSON.stringify(invocationFile)},'业务一次\\n');await registerLocalRedeploymentRebuildableArtifact(${JSON.stringify(directory)},{kind:'runtime_state_backup_capture_collection',stage:'state_preservation',attemptNumber:count,path:${JSON.stringify(dirname(failedCopy))}});await mkdir(${JSON.stringify(failedCopy)});await writeFile(${JSON.stringify(join(failedCopy, "copied-content"))},'可重建副本');
if(count===1){const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childReady)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseChild)})){clearInterval(timer);process.exit(0);}},25);`)}],{stdio:'ignore'});child.unref();while(!existsSync(${JSON.stringify(releaseBusiness)}))await wait(25);}
if(${JSON.stringify(mode)}==='semantic_resume')await writeFile(${JSON.stringify(join(directory, "owned-command-business-result.json"))},JSON.stringify(count===1?{disposition:'machine_evidence_pending',recovery:{action:'resume_same_run',maximum_unchanged_retries:0,retry_not_before_epoch_ms:0}}:{disposition:'agent_review_ready'}));process.stderr.write('隔离业务失败原件\\n');process.exitCode=2;`,
			);
			await writeFile(
				cleanupScript,
				`import {existsSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const first=${JSON.stringify(join(directory, "cleanup-first-failure"))};if(!existsSync(first)){writeFileSync(first,'保留首次清理失败');process.exitCode=2;}else{const result=spawnSync(process.execPath,[${JSON.stringify(executor)},'cleanup-redeployment-failed-attempts','--execution-directory',${JSON.stringify(directory)}],{stdio:'inherit'});process.exitCode=result.status??2;}`,
			);
			const specification = taskCommandExecutionSpecificationSchema.parse({
				...createLocalRedeploymentOwnedCommandSpecification(directory, frozen),
				command: [process.execPath, businessScript],
				resumeCommand: [process.execPath, businessScript],
				supervisorMaintainsSemanticRecovery: mode === "semantic_resume",
				beforeSupervisorRecoveryDispatchValidationCommand: [process.execPath, "-e", "process.exitCode=0"],
				readOnlyRecoveryEvidenceObservationCommand: [
					process.execPath,
					"-e",
					`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(observationFile)},'utf8'))`,
				],
				cancelCommand: undefined,
				postProcessExitCleanupCommand: [process.execPath, cleanupScript],
			});
			await writeFile(join(directory, "owned-command-specification.json"), JSON.stringify(specification));
			const record = {
				workspaceId: request.workspaceId,
				executionId: request.executionId,
				launchNonce: randomUUID(),
				previousLaunchNonces: [] as string[],
				launchAttemptCount: 1,
				revocationFile: join(directory, "owned-execution-revocation.json"),
				specification,
			};
			const artifactDirectory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
			const cleanupDirectory = join(
				artifactDirectory,
				"post-process-exit-cleanup",
				record.launchNonce,
				"dispatch-1",
			);
			const cleanupCommand = specification.postProcessExitCleanupCommand;
			if (!cleanupCommand) throw new Error("隔离规格缺少退出后清理命令");
			const cleanupRecord = {
				...record,
				revocationFile: join(cleanupDirectory, "cleanup-revocation.json"),
				specification: {
					...specification,
					command: cleanupCommand,
					resumeCommand: cleanupCommand,
					postProcessExitCleanupCommand: undefined,
				},
			};
			const waitFor = async (name: string, predicate: () => Promise<boolean>) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					{
						waitedForDescription: name,
						softDeadlineMsExpectedOnUncontendedHost: 10_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
					},
					predicate,
					{ pollIntervalMs: 100 },
				);
			let safelyExited = false;
			try {
				const isolatedChildProcessEnvironment = Object.fromEntries(
					Object.entries(
						fixture.createIsolatedChildProcessEnvironment({
							CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-home"),
							CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite-home"),
						}),
					).filter((entry): entry is [string, string] => entry[1] !== undefined),
				);
				await launchOwnedCommandSupervisor(record, async () => undefined, {
					artifactDirectory,
					superviseProcessGroup: true,
					deadlineAtEpochMs: Date.now() + 300_000,
					environment: isolatedChildProcessEnvironment,
					semanticRecoveryObservationIntervalMs: 100,
				});
				await waitFor("业务及子进程已登记", async () => {
					if (!existsSync(childReady)) return false;
					const progress = JSON.parse(
						await readFile(join(artifactDirectory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
					);
					const childProcessId = Number(await readFile(childReady, "utf8"));
					return progress.ownedProcesses.some((process: { pid: number }) => process.pid === childProcessId);
				});
				expect(existsSync(failedCopy)).toBe(true);
				if (mode === "cancellation")
					await cancelOwnedCommandProcesses(record, { artifactDirectory, skipProducerCancelCommand: true });
				else {
					await writeFile(releaseBusiness, "允许业务命令退出");
					await waitFor("业务退出而子进程仍存活", async () => {
						const progress = JSON.parse(
							await readFile(join(artifactDirectory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
						);
						return progress.returncode === 2;
					});
					expect(existsSync(failedCopy)).toBe(true);
					expect(existsSync(join(directory, "cleanup-first-failure"))).toBe(false);
					expect(existsSync(join(directory, "failed-attempt-cleanup-evidence"))).toBe(false);
					await writeFile(releaseChild, "允许子进程退出");
				}
				if (mode === "semantic_resume") {
					await waitFor("首次失败副本在机器等待期间自动清理", async () => !existsSync(failedCopy));
					await writeFile(observationFile, JSON.stringify({ evidenceSha256: "2".repeat(64) }));
					await waitFor("同一监督者第二次派发并独立清理", async () => {
						if (
							(await readFile(invocationFile, "utf8")).trim().split("\n").length !== 2 ||
							existsSync(failedCopy)
						)
							return false;
						const cleanup = JSON.parse(
							await readFile(join(directory, "failed-attempt-artifact-cleanup.json"), "utf8"),
						);
						return (
							Object.values(cleanup.artifacts[0].deletions).filter(
								(value) => (value as { status: string }).status === "deleted",
							).length === 2
						);
					});
					await waitFor(
						"多次恢复后的原监督者退出",
						async () => (await inspectOwnedCommandSupervisor(record, { artifactDirectory })) === "exited",
					);
					const secondCleanupDirectory = join(
						artifactDirectory,
						"post-process-exit-cleanup",
						record.launchNonce,
						"dispatch-2",
					);
					await waitFor(
						"第二次派发清理监督者退出",
						async () =>
							(await inspectOwnedCommandSupervisor(cleanupRecord, {
								artifactDirectory: secondCleanupDirectory,
							})) === "exited",
					);
					const cleanup = JSON.parse(
						await readFile(join(directory, "failed-attempt-artifact-cleanup.json"), "utf8"),
					);
					expect(
						new Set(
							Object.values(cleanup.artifacts[0].deletions).map(
								(value) => (value as { evidenceFilePath: string }).evidenceFilePath,
							),
						).size,
					).toBe(2);
					safelyExited = true;
					return;
				}
				await waitFor(
					"原业务监督者退出",
					async () => (await inspectOwnedCommandSupervisor(record, { artifactDirectory })) === "exited",
				);
				await waitFor("首次清理失败原件已保存", async () => {
					try {
						const progress = JSON.parse(
							await readFile(join(cleanupDirectory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
						);
						return progress.status === "exited" && progress.returncode === 2;
					} catch {
						return false;
					}
				});
				expect(existsSync(failedCopy)).toBe(true);
				await recoverOwnedCommandPostProcessExitCleanup(record);
				await waitFor("仅恢复清理并完成删除", async () => !existsSync(failedCopy));
				await waitFor(
					"清理监督者退出",
					async () =>
						(await inspectOwnedCommandSupervisor(cleanupRecord, { artifactDirectory: cleanupDirectory })) ===
						"exited",
				);
				await recoverOwnedCommandPostProcessExitCleanup(record);
				expect(await readFile(invocationFile, "utf8")).toBe("业务一次\n");
				expect(existsSync(join(directory, "cleanup-first-failure"))).toBe(true);
				safelyExited = true;
			} finally {
				await cancelOwnedCommandProcesses(record, { artifactDirectory, skipProducerCancelCommand: true });
				await cancelOwnedCommandProcesses(cleanupRecord, {
					artifactDirectory: cleanupDirectory,
					skipProducerCancelCommand: true,
				});
				await cancelOwnedCommandProcesses(cleanupRecord, {
					artifactDirectory: join(
						artifactDirectory,
						"post-process-exit-cleanup",
						record.launchNonce,
						"dispatch-2",
					),
					skipProducerCancelCommand: true,
				});
				vi.unstubAllEnvs();
				if (safelyExited) fixture.cleanup();
			}
		},
	);
});
