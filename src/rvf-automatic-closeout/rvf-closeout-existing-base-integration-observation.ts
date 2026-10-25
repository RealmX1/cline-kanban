import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import { getGitStdout } from "../workspace/git-utils";
import { readNormalRvfCloseoutSuppression } from "./independent-backup-route-ownership";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";
import {
	type ExecutionRecoveryDependencies,
	reportRvfCloseoutExecutionResultWithIndependentEvidence,
} from "./rvf-closeout-execution-stage-recovery";
import { readBoundRvfBaseIntegrationState } from "./validate-rvf-automatic-closeout-execution-result";

function sameObservationBinding(current: RvfAutomaticCloseoutRecord, original: RvfAutomaticCloseoutRecord) {
	return (
		current.workspaceId === original.workspaceId &&
		current.taskId === original.taskId &&
		current.runId === original.runId &&
		current.runDirectory === original.runDirectory &&
		current.handoffPath === original.handoffPath &&
		current.handoffSha256 === original.handoffSha256 &&
		JSON.stringify(current.receipt) === JSON.stringify(original.receipt)
	);
}

// 探测只读文件身份、HEAD 和 base ref；不调用完整评审引擎，也不恢复会话。
async function readBaseIntegrationCapabilityFingerprint(record: RvfAutomaticCloseoutRecord, rvfHome: string) {
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], record.receipt.worktree).catch(
			(error: NodeJS.ErrnoException) => `unavailable:${error.code ?? "unknown"}`,
		);
	const gitDirectory = await git(["rev-parse", "--absolute-git-dir"]);
	const candidate = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
	const artifacts = join(record.runDirectory ?? "", "artifacts");
	const paths = [
		candidate,
		`${candidate}.sha256`,
		record.handoffPath ?? "",
		join(artifacts, "inputs", "scope.contract.json"),
		join(artifacts, ".finalize.lock"),
		join(artifacts, "automatic-closeout-registration.json"),
		join(rvfHome, "automatic-closeout-completion-notifications", `${record.receipt.decision_token}.json`),
		join(
			rvfHome,
			"review-start-independent-user-turn-boundary-receipts",
			`${record.receipt.decision_token}.run-binding.json`,
		),
	];
	let baseRef = record.receipt.comparison_base_ref ?? "";
	try {
		const scope: unknown = JSON.parse(await readFile(join(artifacts, "inputs", "scope.contract.json"), "utf8"));
		if (scope && typeof scope === "object" && "base_ref" in scope && typeof scope.base_ref === "string")
			baseRef = scope.base_ref;
	} catch {
		/* 缺失或损坏由完整核验报告，探测只记录当前能力。 */
	}
	const localBaseRef = baseRef.startsWith("refs/") ? baseRef : `refs/heads/${baseRef}`;
	const metadata = await Promise.all(
		paths.map(async (path) => {
			try {
				const entry = await lstat(path);
				return [path, entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs, entry.isSymbolicLink()];
			} catch (error) {
				return [path, (error as NodeJS.ErrnoException).code ?? "unknown"];
			}
		}),
	);
	return JSON.stringify([
		record.workspaceId,
		record.taskId,
		record.receipt,
		record.runId,
		record.handoffSha256,
		record.landExecutionResult,
		metadata,
		await git(["rev-parse", "--verify", "HEAD"]),
		await git(["rev-parse", "--verify", localBaseRef]),
		await git(["rev-parse", "--git-common-dir"]),
	]);
}

export async function observeExistingRvfBaseIntegrationStateOnce(
	deps: ExecutionRecoveryDependencies,
	original: RvfAutomaticCloseoutRecord,
): Promise<RvfAutomaticCloseoutRecord> {
	if (
		deps.isStopped(original) ||
		original.workspaceId !== deps.workspaceId ||
		original.automaticCloseoutIneligibleReason ||
		original.baseBranchSyncExecutionResult?.outcome === "completed" ||
		original.landExecutionResult?.outcome !== "completed" ||
		!original.runDirectory ||
		!["paused", "submitting_closeout_prompt", "closeout_prompt_submitted"].includes(original.status)
	)
		return original;
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	let observed = original;
	await withRvfAutomaticCloseoutRecordOperationLock(
		storePath,
		original.receipt.decision_token,
		async (assertOwned) => {
			const current = (await readRvfAutomaticCloseoutRecords(storePath)).find((entry) =>
				sameObservationBinding(entry, original),
			);
			if (!current || deps.isStopped(current) || current.baseBranchSyncExecutionResult?.outcome === "completed")
				return;
			observed = current;
			if (await readNormalRvfCloseoutSuppression(current.receipt.worktree, current.runDirectory)) return;
			const previous = current.independentBaseIntegrationObservationBudget;
			if (
				previous &&
				(previous.count >= 3 ? previous.nextCapabilityProbeAtMs : previous.nextAttemptAtMs) > Date.now()
			)
				return;
			const fingerprint = await readBaseIntegrationCapabilityFingerprint(current, deps.rvfHome);
			const same = previous?.fingerprint === fingerprint;
			const verify = !same || previous.count < 3;
			observed = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
				assertOwned();
				const latest = records.find((entry) => sameObservationBinding(entry, current));
				if (!latest || deps.isStopped(latest) || latest.baseBranchSyncExecutionResult?.outcome === "completed")
					return { records, value: latest ?? current };
				const updated = {
					...latest,
					independentBaseIntegrationObservationBudget: {
						fingerprint,
						count: same ? Math.min(3, previous.count + (verify ? 1 : 0)) : 1,
						nextAttemptAtMs: Date.now() + 15_000,
						nextCapabilityProbeAtMs: Date.now() + 60_000,
						recoveryCondition: "本地 base ref、候选、handoff、run 完成凭据或核验能力变化后自动重验。",
					},
				};
				return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
			});
			if (!verify || deps.isStopped(observed) || observed.baseBranchSyncExecutionResult?.outcome === "completed")
				return;
			try {
				const actual = await readBoundRvfBaseIntegrationState(observed);
				assertOwned();
				observed = (
					await reportRvfCloseoutExecutionResultWithIndependentEvidence(
						deps,
						{
							taskId: observed.taskId,
							decisionToken: observed.receipt.decision_token,
							runId: observed.runId ?? "",
							handoffSha256: observed.handoffSha256 ?? "",
							stage: "base_branch_sync",
							outcome: "completed",
							commitSha: actual.baseCommitSha,
							baseRef: actual.baseRef,
						},
						{ automaticObservation: true, assertObservationStillOwned: assertOwned },
					)
				).record;
			} catch (error) {
				observed = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
					assertOwned();
					const latest = records.find((entry) => sameObservationBinding(entry, observed));
					if (!latest || deps.isStopped(latest) || latest.baseBranchSyncExecutionResult?.outcome === "completed")
						return { records, value: latest ?? observed };
					const updated = {
						...latest,
						independentBaseIntegrationObservationBudget: {
							...(observed.independentBaseIntegrationObservationBudget as NonNullable<
								RvfAutomaticCloseoutRecord["independentBaseIntegrationObservationBudget"]
							>),
							reason: error instanceof Error ? error.message : "base 整合证据暂不可核验。",
						},
					};
					return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
				});
			}
		},
	);
	return observed;
}
