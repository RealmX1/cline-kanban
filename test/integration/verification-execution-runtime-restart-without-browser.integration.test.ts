import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimePostDeployVerificationState } from "../../src/core/api-contract";
import { buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults } from "../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import {
	hasSameProcessGeneration,
	type OwnedProcessIdentity,
	readProcessIdentity,
} from "../../src/task-command-execution/task-command-execution-supervisor";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromThisTest = createRequire(import.meta.url);
const runtimeChildProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

afterEach(async () => {
	await runtimeChildProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe(
	"PDV 执行跨真实 runtime 重启自动收口",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 90_000,
		}),
	},
	() => {
		it("没有浏览器或 PDV 查询，原 attempt 继续观察且脚本只派发一次", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "verification-execution-runtime-restart",
			});
			const childEnvironment = fixture.createIsolatedChildProcessEnvironment({
				CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
				CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			});
			const startRuntime = async () => {
				const child = runtimeChildProcesses.register(
					spawn(
						process.execPath,
						[
							"--require",
							resolve("test/integration/shutdown-ipc-hook.cjs"),
							"--import",
							pathToFileURL(requireFromThisTest.resolve("tsx")).href,
							resolve("src/cli.ts"),
							"--port",
							"auto",
							"--no-open",
							"--no-passcode",
						],
						{
							cwd: repository.repositoryPath,
							env: childEnvironment,
							stdio: ["ignore", "pipe", "pipe", "ipc"],
						},
					),
				);
				const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
				return { child, origin: new URL(runtimeUrl).origin };
			};
			const firstRuntime = await startRuntime();
			const client = (workspaceId?: string) =>
				createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpLink({
							url: `${firstRuntime.origin}/api/trpc`,
							headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
						}),
					],
				});
			const workspaceId = (await client().projects.list.query()).projects.find(
				(project) => project.path === repository.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("隔离项目未登记");
			const scopedClient = client(workspaceId);
			const workspaceState = await scopedClient.workspace.getState.query();
			const taskId = "a7e01";
			const taskCreatedAtEpochMs = Date.now();
			workspaceState.board.columns
				.find((column) => column.id === "validation")
				?.cards.push({
					id: taskId,
					title: "隔离 PDV 重启恢复验证",
					prompt: "只运行本测试自己的脚本，不启动 agent",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: taskCreatedAtEpochMs,
					updatedAt: taskCreatedAtEpochMs,
				});
			await scopedClient.workspace.saveState.mutate({
				board: workspaceState.board,
				sessions: workspaceState.sessions,
				expectedRevision: workspaceState.revision,
			});
			const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban");
			const verificationId = randomUUID();
			const deploymentId = randomUUID();
			const itemId = `authored:${verificationId}`;
			const assetsDirectory = join(runtimeHome, "verifications", verificationId);
			const invocationFile = join(assetsDirectory, "script-invocations.txt");
			const completionGateFile = join(assetsDirectory, "script-completion-allowed");
			await mkdir(assetsDirectory, { recursive: true });
			await writeFile(
				join(assetsDirectory, "run.cjs"),
				`const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationFile)}, 'once\\n');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(completionGateFile)})) { clearInterval(timer); process.exit(0); } }, 25);
setTimeout(() => process.exit(92), 60000).unref();
`,
			);
			const statePath = join(runtimeHome, "post-deploy-verification-state.json");
			const state: RuntimePostDeployVerificationState = {
				deploymentGroups: [
					{
						deploymentId,
						workspaceId,
						deployedSourceCommit: "a".repeat(40),
						previousDeployedSourceCommit: null,
						deployedAtIso: new Date().toISOString(),
						foldedAtIso: null,
						tasks: [
							{
								...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
								taskId,
								postDeployVerificationTaskInstanceId: randomUUID(),
								taskIncarnationCreatedAtEpochMs: taskCreatedAtEpochMs,
								columnIdAtMatch: "validation",
								matchedCommits: [],
								inclusionReason: "validation_column",
								checklist: [
									{
										id: itemId,
										label: "同一次脚本执行跨重启完成",
										checked: false,
										source: "authored",
										kind: "automated_script",
										guidance: null,
										script: { entrypoint: "run.cjs", interpreter: "node", timeoutMs: 60_000 },
										run: null,
										cleanup: { mode: "manual", assetsDir: assetsDirectory, manualSteps: [] },
									},
								],
								verifiedAt: null,
								boardMovedToDoneAt: null,
								pendingConfirmation: null,
								droppedReason: null,
							},
						],
					},
				],
			};
			await lockedFileSystem.writeJsonFileAtomic(statePath, state, { durable: true });
			const readPersistedItem = async () => {
				const persisted = JSON.parse(await readFile(statePath, "utf8")) as RuntimePostDeployVerificationState;
				return persisted.deploymentGroups[0]?.tasks[0]?.checklist.find((item) => item.id === itemId);
			};
			let executionAttemptId: string | undefined;
			try {
				void scopedClient.deployment.runPostDeployVerificationItem
					.mutate({ deploymentId, taskId, itemId })
					.catch(() => null);
				try {
					await vi.waitFor(() => expect(readFile(invocationFile, "utf8")).resolves.toBe("once\n"), {
						timeout: 20_000,
					});
				} catch (error) {
					const pendingItem = await readPersistedItem();
					executionAttemptId = pendingItem?.run?.verificationExecutionAttemptId;
					const executionEvidence = executionAttemptId
						? await Promise.all(
								[
									"attempt.json",
									`supervisor-identity-${executionAttemptId}.json`,
									`supervisor-progress-${executionAttemptId}.json`,
									`supervisor-not-dispatched-${executionAttemptId}.json`,
								].map(async (file) => ({
									file,
									text: await readFile(
										join(runtimeHome, "verification-execution-attempts", executionAttemptId ?? "", file),
										"utf8",
									).catch((readError: unknown) => String(readError)),
								})),
							)
						: [];
					throw new Error(`脚本未派发：${JSON.stringify({ run: pendingItem?.run, executionEvidence })}`, {
						cause: error,
					});
				}
				executionAttemptId = (await readPersistedItem())?.run?.verificationExecutionAttemptId;
				expect(executionAttemptId).toBeDefined();
				await sigkillChildProcessAndWaitForExit(firstRuntime.child);
				await startRuntime();
				expect((await readPersistedItem())?.run?.verificationExecutionAttemptId).toBe(executionAttemptId);
				expect(await readFile(invocationFile, "utf8")).toBe("once\n");
				await writeFile(completionGateFile, "允许本测试脚本正常结束");
				await vi.waitFor(
					async () => {
						const item = await readPersistedItem();
						expect(["passed", "failed", "errored", "timed_out"], JSON.stringify(item?.run)).toContain(
							item?.run?.status,
						);
					},
					{ timeout: 40_000, interval: 150 },
				);
				const completedItem = await readPersistedItem();
				expect(completedItem?.run?.status, JSON.stringify(completedItem?.run)).toBe("passed");
				expect(completedItem?.checked).toBe(true);
				expect(completedItem?.run?.verificationExecutionAttemptId).toBe(executionAttemptId);
				expect(await readFile(invocationFile, "utf8")).toBe("once\n");
			} finally {
				await writeFile(completionGateFile, "测试收口");
				if (executionAttemptId) {
					const executionArtifactDirectory = join(
						runtimeHome,
						"verification-execution-attempts",
						executionAttemptId,
					);
					try {
						const identity = JSON.parse(
							await readFile(
								join(executionArtifactDirectory, `supervisor-identity-${executionAttemptId}.json`),
								"utf8",
							),
						) as OwnedProcessIdentity & {
							launchNonce?: string;
						};
						const materials = JSON.parse(
							await readFile(
								join(executionArtifactDirectory, `launch-materials-${executionAttemptId}.json`),
								"utf8",
							),
						) as { darwinOriginalParentGenerationProbePath?: string | null };
						if (
							identity.launchNonce === executionAttemptId &&
							identity.nativeProcessGenerationIdentity !== undefined &&
							hasSameProcessGeneration(
								await readProcessIdentity(
									identity.pid,
									materials.darwinOriginalParentGenerationProbePath,
									true,
								),
								identity,
							)
						)
							process.kill(identity.pid, "SIGKILL");
					} catch {
						// 已退出或原生身份已消失；不能按裸 PID 误杀其他进程。
					}
				}
			}
		});
	},
);
