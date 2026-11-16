import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, readlink, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as waitBetweenSourceStabilitySamples } from "node:timers/promises";
import { LOCAL_DEPLOYMENT_EXECUTION_RECORD_FILENAME } from "./local-deployment-execution";
import {
	LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER,
	localDeploymentCommandOriginalSchema,
	localDeploymentExecutionRecordSchema,
} from "./local-deployment-execution-contract";
import type {
	LocalDeploymentBlockingFailure,
	LocalDeploymentRecoveryBudgetStage,
} from "./local-deployment-target-stage-recovery-budget";
import {
	observeLocalRedeploymentFilesystemEvidence,
	readLocalRedeploymentMachineEvidenceRequests,
} from "./local-redeployment-persistent-checks";
import {
	type FrozenLocalRedeploymentRequest,
	localRedeploymentSha256,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";
import { backupLocalRedeploymentRuntimeState } from "./local-redeployment-state-preservation";

const copyValidationReceiptName = "backup-copy-identity-isolated-validation.json";

export async function classifyLocalRedeploymentStageFailure(
	directory: string,
	error: unknown,
	stage: LocalDeploymentRecoveryBudgetStage,
): Promise<LocalDeploymentBlockingFailure> {
	const fields =
		error instanceof Error
			? (error as NodeJS.ErrnoException & {
					dest?: string;
					sourceFingerprintBeforeCapture?: string;
					sourceFingerprintAfterCapture?: string;
					verificationCheckKey?: string;
				})
			: null;
	const sourcePath = fields?.path && resolve(fields.path) === fields.path ? fields.path : undefined;
	const sourceObservation = sourcePath ? await observeLocalRedeploymentFilesystemEvidence(sourcePath) : null;
	let destination = fields?.dest;
	if (!destination && sourcePath) {
		const frozen = (await readLocalRedeploymentJson(
			join(directory, "frozen-redeployment-request.json"),
		)) as FrozenLocalRedeploymentRequest | null;
		if (frozen) {
			const relativePath = relative(frozen.request.runtimeIdentity.runtimeHomeDirectoryPath, sourcePath);
			if (relativePath && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep)) {
				const captures = join(directory, "runtime-state-backup-capture-attempts");
				for (const child of await readdir(captures).catch(() => [])) {
					const path = join(captures, child, relativePath);
					if (await lstat(path).catch(() => null)) {
						destination = path;
						break;
					}
				}
			}
		}
	}
	const destinationObservation = destination ? await observeLocalRedeploymentFilesystemEvidence(destination) : null;
	const before = fields?.sourceFingerprintBeforeCapture;
	const after = fields?.sourceFingerprintAfterCapture;
	const logicalAtomicResource = sourcePath?.match(/^(.*)\.tmp\.\d+\.\d+\.[a-f0-9-]{36}$/iu)?.[1];
	let classification: LocalDeploymentBlockingFailure["classification"] = "unclassified_failure";
	let logicalResource = sourcePath ?? stage;
	let recoveryCondition = "等待与绑定失败相关的隔离验证或等价证据；旧错误码本身不证明源竞争";
	if (fields?.code === "ENOENT" && logicalAtomicResource) {
		classification = "atomic_temporary_path_disappeared";
		logicalResource = logicalAtomicResource;
		recoveryCondition = "所属正式逻辑资源恢复可读，不等待旧随机临时文件重现";
	} else if (before && after && before !== after) {
		classification = "source_contention";
		recoveryCondition = "已证明竞争的逻辑资源连续采样稳定，且实际冻结执行器的对应隔离验证通过";
	} else if (
		destinationObservation &&
		JSON.stringify(sourceObservation) !== JSON.stringify(destinationObservation) &&
		fields?.code === "SOURCE_CONTENT_CHANGED_DURING_CAPTURE"
	) {
		classification = "copy_identity_mismatch";
		recoveryCondition = "实际冻结执行器的复制身份隔离回归通过；源稳定不能证明复制语义已修复";
	} else if (sourcePath && ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS"].includes(fields?.code ?? "")) {
		classification = "filesystem_unavailable";
		recoveryCondition = "当前逻辑资源的访问或空间条件恢复，不使用文件内容、时间或 nonce 刷新预算";
	} else if (
		!sourcePath &&
		(fields?.verificationCheckKey || (await readLocalRedeploymentMachineEvidenceRequests(directory)).length)
	) {
		classification = "verification_evidence_pending";
		logicalResource = fields?.verificationCheckKey ?? stage;
		recoveryCondition = "原失败登记的核验条件或等价权威快照恢复";
	}
	const originalErrorReference = join(directory, "stage-failure-originals", stage, `${randomUUID()}.json`);
	await writeLocalRedeploymentJson(originalErrorReference, {
		stage,
		error: String(error),
		stack: fields?.stack ?? null,
		code: fields?.code ?? null,
		syscall: fields?.syscall ?? null,
		sourcePath: sourcePath ?? null,
		destination: destination ?? null,
		sourceObservation,
		destinationObservation,
		sourceFingerprintBeforeCapture: before ?? null,
		sourceFingerprintAfterCapture: after ?? null,
		classification,
		logicalResource,
		recoveryCondition,
	});
	return {
		classification,
		logicalResource,
		recoveryCondition,
		originalErrorReference,
		...(sourcePath ? { sourcePath, sourceObservationAfterFailure: sourceObservation } : {}),
		...(before ? { sourceObservationBeforeFailure: before } : {}),
	};
}

