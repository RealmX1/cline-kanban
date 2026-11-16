import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER } from "./local-deployment-execution-contract";

export const localDeploymentBlockingFailureSchema = z.strictObject({
	classification: z.enum([
		"source_contention",
		"atomic_temporary_path_disappeared",
		"copy_identity_mismatch",
		"filesystem_unavailable",
		"verification_evidence_pending",
		"unclassified_failure",
	]),
	logicalResource: z.string().min(1),
	recoveryCondition: z.string().min(1),
	originalErrorReference: z.string().min(1),
	sourcePath: z.string().optional(),
	sourceObservationBeforeFailure: z.unknown().optional(),
	sourceObservationAfterFailure: z.unknown().optional(),
});
export type LocalDeploymentBlockingFailure = z.infer<typeof localDeploymentBlockingFailureSchema>;
export type LocalDeploymentRecoveryBudgetStage =
	| (typeof LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER)[number]
	| "candidate_bootstrap";
export interface LocalDeploymentTargetStageBinding {
	executionId: string;
	runtimeIdentity: { runtimeHomeDirectoryPath: string; runtimePort: number };
	distributionDirectoryPath: string;
}

const localDeploymentTargetStageRecoveryBudgetSchema = z.strictObject({
	schemaVersion: z.literal(1),
	target: z.strictObject({
		runtimeHomeDirectoryPath: z.string(),
		runtimePort: z.number(),
		distributionDirectoryPath: z.string(),
	}),
	stage: z.enum([...LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER, "candidate_bootstrap"]),
	blockingFailure: localDeploymentBlockingFailureSchema.nullable(),
	consumedRecoveryEvidence: z.array(z.string()),
	attempts: z.array(
		z.strictObject({
			executionId: z.string(),
			executionDirectory: z.string(),
			attemptNumber: z.number().int().positive(),
			recoveryEvidenceSha256: z.string().nullable(),
			reservedAtEpochMs: z.number(),
		}),
	),
});
export type LocalDeploymentTargetStageRecoveryBudget = z.infer<typeof localDeploymentTargetStageRecoveryBudgetSchema>;

async function resolveCanonicalDeploymentTargetPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const absolute = resolve(path);
		return join(
			await resolveCanonicalDeploymentTargetPath(dirname(absolute)),
			absolute.slice(dirname(absolute).length + 1),
		);
	}
}

async function resolveLocalDeploymentTargetStageRecoveryBudgetLocation(
	binding: LocalDeploymentTargetStageBinding,
	stage: LocalDeploymentRecoveryBudgetStage,
) {
	const target = {
		runtimeHomeDirectoryPath: await resolveCanonicalDeploymentTargetPath(
			binding.runtimeIdentity.runtimeHomeDirectoryPath,
		),
		runtimePort: binding.runtimeIdentity.runtimePort,
		distributionDirectoryPath: await resolveCanonicalDeploymentTargetPath(binding.distributionDirectoryPath),
	};
	const key = createHash("sha256").update(JSON.stringify({ target, stage })).digest("hex");
	return {
		target,
		path: join(target.runtimeHomeDirectoryPath, "local-deployment-target-stage-recovery-budgets", `${key}.json`),
	};
}

