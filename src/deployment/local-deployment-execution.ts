import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES,
	LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER,
	type LocalDeploymentExecutionManifest,
	type LocalDeploymentExecutionRecord,
	type LocalDeploymentExecutionRestriction,
	type LocalDeploymentIndependentFindings,
	type LocalDeploymentObservation,
	type LocalDeploymentStage,
	type LocalDeploymentStageCommand,
	localDeploymentCommandOriginalSchema,
	localDeploymentEffectProofSchema,
	localDeploymentExecutionManifestSchema,
	localDeploymentExecutionRecordSchema,
	localDeploymentExecutionRestrictionSchema,
	localDeploymentIndependentFindingsSchema,
} from "./local-deployment-execution-contract";
import { analyzeLegacyLocalDeploymentExecution } from "./local-deployment-legacy-execution-analysis";

export const LOCAL_DEPLOYMENT_EXECUTION_RECORD_FILENAME = "local-deployment-execution.json";
const MAXIMUM_COMMAND_ATTEMPTS_PER_RECOVERY_EVIDENCE = 2;
const READ_ONLY_RECOVERY_CHECK_INTERVAL_MS = 30_000;
const EXECUTION_RESTRICTION_FILENAME = "local-deployment-execution-restriction.json";

export interface LocalDeploymentCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	processWasStarted?: boolean;
}

export type LocalDeploymentCommandRunner = (
	command: string[],
	context: {
		cwd: string;
		commandOutputDirectory: string;
		executionId: string;
		stage: LocalDeploymentStage;
		attemptNumber: number;
		assertCommandMayStart: () => void;
	},
) => Promise<LocalDeploymentCommandResult>;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function recordPath(directory: string): string {
	return join(resolve(directory), LOCAL_DEPLOYMENT_EXECUTION_RECORD_FILENAME);
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function readLocalDeploymentExecutionRestriction(
	directory: string,
): Promise<LocalDeploymentExecutionRestriction | null> {
	const restriction = await readJsonIfPresent(join(resolve(directory), EXECUTION_RESTRICTION_FILENAME));
	return restriction === null ? null : localDeploymentExecutionRestrictionSchema.parse(restriction);
}

async function commandOriginalProvesProcessWasNotStarted(
	directory: string,
	record: LocalDeploymentExecutionRecord,
	stage: LocalDeploymentStageCommand,
	attempt: LocalDeploymentObservation,
): Promise<boolean> {
	const expectedOutputDirectory = join(
		resolve(directory),
		"stage-command-originals",
		stage.stage,
		`attempt-${attempt.attemptNumber}`,
	);
	if (attempt.commandOutputDirectory !== expectedOutputDirectory) return false;
	try {
		const originalPath = join(expectedOutputDirectory, "command-result.json");
		if (
			(await realpath(expectedOutputDirectory)) !==
				join(
					await realpath(directory),
					"stage-command-originals",
					stage.stage,
					`attempt-${attempt.attemptNumber}`,
				) ||
			!(await lstat(originalPath)).isFile()
		)
			return false;
		const parsed = localDeploymentCommandOriginalSchema.safeParse(await readJsonIfPresent(originalPath));
		if (!parsed.success) return false;
		const original = parsed.data;
		if (
			original.processWasStarted !== false ||
			original.processId !== null ||
			original.exitCode !== null ||
			original.cwd !== record.manifest.sourceCheckoutPath ||
			original.command.length !== stage.command.length ||
			!original.command.every((argument, index) => argument === stage.command[index]) ||
			original.finishedAtEpochMs < original.startedAtEpochMs
		)
			return false;
		const identity = original.attemptIdentity;
		// 旧版原件以规范尝试目录与意图之后的原生时间绑定；新版另核对执行、阶段和尝试身份。
		return identity
			? identity.executionId === record.manifest.executionId &&
					identity.stage === stage.stage &&
					identity.attemptNumber === attempt.attemptNumber &&
					identity.commandOutputDirectory === expectedOutputDirectory
			: original.startedAtEpochMs >= attempt.observedAtEpochMs;
	} catch {
		return false;
	}
}

async function withExecutionLock<T>(
	directory: string,
	operation: (assertLockHeld: () => void) => Promise<T>,
): Promise<T> {
	let compromisedError: Error | null = null;
	return await lockedFileSystem.withLock(
		{
			type: "directory",
			path: resolve(directory),
			lockfileName: ".local-deployment-execution.lock",
			onCompromised: (error) => {
				compromisedError = error;
			},
		},
		async () =>
			await operation(() => {
				if (compromisedError) throw compromisedError;
			}),
	);
}

async function persistRecord(
	directory: string,
	record: LocalDeploymentExecutionRecord,
	assertLockHeld: () => void,
): Promise<void> {
	assertLockHeld();
	await lockedFileSystem.writeJsonFileAtomic(
		recordPath(directory),
		localDeploymentExecutionRecordSchema.parse(record),
		{
			lock: null,
			durable: true,
			fileMode: 0o600,
		},
	);
}

export async function readLocalDeploymentExecution(directory: string): Promise<LocalDeploymentExecutionRecord> {
	return localDeploymentExecutionRecordSchema.parse(JSON.parse(await readFile(recordPath(directory), "utf8")));
}

export async function initializeLocalDeploymentExecution(
	directory: string,
	input: LocalDeploymentExecutionManifest,
): Promise<LocalDeploymentExecutionRecord> {
	const manifest = localDeploymentExecutionManifestSchema.parse(input);
	return await withExecutionLock(directory, async (assertLockHeld) => {
		const existing = await readJsonIfPresent(recordPath(directory));
		if (existing !== null) {
			const record = localDeploymentExecutionRecordSchema.parse(existing);
			if (JSON.stringify(record.manifest) !== JSON.stringify(manifest))
				throw new Error("该执行目录已绑定不同候选、授权或命令，不能改写原件");
			return record;
		}
		const record: LocalDeploymentExecutionRecord = {
			schemaVersion: 1,
			manifest,
			createdAtEpochMs: Date.now(),
			observations: [],
			finishedOutcome: null,
			retrospective: { status: "not_requested", analysisFingerprint: null, independentFindingsFilePath: null },
		};
		await persistRecord(directory, record, assertLockHeld);
		return record;
	});
}

function stageSucceeded(record: LocalDeploymentExecutionRecord, stage: LocalDeploymentStage): boolean {
	return record.observations.some(
		(item) =>
			item.stage === stage &&
			(item.kind === "effect_verified" ||
				(!LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage) && item.kind === "command_succeeded")),
	);
}

