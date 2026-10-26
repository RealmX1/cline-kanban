import {
	countDailyWorkProgressCollectionCost,
	measureDailyWorkProgressSynchronousStage,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";

export interface ProgrammaticPromptSubmissionReceipt {
	promptSha256: string;
	confirmedAtEpochMs: number;
}
export interface ProgrammaticPromptReceiptTimeIndex {
	containsWithinTimestampWindow(promptSha256: string, timestamp: number, maximumDistanceMs: number): boolean;
}

/** 同一正文的确认时间排序；只保存哈希和时间，后来的同文人工输入不会成为永久黑名单。 */
// EXPERIMENT_NODE: 零等待回填的总体收益不稳定，调度变化时重测索引的构建与 GC 成本。
export function createProgrammaticPromptReceiptTimeIndex(
	receipts: readonly ProgrammaticPromptSubmissionReceipt[],
): ProgrammaticPromptReceiptTimeIndex {
	return measureDailyWorkProgressSynchronousStage("receipt_index_build", () => {
		const timestampsByPromptSha256 = new Map<string, number[]>();
		for (const receipt of receipts) {
			if (!Number.isFinite(receipt.confirmedAtEpochMs)) continue;
			let timestamps = timestampsByPromptSha256.get(receipt.promptSha256);
			if (!timestamps) {
				timestamps = [];
				timestampsByPromptSha256.set(receipt.promptSha256, timestamps);
			}
			timestamps.push(receipt.confirmedAtEpochMs);
		}
		countDailyWorkProgressCollectionCost("receipt_indexed_entries", receipts.length);
		for (const timestamps of timestampsByPromptSha256.values()) timestamps.sort((a, b) => a - b);
		return {
			containsWithinTimestampWindow(promptSha256, timestamp, maximumDistanceMs) {
				countDailyWorkProgressCollectionCost("receipt_candidate_queries");
				const timestamps = timestampsByPromptSha256.get(promptSha256);
				if (!timestamps || !Number.isFinite(timestamp)) return false;
				let left = 0;
				let right = timestamps.length;
				while (left < right) {
					countDailyWorkProgressCollectionCost("receipt_comparisons");
					const middle = Math.floor((left + right) / 2);
					if ((timestamps[middle] as number) < timestamp - maximumDistanceMs) left = middle + 1;
					else right = middle;
				}
				return left < timestamps.length && (timestamps[left] as number) <= timestamp + maximumDistanceMs;
			},
		};
	});
}
