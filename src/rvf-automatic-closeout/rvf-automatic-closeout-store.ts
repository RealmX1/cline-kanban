import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	type RvfAutomaticCloseoutRecord,
	rvfAutomaticCloseoutRecordSchema,
} from "../core/rvf-automatic-closeout-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "../state/workspace-state";
import {
	boundRvfCloseoutGoalCompletion,
	resolveRvfCloseoutSchedulingDecision,
	sameRvfCloseoutObservationBinding,
} from "./rvf-closeout-scheduling-decision";

export class RvfAutomaticCloseoutRecordOperationClaimLostError extends Error {}

export async function withRvfAutomaticCloseoutRecordOperationLock(
	storePath: string,
	decisionToken: string,
	operation: (assertOperationLockStillOwned: () => void) => Promise<void>,
): Promise<void> {
	// 副作用锁独立于 JSON 短写锁，恢复中仍能 save，用户也能随时持久暂停。
	const tokenDigest = createHash("sha256").update(decisionToken).digest("hex");
	let enteredOperation = false;
	let lockCompromised = false;
	try {
		await lockedFileSystem.withLocks(
			[
				{
					path: `${storePath}.record-operation-${tokenDigest}`,
					retries: 0,
					onCompromised: () => {
						lockCompromised = true;
					},
				},
			],
			async () => {
				enteredOperation = true;
				await operation(() => {
					if (lockCompromised)
						throw new RvfAutomaticCloseoutRecordOperationClaimLostError("自动收尾记录操作锁已失效。");
				});
			},
		);
	} catch (error) {
		if (!enteredOperation && (error as NodeJS.ErrnoException).code === "ELOCKED") return;
		throw error;
	}
}

export function getRvfAutomaticCloseoutStorePath(workspaceId: string): string {
	const directory = resolve(getWorkspaceDirectoryPath(workspaceId));
	if (dirname(directory) !== resolve(getWorkspacesRootPath())) throw new Error("非法 workspaceId。");
	return join(directory, "rvf-automatic-rewind-and-closeout-records.json");
}
export async function readRvfAutomaticCloseoutRecords(path: string): Promise<RvfAutomaticCloseoutRecord[]> {
	try {
		return z.array(rvfAutomaticCloseoutRecordSchema).parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
export async function updateRvfAutomaticCloseoutRecords<T>(
	path: string,
	operation: (
		records: RvfAutomaticCloseoutRecord[],
	) =>
		| { records: RvfAutomaticCloseoutRecord[]; value: T }
		| Promise<{ records: RvfAutomaticCloseoutRecord[]; value: T }>,
): Promise<T> {
	return lockedFileSystem.withLocks([{ path }], async () => {
		const before = await readRvfAutomaticCloseoutRecords(path);
		const beforeText = JSON.stringify(before);
		const outcome = await operation(structuredClone(before));
		const originalValues = [...outcome.records];
		// 所有写回漏斗共用单调保护；迟到的异步 patch 不能把可信完成事实降回待执行。
		outcome.records = outcome.records.map((record) => {
			const original = before.find((entry) => sameRvfCloseoutObservationBinding(entry, record));
			if (!original) return record;
			const accepted = boundRvfCloseoutGoalCompletion(original);
			if (accepted && (accepted.verifiedStages.length || accepted.externalConsumption)) {
				const next = boundRvfCloseoutGoalCompletion(record);
				record = {
					...record,
					existingCloseoutGoalCompletionReconciliation: {
						...(next ?? accepted),
						verifiedStages: [
							...accepted.verifiedStages,
							...(next?.verifiedStages ?? []).filter(
								(stage) => !accepted.verifiedStages.some((prior) => prior.stage === stage.stage),
							),
						],
						...(accepted.externalConsumption ? { externalConsumption: accepted.externalConsumption } : {}),
						...(accepted.verdict === "completed" ? { verdict: "completed" as const } : {}),
					},
				};
			}
			if (original.status === "completed") record = { ...record, status: "completed" };
			const originalDecision = resolveRvfCloseoutSchedulingDecision(original);
			if (originalDecision.completed || originalDecision.externallyConsumed) {
				record = {
					...record,
					status: record.status === "completed" ? "completed" : original.status,
					promptDeliveryAttempts: original.promptDeliveryAttempts,
					stageExecutionClaims: record.stageExecutionClaims?.filter((claim) =>
						original.stageExecutionClaims?.some(
							(prior) => prior.stageExecutionClaimId === claim.stageExecutionClaimId,
						),
					),
				};
			}
			for (const key of ["landExecutionResult", "baseBranchSyncExecutionResult"] as const)
				if (original[key]?.outcome === "completed") record = { ...record, [key]: original[key] };
			if (
				resolveRvfCloseoutSchedulingDecision(record).suppressAllScheduling &&
				record.automaticRecoveryProgress &&
				record.explicitStopRequestedAt === undefined
			)
				record = {
					...record,
					automaticRecoveryProgress: {
						...record.automaticRecoveryProgress,
						kind: "settled",
						nextAutomaticAction: "none",
						reasonCode: "closeout_goal_completed_or_externally_consumed",
					},
				};
			return record;
		});
		const parsed = z.array(rvfAutomaticCloseoutRecordSchema).parse(outcome.records);
		if (JSON.stringify(parsed) !== beforeText)
			await lockedFileSystem.writeJsonFileAtomic(path, parsed, { lock: null });
		const normalizedValue = (value: unknown) => {
			const index = originalValues.indexOf(value as RvfAutomaticCloseoutRecord);
			return index < 0 ? value : parsed[index];
		};
		const value = outcome.value;
		if (value && typeof value === "object" && "record" in value)
			return { ...value, record: normalizedValue(value.record) } as T;
		return normalizedValue(value) as T;
	});
}