function analysisFingerprint(
	record: LocalDeploymentExecutionRecord,
	restriction: LocalDeploymentExecutionRestriction | null = null,
): string {
	// 只把真实执行与已证实效果作为分析版本；没有新证据的核验轮询不重新触发语义分析。
	const canonicalRecord = localDeploymentExecutionRecordSchema.parse(record);
	return sha256(
		JSON.stringify({
			manifest: canonicalRecord.manifest,
			...(restriction ? { restriction } : {}),
			outcome: canonicalRecord.finishedOutcome,
			observations: canonicalRecord.observations.filter((item) => item.kind !== "effect_verification_failed"),
			currentEffectEligibility: [...LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES].map((stage) => [
				stage,
				canonicalRecord.observations
					.filter(
						(item) =>
							item.stage === stage &&
							(item.kind === "effect_verified" || item.kind === "effect_verification_failed"),
					)
					.at(-1)?.kind ?? "not_observed",
			]),
		}),
	);
}

export interface LocalDeploymentExecutionAnalysis {
	executionDirectory: string;
	executionId: string;
	executionIdentityEvidenceKind: "bound_execution_manifest" | "deployment_registration_receipt" | "unknown";
	candidateSourceCommit: string;
	candidateDistributionSha256: string;
	deploymentOutcome:
		| "succeeded"
		| "machine_evidence_pending"
		| "quality_validation_failed"
		| "failed"
		| "rolled_back"
		| "abandoned"
		| "permission_revoked"
		| "human_decision_required";
	ancillaryFailures: LocalDeploymentStage[];
	analysisFingerprint: string;
	retrospective: LocalDeploymentExecutionRecord["retrospective"];
	recovery: {
		unfinishedStage: LocalDeploymentStage | null;
		nextCheckAtEpochMs: number | null;
		condition: string | null;
	};
	metrics: {
		commandAttempts: number | null;
		failedCommandAttempts: number | null;
		recoveredEffects: number | null;
		commandElapsedByStageMs: Partial<Record<LocalDeploymentStage, number>>;
		verifiedStageEffects: number | null;
		httpDowntimeMs: null;
		nativeModelUsage: null;
		unknownMetricReasons: Record<string, string>;
	};
	deepAnalysisReasons: string[];
	observedStageFailures: Array<{ stage: LocalDeploymentStage; evidenceReference: string; detail: string }>;
}

