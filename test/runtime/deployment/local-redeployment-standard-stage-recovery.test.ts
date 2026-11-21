import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fingerprintLocalDeploymentDistribution } from "../../../src/deployment/local-deployment-distribution-manifest";
import { initializeLocalDeploymentExecution } from "../../../src/deployment/local-deployment-execution";
import { LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER } from "../../../src/deployment/local-deployment-execution-contract";
import {
	recordLocalDeploymentTargetStageFailure,
	reserveLocalDeploymentTargetStageAttempt,
} from "../../../src/deployment/local-deployment-target-stage-recovery-budget";
import { localRedeploymentSha256 } from "../../../src/deployment/local-redeployment-preparation";
import {
	executeStandardLocalRedeploymentStage,
	observeStandardLocalRedeploymentStageRecoveryEvidence,
} from "../../../src/deployment/local-redeployment-standard-execution";
import {
	backupLocalRedeploymentRuntimeState,
	queryLocalRedeploymentRuntime,
} from "../../../src/deployment/local-redeployment-state-preservation";
import { readProcessIdentity } from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

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
	const directory = temporary.path;
	const source = join(directory, "source");
	const candidate = join(directory, "candidate-source-checkout");
	await mkdir(join(source, "scripts"), { recursive: true });
	await mkdir(join(source, "dist"), { recursive: true });
	await mkdir(join(candidate, "scripts"), { recursive: true });
	await mkdir(join(candidate, "dist"), { recursive: true });
	const candidateBytes = "已绑定候选入口";
	await writeFile(join(candidate, "dist/cli.js"), candidateBytes);
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

	it("从派发前就绪到阶段内阻塞再恢复就绪时获得一次新证据", async () => {
		const { directory, request } = await createStandardStageFixture();
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
		await writeFile(join(request.distributionDirectoryPath, "cli.js"), candidateBytes);
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
