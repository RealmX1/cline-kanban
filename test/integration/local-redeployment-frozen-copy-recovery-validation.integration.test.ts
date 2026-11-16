import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
	localRedeploymentRequestSchema,
	localRedeploymentSha256,
} from "../../src/deployment/local-redeployment-preparation";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

describe("冻结复制实现的相关恢复验证", { timeout: 120_000 }, () => {
	const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
	afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());
	it("稳定相对链接不解锁旧复制器，实际冻结修复的隔离回归通过后才提供恢复证据", async (testContext) => {
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const parent = join(repositoryRoot, "test-results", "frozen-copy-recovery-validation");
		await mkdir(parent, { recursive: true });
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "copy-validation-",
			fixtureRootParentDirectoryPath: parent,
		});
		onTestFinished(fixture.cleanup);
		for (const variant of ["original_copy_semantics", "verified_preserving_copy_semantics"]) {
			const directory = join(await realpath(fixture.fixtureRootDirectoryPath), variant);
			await mkdir(directory);
			const executor = join(directory, "frozen-local-redeployment-executor.mjs");
			const module = join(repositoryRoot, "src/deployment/local-redeployment-failure-recovery-evidence.ts");
			await build({
				stdin: {
					contents: `import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {validateFrozenLocalRedeploymentBackupCopyIdentity,observeLocalRedeploymentBlockingFailureRecovery} from ${JSON.stringify(module)};const directory=process.argv[2];const failure={classification:'copy_identity_mismatch',logicalResource:join(directory,'LICENSE'),sourcePath:join(directory,'LICENSE'),originalErrorReference:join(directory,'original-error.json'),recoveryCondition:'实际冻结复制回归通过'};const before=await observeLocalRedeploymentBlockingFailureRecovery(directory,failure);await validateFrozenLocalRedeploymentBackupCopyIdentity(directory);const after=await observeLocalRedeploymentBlockingFailureRecovery(directory,failure);process.stdout.write(JSON.stringify({before,after,receipt:JSON.parse(await readFile(join(directory,'backup-copy-identity-isolated-validation.json'),'utf8'))}));`,
					resolveDir: repositoryRoot,
					loader: "ts",
				},
				outfile: executor,
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				external: ["better-sqlite3", "node-pty", "@napi-rs/keyring", "sharp"],
				banner: {
					js: 'import {createRequire as bundledRequire} from "node:module";const require=bundledRequire(import.meta.url);',
				},
				logLevel: "silent",
				plugins: [
					{
						name: "isolated-copy-semantics-variant",
						setup(plugin) {
							plugin.onLoad({ filter: /local-redeployment-state-preservation\.ts$/ }, async (args) => {
								// 仅在隔离 bundle 中模拟旧复制器与已修复复制器，不改仓库中的备份实现。
								const original = (await readFile(args.path, "utf8")).replace(
									/verbatimSymlinks:\s*true\s*,?/gu,
									"",
								);
								return {
									contents:
										variant === "original_copy_semantics"
											? original
											: original.replaceAll(
													"dereference: false",
													"dereference: false, verbatimSymlinks: true",
												),
									loader: "ts",
								};
							});
						},
					},
				],
			});
			await symlink("COPYING", join(directory, "LICENSE"));
			const request = localRedeploymentRequestSchema.parse({
				schemaVersion: 1,
				executionId: randomUUID(),
				workspaceId: "isolated-copy-validation",
				taskId: "isolated-copy-validation",
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
				authorization: { sourceReference: "test:isolated-copy-validation", userRequestQuote: "仅隔离复制验证" },
			});
			await writeFile(
				join(directory, "frozen-redeployment-request.json"),
				JSON.stringify({
					request,
					requestSha256: localRedeploymentSha256(JSON.stringify(request)),
					executorSha256: localRedeploymentSha256(await readFile(executor)),
					npmCliEntrypointPath: process.execPath,
					serviceExecutableSha256: "b".repeat(64),
					owner: null,
				}),
			);
			const child = children.register(
				spawn(process.execPath, [executor, directory], {
					cwd: directory,
					env: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-home"),
						CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite-home"),
					}),
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (bytes) => {
				stdout += bytes;
			});
			child.stderr?.on("data", (bytes) => {
				stderr += bytes;
			});
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, {
				waitedForDescription: "隔离冻结复制回归退出",
				softDeadlineMsExpectedOnUncontendedHost: 10_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
			});
			expect(child.exitCode, stderr).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.before.recoveryEvidenceReady).toBe(false);
			expect(result.after.recoveryEvidenceReady).toBe(variant === "verified_preserving_copy_semantics");
			expect(result.receipt.status).toBe(variant === "verified_preserving_copy_semantics" ? "passed" : "failed");
		}
	});
});
