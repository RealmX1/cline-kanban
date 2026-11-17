import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	analyzeLocalDeploymentExecutions,
	executeLocalDeploymentStages,
	finishLocalDeploymentExecution,
	freezeLocalDeploymentIndependentFindings,
	initializeLocalDeploymentExecution,
	type LocalDeploymentCommandRunner,
	readLocalDeploymentExecution,
	restrictLocalDeploymentExecution,
} from "../../../src/deployment/local-deployment-execution";
import type { LocalDeploymentExecutionManifest } from "../../../src/deployment/local-deployment-execution-contract";
import { observeLocalDeploymentRecoveryEvidence } from "../../../src/deployment/local-deployment-recovery-evidence";
import { verifyLocalDeploymentRegistrationEffectFromPersistedEvidence } from "../../../src/deployment/local-deployment-registration-effect-evidence";
import { readLocalDeploymentTargetStageRecoveryBudget } from "../../../src/deployment/local-deployment-target-stage-recovery-budget";
import { observeLocalRedeploymentBlockingFailureRecovery } from "../../../src/deployment/local-redeployment-failure-recovery-evidence";
import { localRedeploymentSha256 } from "../../../src/deployment/local-redeployment-preparation";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { createTempDir } from "../../utilities/temp-dir";

function createExecutionDirectory(prefix: string): string {
	const temporary = createTempDir(prefix);
	onTestFinished(temporary.cleanup);
	return temporary.path;
}

function verifiedEffectStdout(command: string[]): string {
	return command[0].startsWith("verify-")
		? JSON.stringify({
				ok: true,
				executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
				candidateSourceCommit: "a".repeat(40),
				candidateDistributionSha256: "c".repeat(64),
			})
		: "";
}

function manifest(executionDirectory: string): LocalDeploymentExecutionManifest {
	return {
		schemaVersion: 1,
		executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
		workspaceId: "isolated-deployment-workspace",
		taskId: "deployment-test",
		originatingTaskWorktreePath: executionDirectory,
		sourceCheckoutPath: executionDirectory,
		deploymentNodeBinaryPath: process.execPath,
		candidateSourceCommit: "a".repeat(40),
		previousDeployedSourceCommit: "b".repeat(40),
		candidateDistributionSha256: "c".repeat(64),
		candidateDistributionDirectoryPath: join(executionDirectory, "candidate-distribution"),
		distributionDirectoryPath: join(executionDirectory, "published-distribution"),
		runtimeIdentity: {
			runtimeHomeDirectoryPath: join(executionDirectory, "isolated-runtime-home"),
			runtimeHost: "127.0.0.1",
			runtimePort: 39884,
		},
		runtimeBefore: { processId: 100, processStartTimeText: "original-runtime-start" },
		authorization: { sourceReference: "test:explicit-request", userRequestQuote: "部署隔离测试实例" },
		stages: [
			{ stage: "candidate_preparation", command: ["prepare"] },
			{ stage: "state_preservation", command: ["preserve"] },
			{ stage: "build_publication", command: ["publish"], effectVerificationCommand: ["verify-publication"] },
			{ stage: "runtime_restart", command: ["restart"], effectVerificationCommand: ["verify-restart"] },
			{ stage: "runtime_validation", command: ["validate"] },
			{ stage: "deployment_record", command: ["record"], effectVerificationCommand: ["verify-record"] },
			{ stage: "staging_cleanup", command: ["cleanup"] },
			{ stage: "task_comment", command: ["comment"] },
		],
	};
}