export function summarizeLocalDeploymentExecution(
	record: LocalDeploymentExecutionRecord,
	restriction: LocalDeploymentExecutionRestriction | null = null,
): LocalDeploymentExecutionAnalysis {
	const criticalStages = LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.slice(0, 6);
	const deploymentSucceeded = criticalStages.every((stage) => stageSucceeded(record, stage));
	const unfinishedStage =
		criticalStages.find((stage) => {
			const latestVerified = record.observations
				.filter((item) => item.stage === stage && item.kind === "effect_verified")
				.at(-1);
			const latestRejected = record.observations
				.filter((item) => item.stage === stage && item.kind === "effect_verification_failed")
				.at(-1);
			return (
				!stageSucceeded(record, stage) ||
				(!!latestRejected && (!latestVerified || latestRejected.sequence > latestVerified.sequence))
			);
		}) ?? null;
	const ancillaryFailures = record.manifest.stages
		.filter(
			(stage) =>
				!criticalStages.includes(stage.stage) &&
				!stageSucceeded(record, stage.stage) &&
				record.observations.some(
					(item) =>
						item.stage === stage.stage && (item.kind === "command_failed" || item.kind === "command_not_started"),
				),
		)
		.map((stage) => stage.stage);
	const latestUnfinishedCommandResult = record.observations
		.filter((item) => item.stage === unfinishedStage && ["command_failed", "command_succeeded"].includes(item.kind))
		.at(-1);
	const hasQualityValidationFailure =
		latestUnfinishedCommandResult?.kind === "command_failed" &&
		latestUnfinishedCommandResult.commandFailureKind === "quality_validation_failed";
	const deploymentOutcome =
		record.finishedOutcome ??
		(deploymentSucceeded
			? "succeeded"
			: (restriction?.kind ??
				(hasQualityValidationFailure ? "quality_validation_failed" : "machine_evidence_pending")));
	const started = record.observations.filter((item) => item.kind === "command_execution_intent_persisted");
	const failures = record.observations.filter(
		(item) => item.kind === "command_failed" || item.kind === "command_not_started",
	);
	const commandElapsedByStageMs: Partial<Record<LocalDeploymentStage, number>> = {};
	for (const beginning of started) {
		const ending = record.observations.find(
			(item) =>
				item.stage === beginning.stage &&
				item.attemptNumber === beginning.attemptNumber &&
				(item.kind === "command_succeeded" ||
					item.kind === "command_failed" ||
					item.kind === "command_not_started"),
		);
		if (ending)
			commandElapsedByStageMs[beginning.stage] =
				(commandElapsedByStageMs[beginning.stage] ?? 0) +
				Math.max(0, ending.observedAtEpochMs - beginning.observedAtEpochMs);
	}
	return {
		executionDirectory: "",
		executionId: record.manifest.executionId,
		executionIdentityEvidenceKind: "bound_execution_manifest",
		candidateSourceCommit: record.manifest.candidateSourceCommit,
		candidateDistributionSha256: record.manifest.candidateDistributionSha256,
		deploymentOutcome,
		ancillaryFailures,
		analysisFingerprint: analysisFingerprint(record, restriction),
		retrospective: record.retrospective,
		recovery: {
			unfinishedStage,
			nextCheckAtEpochMs:
				deploymentOutcome === "machine_evidence_pending" ? Date.now() + READ_ONLY_RECOVERY_CHECK_INTERVAL_MS : null,
			condition: restriction
				? `${restriction.reason}（${restriction.sourceReference}）；不自动恢复权限`
				: hasQualityValidationFailure
					? "源码验证真实失败；读取绑定报告和原件，由 Agent 修复或处置，不按机器缺证自动重试"
					: unfinishedStage
						? "先核验原动作效果；非重复动作不重发；普通动作只在补证文件或阶段只读语义证据变化后取得新重试预算"
						: null,
		},
		metrics: {
			commandAttempts: started.length,
			failedCommandAttempts: failures.length,
			verifiedStageEffects: new Set(
				record.observations.filter((item) => item.kind === "effect_verified").map((item) => item.stage),
			).size,
			recoveredEffects: new Set(
				record.observations
					.filter(
						(item) =>
							item.kind === "effect_verified" &&
							!record.observations.some(
								(outcome) =>
									outcome.stage === item.stage &&
									outcome.attemptNumber === item.attemptNumber &&
									outcome.kind === "command_succeeded",
							),
					)
					.map((item) => `${item.stage}:${item.attemptNumber}`),
			).size,
			commandElapsedByStageMs,
			httpDowntimeMs: null,
			nativeModelUsage: null,
			unknownMetricReasons: {
				httpDowntimeMs: "未记录连续 HTTP 可用性采样",
				nativeModelUsage: "未记录绑定本次执行的原生模型 usage",
			},
		},
		deepAnalysisReasons: [
			...new Set([
				...failures
					.filter((item) => LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(item.stage))
					.map((item) => `不可重复阶段结果异常：${item.stage}`),
				...LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.filter(
					(stage) => started.filter((item) => item.stage === stage).length > 1,
				).map((stage) => `同阶段重复执行：${stage}`),
			]),
		],
		observedStageFailures: failures.map((item) => ({
			stage: item.stage,
			evidenceReference: item.commandOutputDirectory,
			detail: item.detail,
		})),
	};
}

