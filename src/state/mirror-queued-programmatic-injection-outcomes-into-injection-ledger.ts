// 程序化排队投递（`kanban task message --deliver-when-agent-idle`）的结论 → 注入账本（task-message-injections.json）。
//
// 两条入口，一主一备：
//   - mirrorProgrammaticInjectionQueueTransitionsIntoInjectionLedger —— 主路径。由 store 唯一的持锁读-改-写
//     （updateWorkspaceQueuedTaskPromptDeliveriesUnderLock）在每次写盘、锁释放之后调用，比较写前写后两份快照；
//   - reconcileInjectionLedgerWithSettledProgrammaticInjections —— 兜底。出队引擎的 60s sweep 调用，补主路径
//     写账本失败的漏网。
// 「哪种队列变化该写什么回执」是纯规则，在 src/core/queued-programmatic-injection-ledger-receipt-mirroring.ts；
// 这里只做 IO。不 import store（store import 本文件）。

import type { QueuedTaskPromptDeliveryEntry, WorkspaceQueuedTaskPromptDeliverySnapshot } from "../core/api-contract";
import {
	collectInjectionLedgerUpdatesForQueueSnapshotTransition,
	resolveInjectionLedgerReceiptForSettledProgrammaticInjection,
} from "../core/queued-programmatic-injection-ledger-receipt-mirroring";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	isTaskMessageTerminalDeliveryStatusSettled,
	readTaskMessageInjectionLedger,
	recordTaskMessageInjectionAgentIdleGatePassed,
	recordTaskMessageTerminalDeliveryOutcome,
} from "../core/task-message-injection-ledger";
import { getWorkspaceDirectoryPath } from "./workspace-state";

// 把一次队列写盘对程序化条目造成的改动镜像进注入账本（见 queued-programmatic-injection-ledger-receipt-mirroring.ts）。
//
// 在**队列锁释放之后**做：两份文件两把锁，嵌套持有只会拉长锁的持有时间，还要给全仓定一个加锁顺序。
// 逐条容错、绝不抛：队列已经落盘，这里抛出去会让调用方以为队列写失败了而去重试。漏写的终态由出队引擎的
// 兜底 sweep（reconcileInjectionLedgerWithSettledProgrammaticInjections）补上；漏写的「通过空闲门」只是诊断字段。
export async function mirrorProgrammaticInjectionQueueTransitionsIntoInjectionLedger(input: {
	workspaceId: string;
	before: WorkspaceQueuedTaskPromptDeliverySnapshot;
	after: WorkspaceQueuedTaskPromptDeliverySnapshot;
	nowEpochMs: number;
}): Promise<void> {
	const updates = collectInjectionLedgerUpdatesForQueueSnapshotTransition(input.before, input.after, input.nowEpochMs);
	if (updates.length === 0) {
		return;
	}
	const workspaceId = input.workspaceId;
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId));
	for (const update of updates) {
		try {
			if (update.kind === "record_agent_idle_gate_passed") {
				await recordTaskMessageInjectionAgentIdleGatePassed({
					ledgerPath,
					taskId: update.taskId,
					idempotencyKey: update.injectionLedgerIdempotencyKey,
					nowIso: new Date(update.passedAtEpochMs).toISOString(),
				});
				continue;
			}
			await recordTaskMessageTerminalDeliveryOutcome({
				ledgerPath,
				taskId: update.taskId,
				idempotencyKey: update.injectionLedgerIdempotencyKey,
				status: update.receipt.status,
				...(update.receipt.reason === null ? {} : { failureReason: update.receipt.reason }),
				...(update.receipt.failureNote ? { failureDetail: update.receipt.failureNote } : {}),
				...(update.receipt.codexNativePromptDeliveryEvidence
					? { codexNativePromptDeliveryEvidence: update.receipt.codexNativePromptDeliveryEvidence }
					: {}),
				nowIso: new Date().toISOString(),
			});
		} catch {
			// 见函数头：兜底 sweep 会补。
		}
	}
}

// 兜底对账：已落定的程序化条目，账本里那条却还 pending ⇒ 补写。只补「写盘后镜像那一步失败了」这一种漏网，
// 所以先无锁读两份文件、只对真不一致的那几条去拿账本锁（账本写一次即定，补写与并发的正常写不会互相覆盖）。
// 返回补写的条数。
export async function reconcileInjectionLedgerWithSettledProgrammaticInjections(input: {
	workspaceId: string;
	// 调用方手上刚读到的队列快照（兜底 sweep 恰好有）。由调用方传入而不是这里去读：本模块被 store 的写盘咽喉
	// import，反过来再 import store 就成环。
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
}): Promise<number> {
	const snapshot = input.snapshot;
	const pendingReceipts: { taskId: string; idempotencyKey: string; entry: QueuedTaskPromptDeliveryEntry }[] = [];
	for (const entries of Object.values(snapshot.entriesByTaskId)) {
		for (const entry of entries) {
			const link = entry.programmaticInjectionLedgerReceiptLink ?? null;
			if (link !== null && resolveInjectionLedgerReceiptForSettledProgrammaticInjection(entry) !== null) {
				pendingReceipts.push({ taskId: entry.taskId, idempotencyKey: link.injectionLedgerIdempotencyKey, entry });
			}
		}
	}
	if (pendingReceipts.length === 0) {
		return 0;
	}
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(input.workspaceId));
	const records = await readTaskMessageInjectionLedger(ledgerPath);
	let reconciledCount = 0;
	for (const candidate of pendingReceipts) {
		const record = findTaskMessageInjectionRecord(records, candidate.taskId, candidate.idempotencyKey);
		const receipt = resolveInjectionLedgerReceiptForSettledProgrammaticInjection(candidate.entry);
		if (
			record === null ||
			receipt === null ||
			isTaskMessageTerminalDeliveryStatusSettled(record.terminal_delivery_status)
		) {
			continue;
		}
		const outcome = await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: candidate.taskId,
			idempotencyKey: candidate.idempotencyKey,
			status: receipt.status,
			...(receipt.reason === null ? {} : { failureReason: receipt.reason }),
			...(receipt.failureNote ? { failureDetail: receipt.failureNote } : {}),
			...(receipt.codexNativePromptDeliveryEvidence
				? { codexNativePromptDeliveryEvidence: receipt.codexNativePromptDeliveryEvidence }
				: {}),
			nowIso: new Date().toISOString(),
		});
		if (outcome.outcome === "settled") {
			reconciledCount += 1;
		}
	}
	return reconciledCount;
}
