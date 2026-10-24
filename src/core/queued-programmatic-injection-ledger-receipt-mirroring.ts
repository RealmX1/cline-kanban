// 程序化排队投递（`kanban task message --deliver-when-agent-idle`）的「队列条目 → 注入账本」镜像规则。
// **纯函数、零 IO**：IO 由 src/state/queued-task-prompt-delivery-store.ts 在每一次队列写盘之后统一执行。
//
// ## 为什么镜像挂在「队列写盘」这一个咽喉上，而不是散在每条落定路径里
//
// 一条程序化条目会经由七条路径落定：出队引擎拿到终端回执、Queue tab 取消、`message-cancel` 取消、到截止时刻
// 过期、托管实例死掉（启动清扫 / 持续巡检）、被撂下的在途投递清扫、任务被删出看板。每一条都必须把结论写进
// 账本，否则调用方（RVF）手上那条 accepted_pending_submit_confirmation 就再也没人收敛——正是跨仓契约「唯一
// 非终态必然有界收敛」要防的那件事。七处各写一遍必漏其一；而七条路径**全部**经过 store 的同一个持锁读-改-写，
// 在那里比较写前 / 写后两份快照，就一处覆盖全部，将来新增第八条路径也自动覆盖。
//
// ## 回执怎么来
//
// 出队引擎拿到真实终端回执时，把它存在条目的 settledTerminalDeliveryReceipt 上（确认 vs 排在回合后面、
// 具体哪种失败，只有它知道）。其余路径没有终端回执可言，回执由落定后的 deliveryState 推出——见
// resolveInjectionLedgerReceiptForSettledProgrammaticInjection 的表。

