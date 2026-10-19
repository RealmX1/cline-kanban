import { randomUUID } from "node:crypto";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import {
	RvfAutomaticCloseoutRecordOperationClaimLostError,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";

export class RvfAutomaticCloseoutWaitError extends Error {}
export class RvfAutomaticCloseoutPauseError extends Error {}
export type RvfCompletionEvidence = Pick<
	RvfAutomaticCloseoutRecord,
	"runId" | "runDirectory" | "handoffPath" | "handoffSha256"
>;
export function createRvfAutomaticCloseoutCoordinator(deps: {
	storePath: string;
	inspectCompletion: (record: RvfAutomaticCloseoutRecord) => Promise<RvfCompletionEvidence | null>;
	restore: (
		record: RvfAutomaticCloseoutRecord,
		save: (patch: Partial<RvfAutomaticCloseoutRecord>) => Promise<void>,
	) => Promise<void>;
	enqueue: (record: RvfAutomaticCloseoutRecord, assertOperationStillOwned: () => Promise<void>) => Promise<void>;
	onPaused?: (record: RvfAutomaticCloseoutRecord) => Promise<unknown>;
}) {
	let inFlight: Promise<void> | null = null;
	async function processRecord(
		token: string,
		previousClaimId: string | null,
		assertOperationLockStillOwned: () => void,
	) {
		const claimId = randomUUID();
		const claimedRecord = await updateRvfAutomaticCloseoutRecords(deps.storePath, (records) => {
			assertOperationLockStillOwned();
			const current = records.find((entry) => entry.receipt.decision_token === token);
			if (
				!current ||
				current.status === "captured_review_start_boundary" ||
				current.status === "paused" ||
				current.status === "closeout_prompt_submitted" ||
				current.status === "completed"
			)
				return { records, value: null };
			// 陈旧文件锁被接管后，尚未收到 compromise 通知的旧进程也不能抢回持久 claim。
			if ((current.activeCoordinatorOperationClaimId ?? null) !== previousClaimId) return { records, value: null };
			const claimed = { ...current, activeCoordinatorOperationClaimId: claimId };
			return {
				records: records.map((entry) => (entry === current ? claimed : entry)),
				value: claimed,
			};
		});
		if (!claimedRecord) return;
		let record: RvfAutomaticCloseoutRecord = claimedRecord;
		try {
			const save = async (patch: Partial<RvfAutomaticCloseoutRecord>) => {
				record = await updateRvfAutomaticCloseoutRecords(deps.storePath, (records) => {
					assertOperationLockStillOwned();
					const current = records.find((entry) => entry.receipt.decision_token === token);
					if (current?.activeCoordinatorOperationClaimId !== claimId)
						throw new RvfAutomaticCloseoutRecordOperationClaimLostError("自动收尾记录已被其他运行时认领。");
					if (current.status === "paused") {
						record = current;
						throw new RvfAutomaticCloseoutRecordOperationClaimLostError(
							current.pauseReason ?? "自动收尾已暂停。",
						);
					}
					const replacement = {
						...current,
						...patch,
						activeCoordinatorOperationClaimId: claimId,
						updatedAt: Date.now(),
					};
					return {
						records: records.map((entry) => (entry === current ? replacement : entry)),
						value: replacement,
					};
				});
			};
			try {
				if (record.status === "awaiting_rvf_completion") {
					let completion: RvfCompletionEvidence | null;
					try {
						completion = await deps.inspectCompletion(record);
					} catch (error) {
						throw new RvfAutomaticCloseoutPauseError(error instanceof Error ? error.message : String(error));
					}
					if (!completion) return;
					await save({ ...completion, status: "restoring_pre_review_conversation" });
				}
				if (record.status === "restoring_pre_review_conversation") {
					await deps.restore(record, save);
					await save({ status: "restored_pre_review_conversation" });
				}
				if (
					record.status === "restored_pre_review_conversation" ||
					record.status === "submitting_closeout_prompt"
				) {
					await save({ status: "submitting_closeout_prompt" });
					// 同一持久幂等键贯穿重启；投递账本不确定时不能生成新键绕过它。
					await deps.enqueue(record, () => save({}));
					await save({ status: "closeout_prompt_submitted" });
				}
			} catch (error) {
				if (
					error instanceof RvfAutomaticCloseoutWaitError ||
					error instanceof RvfAutomaticCloseoutRecordOperationClaimLostError
				)
					return;
				if (!(error instanceof RvfAutomaticCloseoutPauseError)) throw error;
				if (record.status !== "paused") await save({ status: "paused", pauseReason: error.message });
				await deps.onPaused?.(record);
			}
		} finally {
			await updateRvfAutomaticCloseoutRecords(deps.storePath, (records) => ({
				records: records.map((entry) =>
					entry.receipt.decision_token === token && entry.activeCoordinatorOperationClaimId === claimId
						? { ...entry, activeCoordinatorOperationClaimId: null }
						: entry,
				),
				value: null,
			}));
		}
	}
	async function run() {
		for (const record of await readRvfAutomaticCloseoutRecords(deps.storePath)) {
			if (
				["captured_review_start_boundary", "paused", "closeout_prompt_submitted", "completed"].includes(
					record.status,
				)
			)
				continue;
			try {
				await withRvfAutomaticCloseoutRecordOperationLock(
					deps.storePath,
					record.receipt.decision_token,
					(assertOwned) =>
						processRecord(
							record.receipt.decision_token,
							record.activeCoordinatorOperationClaimId ?? null,
							assertOwned,
						),
				);
			} catch (error) {
				if (!(error instanceof RvfAutomaticCloseoutRecordOperationClaimLostError)) throw error;
			}
		}
	}
	return {
		sweep: () => {
			if (!inFlight)
				inFlight = run().finally(() => {
					inFlight = null;
				});
			return inFlight;
		},
	};
}
