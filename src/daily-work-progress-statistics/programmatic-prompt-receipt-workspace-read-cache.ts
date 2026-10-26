import { readTaskMessageInjectionLedger, type TaskMessageInjectionRecord } from "../core/task-message-injection-ledger";
import { measureDailyWorkProgressSynchronousStage } from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { createParsedPersistedJsonFileReadCache } from "../state/parsed-persisted-json-file-read-cache";
import {
	createProgrammaticPromptReceiptTimeIndex,
	type ProgrammaticPromptReceiptTimeIndex,
	type ProgrammaticPromptSubmissionReceipt,
} from "./programmatic-prompt-receipt-time-index";

const receiptTargetKey = (taskId: string, conversationSessionId: string) =>
	JSON.stringify([taskId, conversationSessionId]);
// EXPERIMENT_NODE: 用自然窗口验证缓存容量与重建成本的权衡，始终保留身份和历史边界复验。
const MAXIMUM_CACHED_WORKSPACES = 32;
const MAXIMUM_CACHED_RECEIPTS = 262_144;
interface ProgrammaticPromptReceiptWorkspaceSnapshot {
	receiptCount: number;
	receiptsByTaskAndTargetSession: Map<string, ProgrammaticPromptSubmissionReceipt[]>;
	byTaskAndTargetSession: Map<string, ProgrammaticPromptReceiptTimeIndex>;
}
export function groupProgrammaticPromptReceiptsByTaskAndTargetSession(
	records: readonly TaskMessageInjectionRecord[],
	createTimeIndexes = true,
): ProgrammaticPromptReceiptWorkspaceSnapshot {
	const grouped = measureDailyWorkProgressSynchronousStage("receipt_target_grouping", () => {
		const grouped = new Map<string, { promptSha256: string; confirmedAtEpochMs: number }[]>();
		for (const record of records) {
			if (record.terminal_delivery_status === "delivery_failed") continue;
			const key = receiptTargetKey(record.task_id, record.attempt_id ?? record.task_id);
			let receipts = grouped.get(key);
			if (!receipts) {
				receipts = [];
				grouped.set(key, receipts);
			}
			receipts.push({
				promptSha256: record.prompt_sha256,
				confirmedAtEpochMs: Date.parse(record.terminal_delivery_status_updated_at),
			});
		}
		return grouped;
	});
	return {
		receiptCount: records.length,
		receiptsByTaskAndTargetSession: grouped,
		byTaskAndTargetSession: new Map(
			createTimeIndexes
				? [...grouped].map(([key, receipts]) => [key, createProgrammaticPromptReceiptTimeIndex(receipts)])
				: [],
		),
	};
}

/** 只读派生索引，沿用 inode/size/mtimeNs/ctimeNs 双重检查；缺失、换代或失败后重新读取。 */
export function createProgrammaticPromptReceiptWorkspaceReadCache(options: { createTimeIndexes?: boolean } = {}) {
	const cache = createParsedPersistedJsonFileReadCache<ProgrammaticPromptReceiptWorkspaceSnapshot>();
	const retainedReceiptCountsByPath = new Map<string, number>();
	return {
		async read(path: string): Promise<ProgrammaticPromptReceiptWorkspaceSnapshot> {
			const snapshot = await cache.read(path, async () =>
				groupProgrammaticPromptReceiptsByTaskAndTargetSession(
					await readTaskMessageInjectionLedger(path),
					options.createTimeIndexes,
				),
			);
			retainedReceiptCountsByPath.delete(path);
			retainedReceiptCountsByPath.set(path, snapshot.receiptCount);
			let retainedCount = [...retainedReceiptCountsByPath.values()].reduce((sum, count) => sum + count, 0);
			while (
				retainedReceiptCountsByPath.size > MAXIMUM_CACHED_WORKSPACES ||
				retainedCount > MAXIMUM_CACHED_RECEIPTS
			) {
				const oldestPath = retainedReceiptCountsByPath.keys().next().value;
				if (oldestPath === undefined) break;
				retainedCount -= retainedReceiptCountsByPath.get(oldestPath) ?? 0;
				retainedReceiptCountsByPath.delete(oldestPath);
				cache.forget(oldestPath);
			}
			return snapshot;
		},
		find(snapshot: ProgrammaticPromptReceiptWorkspaceSnapshot, taskId: string, conversationSessionId: string) {
			return snapshot.byTaskAndTargetSession.get(receiptTargetKey(taskId, conversationSessionId));
		},
		findReceipts(
			snapshot: ProgrammaticPromptReceiptWorkspaceSnapshot,
			taskId: string,
			conversationSessionId: string,
		) {
			return snapshot.receiptsByTaskAndTargetSession.get(receiptTargetKey(taskId, conversationSessionId)) ?? [];
		},
	};
}