/** 直接调用当前冻结执行器载入的复制实现；不把后来安装版本的测试结果借给旧执行。 */
export async function validateFrozenLocalRedeploymentBackupCopyIdentity(directory: string): Promise<void> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	if (!process.argv[1] || localRedeploymentSha256(await readFile(process.argv[1])) !== frozen.executorSha256)
		throw new Error("复制回归必须由实际冻结执行器执行，不能借用当前安装版本");
	const nodeSha256 = localRedeploymentSha256(await readFile(frozen.request.deploymentNodeBinaryPath));
	const previous = (await readLocalRedeploymentJson(join(directory, copyValidationReceiptName))) as {
		executorSha256?: string;
		nodeSha256?: string;
	} | null;
	if (previous?.executorSha256 === frozen.executorSha256 && previous.nodeSha256 === nodeSha256) return;
	const workspace = join(directory, "recovery-validation-workspaces", `backup-copy-identity-${randomUUID()}`);
	const home = join(workspace, "isolated-runtime-home");
	const distribution = join(workspace, "isolated-distribution");
	const artifacts = join(workspace, "isolated-backup-artifacts");
	await mkdir(home, { recursive: true });
	await mkdir(distribution);
	await mkdir(artifacts);
	await writeFile(join(home, "COPYING"), "隔离复制验证正文");
	await symlink("COPYING", join(home, "LICENSE"));
	await symlink("missing-target", join(home, "dangling-link"));
	await writeFile(join(distribution, "COPYING"), "隔离回滚正文");
	await symlink("COPYING", join(distribution, "LICENSE"));
	let failure: string | null = null;
	try {
		await backupLocalRedeploymentRuntimeState(
			{
				...frozen.request,
				runtimeIdentity: { ...frozen.request.runtimeIdentity, runtimeHomeDirectoryPath: home },
				distributionDirectoryPath: distribution,
			},
			artifacts,
		);
		if (
			(await readlink(join(artifacts, "preserved-runtime-state/LICENSE"))) !== "COPYING" ||
			(await readlink(join(artifacts, "preserved-runtime-state/dangling-link"))) !== "missing-target" ||
			(await readlink(join(artifacts, "preserved-previous-distribution/LICENSE"))) !== "COPYING"
		)
			throw new Error("相对或悬空链接文本不一致");
		await rm(join(home, "COPYING"));
		await rm(join(distribution, "COPYING"));
		if (
			(await readFile(join(artifacts, "preserved-runtime-state/LICENSE"), "utf8")) !== "隔离复制验证正文" ||
			(await readFile(join(artifacts, "preserved-previous-distribution/LICENSE"), "utf8")) !== "隔离回滚正文"
		)
			throw new Error("副本仍依赖原始文件");
	} catch (error) {
		failure = String(error);
	}
	await writeLocalRedeploymentJson(join(directory, copyValidationReceiptName), {
		regressionKey: "frozen_executor_backup_copy_identity",
		executorSha256: frozen.executorSha256,
		nodeSha256,
		status: failure === null ? "passed" : "failed",
		failure,
		workspace,
	});
}

