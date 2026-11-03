import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LocalDeploymentExecutionAnalysis } from "./local-deployment-execution";
import { localDeploymentAcceptedRecordIdentitySchema } from "./local-deployment-execution-contract";

async function readLegacyObject(path: string): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export async function analyzeLegacyLocalDeploymentExecution(
	directory: string,
): Promise<LocalDeploymentExecutionAnalysis> {
	let executionDirectory = resolve(directory);
	// 只跟随原执行显式绑定的目录，拒绝跨目录的 latest 或任意文件系统遍历。
	try {
		const boundDirectory = (
			await readFile(join(executionDirectory, "authorized-interruption-execution-path.txt"), "utf8")
		).trim();
		const child = await realpath(boundDirectory);
		if (!child.startsWith(`${await realpath(executionDirectory)}${sep}`))
			throw new Error("历史执行目录指针超出本次证据目录");
		executionDirectory = child;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const receipt =
		(await readLegacyObject(join(executionDirectory, "deployment-record.json"))) ??
		(await readLegacyObject(join(executionDirectory, "actual-local-deployment-record-receipt.json")));
	const executionStatus = await readLegacyObject(join(executionDirectory, "execution-status.json"));
	const continuation = await readLegacyObject(join(executionDirectory, "deployment-continuation-state.json"));
	if (!receipt && !executionStatus && !continuation) throw new Error(`没有可识别的部署原件：${executionDirectory}`);
	const registered = localDeploymentAcceptedRecordIdentitySchema.safeParse(receipt).success;
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ receipt, executionStatus, continuation }))
		.digest("hex");
	const observedStageFailures: LocalDeploymentExecutionAnalysis["observedStageFailures"] = [];
	const stagingFailurePath = join(
		executionDirectory,
		"publication-empty-staging-directory-cleanup-failure-and-recovery-evidence.json",
	);
	const stagingFailure = await readLegacyObject(stagingFailurePath);
	if (typeof stagingFailure?.failure === "string")
		observedStageFailures.push({
			stage: "staging_cleanup",
			evidenceReference: stagingFailurePath,
			detail: stagingFailure.failure,
		});
	const recoveryNotesPath = join(executionDirectory, "deployment-execution-recovery-notes.json");
	try {
		const notes: unknown = JSON.parse(await readFile(recoveryNotesPath, "utf8"));
		if (Array.isArray(notes)) {
			for (const note of notes) {
				if (
					note &&
					typeof note === "object" &&
					typeof note.observedFailure === "string" &&
					/rmdir|暂存子目录/.test(note.observedFailure)
				) {
					observedStageFailures.push({
						stage: "staging_cleanup",
						evidenceReference: recoveryNotesPath,
						detail: note.observedFailure,
					});
				}
			}
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return {
		executionDirectory,
		executionId: registered ? String(receipt?.deploymentId) : `legacy-${fingerprint}`,
		executionIdentityEvidenceKind: registered ? "deployment_registration_receipt" : "unknown",
		candidateSourceCommit: String(
			receipt?.deployedSourceCommit ?? continuation?.preparedCandidateSourceCommit ?? "unknown",
		),
		candidateDistributionSha256: "unknown",
		deploymentOutcome: registered ? "succeeded" : "machine_evidence_pending",
		ancillaryFailures: registered && /comment/i.test(String(executionStatus?.error)) ? ["task_comment"] : [],
		analysisFingerprint: fingerprint,
		retrospective: { status: "not_requested", analysisFingerprint: null, independentFindingsFilePath: null },
		recovery: {
			unfinishedStage: registered ? null : "runtime_validation",
			nextCheckAtEpochMs: null,
			condition: registered ? null : "历史缺证；读取精确原始回执、日志与进程证据，不重新执行部署",
		},
		metrics: {
			commandAttempts: null,
			failedCommandAttempts: null,
			recoveredEffects: null,
			verifiedStageEffects: null,
			commandElapsedByStageMs: {},
			httpDowntimeMs: null,
			nativeModelUsage: null,
			unknownMetricReasons: {
				commandAttempts: "历史回执不包含完整尝试记录",
				failedCommandAttempts: "历史回执不包含完整失败记录",
				recoveredEffects: "未结构化记录恢复事实",
				httpDowntimeMs: "历史材料未连续采样，不能由总耗时推算停机",
				nativeModelUsage: "历史材料未绑定模型 usage",
			},
		},
		deepAnalysisReasons:
			registered && executionStatus?.error ? ["部署登记成功而外层执行状态仍失败，需分别核对附属收尾"] : [],
		observedStageFailures,
	};
}