async function materializeRetrospectiveRequest(
	directory: string,
	record: LocalDeploymentExecutionRecord,
): Promise<boolean> {
	const restriction = await readLocalDeploymentExecutionRestriction(directory);
	const fingerprint = analysisFingerprint(record, restriction);
	if (
		record.retrospective.analysisFingerprint === fingerprint &&
		record.retrospective.status !== "request_material_pending"
	)
		return false;
	const requestDirectory = join(resolve(directory), "retrospective-analysis-requests");
	const requestPath = join(requestDirectory, `${fingerprint}.json`);
	try {
		await mkdir(requestDirectory, { recursive: true });
		const existing = await readJsonIfPresent(requestPath);
		if (
			existing !== null &&
			(typeof existing !== "object" ||
				!("executionId" in existing) ||
				existing.executionId !== record.manifest.executionId ||
				!("analysisFingerprint" in existing) ||
				existing.analysisFingerprint !== fingerprint)
		)
			throw new Error("已有复盘请求与本次执行或分析版本不符，保留原件等待补证");
		if (existing === null)
			await lockedFileSystem.writeJsonFileAtomic(
				requestPath,
				{
					schemaVersion: 1,
					executionId: record.manifest.executionId,
					analysisFingerprint: fingerprint,
					restriction,
					analysis: {
						...summarizeLocalDeploymentExecution(record, restriction),
						executionDirectory: resolve(directory),
					},
					instructions:
						"每次轻量复盘成功经验、重复工作、成本与风险；单次严重事件或跨次复发即深入分析。先固化独立发现，再查询 Issues；看目录后产生的补证另记来源。发现性质、修复仓库、证据状态与采用状态分别记录。不得把重复投递算独立支持，也不据支持次数自动采纳。",
				},
				{ lock: null, durable: true, fileMode: 0o600 },
			);
		record.retrospective = { status: "pending", analysisFingerprint: fingerprint, independentFindingsFilePath: null };
	} catch (error) {
		record.retrospective = {
			status: "request_material_pending",
			analysisFingerprint: fingerprint,
			independentFindingsFilePath: null,
			requestPreparationError: String(error),
		};
	}
	return true;
}

async function requestRetrospective(
	directory: string,
	record: LocalDeploymentExecutionRecord,
	assertLockHeld: () => void,
): Promise<void> {
	if (await materializeRetrospectiveRequest(directory, record)) await persistRecord(directory, record, assertLockHeld);
}

async function recoveryEvidenceSha256(
	stage: LocalDeploymentStageCommand,
	readOnlyRecoveryEvidenceSha256: string | null,
): Promise<string> {
	const evidence = await Promise.all(
		(stage.recoveryEvidenceFilePaths ?? []).map(async (path) => {
			try {
				return [
					path,
					createHash("sha256")
						.update(await readFile(path))
						.digest("hex"),
				];
			} catch (error) {
				return [path, isMissingFile(error) ? "absent" : "unreadable"];
			}
		}),
	);
	return sha256(
		JSON.stringify(
			readOnlyRecoveryEvidenceSha256 === null ? evidence : [...evidence, readOnlyRecoveryEvidenceSha256],
		),
	);
}

function effectMatchesExecution(stdout: string, manifest: LocalDeploymentExecutionManifest): boolean {
	try {
		const result = localDeploymentEffectProofSchema.parse(JSON.parse(stdout));
		return (
			result.executionId === manifest.executionId &&
			result.candidateSourceCommit === manifest.candidateSourceCommit &&
			result.candidateDistributionSha256 === manifest.candidateDistributionSha256
		);
	} catch {
		return false;
	}
}

