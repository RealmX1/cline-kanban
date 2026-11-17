import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { LocalDeploymentBlockingFailure } from "./local-deployment-target-stage-recovery-budget";
import {
	assertLocalRedeploymentNotRevoked,
	assertLocalRedeploymentOwnerStillEligible,
	canonicalizeLocalRedeploymentRequest,
	executeLocalRedeploymentFile,
	localRedeploymentRequestSchema,
	localRedeploymentSha256,
	prepareLocalRedeployment,
	readCurrentBoundLocalRedeploymentOwner,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";

const repairContinuationSchema = z.strictObject({
	rootExecutionDirectory: z.string(),
	rootExecutionId: z.uuid(),
	failedExecutionDirectory: z.string(),
	failedExecutionId: z.uuid(),
	executionDirectory: z.string(),
	executionId: z.uuid(),
	requestSha256: z.string(),
	failedValidationReportSha256: z.string(),
	executorSha256: z.string(),
	deploymentBranchName: z.string(),
	candidateSourceCommit: z.string(),
	repairAttemptNumber: z.number().int().positive(),
});

const sourceValidationReportSchema = z.object({
	status: z.enum(["quality_validation_failed", "passed", "inspection_complete"]),
	candidateSourceCommit: z.string(),
});

function isPostSourceRedeploymentQualityFailure(error: string): boolean {
	return error.startsWith("LocalRedeploymentQualityFailure:");
}

async function readRecordedRedeploymentFailureError(path: string): Promise<string | null> {
	const body = await readLocalRedeploymentJson(path);
	return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
}

async function hasPostSourceRedeploymentQualityFailure(directory: string): Promise<boolean> {
	const root = join(directory, "stage-failure-originals");
	const stages = await readdir(root).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	for (const stage of stages) {
		if (stage === "candidate_bootstrap") continue;
		const names = await readdir(join(root, stage)).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		});
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const error = await readRecordedRedeploymentFailureError(join(root, stage, name));
			if (error && isPostSourceRedeploymentQualityFailure(error)) return true;
		}
	}
	return false;
}