async function observeBoundProcessNotStarted(
	directory: string,
	failure: LocalDeploymentBlockingFailure,
): Promise<{ kind: "bound_command_not_started"; stage: string } | null> {
	if (
		existsSync(join(directory, "redeployment-revocation.json")) ||
		existsSync(join(directory, "local-deployment-execution-restriction.json"))
	)
		return null;
	const stage = LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.find((item) => item === failure.logicalResource);
	if (!stage) return null;
	let record: ReturnType<typeof localDeploymentExecutionRecordSchema.parse>;
	try {
		record = localDeploymentExecutionRecordSchema.parse(
			JSON.parse(await readFile(join(directory, LOCAL_DEPLOYMENT_EXECUTION_RECORD_FILENAME), "utf8")),
		);
	} catch {
		return null;
	}
	const latestIntent = record.observations
		.filter((item) => item.stage === stage && item.kind === "command_execution_intent_persisted")
		.at(-1);
	if (!latestIntent) return null;
	const terminal = record.observations.find(
		(item) =>
			item.stage === stage &&
			item.attemptNumber === latestIntent.attemptNumber &&
			(item.kind === "command_not_started" || item.kind === "command_failed" || item.kind === "command_succeeded"),
	);
	if (terminal?.kind !== "command_not_started") return null;
	const originalPath = join(latestIntent.commandOutputDirectory, "command-result.json");
	if (existsSync(originalPath)) {
		try {
			const parsed = localDeploymentCommandOriginalSchema.safeParse(
				JSON.parse(await readFile(originalPath, "utf8")),
			);
			if (!parsed.success) return null;
			const original = parsed.data;
			const identity = original.attemptIdentity;
			const identityMatches = identity
				? identity.executionId === record.manifest.executionId &&
					identity.stage === stage &&
					identity.attemptNumber === latestIntent.attemptNumber &&
					identity.commandOutputDirectory === latestIntent.commandOutputDirectory
				: true;
			if (
				!identityMatches ||
				original.processWasStarted !== false ||
				original.processId !== null ||
				original.exitCode !== null
			)
				return null;
		} catch {
			return null;
		}
	}
	return { kind: "bound_command_not_started", stage };
}

export async function observeLocalRedeploymentBlockingFailureRecovery(
	directory: string,
	failure: LocalDeploymentBlockingFailure,
): Promise<{ evidenceSha256: string; recoveryEvidenceReady: boolean }> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	let proof: unknown = null;
	if (
		["copy_identity_mismatch", "source_contention", "unclassified_failure"].includes(failure.classification) &&
		failure.sourcePath
	) {
		const validation = (await readLocalRedeploymentJson(join(directory, copyValidationReceiptName))) as {
			status?: string;
			executorSha256?: string;
			nodeSha256?: string;
			regressionKey?: string;
		} | null;
		if (
			validation?.status === "passed" &&
			validation.executorSha256 === frozen.executorSha256 &&
			validation.nodeSha256 === localRedeploymentSha256(await readFile(frozen.request.deploymentNodeBinaryPath)) &&
			validation.regressionKey === "frozen_executor_backup_copy_identity"
		) {
			if (failure.classification === "source_contention") {
				const first = await observeLocalRedeploymentFilesystemEvidence(failure.sourcePath);
				await waitBetweenSourceStabilitySamples(500);
				const second = await observeLocalRedeploymentFilesystemEvidence(failure.sourcePath);
				if (
					JSON.stringify(first) === JSON.stringify(second) &&
					first &&
					typeof first === "object" &&
					"kind" in first &&
					first.kind !== "unavailable" &&
					!("sha256" in first && first.sha256 === "content_exceeds_observation_budget")
				)
					proof = { regression: validation.regressionKey, executorSha256: frozen.executorSha256, source: first };
			} else proof = { regression: validation.regressionKey, executorSha256: frozen.executorSha256 };
		}
	} else if (
		failure.classification === "atomic_temporary_path_disappeared" ||
		failure.classification === "filesystem_unavailable"
	) {
		try {
			const path = failure.logicalResource;
			const original = (await readLocalRedeploymentJson(failure.originalErrorReference)) as {
				code?: string;
				syscall?: string;
			} | null;
			if (failure.classification === "filesystem_unavailable" && original?.code === "ENOSPC") {
				const filesystem = await statfs(dirname(path));
				if (filesystem.bavail * filesystem.bsize < 16 * 1024 * 1024) throw new Error("相关文件系统空间仍不足");
				await access(dirname(path), constants.W_OK);
				proof = { logicalResource: dirname(path), sufficientSpaceAvailable: true };
			}
			if (
				failure.classification === "filesystem_unavailable" &&
				(original?.code === "EROFS" || /write|mkdir|rename|unlink/iu.test(original?.syscall ?? ""))
			) {
				await access(dirname(path), constants.W_OK);
				proof = { logicalResource: dirname(path), writable: true };
			}
			if (!proof) {
				const metadata = await lstat(path);
				if (metadata.isFile() || metadata.isDirectory()) await access(path, constants.R_OK);
				else if (metadata.isSymbolicLink()) await readlink(path);
				proof = {
					logicalResource: path,
					kind: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "symbolic_link",
					readable: true,
				};
			}
		} catch {
			/* 观察失败保持未知，不消费预算。 */
		}
	}
	if (!proof && failure.classification === "unclassified_failure" && !failure.sourcePath)
		proof = await observeBoundProcessNotStarted(directory, failure);
	return {
		evidenceSha256: localRedeploymentSha256(
			JSON.stringify({ classification: failure.classification, logicalResource: failure.logicalResource, proof }),
		),
		recoveryEvidenceReady: proof !== null,
	};
}