async function executeOneStage(
	directory: string,
	record: LocalDeploymentExecutionRecord,
	stage: LocalDeploymentStageCommand,
	deps: {
		runCommand: LocalDeploymentCommandRunner;
		readNowEpochMs: () => number;
		readRuntimeLockCompromise: () => Error | null;
	},
	assertLockHeld: () => void,
): Promise<boolean> {
	const previouslySucceeded = stageSucceeded(record, stage.stage);
	const hasUnfinishedCriticalStage = summarizeLocalDeploymentExecution(record).recovery.unfinishedStage !== null;
	if (previouslySucceeded && (!LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage) || !hasUnfinishedCriticalStage))
		return true;
	let previousAttempts = record.observations.filter(
		(item) => item.stage === stage.stage && item.kind === "command_execution_intent_persisted",
	);
	function assertCommandMayStart(): void {
		// 最后一道同步门禁在 runner 打开输出文件之后执行，核验与 spawn 之间不再穿过异步 I/O。
		try {
			const restriction = localDeploymentExecutionRestrictionSchema.parse(
				JSON.parse(readFileSync(join(resolve(directory), EXECUTION_RESTRICTION_FILENAME), "utf8")),
			);
			throw new Error(`执行资格已撤销：${restriction.reason}（${restriction.sourceReference}）`);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		assertLockHeld();
		const runtimeLockError = deps.readRuntimeLockCompromise();
		if (runtimeLockError && LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage)) throw runtimeLockError;
	}
	if (await readLocalDeploymentExecutionRestriction(directory)) return false;
	let readOnlyRecoveryEvidenceSha256: string | null = null;
	if (stage.readOnlyRecoveryEvidenceObservationCommand) {
		readOnlyRecoveryEvidenceSha256 = "unavailable";
		const outputDirectory = join(
			resolve(directory),
			"stage-command-originals",
			stage.stage,
			`recovery-evidence-observation-${randomUUID()}`,
		);
		await mkdir(outputDirectory, { recursive: true });
		try {
			const result = await deps.runCommand(stage.readOnlyRecoveryEvidenceObservationCommand, {
				cwd: record.manifest.sourceCheckoutPath,
				commandOutputDirectory: outputDirectory,
				executionId: record.manifest.executionId,
				stage: stage.stage,
				attemptNumber: previousAttempts.length,
				assertCommandMayStart,
			});
			const observation: unknown = JSON.parse(result.stdout);
			if (
				result.exitCode === 0 &&
				observation !== null &&
				typeof observation === "object" &&
				"evidenceSha256" in observation &&
				typeof observation.evidenceSha256 === "string" &&
				/^[a-f0-9]{64}$/u.test(observation.evidenceSha256)
			)
				readOnlyRecoveryEvidenceSha256 = observation.evidenceSha256;
		} catch {
			// 不可读取保持同一未知指纹；原始输出与异常不会制造新的动作预算。
		}
	}
	const recoveryFingerprint = await recoveryEvidenceSha256(stage, readOnlyRecoveryEvidenceSha256);
	async function observe(
		kind: LocalDeploymentObservation["kind"],
		attempt: number,
		commandOutputDirectory: string,
		exitCode: number | null,
		detail: string,
		commandFailureKind?: "quality_validation_failed",
	): Promise<LocalDeploymentObservation> {
		const observation: LocalDeploymentObservation = {
			sequence: record.observations.length + 1,
			stage: stage.stage,
			kind,
			observedAtEpochMs: deps.readNowEpochMs(),
			attemptNumber: attempt,
			recoveryEvidenceSha256: recoveryFingerprint,
			commandOutputDirectory,
			exitCode,
			detail,
			...(commandFailureKind ? { commandFailureKind } : {}),
		};
		record.observations.push(observation);
		await persistRecord(directory, record, assertLockHeld);
		return observation;
	}
	async function verifyPreviousEffect(afterEffectAction = false): Promise<boolean> {
		if (!stage.effectVerificationCommand) return false;
		if (await readLocalDeploymentExecutionRestriction(directory)) return false;
		const previousProbe = record.observations
			.filter(
				(item) =>
					item.stage === stage.stage &&
					(item.kind === "effect_verification_failed" || item.kind === "effect_verified"),
			)
			.at(-1);
		if (
			!afterEffectAction &&
			previousProbe?.kind === "effect_verification_failed" &&
			previousProbe.recoveryEvidenceSha256 === recoveryFingerprint &&
			deps.readNowEpochMs() < previousProbe.observedAtEpochMs + READ_ONLY_RECOVERY_CHECK_INTERVAL_MS
		)
			return false;
		const outputDirectory = join(
			resolve(directory),
			"stage-command-originals",
			stage.stage,
			`effect-verification-${randomUUID()}`,
		);
		await mkdir(outputDirectory, { recursive: true });
		if (await readLocalDeploymentExecutionRestriction(directory)) return false;
		assertLockHeld();
		try {
			const result = await deps.runCommand(stage.effectVerificationCommand, {
				cwd: record.manifest.sourceCheckoutPath,
				commandOutputDirectory: outputDirectory,
				executionId: record.manifest.executionId,
				stage: stage.stage,
				attemptNumber: previousAttempts.length,
				assertCommandMayStart,
			});
			if (result.exitCode === 0 && effectMatchesExecution(result.stdout, record.manifest)) {
				if (!previouslySucceeded || previousProbe?.kind === "effect_verification_failed") {
					await observe(
						"effect_verified",
						previousAttempts.length,
						outputDirectory,
						result.exitCode,
						"已核对同一执行、候选及产物摘要，历史接受与当前执行资格分开核验",
					);
				}
				return true;
			}
			await observe(
				"effect_verification_failed",
				previousAttempts.length,
				outputDirectory,
				result.exitCode,
				"效果证据缺失或与绑定不一致，保留未知",
			);
		} catch (error) {
			await observe("effect_verification_failed", previousAttempts.length, outputDirectory, null, String(error));
		}
		return false;
	}
	for (const attempt of previousAttempts) {
		const settled = record.observations.some(
			(item) =>
				item.stage === stage.stage &&
				item.attemptNumber === attempt.attemptNumber &&
				(item.kind === "command_not_started" ||
					item.kind === "command_succeeded" ||
					item.kind === "command_failed"),
		);
		if (settled) continue;
		if (await commandOriginalProvesProcessWasNotStarted(directory, record, stage, attempt)) {
			await observe(
				"command_not_started",
				attempt.attemptNumber,
				attempt.commandOutputDirectory,
				null,
				"持久原件确证进程未创建，恢复有界重试",
			);
		}
	}
	previousAttempts = record.observations.filter(
		(item) => item.stage === stage.stage && item.kind === "command_execution_intent_persisted",
	);
	const hasPossiblySubmittedAttempt = previousAttempts.some(
		(attempt) =>
			!record.observations.some(
				(item) =>
					item.stage === stage.stage &&
					item.attemptNumber === attempt.attemptNumber &&
					item.kind === "command_not_started",
			),
	);
	if (hasPossiblySubmittedAttempt && LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage)) {
		if (await verifyPreviousEffect()) return true;
		if (record.manifest.schemaVersion !== 2 || !stage.idempotentEffectRecoveryCommand) return false;
	}
	while (
		previousAttempts.filter((item) => item.recoveryEvidenceSha256 === recoveryFingerprint).length <
		MAXIMUM_COMMAND_ATTEMPTS_PER_RECOVERY_EVIDENCE
	) {
		if (await readLocalDeploymentExecutionRestriction(directory)) return false;
		if (deps.readRuntimeLockCompromise() && LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage)) return false;
		const attempt = previousAttempts.length + 1;
		const outputDirectory = join(resolve(directory), "stage-command-originals", stage.stage, `attempt-${attempt}`);
		await mkdir(outputDirectory, { recursive: true });
		// 意图先于子进程落盘；即使正好重启，下一次也会先核验效果。
		const intent = await observe(
			"command_execution_intent_persisted",
			attempt,
			outputDirectory,
			null,
			"命令即将开始；退出码与副作用接受事实分开记录",
		);
		if (await readLocalDeploymentExecutionRestriction(directory)) {
			await observe("command_not_started", attempt, outputDirectory, null, "撤销已持久化，未启动命令");
			return false;
		}
		const runtimeLockError = deps.readRuntimeLockCompromise();
		if (runtimeLockError && LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage)) {
			await observe(
				"command_not_started",
				attempt,
				outputDirectory,
				null,
				`运行时锁已失效，未启动命令：${runtimeLockError.message}`,
			);
			return false;
		}
		assertLockHeld();
		let result: LocalDeploymentCommandResult;
		try {
			result = await deps.runCommand(
				hasPossiblySubmittedAttempt && stage.idempotentEffectRecoveryCommand
					? stage.idempotentEffectRecoveryCommand
					: stage.command,
				{
					cwd: record.manifest.sourceCheckoutPath,
					commandOutputDirectory: outputDirectory,
					executionId: record.manifest.executionId,
					stage: stage.stage,
					attemptNumber: attempt,
					assertCommandMayStart,
				},
			);
		} catch (error) {
			const provenNotStarted = await commandOriginalProvesProcessWasNotStarted(directory, record, stage, intent);
			result = {
				exitCode: null,
				stdout: "",
				stderr: String(error),
				...(provenNotStarted ? { processWasStarted: false } : {}),
			};
		}
		let reportedFailure = false;
		let qualityValidationFailed = false;
		try {
			const reported: unknown = JSON.parse(result.stdout);
			if (reported !== null && typeof reported === "object") {
				reportedFailure = "ok" in reported && reported.ok === false;
				qualityValidationFailed =
					result.processWasStarted === true &&
					reportedFailure &&
					"status" in reported &&
					reported.status === "quality_validation_failed";
			}
		} catch {
			/* 普通构建命令可以只输出文本。 */
		}
		const commandSucceeded = result.processWasStarted !== false && result.exitCode === 0 && !reportedFailure;
		await observe(
			result.processWasStarted === false
				? "command_not_started"
				: commandSucceeded
					? "command_succeeded"
					: "command_failed",
			attempt,
			outputDirectory,
			result.exitCode,
			result.stderr.slice(-2_000),
			qualityValidationFailed ? "quality_validation_failed" : undefined,
		);
		previousAttempts = record.observations.filter(
			(item) => item.stage === stage.stage && item.kind === "command_execution_intent_persisted",
		);
		if (result.processWasStarted === false) continue;
		if (qualityValidationFailed) return false;
		if (LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage)) return await verifyPreviousEffect(true);
		if (commandSucceeded) return true;
	}
	return false;
}