export async function prepareLocalRedeploymentRepairContinuation(
	directory: string,
	raw: unknown,
	executorPath: string,
	failedExecutionDirectory: string,
	deploymentBranchName: string,
) {
	directory = resolve(directory);
	failedExecutionDirectory = resolve(failedExecutionDirectory);
	const failed = await readFrozenLocalRedeploymentRequest(failedExecutionDirectory);
	assertLocalRedeploymentNotRevoked(failedExecutionDirectory);
	const request = localRedeploymentRequestSchema.parse(raw);
	if (
		directory === failedExecutionDirectory ||
		request.executionId === failed.request.executionId ||
		request.candidateSourceCommit === failed.request.candidateSourceCommit ||
		JSON.stringify({
			...request,
			executionId: failed.request.executionId,
			candidateSourceCommit: failed.request.candidateSourceCommit,
		}) !== JSON.stringify(failed.request)
	)
		throw new Error("修复接续只能改变执行身份与候选提交，部署目标和原授权必须保留");
	const owner = await readCurrentBoundLocalRedeploymentOwner(request);
	if (
		failed.owner &&
		(!owner ||
			owner.taskIncarnationCreatedAtEpochMs !== failed.owner.taskIncarnationCreatedAtEpochMs ||
			owner.conversationSessionId !== failed.owner.conversationSessionId ||
			JSON.stringify(owner.worktreeIdentity) !== JSON.stringify(failed.owner.worktreeIdentity))
	)
		throw new Error("修复接续必须保留原任务与工作树归属");
	await assertLocalRedeploymentOwnerStillEligible(failedExecutionDirectory, { ...failed, owner });
	const result = z
		.object({
			disposition: z.literal("agent_review_ready"),
			deploymentExecutionId: z.uuid(),
			analysis: z.object({ deploymentOutcome: z.string() }).optional(),
		})
		.parse(await readLocalRedeploymentJson(join(failedExecutionDirectory, "owned-command-business-result.json")));
	const reportPath = join(failedExecutionDirectory, "source-validation/source-validation-evidence-reuse-report.json");
	const report = sourceValidationReportSchema.parse(await readLocalRedeploymentJson(reportPath));
	const postSourceQualityFailure =
		report.status !== "quality_validation_failed" &&
		result.analysis?.deploymentOutcome === "quality_validation_failed" &&
		(await hasPostSourceRedeploymentQualityFailure(failedExecutionDirectory));
	if (
		result.deploymentExecutionId !== failed.request.executionId ||
		report.candidateSourceCommit !== failed.request.candidateSourceCommit ||
		(report.status !== "quality_validation_failed" && !postSourceQualityFailure)
	)
		throw new Error("质量失败原件与来源执行不匹配");
	const git = async (args: string[]) =>
		(
			await executeLocalRedeploymentFile("git", ["--no-optional-locks", "-C", request.sourceCheckoutPath, ...args])
		).stdout.trim();
	if (!deploymentBranchName.startsWith(`deployment-repair/${request.taskId}-`))
		throw new Error("修复候选必须来自本任务的 deployment-repair 分支");
	await git(["check-ref-format", "--branch", deploymentBranchName]);
	if ((await git(["rev-parse", `refs/heads/${deploymentBranchName}`])) !== request.candidateSourceCommit)
		throw new Error("部署修复分支与候选提交不一致");
	await git(["merge-base", "--is-ancestor", failed.request.candidateSourceCommit, request.candidateSourceCommit]);
	if (
		(await git(["rev-parse", `${request.candidateSourceCommit}^{tree}`])) ===
		(await git(["rev-parse", `${failed.request.candidateSourceCommit}^{tree}`]))
	)
		throw new Error("修复候选必须改变源码树，空提交不能重置失败资格");
	const parentContinuation = repairContinuationSchema
		.nullable()
		.parse(await readLocalRedeploymentJson(join(failedExecutionDirectory, "deployment-repair-continuation.json")));
	const rootDirectory = parentContinuation?.rootExecutionDirectory ?? failedExecutionDirectory;
	const root = await readFrozenLocalRedeploymentRequest(rootDirectory);
	if (
		parentContinuation &&
		(parentContinuation.rootExecutionId !== root.request.executionId ||
			parentContinuation.executionId !== failed.request.executionId ||
			parentContinuation.executionDirectory !== failedExecutionDirectory ||
			parentContinuation.candidateSourceCommit !== failed.request.candidateSourceCommit ||
			JSON.stringify({
				...failed.request,
				executionId: root.request.executionId,
				candidateSourceCommit: root.request.candidateSourceCommit,
			}) !== JSON.stringify(root.request))
	)
		throw new Error("修复链来源身份不匹配");
	const reservationsDirectory = join(rootDirectory, "deployment-repair-continuations");
	await mkdir(reservationsDirectory, { recursive: true });
	return lockedFileSystem.withLock({ path: reservationsDirectory }, async () => {
		assertLocalRedeploymentNotRevoked(rootDirectory);
		assertLocalRedeploymentNotRevoked(failedExecutionDirectory);
		const reservationPath = join(reservationsDirectory, `${request.executionId}.json`);
		const existing = repairContinuationSchema.nullable().parse(await readLocalRedeploymentJson(reservationPath));
		const repairAttemptNumber =
			existing?.repairAttemptNumber ??
			(await readdir(reservationsDirectory)).filter((name) => name.endsWith(".json")).length + 1;
		const canonicalRequest = await canonicalizeLocalRedeploymentRequest(request);
		const continuation = {
			rootExecutionDirectory: rootDirectory,
			rootExecutionId: root.request.executionId,
			failedExecutionDirectory,
			failedExecutionId: failed.request.executionId,
			executionDirectory: directory,
			executionId: request.executionId,
			requestSha256: localRedeploymentSha256(JSON.stringify(canonicalRequest)),
			failedValidationReportSha256: localRedeploymentSha256(await readFile(reportPath)),
			executorSha256: localRedeploymentSha256(await readFile(executorPath)),
			deploymentBranchName,
			candidateSourceCommit: request.candidateSourceCommit,
			repairAttemptNumber,
		};
		if (existing && JSON.stringify(existing) !== JSON.stringify(continuation))
			throw new Error("同一修复执行已绑定不同材料");
		if (repairAttemptNumber > 3) throw new Error("同一部署授权的三次修复候选预算已用尽，保留原件供 Agent 处置");
		await writeLocalRedeploymentJson(reservationPath, continuation);
		const linkPath = join(directory, "deployment-repair-continuation.json");
		const previousLink = await readLocalRedeploymentJson(linkPath);
		if (previousLink && JSON.stringify(previousLink) !== JSON.stringify(continuation))
			throw new Error("目标目录已有不同的修复接续身份");
		await writeLocalRedeploymentJson(linkPath, continuation);
		await assertLocalRedeploymentOwnerStillEligible(failedExecutionDirectory, { ...failed, owner });
		const prepared = await prepareLocalRedeployment(directory, canonicalRequest, executorPath);
		return { ...prepared, repairContinuation: continuation };
	});
}

