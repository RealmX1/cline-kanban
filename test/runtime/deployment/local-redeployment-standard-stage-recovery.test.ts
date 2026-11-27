import { lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fingerprintLocalDeploymentDistribution } from "../../../src/deployment/local-deployment-distribution-manifest";
import {
	analyzeLocalDeploymentExecutions,
	initializeLocalDeploymentExecution,
	readLocalDeploymentExecution,
} from "../../../src/deployment/local-deployment-execution";
import { LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER } from "../../../src/deployment/local-deployment-execution-contract";
import {
	recordLocalDeploymentTargetStageFailure,
	reserveLocalDeploymentTargetStageAttempt,
} from "../../../src/deployment/local-deployment-target-stage-recovery-budget";
import {
	canonicalizeLocalRedeploymentRequest,
	createBoundLocalRedeploymentSourceValidationArguments,
	localRedeploymentRequestSchema,
	localRedeploymentSha256,
	readBoundPreviousLocalRedeployment,
	readFrozenLocalRedeploymentRequest,
} from "../../../src/deployment/local-redeployment-preparation";
import {
	executeStandardLocalRedeploymentStage,
	observeStandardLocalRedeploymentStageRecoveryEvidence,
	readCompletedCandidateBuildCommandOriginal,
	runLocalRedeploymentStandardCommand,
	verifyLocalRedeploymentCandidateBuildReceipt,
} from "../../../src/deployment/local-redeployment-standard-execution";
import {
	backupLocalRedeploymentRuntimeState,
	queryLocalRedeploymentRuntime,
} from "../../../src/deployment/local-redeployment-state-preservation";
import type * as LockedFileSystemModule from "../../../src/fs/locked-file-system";
import { readProcessIdentity } from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("../../../src/fs/locked-file-system", async (importOriginal) => {
	const actual = await importOriginal<typeof LockedFileSystemModule>();
	const guardedTestDirectory = process.env.TMPDIR;
	if (!guardedTestDirectory) throw new Error("必须通过 guarded runner 提供独占测试目录。");
	return { ...actual, lockedFileSystem: await actual.LockedFileSystem.forIsolatedTestDirectory(guardedTestDirectory) };
});

vi.mock("../../../src/deployment/local-redeployment-state-preservation", () => ({
	queryLocalRedeploymentRuntime: vi.fn(),
	backupLocalRedeploymentRuntimeState: vi.fn(),
	captureLocalRedeploymentState: vi.fn(),
}));
vi.mock("../../../src/task-command-execution/task-command-execution-supervisor", () => ({
	readProcessIdentity: vi.fn(),
	readSystemBootIdentity: vi.fn(async () => "isolated-boot"),
}));