export async function readLocalDeploymentTargetStageRecoveryBudget(
	binding: LocalDeploymentTargetStageBinding,
	stage: LocalDeploymentRecoveryBudgetStage,
): Promise<LocalDeploymentTargetStageRecoveryBudget | null> {
	const { target, path } = await resolveLocalDeploymentTargetStageRecoveryBudgetLocation(binding, stage);
	try {
		const budget = localDeploymentTargetStageRecoveryBudgetSchema.parse(JSON.parse(await readFile(path, "utf8")));
		if (JSON.stringify(budget.target) !== JSON.stringify(target) || budget.stage !== stage)
			throw new Error("部署目标恢复预算归属不一致");
		return budget;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

interface LocalDeploymentTargetStageAttemptInput {
	binding: LocalDeploymentTargetStageBinding;
	stage: LocalDeploymentRecoveryBudgetStage;
	executionDirectory: string;
	attemptNumber: number;
}

export async function reserveLocalDeploymentTargetStageAttempt(
	input: LocalDeploymentTargetStageAttemptInput & {
		recoveryEvidenceSha256: string | null;
		recoveryEvidenceReady: boolean;
	},
): Promise<boolean> {
	const { target, path } = await resolveLocalDeploymentTargetStageRecoveryBudgetLocation(input.binding, input.stage);
	return lockedFileSystem.withLock({ path }, async () => {
		const budget = (await readLocalDeploymentTargetStageRecoveryBudget(input.binding, input.stage)) ?? {
			schemaVersion: 1 as const,
			target,
			stage: input.stage,
			blockingFailure: null,
			consumedRecoveryEvidence: [],
			attempts: [],
		};
		const failure = budget.blockingFailure;
		const evidenceKey = JSON.stringify([
			failure?.classification,
			failure?.logicalResource,
			input.recoveryEvidenceSha256,
		]);
		if (
			failure &&
			(!input.recoveryEvidenceReady ||
				!input.recoveryEvidenceSha256 ||
				budget.consumedRecoveryEvidence.includes(evidenceKey))
		)
			return false;
		if (failure) budget.consumedRecoveryEvidence.push(evidenceKey);
		budget.attempts.push({
			executionId: input.binding.executionId,
			executionDirectory: resolve(input.executionDirectory),
			attemptNumber: input.attemptNumber,
			recoveryEvidenceSha256: input.recoveryEvidenceSha256,
			reservedAtEpochMs: Date.now(),
		});
		// 派发意图也占预算；中断后先补原件，不能因缺少失败回执再开一个候选。
		budget.blockingFailure ??= {
			classification: "unclassified_failure",
			logicalResource: input.stage,
			recoveryCondition: "等待绑定命令原件及相关隔离验证，不以候选、时间或目录变化取得新资格",
			originalErrorReference: resolve(input.executionDirectory),
		};
		await lockedFileSystem.writeJsonFileAtomic(path, localDeploymentTargetStageRecoveryBudgetSchema.parse(budget), {
			lock: null,
			durable: true,
			fileMode: 0o600,
		});
		return true;
	});
}

export async function recordLocalDeploymentTargetStageFailure(
	input: LocalDeploymentTargetStageAttemptInput & { failure: LocalDeploymentBlockingFailure },
): Promise<void> {
	const { path } = await resolveLocalDeploymentTargetStageRecoveryBudgetLocation(input.binding, input.stage);
	await lockedFileSystem.withLock({ path }, async () => {
		const budget = await readLocalDeploymentTargetStageRecoveryBudget(input.binding, input.stage);
		const attempt = budget?.attempts.at(-1);
		if (
			!budget ||
			attempt?.executionId !== input.binding.executionId ||
			attempt.attemptNumber !== input.attemptNumber ||
			attempt.executionDirectory !== resolve(input.executionDirectory)
		)
			throw new Error("失败事实不属于当前部署目标尝试");
		budget.blockingFailure = localDeploymentBlockingFailureSchema.parse(input.failure);
		if (attempt.recoveryEvidenceSha256) {
			const evidenceKey = JSON.stringify([
				input.failure.classification,
				input.failure.logicalResource,
				attempt.recoveryEvidenceSha256,
			]);
			if (!budget.consumedRecoveryEvidence.includes(evidenceKey)) budget.consumedRecoveryEvidence.push(evidenceKey);
		}
		await lockedFileSystem.writeJsonFileAtomic(path, budget, { lock: null, durable: true, fileMode: 0o600 });
	});
}

export async function completeLocalDeploymentTargetStageAttempt(
	binding: LocalDeploymentTargetStageBinding,
	stage: LocalDeploymentRecoveryBudgetStage,
): Promise<void> {
	const { path } = await resolveLocalDeploymentTargetStageRecoveryBudgetLocation(binding, stage);
	await lockedFileSystem.withLock({ path }, async () => {
		const budget = await readLocalDeploymentTargetStageRecoveryBudget(binding, stage);
		if (!budget || budget.attempts.at(-1)?.executionId !== binding.executionId) return;
		budget.blockingFailure = null;
		await lockedFileSystem.writeJsonFileAtomic(path, budget, { lock: null, durable: true, fileMode: 0o600 });
	});
}
