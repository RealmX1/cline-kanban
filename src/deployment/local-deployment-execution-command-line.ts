import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import { taskCommandExecutionSpecificationSchema } from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	fingerprintLocalDeploymentDistribution,
	verifyLocalDeploymentPublishedFiles,
} from "./local-deployment-distribution-manifest";
import {
	analyzeLocalDeploymentExecutions,
	executeLocalDeploymentStages,
	finishLocalDeploymentExecution,
	freezeLocalDeploymentIndependentFindings,
	initializeLocalDeploymentExecution,
	readLocalDeploymentExecution,
	restrictLocalDeploymentExecution,
} from "./local-deployment-execution";
import {
	LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER,
	localDeploymentExecutionManifestSchema,
	localDeploymentExecutionRestrictionSchema,
	localDeploymentIndependentFindingsSchema,
} from "./local-deployment-execution-contract";
import { runLocalDeploymentCommandPreservingOriginalOutput } from "./local-deployment-execution-process";
import { observeLocalDeploymentRecoveryEvidence } from "./local-deployment-recovery-evidence";
import { verifyLocalDeploymentRegistrationEffectFromPersistedEvidence } from "./local-deployment-registration-effect-evidence";
import {
	completeLocalDeploymentTargetStageAttempt,
	readLocalDeploymentTargetStageRecoveryBudget,
	recordLocalDeploymentTargetStageFailure,
	reserveLocalDeploymentTargetStageAttempt,
} from "./local-deployment-target-stage-recovery-budget";
import {
	cleanupLocalRedeploymentFailedAttemptArtifacts,
	setLocalRedeploymentAutomaticFailedAttemptCleanup,
} from "./local-redeployment-failed-attempt-artifact-cleanup";
import {
	classifyLocalRedeploymentStageFailure,
	validateFrozenLocalRedeploymentBackupCopyIdentity,
} from "./local-redeployment-failure-recovery-evidence";
import { cancelPreparedLocalRedeployment, startPreparedLocalRedeployment } from "./local-redeployment-owned-execution";
import {
	clearLocalRedeploymentFilesystemEvidenceRequests,
	recordLocalRedeploymentFilesystemEvidenceRequest,
} from "./local-redeployment-persistent-checks";
import {
	assertLocalRedeploymentOwnerStillEligible,
	authorizeLocalRedeploymentSessionInterruption,
	LocalRedeploymentIdentityMismatch,
	prepareLocalRedeployment,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";
import { prepareLocalRedeploymentRepairContinuation } from "./local-redeployment-repair-continuation";
import { preserveLocalRedeploymentRuntimeRestartAcceptance } from "./local-redeployment-runtime-restart-acceptance";
import {
	executeStandardLocalRedeploymentStage,
	initializeStandardLocalRedeployment,
	LocalRedeploymentQualityFailure,
	localRedeploymentStageCommandStatus,
	observeStandardLocalRedeploymentRecoveryEvidence,
	observeStandardLocalRedeploymentStageRecoveryEvidence,
} from "./local-redeployment-standard-execution";

const executeDeploymentEffectVerificationOrRecoveryCommand = promisify(execFile);

async function assertPersistentExecutionDirectory(path: string): Promise<string> {
	let existing = resolve(path);
	const missingNames: string[] = [];
	while (true) {
		try {
			existing = await realpath(existing);
			break;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			missingNames.unshift(existing.slice(parent.length + 1));
			existing = parent;
		}
	}
	const resolved = join(existing, ...missingNames);
	const transientRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map((root) =>
		resolve(root),
	);
	if (transientRoots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`))) {
		throw new Error("部署执行与交接材料必须保存在持久目录，不能使用系统临时目录");
	}
	return resolved;
}

function printResult(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runLocalDeploymentExecutionAndWriteBusinessResult(directory: string): Promise<void> {
	const result = await executeLocalDeploymentStages(await assertPersistentExecutionDirectory(directory), {
		runCommand: runLocalDeploymentCommandPreservingOriginalOutput,
	});
	printResult(result);
	const execution = await readLocalDeploymentExecution(directory);
	const needsMachineEvidence = result.deploymentOutcome === "machine_evidence_pending";
	const revoked = result.deploymentOutcome === "permission_revoked";
	const disposition = revoked
		? "cancelled"
		: needsMachineEvidence
			? "machine_evidence_pending"
			: result.deploymentOutcome === "human_decision_required"
				? "agent_judgment_required"
				: "agent_review_ready";
	await lockedFileSystem.writeJsonFileAtomic(
		join(resolve(directory), "owned-command-business-result.json"),
		{
			disposition,
			deploymentExecutionId: result.executionId,
			analysis: result,
			retrospectiveAnalysisRequestFilePath:
				result.retrospective.status === "pending" && result.retrospective.analysisFingerprint
					? join(
							resolve(directory),
							"retrospective-analysis-requests",
							`${result.retrospective.analysisFingerprint}.json`,
						)
					: null,
			nextAction: needsMachineEvidence
				? "按已登记的机器条件自动接续，不请求人工提供机器可取得的信息"
				: result.deploymentOutcome === "quality_validation_failed"
					? "本次核验真实失败；Agent 在原授权内于 deployment-repair 分支修复并提交，再用 prepare-redeployment --repair-of-execution-directory 与 --deployment-branch 准备新候选；保留旧失败，不按机器缺证重试"
					: result.deploymentOutcome === "human_decision_required"
						? "发布身份与授权目标不一致，交回判断；不要把这次失败当成源码质量失败去准备修复接续"
						: "读取绑定原件，完成轻量语义复盘并固化独立发现，再查询既有 Issues；不重复部署",
			recovery: needsMachineEvidence
				? {
						action: "resume_same_run",
						trigger: result.recovery.condition,
						retry_not_before_epoch_ms: result.recovery.nextCheckAtEpochMs,
						maximum_unchanged_retries: execution.manifest.schemaVersion === 2 ? 1 : 0,
						require_ready_recovery_evidence: execution.manifest.schemaVersion === 2,
						evidence_paths: execution.manifest.stages.flatMap((stage) => stage.recoveryEvidenceFilePaths ?? []),
						equivalent_evidence_sources: [
							"bound_stage_effect_probe",
							"immutable_command_original",
							"runtime_native_process_identity",
						],
					}
				: null,
		},
		{ durable: true, fileMode: 0o600 },
	);
	if (result.deploymentOutcome !== "succeeded") process.exitCode = 2;
}

export function createLocalDeploymentExecutionCommandLineProgram(): Command {
	const program = new Command()
		.name("local-deployment-execution")
		.description("绑定授权与候选，持久执行本地部署步骤并准备独立复盘；不新增部署授权");
	program
		.command("set-redeployment-cleanup")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--automatic-cleanup <enabled-or-disabled>")
		.option("--inspection-reason <text>")
		.action(async (options: { executionDirectory: string; automaticCleanup: string; inspectionReason?: string }) => {
			if (!["enabled", "disabled"].includes(options.automaticCleanup))
				throw new Error("automatic-cleanup 必须为 enabled 或 disabled");
			const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
			await setLocalRedeploymentAutomaticFailedAttemptCleanup(
				directory,
				options.automaticCleanup === "enabled",
				options.inspectionReason,
			);
			printResult(await cleanupLocalRedeploymentFailedAttemptArtifacts(directory));
		});
	program
		.command("cleanup-redeployment-failed-attempts")
		.requiredOption("--execution-directory <path>")
		.action(async (options: { executionDirectory: string }) => {
			const result = await cleanupLocalRedeploymentFailedAttemptArtifacts(
				await assertPersistentExecutionDirectory(options.executionDirectory),
			);
			printResult(result);
			if (result.status === "pending") process.exitCode = 2;
		});
	program
		.command("prepare-redeployment")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--request-file <path>")
		.option("--repair-of-execution-directory <path>")
		.option("--deployment-branch <name>")
		.action(
			async (options: {
				executionDirectory: string;
				requestFile: string;
				repairOfExecutionDirectory?: string;
				deploymentBranch?: string;
			}) => {
				if (!!options.repairOfExecutionDirectory !== !!options.deploymentBranch)
					throw new Error("修复接续必须同时提供来源执行目录与本地部署分支");
				const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
				const request = JSON.parse(await readFile(options.requestFile, "utf8"));
				printResult(
					options.repairOfExecutionDirectory && options.deploymentBranch
						? await prepareLocalRedeploymentRepairContinuation(
								directory,
								request,
								process.argv[1],
								await assertPersistentExecutionDirectory(options.repairOfExecutionDirectory),
								options.deploymentBranch,
							)
						: await prepareLocalRedeployment(directory, request, process.argv[1]),
				);
			},
		);
	program
		.command("authorize-redeployment-session-interruption")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--authorization-file <path>")
		.action(async (options: { executionDirectory: string; authorizationFile: string }) => {
			const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
			printResult(
				await authorizeLocalRedeploymentSessionInterruption(
					directory,
					await readLocalRedeploymentJson(options.authorizationFile),
				),
			);
		});
	for (const operation of ["start-redeployment", "cancel-redeployment", "observe-redeployment"] as const) {
		program
			.command(operation)
			.requiredOption("--execution-directory <path>")
			.action(async (options: { executionDirectory: string }) => {
				const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
				if (operation === "start-redeployment") printResult(await startPreparedLocalRedeployment(directory));
				if (operation === "cancel-redeployment") {
					await cancelPreparedLocalRedeployment(directory);
					printResult({ ok: true, cancelled: true });
				}
				if (operation === "observe-redeployment")
					printResult(await observeStandardLocalRedeploymentRecoveryEvidence(directory));
			});
	}
	program
		.command("run-redeployment")
		.requiredOption("--execution-directory <path>")
		.action(async (options: { executionDirectory: string }) => {
			const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
			let executionId: string | undefined;
			let requestSha256: string | undefined;
			try {
				const frozen = await readFrozenLocalRedeploymentRequest(directory);
				executionId = frozen.request.executionId;
				requestSha256 = frozen.requestSha256;
				if (!existsSync(join(directory, "local-deployment-execution.json"))) {
					const targetBudget = await readLocalDeploymentTargetStageRecoveryBudget(
						frozen.request,
						"candidate_bootstrap",
					);
					if (targetBudget?.blockingFailure?.sourcePath)
						await validateFrozenLocalRedeploymentBackupCopyIdentity(directory);
					const evidence = await observeStandardLocalRedeploymentRecoveryEvidence(directory);
					const attemptNumber = (targetBudget?.attempts.length ?? 0) + 1;
					if (
						!(await reserveLocalDeploymentTargetStageAttempt({
							binding: frozen.request,
							stage: "candidate_bootstrap",
							executionDirectory: directory,
							attemptNumber,
							recoveryEvidenceSha256: evidence.evidenceSha256,
							recoveryEvidenceReady: evidence.recoveryEvidenceReady === true,
						}))
					)
						throw new Error("目标准备预算已消费，等待相关恢复条件");
					try {
						await initializeStandardLocalRedeployment(directory);
					} catch (error) {
						await recordLocalDeploymentTargetStageFailure({
							binding: frozen.request,
							stage: "candidate_bootstrap",
							executionDirectory: directory,
							attemptNumber,
							failure: await classifyLocalRedeploymentStageFailure(directory, error, "candidate_bootstrap"),
						});
						throw error;
					}
					await completeLocalDeploymentTargetStageAttempt(frozen.request, "candidate_bootstrap");
				}
				const activeBudget = await readLocalDeploymentTargetStageRecoveryBudget(
					frozen.request,
					"state_preservation",
				);
				if (
					activeBudget?.blockingFailure?.sourcePath &&
					["copy_identity_mismatch", "source_contention", "unclassified_failure"].includes(
						activeBudget.blockingFailure.classification,
					)
				)
					await validateFrozenLocalRedeploymentBackupCopyIdentity(directory);
				await runLocalDeploymentExecutionAndWriteBusinessResult(directory);
			} catch (error) {
				await recordLocalRedeploymentFilesystemEvidenceRequest(directory, error);
				const revoked =
					existsSync(join(directory, "redeployment-revocation.json")) ||
					existsSync(join(directory, "local-deployment-execution-restriction.json"));
				const disposition = revoked
					? "cancelled"
					: error instanceof LocalRedeploymentIdentityMismatch
						? "agent_judgment_required"
						: error instanceof LocalRedeploymentQualityFailure
							? "agent_review_ready"
							: "machine_evidence_pending";
				const result = {
					disposition,
					deploymentExecutionId: executionId,
					requestSha256,
					nextAction:
						error instanceof LocalRedeploymentQualityFailure
							? "Agent 在原部署授权内修复并提交 deployment-repair 分支，通过 prepare-redeployment --repair-of-execution-directory 与 --deployment-branch 固定新候选继续部署；原失败保留，不跳过检查。"
							: null,
					error: String(error),
					recovery:
						disposition === "machine_evidence_pending"
							? {
									action: "resume_same_run",
									trigger: "绑定实例、源码验证或依赖的语义证据变化",
									retry_not_before_epoch_ms: Date.now() + 30_000,
									maximum_unchanged_retries: 1,
									require_ready_recovery_evidence: true,
									evidence_paths: [],
									equivalent_evidence_sources: [
										"consistent_workspace_snapshot",
										"bound_candidate_validation",
										"native_listener_and_boot_identity",
									],
								}
							: null,
				};
				await writeLocalRedeploymentJson(join(directory, "owned-command-business-result.json"), result);
				printResult(result);
				process.exitCode = 2;
			}
		});
	program
		.command("redeployment-stage")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--stage <name>")
		.action(async (options: { executionDirectory: string; stage: string }) => {
			const stage = LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.find((stage) => stage === options.stage);
			if (!stage) throw new Error("未知部署阶段");
			try {
				await executeStandardLocalRedeploymentStage(
					await assertPersistentExecutionDirectory(options.executionDirectory),
					stage,
				);
				await clearLocalRedeploymentFilesystemEvidenceRequests(options.executionDirectory, options.stage);
				printResult({ ok: true });
			} catch (error) {
				await recordLocalRedeploymentFilesystemEvidenceRequest(options.executionDirectory, error, options.stage);
				const blockingFailure = await classifyLocalRedeploymentStageFailure(
					options.executionDirectory,
					error,
					stage,
				);
				printResult({
					ok: false,
					blockingFailure,
					status: localRedeploymentStageCommandStatus(error),
					error: String(error),
				});
				process.exitCode = 2;
			}
		});
	program
		.command("validate-redeployment-owner")
		.requiredOption("--execution-directory <path>")
		.action(async (options: { executionDirectory: string }) => {
			await assertLocalRedeploymentOwnerStillEligible(
				options.executionDirectory,
				await readFrozenLocalRedeploymentRequest(options.executionDirectory),
			);
			printResult({ ok: true });
		});
	program
		.command("observe-redeployment-stage")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--stage <name>")
		.action(async (options: { executionDirectory: string; stage: string }) => {
			const stage = LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.find((stage) => stage === options.stage);
			if (!stage) throw new Error("未知部署阶段");
			printResult(await observeStandardLocalRedeploymentStageRecoveryEvidence(options.executionDirectory, stage));
		});
	program
		.command("observe-recovery-evidence")
		.requiredOption("--execution-directory <path>")
		.action(async (options: { executionDirectory: string }) => {
			printResult(await observeLocalDeploymentRecoveryEvidence(options.executionDirectory));
		});
	program
		.command("fingerprint-distribution")
		.requiredOption("--distribution-directory <path>")
		.action(async (options: { distributionDirectory: string }) => {
			printResult({ ok: true, ...(await fingerprintLocalDeploymentDistribution(options.distributionDirectory)) });
		});
	program
		.command("initialize")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--manifest-file <path>")
		.action(async (options: { executionDirectory: string; manifestFile: string }) => {
			const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
			const input = localDeploymentExecutionManifestSchema.parse(
				JSON.parse(await readFile(options.manifestFile, "utf8")),
			);
			if ((await realpath(input.deploymentNodeBinaryPath)) !== (await realpath(process.execPath)))
				throw new Error("初始化与实际部署必须固定同一 Node 二进制");
			const fingerprint = await fingerprintLocalDeploymentDistribution(input.candidateDistributionDirectoryPath);
			if (fingerprint.candidateDistributionSha256 !== input.candidateDistributionSha256)
				throw new Error("候选目录内容与声明摘要不一致");
			const record = await initializeLocalDeploymentExecution(directory, input);
			printResult({ ok: true, executionId: record.manifest.executionId, executionDirectory: directory });
		});
	program
		.command("run")
		.requiredOption("--execution-directory <path>")
		.action(async (options: { executionDirectory: string }) => {
			await runLocalDeploymentExecutionAndWriteBusinessResult(options.executionDirectory);
		});
	program
		.command("prepare-owned-command")
		.requiredOption("--execution-directory <path>")
		.action(async (options: { executionDirectory: string }) => {
			const directory = await assertPersistentExecutionDirectory(options.executionDirectory);
			const record = await readLocalDeploymentExecution(directory);
			const entrypoint = join(directory, "frozen-local-deployment-executor.mjs");
			const executorIdentityPath = join(directory, "frozen-local-deployment-executor-identity.json");
			const candidateFingerprint = await fingerprintLocalDeploymentDistribution(
				record.manifest.candidateDistributionDirectoryPath,
			);
			if (candidateFingerprint.candidateDistributionSha256 !== record.manifest.candidateDistributionSha256)
				throw new Error("冻结执行器前候选产物摘要已变化");
			const sourceEntrypoint = join(
				record.manifest.candidateDistributionDirectoryPath,
				"local-deployment-execution.js",
			);
			const source = await readFile(sourceEntrypoint, "utf8");
			const executorSha256 = createHash("sha256").update(source).digest("hex");
			let identityPresent = false;
			try {
				const identity: { executionId: string; candidateSourceCommit: string; executorSha256: string } = JSON.parse(
					await readFile(executorIdentityPath, "utf8"),
				);
				if (
					identity.executionId !== record.manifest.executionId ||
					identity.candidateSourceCommit !== record.manifest.candidateSourceCommit ||
					identity.executorSha256 !== executorSha256
				)
					throw new Error("已冻结的部署执行器身份不一致");
				identityPresent = true;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			try {
				if (
					createHash("sha256")
						.update(await readFile(entrypoint))
						.digest("hex") !== executorSha256
				)
					throw new Error("冻结执行器原件发生变化，不能覆盖");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				// 中断留下的缺件可从同一摘要的候选恢复，不借当前安装版本替换历史执行器。
				await lockedFileSystem.writeTextFileAtomic(entrypoint, source, { durable: true, fileMode: 0o700 });
			}
			if (!identityPresent)
				await lockedFileSystem.writeJsonFileAtomic(
					executorIdentityPath,
					{
						executionId: record.manifest.executionId,
						candidateSourceCommit: record.manifest.candidateSourceCommit,
						executorSha256,
						sourceEntrypoint,
					},
					{ durable: true, fileMode: 0o600 },
				);
			const command = [
				record.manifest.deploymentNodeBinaryPath,
				entrypoint,
				"run",
				"--execution-directory",
				directory,
			];
			const restrictionFile = join(directory, "owned-command-cancellation-restriction.json");
			await lockedFileSystem.writeJsonFileAtomic(
				restrictionFile,
				{
					kind: "permission_revoked",
					reason: "所属命令执行已收到持久取消",
					sourceReference: `owned-command:${record.manifest.executionId}`,
				},
				{ durable: true, fileMode: 0o600 },
			);
			const specification = taskCommandExecutionSpecificationSchema.parse({
				command,
				resumeCommand: command,
				resumeCommandPreservesBusinessSingleFlight: true,
				readOnlyRecoveryEvidenceObservationCommand: [
					record.manifest.deploymentNodeBinaryPath,
					entrypoint,
					"observe-recovery-evidence",
					"--execution-directory",
					directory,
				],
				cancelCommand: [
					record.manifest.deploymentNodeBinaryPath,
					entrypoint,
					"restrict",
					"--execution-directory",
					directory,
					"--restriction-file",
					restrictionFile,
				],
				workingDirectory: record.manifest.originatingTaskWorktreePath,
				resultFile: join(directory, "owned-command-business-result.json"),
				materialSha256: createHash("sha256")
					.update(JSON.stringify({ manifest: record.manifest, executorSha256 }))
					.digest("hex"),
				label: "本地部署执行与独立复盘交回",
				recoveryEvidencePaths: [
					...new Set(record.manifest.stages.flatMap((stage) => stage.recoveryEvidenceFilePaths ?? [])),
					join(
						record.manifest.runtimeIdentity.runtimeHomeDirectoryPath,
						"workspaces",
						record.manifest.workspaceId,
						"sessions.json",
					),
					join(record.manifest.runtimeIdentity.runtimeHomeDirectoryPath, "config.json"),
					join(record.manifest.runtimeIdentity.runtimeHomeDirectoryPath, "post-deploy-verification-state.json"),
					join(record.manifest.runtimeIdentity.runtimeHomeDirectoryPath, "last-deployed-source-commit.json"),
				],
			});
			const specificationFile = join(directory, "owned-command-specification.json");
			await lockedFileSystem.writeJsonFileAtomic(specificationFile, specification, {
				durable: true,
				fileMode: 0o600,
			});
			printResult({
				ok: true,
				taskId: record.manifest.taskId,
				idempotencyKey: `local-deployment:${record.manifest.executionId}`,
				specificationFile,
				nextAction:
					"已有本次部署授权时，经 kanban task command-execution start 注册；本命令仅准备材料，不启动执行器",
			});
		});
	program
		.command("finish")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--outcome <failed|rolled_back|abandoned>")
		.action(async (options: { executionDirectory: string; outcome: string }) => {
			if (options.outcome !== "failed" && options.outcome !== "rolled_back" && options.outcome !== "abandoned")
				throw new Error("不支持的结束结果");
			printResult(await finishLocalDeploymentExecution(options.executionDirectory, options.outcome));
		});
	program
		.command("restrict")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--restriction-file <path>")
		.action(async (options: { executionDirectory: string; restrictionFile: string }) => {
			await restrictLocalDeploymentExecution(
				options.executionDirectory,
				localDeploymentExecutionRestrictionSchema.parse(
					JSON.parse(await readFile(options.restrictionFile, "utf8")),
				),
			);
			printResult({ ok: true, executionDirectory: resolve(options.executionDirectory) });
		});
	program
		.command("freeze-independent-findings")
		.requiredOption("--execution-directory <path>")
		.requiredOption("--findings-file <path>")
		.action(async (options: { executionDirectory: string; findingsFile: string }) => {
			const input = localDeploymentIndependentFindingsSchema.parse(
				JSON.parse(await readFile(options.findingsFile, "utf8")),
			);
			printResult({
				ok: true,
				findingsFilePath: await freezeLocalDeploymentIndependentFindings(options.executionDirectory, input),
			});
		});
	program
		.command("analyze")
		.requiredOption("--execution-directory <paths...>")
		.action(async (options: { executionDirectory: string[] }) => {
			printResult({ ok: true, ...(await analyzeLocalDeploymentExecutions(options.executionDirectory)) });
		});
	for (const operation of [
		"verify-publication",
		"verify-runtime-restart",
		"verify-deployment-record",
		"recover-deployment-record",
	] as const) {
		program
			.command(operation)
			.requiredOption("--execution-directory <path>")
			.action(async (options: { executionDirectory: string }) => {
				const { manifest } = await readLocalDeploymentExecution(options.executionDirectory);
				let ok = false;
				if (operation === "verify-publication") {
					ok = await verifyLocalDeploymentPublishedFiles(manifest);
					if (ok && manifest.schemaVersion === 2) {
						try {
							ok =
								(await realpath(join(dirname(manifest.deploymentNodeBinaryPath), "kanban"))) ===
								(await realpath(join(manifest.distributionDirectoryPath, "cli.js")));
						} catch {
							ok = false;
						}
					}
				}
				if (operation === "verify-runtime-restart" && (await verifyLocalDeploymentPublishedFiles(manifest))) {
					const result = await executeDeploymentEffectVerificationOrRecoveryCommand(
						process.execPath,
						[join(manifest.sourceCheckoutPath, "scripts/verify-agent-session-pty-host-runtime-readiness.mjs")],
						{
							cwd: manifest.sourceCheckoutPath,
							env: {
								...process.env,
								KANBAN_RUNTIME_HOST: manifest.runtimeIdentity.runtimeHost,
								KANBAN_RUNTIME_PORT: String(manifest.runtimeIdentity.runtimePort),
							},
							maxBuffer: 4_194_304,
						},
					);
					const evidence = JSON.parse(result.stdout);
					ok =
						evidence.ok === true &&
						(manifest.schemaVersion === 1 ||
							evidence.runtimeLoadedEntrypointSha256 ===
								createHash("sha256")
									.update(await readFile(join(manifest.candidateDistributionDirectoryPath, "cli.js")))
									.digest("hex")) &&
						evidence.runtimeIdentity?.runtimeHomeDirectoryPath ===
							manifest.runtimeIdentity.runtimeHomeDirectoryPath &&
						evidence.runtimeIdentity?.runtimePort === manifest.runtimeIdentity.runtimePort &&
						Number.isInteger(evidence.runtimeProcessId) &&
						typeof evidence.runtimeProcessStartTimeText === "string" &&
						(manifest.runtimeBefore === null ||
							evidence.runtimeProcessId !== manifest.runtimeBefore.processId ||
							evidence.runtimeProcessStartTimeText !== manifest.runtimeBefore.processStartTimeText);
					if (ok && manifest.schemaVersion === 2)
						await preserveLocalRedeploymentRuntimeRestartAcceptance(
							options.executionDirectory,
							manifest,
							evidence,
						);
				}
				if (operation === "recover-deployment-record") {
					if (
						manifest.schemaVersion === 2 &&
						existsSync(join(options.executionDirectory, "frozen-redeployment-request.json"))
					)
						await assertLocalRedeploymentOwnerStillEligible(
							options.executionDirectory,
							await readFrozenLocalRedeploymentRequest(options.executionDirectory),
						);
					await executeDeploymentEffectVerificationOrRecoveryCommand(
						process.execPath,
						[
							join(manifest.distributionDirectoryPath, "cli.js"),
							"deployment",
							"record",
							"--execution-directory",
							resolve(options.executionDirectory),
						],
						{
							cwd: manifest.sourceCheckoutPath,
							maxBuffer: 4_194_304,
						},
					);
				}
				if (operation === "verify-deployment-record" || operation === "recover-deployment-record") {
					const state: {
						deploymentGroups: Array<{
							deploymentId: string;
							workspaceId: string;
							deployedSourceCommit: string;
							previousDeployedSourceCommit: string | null;
							deployedAtIso: string;
							foldedAtIso: string | null;
						}>;
					} = JSON.parse(
						await readFile(
							join(manifest.runtimeIdentity.runtimeHomeDirectoryPath, "post-deploy-verification-state.json"),
							"utf8",
						),
					);
					const marker: { deploymentId: string; deployedSourceCommit: string; deployedAtIso: string } = JSON.parse(
						await readFile(
							join(manifest.runtimeIdentity.runtimeHomeDirectoryPath, "last-deployed-source-commit.json"),
							"utf8",
						),
					);
					ok = verifyLocalDeploymentRegistrationEffectFromPersistedEvidence({
						manifest,
						deploymentGroups: state.deploymentGroups,
						marker,
					});
					if (ok && manifest.schemaVersion === 2) {
						const receipt = (await readLocalRedeploymentJson(
							join(options.executionDirectory, "deployment-record-receipt.json"),
						)) as {
							ok?: boolean;
							deploymentId?: string;
							workspaceId?: string;
							deployedSourceCommit?: string;
						} | null;
						ok =
							receipt?.ok === true &&
							receipt.deploymentId === manifest.executionId &&
							receipt.workspaceId === manifest.workspaceId &&
							receipt.deployedSourceCommit === manifest.candidateSourceCommit;
					}
				}
				printResult({
					ok,
					executionId: manifest.executionId,
					candidateSourceCommit: manifest.candidateSourceCommit,
					candidateDistributionSha256: manifest.candidateDistributionSha256,
				});
				if (!ok) process.exitCode = 2;
			});
	}
	return program;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await createLocalDeploymentExecutionCommandLineProgram().parseAsync();
	} catch (error) {
		printResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	}
}