async function createStandardStageFixture(
	options: { candidateAlreadyLoaded?: boolean; currentMatchesFrozenBaseline?: boolean } = {},
) {
	const temporary = createTempDir("standard-redeployment-stage-recovery-");
	onTestFinished(temporary.cleanup);
	onTestFinished(() => {
		vi.clearAllMocks();
	});
	const directory = await realpath(temporary.path);
	const source = join(directory, "source");
	const candidate = join(directory, "candidate-source-checkout");
	await mkdir(join(source, "scripts"), { recursive: true });
	await mkdir(join(source, "dist"), { recursive: true });
	await mkdir(join(candidate, "scripts"), { recursive: true });
	await mkdir(join(candidate, "dist"), { recursive: true });
	const candidateBytes = "已绑定候选入口";
	await writeFile(join(candidate, "dist/cli.js"), candidateBytes, { mode: 0o755 });
	const request = {
		schemaVersion: 1 as const,
		executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
		workspaceId: "isolated-workspace",
		taskId: "isolated-standard-stage",
		originatingTaskWorktreePath: source,
		sourceCheckoutPath: source,
		candidateSourceCommit: "a".repeat(40),
		deploymentNodeBinaryPath: process.execPath,
		distributionDirectoryPath: join(source, "dist"),
		runtimeIdentity: {
			runtimeHomeDirectoryPath: join(directory, "isolated-runtime-home"),
			runtimeHost: "127.0.0.1",
			runtimePort: 39884,
		},
		serviceLaunch: { command: [process.execPath] },
		authorization: { sourceReference: "test:isolated-standard-stage", userRequestQuote: "仅隔离验证" },
	};
	const executor = "// 隔离冻结执行器\n";
	await writeFile(join(directory, "frozen-local-redeployment-executor.mjs"), executor);
	const frozen = {
		request,
		requestSha256: localRedeploymentSha256(JSON.stringify(request)),
		executorSha256: localRedeploymentSha256(executor),
		npmCliEntrypointPath: process.execPath,
		serviceExecutableSha256: "b".repeat(64),
		owner: null,
	};
	await writeFile(join(directory, "frozen-redeployment-request.json"), JSON.stringify(frozen));
	const current = {
		ok: true,
		runtimeIdentity: request.runtimeIdentity,
		runtimeProcessId: 2002,
		runtimeProcessStartTimeText: "Fri Nov 13 12:05:00 2026",
		runtimeLoadedEntrypointSha256: localRedeploymentSha256(
			options.candidateAlreadyLoaded ? candidateBytes : "旧版入口",
		),
		validatedHostedSessions: [],
		blockingSessions: [] as Array<{ processId: number }>,
	};
	const reportPath = join(directory, "isolated-runtime-report.json");
	await writeFile(reportPath, JSON.stringify(current));
	vi.mocked(queryLocalRedeploymentRuntime).mockImplementation(async () =>
		JSON.parse(await readFile(reportPath, "utf8")),
	);
	vi.mocked(readProcessIdentity).mockImplementation(async (pid) => {
		const observed = JSON.parse(await readFile(reportPath, "utf8"));
		return { pid, startAndCommand: `${observed.runtimeProcessStartTimeText} node isolated-runtime` };
	});
	await writeFile(
		join(source, "scripts/verify-notification-archive-native-runtime.mjs"),
		"process.stdout.write('隔离 ABI 通过');",
	);
	await writeFile(
		join(candidate, "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
		`import {readFileSync} from 'node:fs'; const evidence=JSON.parse(readFileSync(${JSON.stringify(reportPath)},'utf8')); process.stdout.write(JSON.stringify({...evidence,checkedAtEpochMs:Date.now(),outputEndByteOffset:Date.now()})); process.exitCode=evidence.ok?0:2;`,
	);
	const handoverInvocationsPath = join(directory, "handover-invocations.txt");
	const successor = {
		...current,
		runtimeProcessId: 3003,
		runtimeProcessStartTimeText: "Fri Nov 13 12:10:00 2026",
		runtimeLoadedEntrypointSha256: localRedeploymentSha256(candidateBytes),
	};
	await writeFile(
		join(source, "dist/cli.js"),
		`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(handoverInvocationsPath)},'交接一次\\n');fs.writeFileSync(${JSON.stringify(reportPath)},${JSON.stringify(JSON.stringify(successor))});`,
	);
	const { serviceLaunch: _serviceLaunch, ...manifestRequestFields } = request;
	await initializeLocalDeploymentExecution(directory, {
		...manifestRequestFields,
		schemaVersion: 2,
		previousDeployedSourceCommit: null,
		candidateDistributionSha256: (await fingerprintLocalDeploymentDistribution(join(candidate, "dist")))
			.candidateDistributionSha256,
		candidateDistributionDirectoryPath: join(candidate, "dist"),
		runtimeBefore: options.currentMatchesFrozenBaseline
			? { processId: current.runtimeProcessId, processStartTimeText: current.runtimeProcessStartTimeText }
			: { processId: 1001, processStartTimeText: "Fri Nov 13 12:00:00 2026" },
		runtimeStartingState: "verified_online",
		runtimeStartingStateEvidenceFilePath: join(directory, "runtime-starting-state-evidence.json"),
		redeploymentRequestSha256: frozen.requestSha256,
		stages: LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.map((stage) => ({
			stage,
			command: ["isolated-stage"],
			effectVerificationCommand: ["isolated-verifier"],
		})),
	});
	await writeFile(
		join(directory, "publication-runtime-baseline.json"),
		JSON.stringify({
			state: "verified_online",
			runtimeBefore: {
				processId: current.runtimeProcessId,
				processStartTimeText: current.runtimeProcessStartTimeText,
			},
		}),
	);
	return { directory, candidateBytes, current, reportPath, handoverInvocationsPath, request };
}

describe("标准部署当前代际与恢复语义", () => {
	it("目标安装已采用新结案协议时，旧候选在发布和启动前被拒绝且原数据字节不变", async () => {
		const { directory, request } = await createStandardStageFixture();
		const runtimeHome = request.runtimeIdentity.runtimeHomeDirectoryPath;
		await mkdir(runtimeHome, { recursive: true });
		await writeFile(
			join(runtimeHome, "task-closure-storage-protocol-adoption.json"),
			JSON.stringify({ minimumReadableOperationSchemaVersion: 2 }),
		);
		const operationPath = join(runtimeHome, "preserved-v2-operation.json");
		await writeFile(operationPath, JSON.stringify({ schemaVersion: 2, automaticAttemptCount: 3, cancelled: true }));
		const originalOperation = await readFile(operationPath);
		const originalInstallation = await readFile(join(request.distributionDirectoryPath, "cli.js"));
		for (const stage of ["build_publication", "runtime_restart"] as const)
			await expect(executeStandardLocalRedeploymentStage(directory, stage)).rejects.toThrow(
				"不支持已采用的结案存储协议 v2",
			);
		expect(await readFile(operationPath)).toEqual(originalOperation);
		expect(await readFile(join(request.distributionDirectoryPath, "cli.js"))).toEqual(originalInstallation);
	});
	it("历史运行验收之后已换候选，禁止补做首次部署登记", async () => {
		const { directory, current, reportPath } = await createStandardStageFixture({ candidateAlreadyLoaded: true });
		const executionPath = join(directory, "local-deployment-execution.json");
		const execution = JSON.parse(await readFile(executionPath, "utf8"));
		execution.observations.push({
			stage: "runtime_validation",
			sequence: 1,
			kind: "command_succeeded",
			observedAtEpochMs: 1,
			attemptNumber: 1,
			recoveryEvidenceSha256: "a".repeat(64),
			exitCode: 0,
			commandOutputDirectory: directory,
			detail: "原候选已通过运行验收",
		});
		await writeFile(executionPath, JSON.stringify(execution));
		const observe = () => observeStandardLocalRedeploymentStageRecoveryEvidence(directory, "deployment_record");
		expect((await observe()).recoveryEvidenceReady).toBe(true);
		await writeFile(reportPath, JSON.stringify({ ...current, runtimeLoadedEntrypointSha256: "b".repeat(64) }));
		expect((await observe()).recoveryEvidenceReady).toBe(false);
		await expect(executeStandardLocalRedeploymentStage(directory, "deployment_record")).rejects.toThrow(
			"等待核对当前候选",
		);
	});

	it("分析历史执行时把后来尝试的阻塞留在共享目标预算", async () => {
		const { directory, request } = await createStandardStageFixture();
		const stage = "candidate_preparation";
		const newerId = "132609d8-7508-4bdc-b202-1d7bd7da8a14";
		const newerDirectory = join(dirname(directory), "later-deployment");
		const attempt = {
			binding: { ...request, executionId: newerId },
			stage,
			executionDirectory: newerDirectory,
			attemptNumber: 1,
		} as const;
		await reserveLocalDeploymentTargetStageAttempt({
			...attempt,
			recoveryEvidenceReady: true,
			recoveryEvidenceSha256: "a".repeat(64),
		});
		await recordLocalDeploymentTargetStageFailure({
			...attempt,
			failure: {
				classification: "filesystem_unavailable",
				logicalResource: "later-resource",
				recoveryCondition: "等待后继执行的文件",
				originalErrorReference: join(newerDirectory, "stage-failure-originals", stage, "new-error.json"),
			},
		});
		const { executions } = await analyzeLocalDeploymentExecutions([directory]);
		expect(executions[0]?.recovery.condition).not.toContain("后继执行");
		expect(executions[0]?.operationalProgress?.executionOwnedBlockingFailure).toBeNull();
		expect(executions[0]?.operationalProgress?.targetStageBudget).toMatchObject({
			latestAttemptExecutionId: newerId,
			blockingFailure: { logicalResource: "later-resource" },
		});
		expect(executions[0]?.recovery.nextCheckAtEpochMs).toBeNull();
		const commandDirectory = join(directory, "stage-command-originals", stage, "attempt-1");
		const originalDirectory = join(directory, "stage-failure-originals", stage);
		await mkdir(commandDirectory, { recursive: true });
		await mkdir(originalDirectory, { recursive: true });
		const historicalFailure = {
			classification: "filesystem_unavailable",
			logicalResource: "original-resource",
			recoveryCondition: "等待历史执行的文件",
			originalErrorReference: join(originalDirectory, "original-error.json"),
		};
		await writeFile(historicalFailure.originalErrorReference, JSON.stringify({ stage, ...historicalFailure }));
		const executionPath = join(directory, "local-deployment-execution.json");
		const record = JSON.parse(await readFile(executionPath, "utf8"));
		const attemptIdentity = {
			executionId: request.executionId,
			stage,
			attemptNumber: 1,
			commandOutputDirectory: commandDirectory,
		};
		await writeFile(
			join(commandDirectory, "command-result.json"),
			JSON.stringify({
				command: record.manifest.stages[0].command,
				cwd: request.sourceCheckoutPath,
				processWasStarted: true,
				processId: 1,
				exitCode: 2,
				startedAtEpochMs: 1,
				finishedAtEpochMs: 2,
				attemptIdentity,
			}),
		);
		await writeFile(
			join(commandDirectory, "stdout.txt"),
			JSON.stringify({ ok: false, blockingFailure: historicalFailure }),
		);
		record.observations.push({
			stage,
			sequence: 1,
			kind: "command_failed",
			observedAtEpochMs: 3,
			attemptNumber: 1,
			recoveryEvidenceSha256: "a".repeat(64),
			exitCode: 2,
			commandOutputDirectory: commandDirectory,
			detail: "保留历史失败",
			commandFailureKind: "machine_evidence_pending",
		});
		await writeFile(executionPath, JSON.stringify(record));
		const history = (await analyzeLocalDeploymentExecutions([directory])).executions[0];
		expect(history?.operationalProgress?.executionOwnedBlockingFailure).toEqual(historicalFailure);
		expect(history?.operationalProgress?.targetStageBudget?.blockingFailure).toMatchObject({
			logicalResource: "later-resource",
		});
	});

	it("前序执行必须来自同一任务代际及同一工作树实体", async () => {
		const { directory, request } = await createStandardStageFixture();
		const frozenPath = join(directory, "frozen-redeployment-request.json");
		const original = await readFrozenLocalRedeploymentRequest(directory);
		const metadata = await lstat(request.originatingTaskWorktreePath);
		const worktreeIdentity = {
			realPath: request.originatingTaskWorktreePath,
			device: metadata.dev,
			inode: metadata.ino,
			createdAtEpochMs: metadata.birthtimeMs,
		};
		const previousDeploymentTaskIdentity = { taskIncarnationCreatedAtEpochMs: 123, worktreeIdentity };
		await writeFile(frozenPath, JSON.stringify({ ...original, previousDeploymentTaskIdentity }));
		const currentDirectory = join(directory, "new-execution");
		await mkdir(currentDirectory);
		const current = {
			...original,
			previousDeploymentTaskIdentity,
			request: {
				...original.request,
				executionId: "132609d8-7508-4bdc-b202-1d7bd7da8a14",
				previousDeploymentExecution: { executionId: request.executionId, executionDirectory: directory },
			},
		};
		const previousReport = join(directory, "source-validation", "source-validation-evidence-reuse-report.json");
		await mkdir(dirname(previousReport));
		await writeFile(previousReport, "{}");
		expect((await readBoundPreviousLocalRedeployment(currentDirectory, current))?.request.executionId).toBe(
			request.executionId,
		);
		expect(await createBoundLocalRedeploymentSourceValidationArguments(currentDirectory, current)).toContain(
			previousReport,
		);
		const foreignReport = join(currentDirectory, "foreign-deployment-validation-report.json");
		await rename(previousReport, foreignReport);
		await symlink(foreignReport, previousReport);
		expect(await createBoundLocalRedeploymentSourceValidationArguments(currentDirectory, current)).not.toContain(
			previousReport,
		);
		for (const changedIdentity of [
			{ ...previousDeploymentTaskIdentity, taskIncarnationCreatedAtEpochMs: 124 },
			{ ...previousDeploymentTaskIdentity, worktreeIdentity: { ...worktreeIdentity, inode: metadata.ino + 1 } },
		])
			await expect(
				readBoundPreviousLocalRedeployment(currentDirectory, {
					...current,
					previousDeploymentTaskIdentity: changedIdentity,
				}),
			).rejects.toThrow("前序执行");
		await writeFile(frozenPath, JSON.stringify({ ...original, owner: null }));
		await expect(readBoundPreviousLocalRedeployment(currentDirectory, current)).resolves.toBeNull();
		const argumentsWithoutUnverifiedPredecessor = await createBoundLocalRedeploymentSourceValidationArguments(
			currentDirectory,
			{
				...current,
				request: {
					...current.request,
					sourceValidationEvidenceFilePaths: [previousReport, join(directory, "independent", "validation.json")],
				},
			},
		);
		expect(argumentsWithoutUnverifiedPredecessor).not.toContain(previousReport);
		expect(argumentsWithoutUnverifiedPredecessor).toContain(join(directory, "independent", "validation.json"));

		const unavailableDirectory = join(directory, "unrecorded-predecessor");
		const requestWithUnavailablePredecessor = {
			...current.request,
			previousDeploymentExecution: {
				executionId: request.executionId,
				executionDirectory: unavailableDirectory,
			},
		};
		const canonicalRequest = await canonicalizeLocalRedeploymentRequest(requestWithUnavailablePredecessor);
		expect(canonicalRequest.previousDeploymentExecution).toEqual(
			requestWithUnavailablePredecessor.previousDeploymentExecution,
		);
		await expect(
			readBoundPreviousLocalRedeployment(currentDirectory, { ...current, request: canonicalRequest }),
		).resolves.toBeNull();
		await mkdir(unavailableDirectory);
		await expect(
			readBoundPreviousLocalRedeployment(currentDirectory, { ...current, request: canonicalRequest }),
		).resolves.toBeNull();
		await writeFile(join(unavailableDirectory, "frozen-redeployment-request.json"), "{");
		await expect(
			readBoundPreviousLocalRedeployment(currentDirectory, { ...current, request: canonicalRequest }),
		).resolves.toBeNull();
	});

	it("构建和 ABI 的成功原件可在最终回执之前各自恢复，拒绝改写产物", async () => {
		const { directory } = await createStandardStageFixture();
		const frozen = await readFrozenLocalRedeploymentRequest(directory);
		const candidate = join(directory, "candidate-source-checkout");
		const inputs = "a".repeat(64);
		const build = [process.execPath, "-e", "process.stdout.write('built')"];
		const failingAbi = [process.execPath, "-e", "process.exitCode = 1"];
		const passedAbi = [process.execPath, "-e", "process.stdout.write('checked')"];
		await runLocalRedeploymentStandardCommand(
			directory,
			frozen,
			"production-build",
			build,
			candidate,
			undefined,
			inputs,
		);
		await expect(
			runLocalRedeploymentStandardCommand(
				directory,
				frozen,
				"candidate-native-abi",
				failingAbi,
				candidate,
				undefined,
				inputs,
			),
		).rejects.toThrow("candidate-native-abi");
		const recover = (name: string, command: string[], fingerprint = inputs) =>
			readCompletedCandidateBuildCommandOriginal(directory, frozen, name, command, fingerprint);
		expect(await recover("production-build", build)).toContain("production-build-");
		expect(await recover("production-build", build, "b".repeat(64))).toBeNull();
		expect(await recover("candidate-native-abi", failingAbi)).toBeNull();
		await runLocalRedeploymentStandardCommand(
			directory,
			frozen,
			"candidate-native-abi",
			passedAbi,
			candidate,
			undefined,
			inputs,
		);
		expect(await recover("candidate-native-abi", passedAbi)).toContain("candidate-native-abi-");
		await writeFile(join(candidate, "dist", "cli.js"), "已改写产物");
		await expect(recover("production-build", build)).rejects.toThrow("私有分发产物发生变化");
	});

	it("前序构建的持久接受原件可补最终回执，成功 ABI 不覆盖构建原件的输入与分发绑定", async () => {
		const { directory, request } = await createStandardStageFixture();
		const frozenBase = await readFrozenLocalRedeploymentRequest(directory);
		const boundRequest = {
			...frozenBase.request,
			previousDeploymentExecution: {
				executionId: "132609d8-7508-4bdc-b202-1d7bd7da8a14",
				executionDirectory: join(directory, "previous-execution"),
			},
		};
		const frozen = {
			...frozenBase,
			request: boundRequest,
			requestSha256: localRedeploymentSha256(JSON.stringify(boundRequest)),
		};
		const candidate = join(directory, "candidate-source-checkout");
		const inputsSha256 = "a".repeat(64);
		const distribution = await fingerprintLocalDeploymentDistribution(join(candidate, "dist"));
		const build = [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "build"];
		const buildCommandResultPath = join(directory, "previous-candidate-build-command-result.json");
		const buildResultBytes = JSON.stringify({
			command: build,
			exitCode: 0,
			completedCandidateBuild: {
				inputsSha256,
				candidateDistributionSha256: distribution.candidateDistributionSha256,
			},
		});
		const buildCommandResultSha256 = localRedeploymentSha256(buildResultBytes);
		await writeFile(buildCommandResultPath, buildResultBytes);
		const recover = () =>
			readCompletedCandidateBuildCommandOriginal(directory, frozen, "production-build", build, inputsSha256);
		await expect(recover()).resolves.toBeNull();
		await writeFile(
			join(directory, "previous-candidate-build-import-receipt.json"),
			JSON.stringify({ requestSha256: frozen.requestSha256, buildCommandResultSha256 }),
		);
		await expect(recover()).resolves.toBe(buildCommandResultPath);
		const abiScript = join(candidate, "scripts/verify-notification-archive-native-runtime.mjs");
		await writeFile(abiScript, "process.exitCode = 0;");
		const abiCommand = [request.deploymentNodeBinaryPath, abiScript];
		const recordAbi = async (inputs: string) => {
			let nativeAbiResultPath = "";
			await runLocalRedeploymentStandardCommand(
				directory,
				frozen,
				"candidate-native-abi",
				abiCommand,
				candidate,
				(path) => {
					nativeAbiResultPath = path;
				},
				inputs,
			);
			return {
				nativeAbiResultPath,
				nativeAbiResultSha256: localRedeploymentSha256(await readFile(nativeAbiResultPath)),
			};
		};
		const receipt = {
			requestSha256: frozen.requestSha256,
			inputsSha256,
			buildCommandResultPath,
			buildCommandResultSha256,
			...(await recordAbi(inputsSha256)),
			...distribution,
		};
		await expect(verifyLocalRedeploymentCandidateBuildReceipt(directory, frozen, receipt)).resolves.toBeUndefined();
		const changedInputsSha256 = "b".repeat(64);
		await expect(
			verifyLocalRedeploymentCandidateBuildReceipt(directory, frozen, {
				...receipt,
				inputsSha256: changedInputsSha256,
				...(await recordAbi(changedInputsSha256)),
			}),
		).rejects.toThrow("输入、分发或归属不匹配");
		await writeFile(join(candidate, "dist", "cli.js"), "构建完成后改写分发");
		await expect(recover()).rejects.toThrow("私有分发产物发生变化");
		await expect(
			verifyLocalRedeploymentCandidateBuildReceipt(directory, frozen, {
				...receipt,
				...(await recordAbi(inputsSha256)),
				...(await fingerprintLocalDeploymentDistribution(join(candidate, "dist"))),
			}),
		).rejects.toThrow("输入、分发或归属不匹配");
	});

	it("备份阶段只接续到具备逐代归属与写入者退出原件的前序执行", async () => {
		const { directory, request } = await createStandardStageFixture();
		const original = await readFrozenLocalRedeploymentRequest(directory);
		const record = await readLocalDeploymentExecution(directory);
		const stage = "state_preservation";
		const metadata = await lstat(request.originatingTaskWorktreePath);
		const previousDeploymentTaskIdentity = {
			taskIncarnationCreatedAtEpochMs: 123,
			worktreeIdentity: {
				realPath: request.originatingTaskWorktreePath,
				device: metadata.dev,
				inode: metadata.ino,
				createdAtEpochMs: metadata.birthtimeMs,
			},
		};
		const initial = {
			executionId: "132609d8-7508-4bdc-b202-1d7bd7da8a14",
			executionDirectory: join(directory, "initial-backup-execution"),
		};
		const intermediate = {
			executionId: "232609d8-7508-4bdc-b202-1d7bd7da8a14",
			executionDirectory: join(directory, "intermediate-backup-execution"),
		};
		for (const [execution, previousDeploymentExecution] of [
			[initial, undefined],
			[intermediate, initial],
			[{ executionId: request.executionId, executionDirectory: directory }, intermediate],
		] as const) {
			const { executionId, executionDirectory } = execution;
			const boundRequest = localRedeploymentRequestSchema.parse({
				...original.request,
				executionId,
				previousDeploymentExecution,
			});
			const requestSha256 = localRedeploymentSha256(JSON.stringify(boundRequest));
			const commandOutputDirectory = join(executionDirectory, "stage-command-originals", stage, "attempt-1");
			await mkdir(commandOutputDirectory, { recursive: true });
			await writeFile(
				join(executionDirectory, "frozen-local-redeployment-executor.mjs"),
				await readFile(join(directory, "frozen-local-redeployment-executor.mjs")),
			);
			await writeFile(
				join(executionDirectory, "frozen-redeployment-request.json"),
				JSON.stringify({ ...original, request: boundRequest, requestSha256, previousDeploymentTaskIdentity }),
			);
			await writeFile(
				join(executionDirectory, "local-deployment-execution.json"),
				JSON.stringify({
					...record,
					manifest: { ...record.manifest, executionId, redeploymentRequestSha256: requestSha256 },
					observations:
						executionDirectory === directory
							? []
							: [
									{
										sequence: 1,
										stage,
										kind: "command_succeeded",
										observedAtEpochMs: 2,
										attemptNumber: 1,
										recoveryEvidenceSha256: "b".repeat(64),
										exitCode: 0,
										commandOutputDirectory,
										detail: "隔离终结原件",
									},
								],
				}),
			);
			await writeFile(
				join(commandOutputDirectory, "command-result.json"),
				JSON.stringify({
					command: ["isolated-stage"],
					cwd: join(executionDirectory, "candidate-source-checkout"),
					processWasStarted: true,
					processId: 1,
					exitCode: 0,
					startedAtEpochMs: 1,
					finishedAtEpochMs: 2,
					attemptIdentity: { executionId, stage, attemptNumber: 1, commandOutputDirectory },
				}),
			);
		}
		const backup = vi.mocked(backupLocalRedeploymentRuntimeState);
		backup.mockRejectedValue(new Error("已核对入口的前序目录"));
		const expectVerifiedDirectories = async (expected: string[]) => {
			await expect(executeStandardLocalRedeploymentStage(directory, stage)).rejects.toThrow("已核对入口的前序目录");
			expect(backup).toHaveBeenLastCalledWith(
				expect.objectContaining({ executionId: request.executionId }),
				directory,
				expected,
			);
		};
		await expectVerifiedDirectories([intermediate.executionDirectory, initial.executionDirectory]);
		await writeFile(
			join(initial.executionDirectory, "stage-command-originals", stage, "attempt-1", "command-result.json"),
			"{}",
		);
		await expectVerifiedDirectories([intermediate.executionDirectory]);
		backup.mockReset();
	});

	it("会话恢复按已核验的运行时代际消费一次资格", async () => {
		const { directory, request, current, reportPath } = await createStandardStageFixture();
		const stage = "state_preservation";
		const observe = () => observeStandardLocalRedeploymentStageRecoveryEvidence(directory, stage);
		const before = await observe();
		const attempt = { binding: request, stage, executionDirectory: directory, attemptNumber: 1 } as const;
		await reserveLocalDeploymentTargetStageAttempt({
			...attempt,
			recoveryEvidenceReady: before.recoveryEvidenceReady,
			recoveryEvidenceSha256: before.evidenceSha256,
		});
		await recordLocalDeploymentTargetStageFailure({
			...attempt,
			failure: {
				classification: "verification_evidence_pending",
				logicalResource: "session-readiness",
				recoveryCondition: "等待会话自然结束",
				originalErrorReference: directory,
			},
		});
		const recovered = await observe();
		expect(recovered.recoveryEvidenceReady).toBe(true);
		expect(recovered.evidenceSha256).not.toBe(before.evidenceSha256);
		expect(await observe()).toEqual(recovered);
		const reserveRecovered = (evidence: typeof recovered) =>
			reserveLocalDeploymentTargetStageAttempt({
				...attempt,
				attemptNumber: 2,
				recoveryEvidenceSha256: evidence.evidenceSha256,
				recoveryEvidenceReady: evidence.recoveryEvidenceReady,
			});
		expect(await reserveRecovered(recovered)).toBe(true);
		expect(await reserveRecovered(await observe())).toBe(false);

		const replacement = { ...current, runtimeProcessStartTimeText: "Fri Nov 13 12:30:00 2026" };
		await writeFile(reportPath, JSON.stringify({ ...replacement, ok: false }));
		expect((await observe()).recoveryEvidenceReady).toBe(false);
		await writeFile(reportPath, JSON.stringify(replacement));
		const recoveredAfterReplacement = await observe();
		expect(recoveredAfterReplacement.recoveryEvidenceReady).toBe(true);
		expect(recoveredAfterReplacement.evidenceSha256).not.toBe(recovered.evidenceSha256);
		expect(await reserveRecovered(recoveredAfterReplacement)).toBe(true);
		expect(await reserveRecovered(await observe())).toBe(false);
	});

	it("已提交的备注失败打开一次独立恢复条件", async () => {
		const { directory } = await createStandardStageFixture();
		const observe = () => observeStandardLocalRedeploymentStageRecoveryEvidence(directory, "task_comment");
		const before = await observe();
		const executionPath = join(directory, "local-deployment-execution.json");
		const execution = JSON.parse(await readFile(executionPath, "utf8"));
		execution.observations.push({
			stage: "task_comment",
			sequence: 1,
			kind: "command_failed",
			observedAtEpochMs: 1,
			attemptNumber: 1,
			recoveryEvidenceSha256: before.evidenceSha256,
			exitCode: 1,
			commandOutputDirectory: directory,
			detail: "隔离备注提交中断",
		});
		await writeFile(executionPath, JSON.stringify(execution));
		const after = await observe();
		expect(after.recoveryEvidenceReady).toBe(true);
		expect(after.evidenceSha256).not.toBe(before.evidenceSha256);
		expect(await observe()).toEqual(after);
	});
	it("会话阻塞时先保存恢复条件，在门禁解除前不启动备份", async () => {
		const fixture = await createStandardStageFixture();
		await writeFile(
			fixture.reportPath,
			JSON.stringify({
				...fixture.current,
				ok: false,
				failures: ["会话尚未自然退出"],
				blockingSessions: [{ processId: 4004 }],
			}),
		);
		await expect(executeStandardLocalRedeploymentStage(fixture.directory, "state_preservation")).rejects.toThrow(
			"会话连续性门禁",
		);
		expect(backupLocalRedeploymentRuntimeState).not.toHaveBeenCalled();
		expect(
			JSON.parse(await readFile(join(fixture.directory, "session-continuity-preflight.json"), "utf8")),
		).toMatchObject({
			status: "blocked",
			blockingReasons: ["会话尚未自然退出"],
			blockingSessions: [{ processId: 4004 }],
			recoveryCondition: expect.any(String),
			nextCheckAtEpochMs: expect.any(Number),
		});
	});
	it("恢复时已发布同一候选，重连 CLI 前仍重新核验运行代际和会话", async () => {
		const { directory, candidateBytes, current, reportPath, request } = await createStandardStageFixture();
		await writeFile(
			join(request.sourceCheckoutPath, "package.json"),
			JSON.stringify({
				name: "kanban",
				bin: { kanban: "dist/cli.js" },
			}),
		);
		await writeFile(join(request.distributionDirectoryPath, "cli.js"), candidateBytes, { mode: 0o755 });
		await writeFile(join(directory, "runtime-state-backup-receipt.json"), "{}");
		await mkdir(join(directory, "preserved-previous-distribution"));
		await writeFile(join(directory, "preserved-previous-distribution/cli.js"), "原版入口");
		await writeFile(
			reportPath,
			JSON.stringify({
				...current,
				ok: false,
				failures: ["原生会话仍在使用当前实例"],
				blockingSessions: [{ processId: 4004 }],
			}),
		);
		await expect(executeStandardLocalRedeploymentStage(directory, "build_publication")).rejects.toThrow(
			"会话连续性门禁",
		);
	});
	it("备份恢复仅接受同一部署阶段的原生退出原件，日志时间变化不刷新预算", async () => {
		const { directory, request } = await createStandardStageFixture();
		const stage = "state_preservation";
		const commandOutputDirectory = join(directory, "stage-command-originals", stage, "attempt-1");
		await mkdir(commandOutputDirectory, { recursive: true });
		const attempt = { binding: request, stage, executionDirectory: directory, attemptNumber: 1 } as const;
		await reserveLocalDeploymentTargetStageAttempt({
			...attempt,
			recoveryEvidenceReady: false,
			recoveryEvidenceSha256: null,
		});
		await recordLocalDeploymentTargetStageFailure({
			...attempt,
			failure: {
				classification: "unclassified_failure",
				logicalResource: stage,
				recoveryCondition: "等待中断原件",
				originalErrorReference: commandOutputDirectory,
			},
		});
		const executionPath = join(directory, "local-deployment-execution.json");
		const execution = JSON.parse(await readFile(executionPath, "utf8"));
		const cwd = join(directory, "candidate-source-checkout");
		execution.manifest.sourceCheckoutPath = cwd;
		const observation = {
			stage,
			observedAtEpochMs: 1,
			attemptNumber: 1,
			recoveryEvidenceSha256: "a".repeat(64),
			exitCode: null,
			commandOutputDirectory,
			detail: "隔离原件",
		};
		execution.observations = [
			{ ...observation, sequence: 1, kind: "command_execution_intent_persisted" },
			{ ...observation, sequence: 2, kind: "command_failed" },
		];
		await writeFile(executionPath, JSON.stringify(execution));
		const originalPath = join(commandOutputDirectory, "command-result.json");
		const original = {
			command: [
				request.deploymentNodeBinaryPath,
				join(directory, "frozen-local-redeployment-executor.mjs"),
				"redeployment-stage",
				"--execution-directory",
				directory,
				"--stage",
				stage,
			],
			cwd,
			processId: 4004,
			processWasStarted: true,
			signal: "SIGTERM",
			exitCode: null,
			startedAtEpochMs: 1,
			finishedAtEpochMs: 2,
			attemptIdentity: { executionId: request.executionId, stage, attemptNumber: 1, commandOutputDirectory },
		};
		const observe = () => observeStandardLocalRedeploymentStageRecoveryEvidence(directory, stage);
		expect((await observe()).recoveryEvidenceReady).toBe(false);
		await writeFile(
			originalPath,
			JSON.stringify({ ...original, attemptIdentity: { ...original.attemptIdentity, attemptNumber: 2 } }),
		);
		expect((await observe()).recoveryEvidenceReady).toBe(false);
		await writeFile(originalPath, JSON.stringify(original));
		const recovered = await observe();
		expect(recovered.recoveryEvidenceReady).toBe(true);
		await writeFile(originalPath, JSON.stringify({ ...original, finishedAtEpochMs: 3 }));
		expect(await observe()).toEqual(recovered);
	});
	it("构建期间 P1 被旧产物 P2 替代后，连续性核验 P2 并交接至本候选 P3", async () => {
		const fixture = await createStandardStageFixture();
		await executeStandardLocalRedeploymentStage(fixture.directory, "runtime_restart");
		expect(await readFile(fixture.handoverInvocationsPath, "utf8")).toBe("交接一次\n");
		const target = JSON.parse(
			await readFile(join(fixture.directory, "runtime-restart-target-baseline.json"), "utf8"),
		);
		expect(target.runtimeBefore.processId).toBe(2002);
		const accepted = JSON.parse(await readFile(join(fixture.directory, "runtime-restart-acceptance.json"), "utf8"));
		expect(accepted.runtime.runtimeProcessId).toBe(3003);
		await executeStandardLocalRedeploymentStage(fixture.directory, "runtime_restart");
		expect(await readFile(fixture.handoverInvocationsPath, "utf8")).toBe("交接一次\n");
	});

	it("当前替代代际已经载入候选时，只接受效果，不再发起 handover", async () => {
		const fixture = await createStandardStageFixture({ candidateAlreadyLoaded: true });
		await executeStandardLocalRedeploymentStage(fixture.directory, "runtime_restart");
		await expect(readFile(fixture.handoverInvocationsPath)).rejects.toThrow();
		const accepted = JSON.parse(await readFile(join(fixture.directory, "runtime-restart-acceptance.json"), "utf8"));
		expect(accepted.runtime.runtimeProcessId).toBe(2002);
	});

	it("同 commit 新执行的原代际已经载入候选时，仍完成本请求的连续性门禁与换代", async () => {
		const fixture = await createStandardStageFixture({
			candidateAlreadyLoaded: true,
			currentMatchesFrozenBaseline: true,
		});
		await executeStandardLocalRedeploymentStage(fixture.directory, "runtime_restart");
		expect(await readFile(fixture.handoverInvocationsPath, "utf8")).toBe("交接一次\n");
		const accepted = JSON.parse(await readFile(join(fixture.directory, "runtime-restart-acceptance.json"), "utf8"));
		expect(accepted.runtime.runtimeProcessId).toBe(3003);
	});

	it("替代旧代际仍有阻塞会话时保留待证，禁止交接；自然结束改变阶段恢复指纹", async () => {
		const fixture = await createStandardStageFixture();
		const blocked = { ...fixture.current, ok: false, blockingSessions: [{ processId: 4004 }] };
		await writeFile(fixture.reportPath, JSON.stringify(blocked));
		await expect(executeStandardLocalRedeploymentStage(fixture.directory, "runtime_restart")).rejects.toThrow();
		await expect(readFile(fixture.handoverInvocationsPath)).rejects.toThrow();
		const first = await observeStandardLocalRedeploymentStageRecoveryEvidence(
			fixture.directory,
			"state_preservation",
		);
		expect(
			await observeStandardLocalRedeploymentStageRecoveryEvidence(fixture.directory, "state_preservation"),
		).toEqual(first);
		await writeFile(fixture.reportPath, JSON.stringify(fixture.current));
		expect(
			await observeStandardLocalRedeploymentStageRecoveryEvidence(fixture.directory, "state_preservation"),
		).not.toEqual(first);
	});

	it("API 缺证恢复进入 runtime_validation 指纹，采样时刻与日志不制造预算", async () => {
		const fixture = await createStandardStageFixture({ candidateAlreadyLoaded: true });
		const requests = join(fixture.directory, "machine-evidence-requests");
		await mkdir(requests);
		await writeFile(
			join(requests, "notification-archive.json"),
			JSON.stringify({
				kind: "verification_check",
				checkKey: "notification-archive",
			}),
		);
		let apiRecovered = false;
		vi.mocked(queryLocalRedeploymentRuntime).mockImplementation(async (_request, procedure) => {
			if (procedure === "notificationIntelligence.listArchive") {
				if (!apiRecovered) throw new Error("隔离 API 缺证");
				return { entries: [], totalCount: 0, nextBeforeSequence: null };
			}
			return JSON.parse(await readFile(fixture.reportPath, "utf8"));
		});
		const first = await observeStandardLocalRedeploymentStageRecoveryEvidence(
			fixture.directory,
			"runtime_validation",
		);
		expect(
			await observeStandardLocalRedeploymentStageRecoveryEvidence(fixture.directory, "runtime_validation"),
		).toEqual(first);
		apiRecovered = true;
		expect(
			await observeStandardLocalRedeploymentStageRecoveryEvidence(fixture.directory, "runtime_validation"),
		).not.toEqual(first);
	});
});