describe("本地部署执行与复盘", () => {
	it("标准阶段跨新候选共用目标预算，报告重写和未知观察不增加备份，相关恢复只解锁一次", async () => {
		const directory = createExecutionDirectory("local-deployment-target-semantic-qualification-");
		const binding = manifest(directory);
		const report = join(directory, "diagnostic-report.json");
		await writeFile(report, "初始报告");
		const preservation = binding.stages[1];
		preservation.recoveryEvidenceObservationMode = "semantic_observation_only";
		preservation.recoveryEvidenceFilePaths = [report];
		preservation.readOnlyRecoveryEvidenceObservationCommand = ["observe-relevant-condition"];
		await initializeLocalDeploymentExecution(directory, binding);
		let fingerprint = "1".repeat(64);
		let ready = false;
		let backupCount = 0;
		const runCommand: LocalDeploymentCommandRunner = async (command) => {
			if (command[0] === "observe-relevant-condition")
				return {
					exitCode: 0,
					stdout: JSON.stringify({ evidenceSha256: fingerprint, recoveryEvidenceReady: ready, nonce: Date.now() }),
					stderr: "",
				};
			if (command[0] === "preserve") {
				backupCount++;
				return {
					processWasStarted: true,
					exitCode: 2,
					stdout: JSON.stringify({
						ok: false,
						status: "machine_evidence_pending",
						blockingFailure: {
							classification: "copy_identity_mismatch",
							logicalResource: "bound-runtime-resource",
							recoveryCondition: "绑定复制回归通过",
							originalErrorReference: report,
						},
					}),
					stderr: "",
				};
			}
			return { processWasStarted: true, exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
		};
		await executeLocalDeploymentStages(directory, { runCommand });
		await writeFile(report, "无关报告重写和新时间戳");
		await executeLocalDeploymentStages(directory, { runCommand });
		const newDirectory = join(directory, "new-candidate-execution");
		await initializeLocalDeploymentExecution(newDirectory, {
			...binding,
			executionId: "042609d8-7508-4bdc-b202-1d7bd7da8a14",
			candidateSourceCommit: "d".repeat(40),
		});
		await executeLocalDeploymentStages(newDirectory, { runCommand });
		expect(backupCount).toBe(1);
		fingerprint = "2".repeat(64);
		ready = true;
		await executeLocalDeploymentStages(newDirectory, { runCommand });
		await executeLocalDeploymentStages(newDirectory, { runCommand });
		expect(backupCount).toBe(2);
		fingerprint = "unavailable";
		ready = false;
		await executeLocalDeploymentStages(newDirectory, { runCommand });
		fingerprint = "2".repeat(64);
		ready = true;
		await executeLocalDeploymentStages(newDirectory, { runCommand });
		expect(backupCount).toBe(2);
	});

	it("阶段明确返回机器待证后立即结束，重启也不使用同一证据再次复制", async () => {
		const directory = createExecutionDirectory("local-deployment-explicit-machine-wait-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const commands: string[] = [];
		const runCommand: LocalDeploymentCommandRunner = async (command) => {
			commands.push(command[0]);
			return command[0] === "preserve"
				? {
						processWasStarted: true,
						exitCode: 2,
						stdout: JSON.stringify({ ok: false, status: "machine_evidence_pending" }),
						stderr: "等待复制身份补证",
					}
				: { processWasStarted: true, exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
		};
		expect((await executeLocalDeploymentStages(directory, { runCommand })).deploymentOutcome).toBe(
			"machine_evidence_pending",
		);
		expect(commands.filter((command) => command === "preserve")).toHaveLength(1);
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(commands.filter((command) => command === "preserve")).toHaveLength(1);
	});

	it.each(["state_preservation", "runtime_validation"] as const)(
		"%s 的内层重试预算随机器语义恢复接续，时间和观察 nonce 不重置预算",
		async (stage) => {
			const directory = createExecutionDirectory(`local-deployment-${stage}-semantic-recovery-`);
			const binding = manifest(directory);
			const stageCommand = binding.stages.find((item) => item.stage === stage);
			if (!stageCommand) throw new Error("缺少待测阶段");
			stageCommand.readOnlyRecoveryEvidenceObservationCommand = ["observe-stage-machine-evidence"];
			const frozenSourceReport = join(directory, "frozen-source-validation-report.json");
			await writeFile(frozenSourceReport, JSON.stringify({ status: "passed" }));
			stageCommand.recoveryEvidenceFilePaths = [frozenSourceReport];
			await initializeLocalDeploymentExecution(directory, binding);
			let conditionRecovered = false;
			let now = Date.now();
			let observationNonce = 0;
			const commands: string[] = [];
			const runCommand = async (command: string[]) => {
				commands.push(command[0]);
				if (command[0] === "observe-stage-machine-evidence")
					return {
						processWasStarted: true,
						exitCode: 0,
						stdout: JSON.stringify({
							evidenceSha256: (conditionRecovered ? "2" : "1").repeat(64),
							nonce: ++observationNonce,
						}),
						stderr: "",
					};
				return {
					processWasStarted: true,
					exitCode: command[0] === stageCommand.command[0] && !conditionRecovered ? 2 : 0,
					stdout: verifiedEffectStdout(command),
					stderr: "",
				};
			};
			const execute = () => executeLocalDeploymentStages(directory, { runCommand, readNowEpochMs: () => now });
			expect((await execute()).recovery.unfinishedStage).toBe(stage);
			expect(commands.filter((command) => command === stageCommand.command[0])).toHaveLength(2);
			now += 60_000;
			expect((await execute()).recovery.unfinishedStage).toBe(stage);
			expect(commands.filter((command) => command === stageCommand.command[0])).toHaveLength(2);
			conditionRecovered = true;
			expect((await execute()).deploymentOutcome).toBe("succeeded");
			expect(commands.filter((command) => command === stageCommand.command[0])).toHaveLength(3);
			for (const irreversible of ["publish", "restart", "record"])
				expect(commands.filter((command) => command === irreversible)).toHaveLength(1);
			expect(await readFile(frozenSourceReport, "utf8")).toBe(JSON.stringify({ status: "passed" }));
		},
	);

	it("源码质量失败交回 Agent，保留实际失败而非等待机器补证或重复检查", async () => {
		const directory = createExecutionDirectory("local-deployment-source-quality-failure-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const commands: string[] = [];
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => {
				commands.push(command[0]);
				if (command[0] === "cleanup") return { processWasStarted: true, exitCode: 0, stdout: "", stderr: "" };
				return {
					processWasStarted: true,
					exitCode: 1,
					stdout: JSON.stringify({ ok: false, status: "quality_validation_failed" }),
					stderr: "源码检查未通过，原始输出保存在验证报告中",
				};
			},
		});
		expect(commands).toEqual(["prepare", "cleanup"]);
		expect(result.deploymentOutcome).toBe("quality_validation_failed");
		expect(result.recovery.nextCheckAtEpochMs).toBeNull();
		expect(
			(await readLocalDeploymentExecution(directory)).observations.find(
				(item) => item.stage === "candidate_preparation" && item.kind === "command_failed",
			)?.commandFailureKind,
		).toBe("quality_validation_failed");
		const recovered = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => ({
				processWasStarted: true,
				exitCode: 0,
				stdout: verifiedEffectStdout(command),
				stderr: "",
			}),
		});
		expect(recovered.deploymentOutcome).toBe("succeeded");
		expect(
			(await readLocalDeploymentExecution(directory)).observations.some(
				(item) => item.commandFailureKind === "quality_validation_failed",
			),
		).toBe(true);
	});

	it("发布身份不匹配交回判断，不记成源码质量失败，也不安排机器重试", async () => {
		const directory = createExecutionDirectory("local-deployment-identity-mismatch-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const commands: string[] = [];
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => {
				commands.push(command[0]);
				if (command[0] === "cleanup") return { processWasStarted: true, exitCode: 0, stdout: "", stderr: "" };
				return {
					processWasStarted: true,
					exitCode: 2,
					stdout: JSON.stringify({ ok: false, status: "human_decision_required" }),
					stderr: "当前源码 package 的 CLI 名称或链接目标与授权发布目录不一致",
				};
			},
		});
		expect(commands).toEqual(["prepare", "cleanup"]);
		expect(result.deploymentOutcome).toBe("human_decision_required");
		expect(result.recovery.nextCheckAtEpochMs).toBeNull();
		expect(result.recovery.condition).toContain("不把这次失败当成源码质量失败");
		expect(
			(await readLocalDeploymentExecution(directory)).observations.find(
				(item) => item.stage === "candidate_preparation" && item.kind === "command_failed",
			)?.commandFailureKind,
		).toBe("human_decision_required");
	});

	it("准备阶段只读观察进入既有恢复指纹，nonce 不触发重试，Stop 禁止继续观察", async () => {
		const directory = createExecutionDirectory("local-deployment-source-validation-observation-");
		const binding = manifest(directory);
		const observationPath = join(directory, "source-validation-observation.json");
		const invocationPath = join(directory, "observer-invocations.txt");
		binding.stages[0].readOnlyRecoveryEvidenceObservationCommand = [
			process.execPath,
			"-e",
			"const fs=require('node:fs');fs.appendFileSync(process.argv[2],'观察\\n');process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))",
			observationPath,
			invocationPath,
		];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("隔离实例未启动"));
		onTestFinished(() => fetchMock.mockRestore());
		await writeFile(observationPath, JSON.stringify({ evidenceSha256: "1".repeat(64), nonce: 1 }));
		await initializeLocalDeploymentExecution(directory, binding);
		const initial = await observeLocalDeploymentRecoveryEvidence(directory);
		await writeFile(observationPath, JSON.stringify({ evidenceSha256: "1".repeat(64), nonce: 2 }));
		expect(await observeLocalDeploymentRecoveryEvidence(directory)).toEqual(initial);
		await writeFile(observationPath, JSON.stringify({ evidenceSha256: "2".repeat(64) }));
		expect(await observeLocalDeploymentRecoveryEvidence(directory)).not.toEqual(initial);
		await restrictLocalDeploymentExecution(directory, {
			kind: "permission_revoked",
			reason: "Stop",
			sourceReference: "test:stop-source-observation",
		});
		const invocationsBeforeStop = await readFile(invocationPath, "utf8");
		await observeLocalDeploymentRecoveryEvidence(directory);
		expect(await readFile(invocationPath, "utf8")).toBe(invocationsBeforeStop);
	});

	it.each(["isolated-deployment-workspace", "another-workspace"])(
		"时间回拨后，%s 的后继登记可证明旧接受事实，前驱 marker 不能冒充后继",
		(workspaceId) => {
			const binding = manifest("/isolated-registration-source");
			const originalGroup = {
				deploymentId: binding.executionId,
				workspaceId: binding.workspaceId,
				deployedSourceCommit: binding.candidateSourceCommit,
				previousDeployedSourceCommit: binding.previousDeployedSourceCommit,
				foldedAtIso: workspaceId === binding.workspaceId ? "2026-10-31T11:00:00Z" : null,
				deployedAtIso: "2026-10-31T12:00:00Z",
			};
			const laterGroup = {
				deploymentId: "cf2574ad-9e8a-496c-b842-9cab57aa815a",
				workspaceId,
				deployedSourceCommit: "e".repeat(40),
				previousDeployedSourceCommit: binding.candidateSourceCommit,
				foldedAtIso: null,
				deployedAtIso: "2026-10-31T11:00:00Z",
			};
			expect(
				verifyLocalDeploymentRegistrationEffectFromPersistedEvidence({
					manifest: binding,
					deploymentGroups: [laterGroup, originalGroup],
					marker: { deploymentId: laterGroup.deploymentId, deployedSourceCommit: laterGroup.deployedSourceCommit },
				}),
			).toBe(true);
			expect(
				verifyLocalDeploymentRegistrationEffectFromPersistedEvidence({
					manifest: binding,
					deploymentGroups: [
						originalGroup,
						{
							...laterGroup,
							workspaceId: "another-workspace",
							previousDeployedSourceCommit: null,
							deployedSourceCommit: binding.previousDeployedSourceCommit ?? "b".repeat(40),
						},
					],
					marker: {
						deploymentId: laterGroup.deploymentId,
						deployedSourceCommit: binding.previousDeployedSourceCommit ?? "b".repeat(40),
					},
				}),
			).toBe(false);
		},
	);

	it.each(["prepare", "publish"])(
		"%s 阶段内部收到 Stop 不启动第二次尝试，取消原件可独立复盘",
		async (stoppedCommand) => {
			const directory = createExecutionDirectory("local-deployment-stop-during-stage-");
			await initializeLocalDeploymentExecution(directory, manifest(directory));
			const commands: string[] = [];
			const result = await executeLocalDeploymentStages(directory, {
				runCommand: async (command) => {
					commands.push(command[0]);
					if (command[0] === stoppedCommand) {
						await restrictLocalDeploymentExecution(directory, {
							kind: "permission_revoked",
							reason: "用户明确 Stop",
							sourceReference: "test:stop-inside-command",
						});
						const requests = await readdir(join(directory, "retrospective-analysis-requests"));
						expect(requests).toHaveLength(1);
						const original = JSON.parse(
							await readFile(join(directory, "retrospective-analysis-requests", requests[0]), "utf8"),
						);
						expect(original.restriction.sourceReference).toBe("test:stop-inside-command");
						expect(original.analysis.deploymentOutcome).toBe("permission_revoked");
						return {
							exitCode: 1,
							processWasStarted: stoppedCommand !== "publish",
							stdout: "",
							stderr: "第一次失败",
						};
					}
					return { exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
				},
			});
			expect(result.deploymentOutcome).toBe("permission_revoked");
			expect(commands.filter((command) => command === stoppedCommand)).toHaveLength(1);
			expect(commands).not.toContain("cleanup");
		},
	);

	it("意图持久化期间运行时锁失效，不能启动发布且仍留下未启动与复盘事实", async () => {
		const directory = createExecutionDirectory("local-deployment-lock-compromise-after-intent-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const originalWithLock = lockedFileSystem.withLock.bind(lockedFileSystem);
		const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		let reportRuntimeLockCompromise: ((error: Error) => void) | undefined;
		vi.spyOn(lockedFileSystem, "withLock").mockImplementation(async (request, operation) => {
			if (
				typeof request === "object" &&
				"lockfileName" in request &&
				request.lockfileName?.startsWith(".local-deployment-runtime-")
			)
				reportRuntimeLockCompromise = request.onCompromised;
			return originalWithLock(request, operation);
		});
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, value, options) => {
			await originalWrite(path, value, options);
			if (
				path === join(directory, "local-deployment-execution.json") &&
				JSON.stringify(value).includes('"stage":"build_publication","kind":"command_execution_intent_persisted"')
			) {
				reportRuntimeLockCompromise?.(new Error("运行时锁在意图写入期间失效"));
			}
		});
		onTestFinished(() => {
			vi.restoreAllMocks();
		});
		const commands: string[] = [];
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => {
				commands.push(command[0]);
				return { exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
			},
		});
		expect(commands).not.toContain("publish");
		expect(result.deploymentOutcome).toBe("machine_evidence_pending");
		expect((await readLocalDeploymentExecution(directory)).observations).toContainEqual(
			expect.objectContaining({ stage: "build_publication", kind: "command_not_started" }),
		);
		expect(await readdir(join(directory, "retrospective-analysis-requests"))).toHaveLength(1);
	});

	it.each([
		"bound",
		"legacy",
		"wrong_execution",
		"wrong_attempt",
		"wrong_cwd",
		"wrong_command",
		"malformed",
		"symbolic_original",
	])("恢复 %s 未启动原件时只接受同一执行与尝试的可信证据", async (originalKind) => {
		const directory = createExecutionDirectory("local-deployment-recover-not-started-original-");
		const binding = manifest(directory);
		const record = await initializeLocalDeploymentExecution(directory, binding);
		const observedAtEpochMs = Date.now();
		const outputDirectory = join(directory, "stage-command-originals", "build_publication", "attempt-1");
		for (const stage of ["candidate_preparation", "state_preservation", "build_publication"] as const) {
			record.observations.push({
				sequence: record.observations.length + 1,
				stage,
				kind: stage === "build_publication" ? "command_execution_intent_persisted" : "command_succeeded",
				attemptNumber: 1,
				observedAtEpochMs,
				recoveryEvidenceSha256: "d".repeat(64),
				commandOutputDirectory: outputDirectory,
				exitCode: null,
				detail: "隔离崩溃切点",
			});
		}
		await writeFile(join(directory, "local-deployment-execution.json"), JSON.stringify(record));
		await mkdir(outputDirectory, { recursive: true });
		const original = {
			command: originalKind === "wrong_command" ? ["another-command"] : ["publish"],
			cwd: originalKind === "wrong_cwd" ? join(directory, "other-cwd") : directory,
			processWasStarted: false,
			processId: null,
			exitCode: null,
			startedAtEpochMs: observedAtEpochMs + 1,
			finishedAtEpochMs: observedAtEpochMs + 2,
			...(originalKind === "legacy"
				? {}
				: {
						attemptIdentity: {
							executionId:
								originalKind === "wrong_execution"
									? "cf2574ad-9e8a-496c-b842-9cab57aa815a"
									: binding.executionId,
							stage: "build_publication",
							attemptNumber: originalKind === "wrong_attempt" ? 2 : 1,
							commandOutputDirectory: outputDirectory,
						},
					}),
		};
		const originalPath = join(outputDirectory, "command-result.json");
		if (originalKind === "symbolic_original") {
			const foreignOriginal = join(directory, "foreign-command-original.json");
			await writeFile(foreignOriginal, JSON.stringify(original));
			await symlink(foreignOriginal, originalPath);
		} else await writeFile(originalPath, originalKind === "malformed" ? "{" : JSON.stringify(original));
		const commands: string[] = [];
		const accepted = originalKind === "bound" || originalKind === "legacy";
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => {
				commands.push(command[0]);
				return { exitCode: 0, stdout: accepted ? verifiedEffectStdout(command) : "{}", stderr: "" };
			},
		});
		expect(commands.filter((command) => command === "publish")).toHaveLength(accepted ? 1 : 0);
		expect(result.deploymentOutcome).toBe(accepted ? "succeeded" : "machine_evidence_pending");
		if (accepted)
			expect((await readLocalDeploymentExecution(directory)).observations).toContainEqual(
				expect.objectContaining({ stage: "build_publication", attemptNumber: 1, kind: "command_not_started" }),
			);
	});

	it("只读恢复指纹忽略采样时间与 nonce，但真实进程换代或效果变化会更新", async () => {
		const directory = createExecutionDirectory("local-deployment-stable-recovery-observation-");
		const binding = manifest(directory);
		let runtimeProcessId = 101;
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					result: {
						data: {
							runtimeIdentity: binding.runtimeIdentity,
							runtimeProcessId,
							runtimeProcessStartTimeText: `start-${runtimeProcessId}`,
							checkedAtEpochMs: Date.now(),
							nonce: Math.random(),
						},
					},
				}),
			);
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("隔离端口不可用");
		binding.runtimeIdentity.runtimePort = address.port;
		const proofFile = join(directory, "bound-effect-proof.json");
		binding.stages[2].effectVerificationCommand = [
			process.execPath,
			"-e",
			`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(proofFile)}, 'utf8'))`,
		];
		await writeFile(proofFile, JSON.stringify({ ok: false }));
		await initializeLocalDeploymentExecution(directory, binding);
		await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => ({ exitCode: command[0] === "publish" ? 1 : 0, stdout: "{}", stderr: "" }),
		});
		const initial = await observeLocalDeploymentRecoveryEvidence(directory);
		expect(await observeLocalDeploymentRecoveryEvidence(directory)).toEqual(initial);
		runtimeProcessId = 102;
		const afterProcessChange = await observeLocalDeploymentRecoveryEvidence(directory);
		expect(afterProcessChange).not.toEqual(initial);
		await writeFile(proofFile, verifiedEffectStdout(["verify-publication"]));
		expect(await observeLocalDeploymentRecoveryEvidence(directory)).not.toEqual(afterProcessChange);
		await restrictLocalDeploymentExecution(directory, {
			kind: "permission_revoked",
			reason: "Stop",
			sourceReference: "test:cancel-observation",
		});
		const cancelled = await observeLocalDeploymentRecoveryEvidence(directory);
		runtimeProcessId = 103;
		expect(await observeLocalDeploymentRecoveryEvidence(directory)).toEqual(cancelled);
	});

	it("登记成功后评论失败只留下附属警告，重复运行不重复发布或重启", async () => {
		const directory = createExecutionDirectory("local-deployment-execution-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const commands: string[] = [];
		const runCommand = async (command: string[]) => {
			commands.push(command[0]);
			return { exitCode: command[0] === "comment" ? 1 : 0, stdout: verifiedEffectStdout(command), stderr: "" };
		};
		const first = await executeLocalDeploymentStages(directory, { runCommand });
		expect(first.deploymentOutcome).toBe("succeeded");
		expect(first.ancillaryFailures).toEqual(["task_comment"]);
		expect(first.retrospective.status).toBe("pending");
		const repeated = await executeLocalDeploymentStages(directory, { runCommand });
		expect(repeated.analysisFingerprint).toBe(first.analysisFingerprint);
		expect(commands.filter((command) => command === "publish")).toHaveLength(1);
		expect(commands.filter((command) => command === "restart")).toHaveLength(1);
		expect(commands.filter((command) => command === "record")).toHaveLength(1);
		await expect(finishLocalDeploymentExecution(directory, "failed")).rejects.toThrow("成功");
	});

	it("发布结果未知时先核对绑定的效果证据，不重放已被接受的动作", async () => {
		const directory = createExecutionDirectory("local-deployment-accepted-effect-");
		const binding = manifest(directory);
		await initializeLocalDeploymentExecution(directory, binding);
		const commands: string[] = [];
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => {
				commands.push(command[0]);
				if (command[0] === "publish") throw new Error("发布已接受，但结果连接断开");
				return {
					exitCode: 0,
					stdout: verifiedEffectStdout(command),
					stderr: "",
				};
			},
		});
		expect(result.deploymentOutcome).toBe("succeeded");
		expect(commands.filter((command) => command === "publish")).toHaveLength(1);
		const record = await readLocalDeploymentExecution(directory);
		expect(record.observations.some((observation) => observation.kind === "command_failed")).toBe(true);
		expect(record.observations.some((observation) => observation.kind === "effect_verified")).toBe(true);
	});

	it("错候选的核验不能放行；机器待证有界复查，仍继续独立清理", async () => {
		const directory = createExecutionDirectory("local-deployment-unknown-effect-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const commands: string[] = [];
		const runCommand = async (command: string[]) => {
			commands.push(command[0]);
			if (command[0] === "publish") throw new Error("结果未知");
			return {
				exitCode: 0,
				stdout: command[0].startsWith("verify-")
					? JSON.stringify({
							ok: true,
							executionId: "another-execution",
							candidateSourceCommit: "d".repeat(40),
							candidateDistributionSha256: "e".repeat(64),
						})
					: "",
				stderr: "",
			};
		};
		const result = await executeLocalDeploymentStages(directory, { runCommand });
		expect(result.deploymentOutcome).toBe("machine_evidence_pending");
		expect(result.recovery.nextCheckAtEpochMs).toBeTypeOf("number");
		expect(commands).toContain("cleanup");
		expect(commands).not.toContain("restart");
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(commands.filter((command) => command === "publish")).toHaveLength(1);
	});

	it("普通命令失败有界重试，补证文件改变后自动接续，旧失败保留", async () => {
		const directory = createExecutionDirectory("local-deployment-machine-recovery-");
		const recoveryEvidencePath = join(directory, "dependency-recovery-evidence.txt");
		await writeFile(recoveryEvidencePath, "dependency-unavailable");
		const binding = manifest(directory);
		binding.stages[0].recoveryEvidenceFilePaths = [recoveryEvidencePath];
		await initializeLocalDeploymentExecution(directory, binding);
		let available = false;
		let preparationCount = 0;
		const runCommand = async (command: string[]) => {
			if (command[0] === "prepare") preparationCount += 1;
			return {
				exitCode: command[0] === "prepare" && !available ? 1 : 0,
				stdout: verifiedEffectStdout(command),
				stderr: "",
			};
		};
		expect((await executeLocalDeploymentStages(directory, { runCommand })).deploymentOutcome).toBe(
			"machine_evidence_pending",
		);
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(preparationCount).toBe(2);
		available = true;
		await writeFile(recoveryEvidencePath, "locked-dependency-restored");
		expect((await executeLocalDeploymentStages(directory, { runCommand })).deploymentOutcome).toBe("succeeded");
		expect(preparationCount).toBe(3);
		expect(
			(await readLocalDeploymentExecution(directory)).observations.filter((item) => item.kind === "command_failed"),
		).toHaveLength(2);
	});

	it("只读分析不改原件，未知指标不变成零，并能固化一次独立发现", async () => {
		const directory = createExecutionDirectory("local-deployment-readonly-analysis-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => ({ exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" }),
		});
		const before = await readFile(join(directory, "local-deployment-execution.json"), "utf8");
		const analysis = await analyzeLocalDeploymentExecutions([directory]);
		expect(analysis.executions[0].metrics.httpDowntimeMs).toBeNull();
		expect(analysis.executions[0].metrics.nativeModelUsage).toBeNull();
		expect(await readFile(join(directory, "local-deployment-execution.json"), "utf8")).toBe(before);
		const report = {
			analysisFingerprint: analysis.executions[0].analysisFingerprint,
			existingIssueCatalogConsulted: false as const,
			findings: [
				{
					problemKey: "deployment:repeated-validation",
					nature: "improvement_proposal" as const,
					description: "消除重复验证",
					evidenceReferences: ["local-deployment-execution.json"],
					evidenceStatus: "single_observation" as const,
				},
			],
		};
		await freezeLocalDeploymentIndependentFindings(directory, report);
		await freezeLocalDeploymentIndependentFindings(directory, report);
		expect(await readdir(join(directory, "independent-retrospective-findings"))).toHaveLength(1);
		await expect(freezeLocalDeploymentIndependentFindings(directory, { ...report, findings: [] })).rejects.toThrow(
			"不同",
		);
	});

	it("同一执行身份不得改候选或授权，核验命令不得缺失", async () => {
		const directory = createExecutionDirectory("local-deployment-binding-");
		const binding = manifest(directory);
		await initializeLocalDeploymentExecution(directory, binding);
		await expect(
			initializeLocalDeploymentExecution(directory, { ...binding, candidateSourceCommit: "d".repeat(40) }),
		).rejects.toThrow("绑定");
		const otherDirectory = createExecutionDirectory("local-deployment-without-effect-probe-");
		binding.stages[2].effectVerificationCommand = undefined;
		await expect(initializeLocalDeploymentExecution(otherDirectory, binding)).rejects.toThrow();
	});

	it("明确停止不自动接续；确需人工取舍与机器待证分别呈现", async () => {
		const directory = createExecutionDirectory("local-deployment-explicit-restriction-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		await restrictLocalDeploymentExecution(directory, {
			kind: "permission_revoked",
			reason: "用户明确 Stop",
			sourceReference: "test:user-stop",
		});
		let commands = 0;
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async () => {
				commands += 1;
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(result.deploymentOutcome).toBe("permission_revoked");
		expect(result.recovery.nextCheckAtEpochMs).toBeNull();
		expect(commands).toBe(0);
	});

	it("旧材料已有登记时不被附属失败覆盖，缺失统计保持未知", async () => {
		const directory = createExecutionDirectory("local-deployment-legacy-receipt-");
		await writeFile(
			join(directory, "deployment-record.json"),
			JSON.stringify({
				ok: true,
				deploymentId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
				deployedSourceCommit: "a".repeat(40),
			}),
		);
		await writeFile(
			join(directory, "execution-status.json"),
			JSON.stringify({ stage: "部署执行暂停", error: "task append-comment timeout" }),
		);
		const before = await readdir(directory);
		const result = (await analyzeLocalDeploymentExecutions([directory])).executions[0];
		expect(result.deploymentOutcome).toBe("succeeded");
		expect(result.metrics.commandAttempts).toBeNull();
		expect(result.metrics.failedCommandAttempts).toBeNull();
		expect(await readdir(directory)).toEqual(before);
	});

	it("复盘材料目录故障也不能把已经完成的部署写成失败", async () => {
		const directory = createExecutionDirectory("local-deployment-retrospective-material-failure-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		await writeFile(join(directory, "retrospective-analysis-requests"), "既有异常文件，不能删除");
		const result = await executeLocalDeploymentStages(directory, {
			runCommand: async (command) => ({ exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" }),
		});
		expect(result.deploymentOutcome).toBe("succeeded");
		expect(result.retrospective.status).toBe("request_material_pending");
		expect(await readFile(join(directory, "retrospective-analysis-requests"), "utf8")).toBe("既有异常文件，不能删除");
	});

	it("后续动作前重新核对当前效果，保留历史接受且不因无变化轮询重复复盘", async () => {
		const directory = createExecutionDirectory("local-deployment-effect-eligibility-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		let publicationStillMatches = true;
		const runCommand = async (command: string[]) => ({
			exitCode: command[0] === "validate" ? 1 : 0,
			stdout: command[0] === "verify-publication" && !publicationStillMatches ? "{}" : verifiedEffectStdout(command),
			stderr: "",
		});
		await executeLocalDeploymentStages(directory, { runCommand });
		publicationStillMatches = false;
		const blocked = await executeLocalDeploymentStages(directory, { runCommand });
		expect(blocked.recovery.unfinishedStage).toBe("build_publication");
		const afterChange = await readdir(join(directory, "retrospective-analysis-requests"));
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(await readdir(join(directory, "retrospective-analysis-requests"))).toEqual(afterChange);
		publicationStillMatches = true;
		const recovered = await executeLocalDeploymentStages(directory, {
			runCommand,
			readNowEpochMs: () => Date.now() + 60_000,
		});
		expect(recovered.metrics.verifiedStageEffects).toBe(2);
		expect(recovered.metrics.recoveredEffects).toBe(0);
		expect(
			(await readLocalDeploymentExecution(directory)).observations.some(
				(item) => item.stage === "build_publication" && item.kind === "effect_verified",
			),
		).toBe(true);
	});

	it("复盘请求原件身份损坏时保留部署成功并准备补证，不接受错执行请求", async () => {
		const directory = createExecutionDirectory("local-deployment-request-identity-");
		await initializeLocalDeploymentExecution(directory, manifest(directory));
		const runCommand = async (command: string[]) => ({
			exitCode: 0,
			stdout: verifiedEffectStdout(command),
			stderr: "",
		});
		const result = await executeLocalDeploymentStages(directory, { runCommand });
		const requestPath = join(directory, "retrospective-analysis-requests", `${result.analysisFingerprint}.json`);
		await writeFile(
			requestPath,
			JSON.stringify({ executionId: "different-execution", analysisFingerprint: result.analysisFingerprint }),
		);
		const record = await readLocalDeploymentExecution(directory);
		record.retrospective.status = "request_material_pending";
		await writeFile(join(directory, "local-deployment-execution.json"), JSON.stringify(record));
		const repeated = await executeLocalDeploymentStages(directory, { runCommand });
		expect(repeated.deploymentOutcome).toBe("succeeded");
		expect(repeated.retrospective.status).toBe("request_material_pending");
		expect(JSON.parse(await readFile(requestPath, "utf8")).executionId).toBe("different-execution");
	});

	it("已确证未启动的发布命令可以在补证变化后恢复，不混淆未知副作用", async () => {
		const directory = createExecutionDirectory("local-deployment-proven-not-started-");
		const evidence = join(directory, "restored-executable-evidence.txt");
		await writeFile(evidence, "missing");
		const binding = manifest(directory);
		binding.stages[2].recoveryEvidenceFilePaths = [evidence];
		await initializeLocalDeploymentExecution(directory, binding);
		let available = false;
		let publications = 0;
		const runCommand = async (command: string[]) => {
			if (command[0] === "publish") {
				publications += 1;
				if (!available)
					return { exitCode: null, stdout: "", stderr: "ENOENT，未创建子进程", processWasStarted: false };
			}
			return { exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
		};
		expect((await executeLocalDeploymentStages(directory, { runCommand })).deploymentOutcome).toBe(
			"machine_evidence_pending",
		);
		available = true;
		await writeFile(evidence, "restored");
		expect((await executeLocalDeploymentStages(directory, { runCommand })).deploymentOutcome).toBe("succeeded");
		expect(publications).toBe(3);
	});

	it("跨次重复阶段失败可识别，重复目录不算额外支持，缺失目录不阻断其余分析", async () => {
		const directories = [
			createExecutionDirectory("local-deployment-history-one-"),
			createExecutionDirectory("local-deployment-history-two-"),
		];
		for (const [index, directory] of directories.entries()) {
			await writeFile(
				join(directory, "deployment-record.json"),
				JSON.stringify({
					ok: true,
					deploymentId: ["032609d8-7508-4bdc-b202-1d7bd7da8a14", "cf2574ad-9e8a-496c-b842-9cab57aa815a"][index],
					deployedSourceCommit: "a".repeat(40),
				}),
			);
			await writeFile(
				join(directory, "deployment-execution-recovery-notes.json"),
				JSON.stringify([
					{
						phase: "first_promotion_attempt",
						observedFailure: "rmdir 无法删除空暂存子目录",
						recovery: "保留发布效果后接续",
					},
				]),
			);
		}
		const analysis = await analyzeLocalDeploymentExecutions([
			...directories,
			directories[0],
			join(directories[0], "absent-originals"),
		]);
		expect(analysis.coverage).toBe("partial");
		expect(analysis.executions).toHaveLength(2);
		expect(analysis.unavailableExecutions).toHaveLength(1);
		expect(analysis.repeatedStageFailures).toEqual([
			{
				stage: "staging_cleanup",
				independentExecutionIds: ["032609d8-7508-4bdc-b202-1d7bd7da8a14", "cf2574ad-9e8a-496c-b842-9cab57aa815a"],
			},
		]);
	});
});

describe("五条代表轨迹的 v2 隔离回归", () => {
	it.each([
		{
			caseId: "D0 离线起点",
			offline: true,
			validationFailures: 0,
			recordFailureAccepted: false,
			commentFailure: false,
		},
		{
			caseId: "D1 登记已接受而命令失败",
			offline: false,
			validationFailures: 0,
			recordFailureAccepted: true,
			commentFailure: true,
		},
		{
			caseId: "D2 跨项目 API 超时后补证",
			offline: false,
			validationFailures: 4,
			recordFailureAccepted: false,
			commentFailure: false,
		},
		{
			caseId: "D3 一次暂时失败后自动恢复",
			offline: false,
			validationFailures: 1,
			recordFailureAccepted: false,
			commentFailure: false,
		},
		{
			caseId: "D4 历史接管补证后正常回收",
			offline: false,
			validationFailures: 3,
			recordFailureAccepted: false,
			commentFailure: false,
		},
	])("$caseId：恢复后不重复发布、重启或登记", async (scenario) => {
		const directory = createExecutionDirectory("representative-redeployment-");
		const evidence = join(directory, "semantic-evidence.json");
		await writeFile(evidence, JSON.stringify({ source: "initial" }));
		const original = manifest(directory);
		const binding: LocalDeploymentExecutionManifest = {
			...original,
			schemaVersion: 2,
			runtimeBefore: scenario.offline ? null : original.runtimeBefore,
			runtimeStartingState: scenario.offline ? "verified_offline" : "verified_online",
			runtimeStartingStateEvidenceFilePath: join(directory, "baseline.json"),
			redeploymentRequestSha256: "d".repeat(64),
			stages: original.stages.map((stage) => ({ ...stage, recoveryEvidenceFilePaths: [evidence] })),
		};
		await initializeLocalDeploymentExecution(directory, binding);
		const counts = new Map<string, number>();
		let now = Date.now();
		const runCommand = async (command: string[]) => {
			const key = command[0];
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			const failed =
				(key === "validate" && count <= scenario.validationFailures) ||
				(key === "record" && scenario.recordFailureAccepted) ||
				(key === "comment" && scenario.commentFailure && count === 1);
			return {
				processWasStarted: true,
				exitCode: failed ? 1 : 0,
				stdout: verifiedEffectStdout(command),
				stderr: failed ? "保留本次原始失败" : "",
			};
		};
		let analysis = await executeLocalDeploymentStages(directory, { runCommand, readNowEpochMs: () => now });
		for (let recovery = 1; analysis.deploymentOutcome !== "succeeded" && recovery <= 3; recovery++) {
			await writeFile(evidence, JSON.stringify({ source: `equivalent-evidence-${recovery}` }));
			now += 31_000;
			analysis = await executeLocalDeploymentStages(directory, { runCommand, readNowEpochMs: () => now });
		}
		expect(analysis.deploymentOutcome).toBe("succeeded");
		for (const irreversible of ["publish", "restart", "record"]) expect(counts.get(irreversible)).toBe(1);
	});

	it("部分发布先探测，再仅执行已声明的幂等补齐；v1 不自动获得恢复权限", async () => {
		const directory = createExecutionDirectory("partial-publication-recovery-");
		const original = manifest(directory);
		const binding: LocalDeploymentExecutionManifest = {
			...original,
			schemaVersion: 2,
			runtimeStartingState: "verified_online",
			runtimeStartingStateEvidenceFilePath: join(directory, "baseline.json"),
			redeploymentRequestSha256: "d".repeat(64),
			stages: original.stages.map((stage) =>
				stage.stage === "build_publication"
					? { ...stage, idempotentEffectRecoveryCommand: ["complete-bound-publication"] }
					: stage,
			),
		};
		await initializeLocalDeploymentExecution(directory, binding);
		const commands: string[] = [];
		let complete = false;
		let now = Date.now();
		const runCommand = async (command: string[]) => {
			commands.push(command[0]);
			if (command[0] === "complete-bound-publication") complete = true;
			const failed = command[0] === "publish" || (command[0] === "verify-publication" && !complete);
			return {
				processWasStarted: true,
				exitCode: failed ? 1 : 0,
				stdout: failed ? "" : verifiedEffectStdout(command),
				stderr: "",
			};
		};
		expect(
			(await executeLocalDeploymentStages(directory, { runCommand, readNowEpochMs: () => now })).deploymentOutcome,
		).toBe("machine_evidence_pending");
		now += 31_000;
		expect(
			(await executeLocalDeploymentStages(directory, { runCommand, readNowEpochMs: () => now })).deploymentOutcome,
		).toBe("succeeded");
		expect(commands.filter((command) => command === "publish")).toHaveLength(1);
		expect(commands.filter((command) => command === "complete-bound-publication")).toHaveLength(1);
		expect(commands.indexOf("verify-publication")).toBeLessThan(commands.indexOf("complete-bound-publication"));
	});

	async function writeFrozenRedeploymentRequest(directory: string, binding: LocalDeploymentExecutionManifest) {
		const executor = "// 隔离未启动恢复\n";
		const request = {
			schemaVersion: 1 as const,
			executionId: binding.executionId,
			workspaceId: binding.workspaceId,
			taskId: binding.taskId,
			originatingTaskWorktreePath: binding.originatingTaskWorktreePath,
			sourceCheckoutPath: binding.sourceCheckoutPath,
			candidateSourceCommit: binding.candidateSourceCommit,
			deploymentNodeBinaryPath: binding.deploymentNodeBinaryPath,
			distributionDirectoryPath: binding.distributionDirectoryPath,
			runtimeIdentity: binding.runtimeIdentity,
			serviceLaunch: { command: [process.execPath] },
			authorization: binding.authorization,
		};
		await writeFile(join(directory, "frozen-local-redeployment-executor.mjs"), executor);
		await writeFile(
			join(directory, "frozen-redeployment-request.json"),
			JSON.stringify({
				request,
				requestSha256: localRedeploymentSha256(JSON.stringify(request)),
				executorSha256: localRedeploymentSha256(executor),
				npmCliEntrypointPath: process.execPath,
				serviceExecutableSha256: "d".repeat(64),
				owner: null,
			}),
		);
	}

	it("确证未启动后只再放行一次，限制未解除或进程已启动时不解锁", async () => {
		const directory = createExecutionDirectory("proven-not-started-recovery-");
		await mkdir(join(directory, "isolated-runtime-home"));
		const binding = manifest(directory);
		binding.stages[1].recoveryEvidenceObservationMode = "semantic_observation_only";
		binding.stages[1].readOnlyRecoveryEvidenceObservationCommand = ["observe-stage"];
		await initializeLocalDeploymentExecution(directory, binding);
		await writeFrozenRedeploymentRequest(directory, binding);
		let attemptedSpawnCount = 0;
		const runCommand: LocalDeploymentCommandRunner = async (command) => {
			if (command[0] === "observe-stage") {
				const budget = await readLocalDeploymentTargetStageRecoveryBudget(binding, "state_preservation");
				const observation = budget?.blockingFailure
					? await observeLocalRedeploymentBlockingFailureRecovery(directory, budget.blockingFailure)
					: { evidenceSha256: "1".repeat(64), recoveryEvidenceReady: false };
				return { exitCode: 0, processWasStarted: true, stdout: JSON.stringify(observation), stderr: "" };
			}
			if (command[0] === "preserve") {
				attemptedSpawnCount += 1;
				return { processWasStarted: false, exitCode: null, stdout: "", stderr: "启动瞬时失败" };
			}
			return { processWasStarted: true, exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
		};
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(attemptedSpawnCount).toBe(1);
		const blocked = await readLocalDeploymentTargetStageRecoveryBudget(binding, "state_preservation");
		expect(blocked?.blockingFailure?.classification).toBe("unclassified_failure");
		expect(blocked?.blockingFailure?.sourcePath).toBeUndefined();
		const failure = blocked?.blockingFailure;
		if (!failure) throw new Error("缺少未启动失败原件");
		await writeFile(
			join(directory, "local-deployment-execution-restriction.json"),
			JSON.stringify({ kind: "permission_revoked", reason: "隔离停止", sourceReference: "test:not-started" }),
		);
		expect((await observeLocalRedeploymentBlockingFailureRecovery(directory, failure)).recoveryEvidenceReady).toBe(
			false,
		);
		await rm(join(directory, "local-deployment-execution-restriction.json"));
		const released = await observeLocalRedeploymentBlockingFailureRecovery(directory, failure);
		expect(released.recoveryEvidenceReady).toBe(true);
		expect(await observeLocalRedeploymentBlockingFailureRecovery(directory, failure)).toEqual(released);
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(attemptedSpawnCount).toBe(2);
		await executeLocalDeploymentStages(directory, { runCommand });
		expect(attemptedSpawnCount).toBe(2);

		const failedDirectory = createExecutionDirectory("started-unclassified-failure-");
		await mkdir(join(failedDirectory, "isolated-runtime-home"));
		const failedBinding = manifest(failedDirectory);
		failedBinding.stages[1].recoveryEvidenceObservationMode = "semantic_observation_only";
		failedBinding.stages[1].readOnlyRecoveryEvidenceObservationCommand = ["observe-stage"];
		await initializeLocalDeploymentExecution(failedDirectory, failedBinding);
		await writeFrozenRedeploymentRequest(failedDirectory, failedBinding);
		let failedStarts = 0;
		const failingCommand: LocalDeploymentCommandRunner = async (command) => {
			if (command[0] === "observe-stage") {
				const budget = await readLocalDeploymentTargetStageRecoveryBudget(failedBinding, "state_preservation");
				const observation = budget?.blockingFailure
					? await observeLocalRedeploymentBlockingFailureRecovery(failedDirectory, budget.blockingFailure)
					: { evidenceSha256: "2".repeat(64), recoveryEvidenceReady: false };
				return { exitCode: 0, processWasStarted: true, stdout: JSON.stringify(observation), stderr: "" };
			}
			if (command[0] === "preserve") {
				failedStarts += 1;
				return { processWasStarted: true, exitCode: 1, stdout: "普通失败", stderr: "进程已创建" };
			}
			return { processWasStarted: true, exitCode: 0, stdout: verifiedEffectStdout(command), stderr: "" };
		};
		await executeLocalDeploymentStages(failedDirectory, { runCommand: failingCommand });
		await executeLocalDeploymentStages(failedDirectory, { runCommand: failingCommand });
		expect(failedStarts).toBe(1);
	});
});