export async function executeLocalDeploymentStages(
	directory: string,
	deps: { runCommand: LocalDeploymentCommandRunner; readNowEpochMs?: () => number },
): Promise<LocalDeploymentExecutionAnalysis> {
	const initialRecord = await readLocalDeploymentExecution(directory);
	let runtimeLockCompromised: Error | null = null;
	return await lockedFileSystem.withLock(
		{
			type: "directory",
			path: initialRecord.manifest.runtimeIdentity.runtimeHomeDirectoryPath,
			lockfileName: `.local-deployment-runtime-${initialRecord.manifest.runtimeIdentity.runtimePort}.lock`,
			onCompromised: (error) => {
				runtimeLockCompromised = error;
			},
		},
		async () =>
			await withExecutionLock(directory, async (assertExecutionLockHeld) => {
				const record = await readLocalDeploymentExecution(directory);
				const stageDeps = {
					runCommand: deps.runCommand,
					readNowEpochMs: deps.readNowEpochMs ?? Date.now,
					readRuntimeLockCompromise: () => runtimeLockCompromised,
				};
				let restriction = await readLocalDeploymentExecutionRestriction(directory);
				if (!record.finishedOutcome && !restriction) {
					for (const stage of record.manifest.stages.slice(0, 6)) {
						restriction = await readLocalDeploymentExecutionRestriction(directory);
						if (restriction) break;
						if (!(await executeOneStage(directory, record, stage, stageDeps, assertExecutionLockHeld))) break;
					}
					// 清理独立于剩余部署步骤；评论需要服务，部署尚未核验时不发布完成评论。
					restriction = await readLocalDeploymentExecutionRestriction(directory);
					if (!restriction)
						await executeOneStage(
							directory,
							record,
							record.manifest.stages[6],
							stageDeps,
							assertExecutionLockHeld,
						);
					restriction = await readLocalDeploymentExecutionRestriction(directory);
					if (!restriction && summarizeLocalDeploymentExecution(record).deploymentOutcome === "succeeded") {
						await executeOneStage(
							directory,
							record,
							record.manifest.stages[7],
							stageDeps,
							assertExecutionLockHeld,
						);
					}
				}
				await requestRetrospective(directory, record, assertExecutionLockHeld);
				restriction = await readLocalDeploymentExecutionRestriction(directory);
				const summary = summarizeLocalDeploymentExecution(record, restriction);
				return {
					...summary,
					executionDirectory: resolve(directory),
				};
			}),
	);
}

