// 排队 prompt 的推流投影——**纯函数、零 IO**。
//
// 投影是前端能看到的全部队列信息：正文截断成预览（正文是易膨胀数据，不上热广播链路）、阻塞原因由
// 运行时算好随行（判据全在会话 facet / 恢复守卫 / PTY 单飞槽上，前端复算必然漂移）。
//
// 阻塞原因要靠调用方注入一个解析器，而不是在这里直接读 summary：summary 来自三条 transport 的服务，
// 「PTY 单飞槽被占」则要问终端管理器——那些都是运行时对象，这个模块要保持能被表格化单测。

import type {
	QueuedTaskPromptDeliveryEntry,
	QueuedTaskPromptDispatchBlockReason,
	RuntimeQueuedTaskPromptDeliveryProjection,
	RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "./api-contract";
import { resolveManagedTaskPromptDeliveryMetadata } from "./managed-task-prompt-delivery";
import { isQueuedTaskPromptDeliveryAwaitingDispatch } from "./queued-task-prompt-delivery-dispatch-eligibility";
import { buildQueuedTaskPromptDeliveryTextPreview } from "./queued-task-prompt-delivery-merge";

export interface BuildQueuedTaskPromptDeliveryProjectionsInput {
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
	// 对一条**仍在等发**的条目给出此刻挡着它的原因；null = 下一个边沿就发。
	resolveDispatchBlockReasonForQueuedEntry: (
		entry: QueuedTaskPromptDeliveryEntry,
	) => QueuedTaskPromptDispatchBlockReason | null;
	// prompt library 里每条条目此刻正文的 sha256。null = 这次没读到库（读失败 / 调用方没提供），
	// 此时一律不下「改过没有」的结论——说不知道，比说错强。
	currentPromptLibraryEntryTextSha256ByEntryId: ReadonlyMap<string, string> | null;
	nowEpochMs: number;
}

// 「这条在重启之后还没被人看见过」。只对非终态条目成立：已经落定的条目没有什么可确认的，
// 让它们也闪一下只会把用户的注意力引到一条早就不会再发的记录上。
export function isQueuedTaskPromptDeliveryAwaitingHumanReconfirmationAfterRuntimeRestart(
	entry: QueuedTaskPromptDeliveryEntry,
): boolean {
	return (
		(entry.deliveryState === "queued" ||
			entry.deliveryState === "claimed_for_dispatch" ||
			entry.deliveryState === "handed_to_transport") &&
		entry.survivedRuntimeRestartAtEpochMs !== null &&
		entry.humanReconfirmedAfterRuntimeRestartAtEpochMs === null
	);
}

function resolveSourcePromptLibraryEntryTextChangedSinceEnqueue(
	entry: QueuedTaskPromptDeliveryEntry,
	currentShaByEntryId: ReadonlyMap<string, string> | null,
): boolean | null {
	if (entry.sourcePromptLibraryEntryId === null || entry.sourcePromptLibraryEntryTextSha256 === null) {
		return null;
	}
	if (currentShaByEntryId === null) {
		return null;
	}
	const currentSha = currentShaByEntryId.get(entry.sourcePromptLibraryEntryId);
	// 库里那条已经被删了：「改过没有」无从谈起。显示成「已改」会误导用户去库里找一条不存在的条目。
	if (currentSha === undefined) {
		return null;
	}
	return currentSha !== entry.sourcePromptLibraryEntryTextSha256;
}

export function buildRuntimeQueuedTaskPromptDeliveryProjection(
	entry: QueuedTaskPromptDeliveryEntry,
	input: Omit<BuildQueuedTaskPromptDeliveryProjectionsInput, "snapshot">,
): RuntimeQueuedTaskPromptDeliveryProjection {
	const awaitingDispatch = isQueuedTaskPromptDeliveryAwaitingDispatch(entry, input.nowEpochMs);
	// 读侧就地把「已过保质期但还没被哪次写入收敛」的 queued 显示成 expired：与出队判据同一口径，
	// 于是 UI 永远不会显示一条「排队中」、而运行时其实已经不会再发它的条目。
	const deliveryState = entry.deliveryState === "queued" && !awaitingDispatch ? "expired" : entry.deliveryState;
	return {
		...(entry.nativeIndependentUserTurnPreflightQueryRecovery
			? {
					nativeIndependentUserTurnPreflightQueryRecovery: entry.nativeIndependentUserTurnPreflightQueryRecovery,
				}
			: {}),
		deliveryId: entry.queueEntryId,
		managedDelivery: resolveManagedTaskPromptDeliveryMetadata(entry),
		queueEntryId: entry.queueEntryId,
		taskId: entry.taskId,
		deliveryState,
		textPreview: buildQueuedTaskPromptDeliveryTextPreview(entry.text),
		textLength: entry.text.length,
		deliverTogetherWithNextQueuedEntry: entry.deliverTogetherWithNextQueuedEntry,
		dispatchBlockReason: awaitingDispatch ? input.resolveDispatchBlockReasonForQueuedEntry(entry) : null,
		awaitsHumanReconfirmationAfterRuntimeRestart:
			isQueuedTaskPromptDeliveryAwaitingHumanReconfirmationAfterRuntimeRestart(entry),
		deliveryAttemptCount: entry.deliveryAttemptCount,
		lastAttemptedAt: entry.lastAttemptedAt,
		lastDeliveryFailureNote: entry.lastDeliveryFailureNote,
		sourcePromptLibraryEntryId: entry.sourcePromptLibraryEntryId,
		sourcePromptLibraryEntryTextChangedSinceEnqueue: resolveSourcePromptLibraryEntryTextChangedSinceEnqueue(
			entry,
			input.currentPromptLibraryEntryTextSha256ByEntryId,
		),
		enqueuedAt: entry.enqueuedAt,
		expiresAt: entry.expiresAt,
		settledAt: deliveryState === "expired" && entry.settledAt === null ? entry.expiresAt : entry.settledAt,
		programmaticInjectionSource: entry.programmaticInjectionLedgerReceiptLink?.injectionSource ?? null,
	};
}

export function buildRuntimeQueuedTaskPromptDeliveryProjectionsByTaskId(
	input: BuildQueuedTaskPromptDeliveryProjectionsInput,
): RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId {
	const projectedEntriesByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId = {};
	for (const [taskId, entries] of Object.entries(input.snapshot.entriesByTaskId)) {
		if (entries.length === 0) {
			continue;
		}
		projectedEntriesByTaskId[taskId] = entries.map((entry) =>
			buildRuntimeQueuedTaskPromptDeliveryProjection(entry, input),
		);
	}
	return projectedEntriesByTaskId;
}
