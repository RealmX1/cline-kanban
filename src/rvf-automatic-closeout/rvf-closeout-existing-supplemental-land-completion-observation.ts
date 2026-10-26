import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import { readNormalRvfCloseoutSuppression } from "./independent-backup-route-ownership";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";
import {
	type ExecutionRecoveryDependencies,
	isRvfCloseoutRecordEligibleForExistingCompletionObservation,
	reportRvfCloseoutExecutionResultWithIndependentEvidence,
} from "./rvf-closeout-execution-stage-recovery";
import {
	findBoundRvfSupplementalCompletionReferences,
	readRvfSupplementalCompletionCapabilityFingerprint,
} from "./verify-rvf-supplemental-land-completion-evidence";

function sameSupplementalObservationBinding(current: RvfAutomaticCloseoutRecord, original: RvfAutomaticCloseoutRecord) {
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

export async function observeExistingRvfSupplementalLandCompletionOnce(
	deps: ExecutionRecoveryDependencies,
	original: RvfAutomaticCloseoutRecord,
	assertObservationStillOwned?: () => void,
): Promise<RvfAutomaticCloseoutRecord> {
	if (
		deps.isStopped(original) ||
		original.workspaceId !== deps.workspaceId ||
		original.landExecutionResult?.outcome === "completed" ||
		!isRvfCloseoutRecordEligibleForExistingCompletionObservation(original)
	)
		return original;
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	let observed = original;
	const observeUnderOperationLock = async (assertOwned: () => void) => {
		const current = (await readRvfAutomaticCloseoutRecords(storePath)).find((entry) =>
			sameSupplementalObservationBinding(entry, original),
		);
		if (!current || deps.isStopped(current) || current.landExecutionResult?.outcome === "completed") return;
		observed = current;
		if (await readNormalRvfCloseoutSuppression(current.receipt.worktree, current.runDirectory)) return;
		const previous = current.supplementalLandCompletionObservationBudget;
		const budgetStillWaiting =
			previous && (previous.count >= 3 ? previous.nextCapabilityProbeAtMs : previous.nextAttemptAtMs) > Date.now();
		if (budgetStillWaiting && !assertObservationStillOwned) return;
		const fingerprint = await readRvfSupplementalCompletionCapabilityFingerprint(current);
		const same = previous?.fingerprint === fingerprint;
		// 原生动作前探测迟到的证明；相同证据仍遵守原预算，不因预检增加全面核验次数。
		if (same && budgetStillWaiting) return;
		const verify = !same || previous.count < 3;
		observed = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
			assertOwned();
			const latest = records.find((entry) => sameSupplementalObservationBinding(entry, current));
			if (!latest || deps.isStopped(latest) || latest.landExecutionResult?.outcome === "completed")
				return { records, value: latest ?? current };
			const updated = {
				...latest,
				supplementalLandCompletionObservationBudget: {
					...(same ? previous : {}),
					fingerprint,
					count: same ? Math.min(3, previous.count + (verify ? 1 : 0)) : 1,
					nextAttemptAtMs: Date.now() + 15_000,
					nextCapabilityProbeAtMs: Date.now() + 60_000,
					recoveryCondition:
						"原 run 的补充证明、bundle、sidecar、handoff、目标 HEAD 或只读 verify 能力变化后自动重验；不执行补审或业务写入。",
				},
			};
			return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
		});
		if (!verify || deps.isStopped(observed) || observed.landExecutionResult?.outcome === "completed") return;
		try {
			const references = await findBoundRvfSupplementalCompletionReferences(observed);
			if (!references.length) throw new Error("尚无精确绑定的已发布补充完成证明；等待原生产方补证发布。");
			let lastError: unknown;
			for (const { targetCommitSha, ...reference } of references) {
				try {
					assertOwned();
					observed = (
						await reportRvfCloseoutExecutionResultWithIndependentEvidence(
							deps,
							{
								taskId: observed.taskId,
								decisionToken: observed.receipt.decision_token,
								runId: observed.runId ?? "",
								handoffSha256: observed.handoffSha256 ?? "",
								stage: "land",
								outcome: "completed",
								commitSha: targetCommitSha,
								supplementalLandCompletionEvidence: reference,
							},
							{ automaticObservation: true, assertObservationStillOwned: assertOwned },
						)
					).record;
					return;
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError;
		} catch (error) {
			observed = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
				assertOwned();
				const latest = records.find((entry) => sameSupplementalObservationBinding(entry, observed));
				if (!latest || deps.isStopped(latest) || latest.landExecutionResult?.outcome === "completed")
					return { records, value: latest ?? observed };
				const updated = {
					...latest,
					supplementalLandCompletionObservationBudget: {
						...(observed.supplementalLandCompletionObservationBudget as NonNullable<
							RvfAutomaticCloseoutRecord["supplementalLandCompletionObservationBudget"]
						>),
						reason: error instanceof Error ? error.message : "补充完成证明暂不可核验。",
					},
				};
				return { records: records.map((entry) => (entry === latest ? updated : entry)), value: updated };
			});
		}
	};
	if (assertObservationStillOwned) await observeUnderOperationLock(assertObservationStillOwned);
	else
		await withRvfAutomaticCloseoutRecordOperationLock(
			storePath,
			original.receipt.decision_token,
			observeUnderOperationLock,
		);
	return observed;
}