export async function observeLocalRedeploymentRepairValidationEligibility(
	directory: string,
	failure: LocalDeploymentBlockingFailure,
): Promise<{ evidenceSha256: string; recoveryEvidenceReady: true } | null> {
	if (failure.classification !== "unclassified_failure" || failure.sourcePath) return null;
	try {
		const continuation = repairContinuationSchema.parse(
			await readLocalRedeploymentJson(join(directory, "deployment-repair-continuation.json")),
		);
		if (
			!resolve(failure.originalErrorReference).startsWith(
				`${join(continuation.failedExecutionDirectory, "stage-failure-originals", failure.logicalResource)}${sep}`,
			)
		)
			return null;
		await readFile(failure.originalErrorReference);
		const frozen = await readFrozenLocalRedeploymentRequest(directory);
		const failed = await readFrozenLocalRedeploymentRequest(continuation.failedExecutionDirectory);
		const reserved = await readLocalRedeploymentJson(
			join(
				continuation.rootExecutionDirectory,
				"deployment-repair-continuations",
				`${continuation.executionId}.json`,
			),
		);
		if (
			JSON.stringify(reserved) !== JSON.stringify(continuation) ||
			continuation.executionDirectory !== resolve(directory) ||
			continuation.executionId !== frozen.request.executionId ||
			continuation.requestSha256 !== frozen.requestSha256 ||
			continuation.executorSha256 !== frozen.executorSha256 ||
			continuation.candidateSourceCommit !== frozen.request.candidateSourceCommit ||
			continuation.failedExecutionId !== failed.request.executionId
		)
			return null;
		assertLocalRedeploymentNotRevoked(directory);
		assertLocalRedeploymentNotRevoked(continuation.rootExecutionDirectory);
		assertLocalRedeploymentNotRevoked(continuation.failedExecutionDirectory);
		await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
		const reportBytes = await readFile(
			join(continuation.failedExecutionDirectory, "source-validation/source-validation-evidence-reuse-report.json"),
		);
		const report = sourceValidationReportSchema
			.extend({ candidateSourceCommit: z.literal(failed.request.candidateSourceCommit) })
			.safeParse(JSON.parse(reportBytes.toString("utf8")));
		if (!report.success || localRedeploymentSha256(reportBytes) !== continuation.failedValidationReportSha256)
			return null;
		if (failure.logicalResource === "candidate_bootstrap") {
			if (report.data.status !== "quality_validation_failed") return null;
		} else if (
			report.data.status === "quality_validation_failed" ||
			!isPostSourceRedeploymentQualityFailure(
				(await readRecordedRedeploymentFailureError(failure.originalErrorReference)) ?? "",
			)
		)
			return null;
		const git = async (args: string[]) =>
			(
				await executeLocalRedeploymentFile("git", [
					"--no-optional-locks",
					"-C",
					frozen.request.sourceCheckoutPath,
					...args,
				])
			).stdout.trim();
		await git([
			"merge-base",
			"--is-ancestor",
			failed.request.candidateSourceCommit,
			frozen.request.candidateSourceCommit,
		]);
		const failedTree = await git(["rev-parse", `${failed.request.candidateSourceCommit}^{tree}`]);
		const repairedTree = await git(["rev-parse", `${frozen.request.candidateSourceCommit}^{tree}`]);
		if (failedTree === repairedTree) return null;
		return {
			evidenceSha256: localRedeploymentSha256(
				JSON.stringify({
					kind: "bound_repaired_source_validation",
					failedTree,
					repairedTree,
					failedValidationReportSha256: continuation.failedValidationReportSha256,
				}),
			),
			recoveryEvidenceReady: true,
		};
	} catch {
		return null;
	}
}
