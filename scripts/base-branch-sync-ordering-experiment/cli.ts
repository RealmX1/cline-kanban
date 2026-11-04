import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { captureCurrentRepositoryBaseline } from "./capture-current-repository-baseline";
import { deriveReviewedBatchFromCohort } from "./derive-reviewed-batch-from-cohort";
import { backupExecutionEnvironment } from "./execution-environment-backup";
import { deriveTaskOrder } from "./experiment-contract";
import { captureFrozenBatch, materializeIndependentWorkingState, verifyFrozenBatch } from "./frozen-source-snapshot";
import { prepareIsolatedKanbanRuntimeBoundary } from "./isolated-kanban-runtime-boundary";
import { ensureNativeTaskFork } from "./isolated-native-task-fork";
import { probeProcessIsolation } from "./macos-experiment-process-isolation";
import { readJson, writeDurableJson } from "./persistent-experiment-storage";
import { backupReusableTaskCohort } from "./reusable-task-cohort-backup";
import { verifyReusableTaskCohortBackup } from "./verify-reusable-cohort-backup";

export async function runExperimentCommand(argv: string[]) {
	const program = new Command().name("排序实验").description("独立 Git / 原生会话排序实验，不调用生产 Kanban 写接口");
	program
		.command("prepare-isolated-runtime-boundary")
		.requiredOption("--owned-root <path>")
		.requiredOption("--instance <path>")
		.requiredOption("--private-runtime-port <number>")
		.requiredOption("--protected-runtime-port <number>")
		.requiredOption("--executable <paths...>")
		.option("--private-home-alias <path>", "指向本实例HOME的持久短路径，避免Unix socket超长")
		.option("--planned-native-codex-conversation-sessions-file <path>", "本实例计划启动的 workspace／会话身份列表")
		.action(
			async (options: {
				ownedRoot: string;
				instance: string;
				privateRuntimePort: string;
				protectedRuntimePort: string;
				executable: string[];
				privateHomeAlias?: string;
				plannedNativeCodexConversationSessionsFile?: string;
			}) => {
				const boundary = await prepareIsolatedKanbanRuntimeBoundary({
					ownedRootDirectory: resolve(options.ownedRoot),
					instanceDirectory: resolve(options.instance),
					runtimePort: Number(options.privateRuntimePort),
					protectedRuntimePort: Number(options.protectedRuntimePort),
					executablePaths: options.executable.map((path) => resolve(path)),
					privateHomeDirectoryPathAlias: options.privateHomeAlias ? resolve(options.privateHomeAlias) : undefined,
					plannedNativeCodexConversationSessions: options.plannedNativeCodexConversationSessionsFile
						? z
								.array(z.object({ workspaceId: z.string(), conversationSessionId: z.string() }))
								.parse(await readJson(options.plannedNativeCodexConversationSessionsFile))
						: undefined,
				});
				console.log(
					JSON.stringify({
						status: boundary.status,
						profilePath: boundary.profilePath,
						browserOrigin: boundary.browserOrigin,
					}),
				);
			},
		);
	program
		.command("backup-current-repository")
		.requiredOption("--project <path>")
		.requiredOption("--task-worktree <path>")
		.requiredOption("--cohort <path>")
		.requiredOption("--output <path>")
		.option("--base-ref <ref>", "本地 base", "main")
		.action(
			async (options: {
				project: string;
				taskWorktree: string;
				cohort: string;
				output: string;
				baseRef: string;
			}) => {
				const result = await captureCurrentRepositoryBaseline({
					projectPath: resolve(options.project),
					taskWorktreePath: resolve(options.taskWorktree),
					sourceCohortDirectory: resolve(options.cohort),
					outputDirectory: resolve(options.output),
					baseRef: options.baseRef,
				});
				console.log(
					JSON.stringify({
						status: result.status,
						baseCommit: result.baseCommit,
						recordedRefCount: result.recordedRefCount,
						candidateDrift: result.candidateDrift,
					}),
				);
			},
		);
	program
		.command("derive-reviewed-batch")
		.requiredOption("--cohort <path>")
		.requiredOption("--decisions <path>")
		.requiredOption("--output <path>")
		.option("--repository-backup <path>", "绑定开始前的实际仓库基线")
		.action(async (options: { cohort: string; decisions: string; output: string; repositoryBackup?: string }) => {
			const batch = await deriveReviewedBatchFromCohort(
				resolve(options.cohort),
				resolve(options.output),
				resolve(options.decisions),
				options.repositoryBackup ? resolve(options.repositoryBackup) : undefined,
			);
			console.log(
				JSON.stringify({ status: "derived-from-frozen-cohort", taskIds: batch.tasks.map((task) => task.taskId) }),
			);
		});
	program
		.command("verify-cohort-backup")
		.requiredOption("--batch <path>")
		.action(async (options: { batch: string }) => {
			const result = await verifyReusableTaskCohortBackup(resolve(options.batch));
			console.log(
				JSON.stringify({
					status: result.status,
					verifiedFileCount: result.verifiedFileCount,
					restoredTaskCount: result.restoredTasks.length,
				}),
			);
		});
	program
		.command("backup-environment")
		.requiredOption("--input <path>")
		.requiredOption("--batch <path>")
		.action(async (options: { input: string; batch: string }) => {
			const result = await backupExecutionEnvironment(resolve(options.input), resolve(options.batch));
			console.log(JSON.stringify({ status: "environment-archived", ...result }));
		});
	program
		.command("backup-cohort")
		.requiredOption("--input <path>")
		.requiredOption("--output <path>")
		.action(async (options: { input: string; output: string }) => {
			const results = await backupReusableTaskCohort(resolve(options.input), resolve(options.output));
			console.log(JSON.stringify({ status: "source-state-backed-up", taskIds: results.map((task) => task.taskId) }));
		});
	program
		.command("capture")
		.requiredOption("--input <path>")
		.requiredOption("--output <path>")
		.action(async (options: { input: string; output: string }) => {
			const output = resolve(options.output);
			await mkdir(output, { recursive: true, mode: 0o700 });
			const release = await lockfile.lock(output, { realpath: true, stale: 120_000, update: 10_000, retries: 0 });
			try {
				const batch = await captureFrozenBatch(resolve(options.input), join(output, "frozen-batch"));
				console.log(
					JSON.stringify({
						status: "completed",
						frozenBatchDirectory: join(output, "frozen-batch"),
						tasks: batch.tasks.map((task) => task.taskId),
					}),
				);
			} catch (error) {
				await writeDurableJson(join(output, "capture-failure.json"), {
					status: "waiting-for-source-evidence",
					observedAt: Date.now(),
					error: String(error),
					recoveryCondition: "来源候选、身份和完整回合稳定后，在新的采集目录重试；失败快照保留",
				});
				throw error;
			} finally {
				await release();
			}
		});
	program
		.command("verify")
		.requiredOption("--batch <path>")
		.action(async (options: { batch: string }) => {
			const batch = await verifyFrozenBatch(resolve(options.batch));
			console.log(
				JSON.stringify({
					status: "verified",
					experimentId: batch.experimentId,
					tasks: batch.tasks.map((task) => task.taskId),
				}),
			);
		});
	program
		.command("plan")
		.requiredOption("--batch <path>")
		.action(async (options: { batch: string }) => {
			const root = resolve(options.batch);
			const batch = await verifyFrozenBatch(root);
			const orders = {
				fifo: deriveTaskOrder(batch.tasks, "fifo"),
				smallestChangeFirst: deriveTaskOrder(batch.tasks, "smallest-change-first"),
			};
			await writeDurableJson(join(root, "deterministic-order-proposals.json"), { orders, tasks: batch.tasks });
			console.log(JSON.stringify(orders));
		});
	program
		.command("fork-check")
		.requiredOption("--batch <path>")
		.requiredOption("--task-id <id>")
		.requiredOption("--codex-binary <path>")
		.requiredOption("--configuration-source-home <path>")
		.action(
			async (options: { batch: string; taskId: string; codexBinary: string; configurationSourceHome: string }) => {
				const root = resolve(options.batch);
				const batch = await verifyFrozenBatch(root);
				const task = batch.tasks.find((entry) => entry.taskId === options.taskId);
				if (!task) throw new Error("任务不在冻结批次");
				const groupDirectory = join(root, "native-fork-checks", options.taskId);
				const workingDirectory = join(groupDirectory, "repository");
				try {
					await stat(join(workingDirectory, ".git"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					await materializeIndependentWorkingState(root, join(root, task.snapshotRelativePath), workingDirectory);
				}
				const result = await ensureNativeTaskFork({
					root,
					taskId: task.taskId,
					groupDirectory,
					workingDirectory,
					binary: resolve(options.codexBinary),
					configurationSourceHome: resolve(options.configurationSourceHome),
				});
				console.log(
					JSON.stringify({
						status: "fork-verified",
						childSessionId: result.operation.childSessionId,
						modelRequestsStarted: 0,
					}),
				);
			},
		);
	program
		.command("isolation-check")
		.requiredOption("--batch <path>")
		.action(async (options: { batch: string }) => {
			const root = resolve(options.batch);
			await verifyFrozenBatch(root);
			await probeProcessIsolation(root, join(root, "isolation-check"));
			console.log(JSON.stringify({ status: "isolation-verified" }));
		});
	await program.parseAsync(argv, { from: "user" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	runExperimentCommand(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`排序实验未完成：${String(error)}`);
		process.exitCode = 1;
	});
}