import type {
	InjectionLedgerTerminalDeliveryReceipt,
	QueuedTaskPromptDeliveryEntry,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "./api-contract";

export type QueuedProgrammaticInjectionLedgerUpdate =
	| {
			kind: "record_terminal_delivery_outcome";
			taskId: string;
			injectionLedgerIdempotencyKey: string;
			receipt: InjectionLedgerTerminalDeliveryReceipt;
	  }
	| {
			kind: "record_agent_idle_gate_passed";
			taskId: string;
			injectionLedgerIdempotencyKey: string;
			passedAtEpochMs: number;
	  };

function isQueueEntryStateTerminal(state: QueuedTaskPromptDeliveryEntry["deliveryState"]): boolean {
	return state !== "queued" && state !== "claimed_for_dispatch" && state !== "handed_to_transport";
}

// 条目落定之后该写进账本的回执。条目还没落定返回 null。
//
// 由状态推出的那几格，每一格都是「确定没送达」或「不知道有没有送达」，绝不推出一个「已送达」：
//   expired         —— 一直没交给终端投递，截止时刻到了。
//   cancelled       —— 人或调用方在它交出之前（或交出后终端确认拦下时）取消了。
//   settled_failed  —— 没带终端回执的失败只有两种来源：托管实例死了（重启跨越）、在途投递被重启撂下。
//                      两者对调用方都是「runtime 重启、记录在重启前没落定」，契约里正好有这个原因。
//   settled_delivered 不带回执 —— 实现上走不到（出队引擎落定送达必带回执）；按最保守的「已确认」镜像，
//                      而不是编一个失败——条目自己记着送达，账本说失败会让调用方重投、把同一段话送两遍。
export function resolveInjectionLedgerReceiptForSettledProgrammaticInjection(
	entry: QueuedTaskPromptDeliveryEntry,
): InjectionLedgerTerminalDeliveryReceipt | null {
	const link = entry.programmaticInjectionLedgerReceiptLink ?? null;
	if (link === null || !isQueueEntryStateTerminal(entry.deliveryState)) {
		return null;
	}
	if (link.settledTerminalDeliveryReceipt !== null) {
		return link.settledTerminalDeliveryReceipt;
	}
	switch (entry.deliveryState) {
		case "expired":
			return {
				...(entry.lastDeliveryFailureNote ? { failureNote: entry.lastDeliveryFailureNote } : {}),
				status: "delivery_failed",
				reason:
					(
						entry.nativeIndependentUserTurnBeforeSubmissionQueryRecovery ??
						entry.nativeIndependentUserTurnPreflightQueryRecovery
					)?.recoveredAtEpochMs === null
						? "native_independent_user_turn_capability_unavailable"
						: "agent_never_became_idle_before_queued_delivery_deadline",
			};
		case "cancelled":
			return { status: "delivery_failed", reason: "cancelled_before_delivery" };
		case "settled_failed":
			return { status: "delivery_failed", reason: "runtime_restarted_before_confirmation" };
		default:
			return { status: "delivered_and_submit_confirmed", reason: null };
	}
}

// 非终态的程序化条目从队列里**消失**（不是落定）只有一条路径：任务离开看板、整条队列被丢弃。
// 投递落定前会话就没了——契约里的 session_ended_before_delivery 说的正是这个。
const INJECTION_LEDGER_RECEIPT_FOR_PROGRAMMATIC_INJECTION_DISCARDED_WITH_ITS_TASK: InjectionLedgerTerminalDeliveryReceipt =
	{
		status: "delivery_failed",
		reason: "session_ended_before_delivery",
	};

function indexEntriesByTaskAndQueueEntryId(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
): Map<string, QueuedTaskPromptDeliveryEntry> {
	const index = new Map<string, QueuedTaskPromptDeliveryEntry>();
	for (const [taskId, entries] of Object.entries(snapshot.entriesByTaskId)) {
		for (const entry of entries) {
			index.set(`${taskId}\u0000${entry.queueEntryId}`, entry);
		}
	}
	return index;
}

// 一次队列写盘（写前 → 写后）需要镜像进账本的全部改动。只看程序化条目；人排的条目不碰账本。
//
//   - 写后已落定、写前不存在或未落定           → 记终态（写一次即定，重复写由账本自己判 already_settled）；
//   - 写后刚变成 handed_to_transport            → 记「通过 agent 空闲门」的时刻；
//   - 写前未落定、写后整条不见了（随任务被丢弃）→ 记 session_ended_before_delivery。
//
// 写前已落定、写后不见了的（终态条目被 Dismiss / 裁掉）不产生任何改动：账本在它落定那一次就该写过了。
// 万一那次镜像写失败、出队引擎的兜底对账又没赶在条目消失前补上，这里也推不出回执（条目都没了，不知道它
// 送没送达）——那条 pending 由账本的持续清扫在「截止 + 终端投递最坏预算」之后收敛
// （src/server/pending-task-message-injection-startup-sweep.ts），同 key 重发也绝不会把它重新排进队列。
export function collectInjectionLedgerUpdatesForQueueSnapshotTransition(
	before: WorkspaceQueuedTaskPromptDeliverySnapshot,
	after: WorkspaceQueuedTaskPromptDeliverySnapshot,
	nowEpochMs: number,
): QueuedProgrammaticInjectionLedgerUpdate[] {
	if (before === after) {
		return [];
	}
	const updates: QueuedProgrammaticInjectionLedgerUpdate[] = [];
	const beforeIndex = indexEntriesByTaskAndQueueEntryId(before);
	const afterIndex = indexEntriesByTaskAndQueueEntryId(after);
	for (const [key, afterEntry] of afterIndex) {
		const link = afterEntry.programmaticInjectionLedgerReceiptLink ?? null;
		if (link === null) {
			continue;
		}
		const beforeEntry = beforeIndex.get(key) ?? null;
		const receipt = resolveInjectionLedgerReceiptForSettledProgrammaticInjection(afterEntry);
		if (receipt !== null && (beforeEntry === null || !isQueueEntryStateTerminal(beforeEntry.deliveryState))) {
			updates.push({
				kind: "record_terminal_delivery_outcome",
				taskId: link.injectionLedgerTaskId ?? afterEntry.taskId,
				injectionLedgerIdempotencyKey: link.injectionLedgerIdempotencyKey,
				receipt,
			});
			continue;
		}
		if (afterEntry.deliveryState === "handed_to_transport" && beforeEntry?.deliveryState !== "handed_to_transport") {
			updates.push({
				kind: "record_agent_idle_gate_passed",
				taskId: link.injectionLedgerTaskId ?? afterEntry.taskId,
				injectionLedgerIdempotencyKey: link.injectionLedgerIdempotencyKey,
				passedAtEpochMs: afterEntry.lastAttemptedAt ?? nowEpochMs,
			});
		}
	}
	for (const [key, beforeEntry] of beforeIndex) {
		const link = beforeEntry.programmaticInjectionLedgerReceiptLink ?? null;
		if (link === null || afterIndex.has(key) || isQueueEntryStateTerminal(beforeEntry.deliveryState)) {
			continue;
		}
		updates.push({
			kind: "record_terminal_delivery_outcome",
			taskId: link.injectionLedgerTaskId ?? beforeEntry.taskId,
			injectionLedgerIdempotencyKey: link.injectionLedgerIdempotencyKey,
			receipt: INJECTION_LEDGER_RECEIPT_FOR_PROGRAMMATIC_INJECTION_DISCARDED_WITH_ITS_TASK,
		});
	}
	return updates;
}

// 程序化条目在 prompt queue 里的 id。由账本 key 确定性派生：同一个 key 重发时 runtime 能认出「这条已经排过了」，
// 而不必另存一张 key → 条目 id 的映射表。账本按 (task_id, idempotency_key) 唯一，队列按 task 分组，
// 所以在同一个 task 的队列里它同样唯一。
export function buildQueuedProgrammaticInjectionQueueEntryId(injectionLedgerIdempotencyKey: string): string {
	return `agent-idle-gated-programmatic-injection:${injectionLedgerIdempotencyKey}`;
}