export async function restrictLocalDeploymentExecution(
	directory: string,
	restriction: LocalDeploymentExecutionRestriction,
): Promise<void> {
	await readLocalDeploymentExecution(directory);
	// 独立锁使 Stop 能在长命令执行期间落盘；下一动作前重新读，不覆盖原命令的接受事实。
	await lockedFileSystem.writeJsonFileAtomic(
		join(resolve(directory), EXECUTION_RESTRICTION_FILENAME),
		localDeploymentExecutionRestrictionSchema.parse(restriction),
		{ durable: true, fileMode: 0o600 },
	);
	const resolvedDirectory = resolve(directory);
	try {
		await lockedFileSystem.withLock(
			{
				type: "directory",
				path: resolvedDirectory,
				lockfileName: ".local-deployment-execution.lock",
				retries: 0,
			},
			async () => {
				const record = await readLocalDeploymentExecution(resolvedDirectory);
				await requestRetrospective(resolvedDirectory, record, () => undefined);
			},
		);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ELOCKED")) throw error;
		// 执行器正持有执行锁。复盘请求文件仍要留下：Stop 随后会终止执行器，run 末尾的复盘不会发生。
		const record = await readLocalDeploymentExecution(resolvedDirectory);
		await materializeRetrospectiveRequest(resolvedDirectory, record);
	}
}

export async function finishLocalDeploymentExecution(
	directory: string,
	outcome: "failed" | "rolled_back" | "abandoned",
): Promise<LocalDeploymentExecutionAnalysis> {
	return await withExecutionLock(directory, async (assertLockHeld) => {
		const record = await readLocalDeploymentExecution(directory);
		if (record.finishedOutcome && record.finishedOutcome !== outcome)
			throw new Error("已有结束事实，不能覆盖；更正应另存证据");
		if (summarizeLocalDeploymentExecution(record).deploymentOutcome === "succeeded" && outcome !== "rolled_back")
			throw new Error("部署成功事实不能被收尾失败或放弃覆盖");
		record.finishedOutcome = outcome;
		await persistRecord(directory, record, assertLockHeld);
		await requestRetrospective(directory, record, assertLockHeld);
		return { ...summarizeLocalDeploymentExecution(record), executionDirectory: resolve(directory) };
	});
}

export async function freezeLocalDeploymentIndependentFindings(
	directory: string,
	input: LocalDeploymentIndependentFindings,
): Promise<string> {
	const report = localDeploymentIndependentFindingsSchema.parse(input);
	return await withExecutionLock(directory, async (assertLockHeld) => {
		const record = await readLocalDeploymentExecution(directory);
		if (
			report.analysisFingerprint !==
			analysisFingerprint(record, await readLocalDeploymentExecutionRestriction(directory))
		)
			throw new Error("发现未绑定当前分析版本，请读取对应原件");
		const filePath = join(
			resolve(directory),
			"independent-retrospective-findings",
			`${report.analysisFingerprint}.json`,
		);
		const existing = await readJsonIfPresent(filePath);
		if (existing !== null && JSON.stringify(existing) !== JSON.stringify(report))
			throw new Error("同一分析版本已有不同的独立发现原件，不能覆盖");
		if (existing === null)
			await lockedFileSystem.writeJsonFileAtomic(filePath, report, { lock: null, durable: true, fileMode: 0o600 });
		await lockedFileSystem.writeJsonFileAtomic(
			join(
				resolve(directory),
				"independent-findings-awaiting-shared-issue-feedback",
				`${report.analysisFingerprint}.json`,
			),
			{
				schemaVersion: 1,
				status: "awaiting_shared_feedback_consumer",
				deploymentExecutionId: record.manifest.executionId,
				workspaceId: record.manifest.workspaceId,
				taskId: record.manifest.taskId,
				independentFindingsFilePath: filePath,
				analysisFingerprint: report.analysisFingerprint,
				feedbackPolicy: {
					matchingIssue: "append_new_evidence",
					unmatchedFinding: "create_when_evidence_sufficient",
					endorsementDoesNotImplyAdoption: true,
				},
			},
			{ lock: null, durable: true, fileMode: 0o600 },
		);
		record.retrospective = {
			status: "independent_findings_frozen",
			analysisFingerprint: report.analysisFingerprint,
			independentFindingsFilePath: filePath,
		};
		await persistRecord(directory, record, assertLockHeld);
		return filePath;
	});
}

export async function analyzeLocalDeploymentExecutions(directories: string[]) {
	const uniqueDirectories = [...new Set(directories.map((directory) => resolve(directory)))];
	const results = await Promise.allSettled(
		uniqueDirectories.map(async (directory) => {
			const original = await readJsonIfPresent(recordPath(directory));
			if (original === null) return await analyzeLegacyLocalDeploymentExecution(directory);
			const summary = summarizeLocalDeploymentExecution(
				localDeploymentExecutionRecordSchema.parse(original),
				await readLocalDeploymentExecutionRestriction(directory),
			);
			return { ...summary, executionDirectory: directory };
		}),
	);
	const executions: LocalDeploymentExecutionAnalysis[] = [];
	const unavailableExecutions: Array<{ executionDirectory: string; reason: string }> = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "fulfilled") executions.push(result.value);
		else unavailableExecutions.push({ executionDirectory: uniqueDirectories[index], reason: String(result.reason) });
	}
	const stageFailureExecutionIds = new Map<string, Set<string>>();
	for (const execution of executions) {
		if (execution.executionIdentityEvidenceKind === "unknown") continue;
		for (const { stage } of execution.observedStageFailures) {
			const ids = stageFailureExecutionIds.get(stage) ?? new Set();
			ids.add(execution.executionId);
			stageFailureExecutionIds.set(stage, ids);
		}
	}
	return {
		schemaVersion: 1,
		coverage: unavailableExecutions.length > 0 ? "partial" : "complete",
		executions,
		unavailableExecutions,
		repeatedStageFailures: [...stageFailureExecutionIds]
			.filter(([, ids]) => ids.size > 1)
			.map(([stage, ids]) => ({ stage, independentExecutionIds: [...ids] })),
	};
}
