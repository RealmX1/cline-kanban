import type {
	RuntimeQueuedTaskPromptDeliveryProjection,
	RuntimeTaskPromptDeliveryQueueResponse,
} from "@/runtime/types";

export interface QueuedTaskPromptDeliveryDebugReference {
	text: string;
	notice: string | null;
}

function describeDebugReferenceTimestamp(timestamp: number | null | undefined) {
	const date = typeof timestamp === "number" ? new Date(timestamp) : null;
	return {
		epochMilliseconds: timestamp ?? null,
		iso8601Utc: date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null,
	};
}

/** 只复制定位字段和投递元数据，不把 prompt 正文带进调试引用。 */
export function buildQueuedTaskPromptDeliveryDebugReference(input: {
	workspaceId: string | null;
	workspaceTaskId: string;
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	queueReadResponse: RuntimeTaskPromptDeliveryQueueResponse | null;
	capturedAtEpochMs: number;
}): QueuedTaskPromptDeliveryDebugReference {
	const { projection } = input;
	let response = input.queueReadResponse;
	const notices: string[] = [];
	if (
		response?.queuedTaskPromptDeliveryDebugReferenceContext &&
		response.queuedTaskPromptDeliveryDebugReferenceContext.workspaceId !== input.workspaceId
	) {
		notices.push("读取结果属于其他项目，已忽略其路径和记录。");
		response = null;
	}
	const readableResponse = response?.ok && response.queue !== null ? response : null;
	const context = readableResponse?.queuedTaskPromptDeliveryDebugReferenceContext;
	const candidate = readableResponse?.queue?.entriesByTaskId[projection.taskId]?.find(
		(entry) => entry.queueEntryId === projection.queueEntryId && entry.taskId === projection.taskId,
	);
	const projectedSnapshot = candidate
		? readableResponse?.projectedEntriesByTaskId?.[projection.taskId]?.find(
				(entry) => entry.queueEntryId === projection.queueEntryId && entry.taskId === projection.taskId,
			)
		: undefined;
	const metadata = candidate ?? projection;
	if (!readableResponse) {
		notices.push("无法读取当前运行时队列，以下仅为界面已知引用。");
	} else if (!candidate) {
		notices.push("该条目已从当前队列移除或清理，以下保留界面已知引用。");
	}
	if (!context) {
		notices.push("运行时未提供实际存储路径，未推测默认 HOME 路径。");
	}
	const link = candidate?.programmaticInjectionLedgerReceiptLink;
	const notice = notices.length > 0 ? notices.join(" ") : null;
	const snapshot = {
		capturedAt: describeDebugReferenceTimestamp(input.capturedAtEpochMs),
		workspaceId: input.workspaceId,
		workspaceTaskId: candidate?.workspaceTaskId ?? input.workspaceTaskId,
		conversationSessionId: projection.taskId,
		queueEntryId: projection.queueEntryId,
		metadataSource: candidate ? "runtime_queue_snapshot" : "previously_displayed_projection",
		...(context
			? {
					workspaceProjectPath: context.workspaceProjectPath,
					queuedTaskPromptDeliveriesFilePath: context.queuedTaskPromptDeliveriesFilePath,
				}
			: {}),
		deliveryState: projectedSnapshot?.deliveryState ?? metadata.deliveryState,
		dispatchBlockReason:
			projectedSnapshot?.dispatchBlockReason ?? (candidate ? null : projection.dispatchBlockReason),
		deliveryAttemptCount: metadata.deliveryAttemptCount,
		enqueuedAt: describeDebugReferenceTimestamp(metadata.enqueuedAt),
		lastAttemptedAt: describeDebugReferenceTimestamp(metadata.lastAttemptedAt),
		lastAttemptedAtMeaning: "最近一次开始交给 transport 的时间，不是尝试结束时间。",
		settledAt: describeDebugReferenceTimestamp(metadata.settledAt),
		expiresAt: describeDebugReferenceTimestamp(metadata.expiresAt),
		lastDeliveryFailureNote: metadata.lastDeliveryFailureNote,
		sourcePromptLibraryEntryId: metadata.sourcePromptLibraryEntryId,
		...(candidate?.dispatchIdempotencyKey ? { dispatchIdempotencyKey: candidate.dispatchIdempotencyKey } : {}),
		...(link
			? {
					programmaticInjectionSource: link.injectionSource,
					injectionLedgerIdempotencyKey: link.injectionLedgerIdempotencyKey,
					injectionLedgerTaskId: link.injectionLedgerTaskId ?? candidate.taskId,
					...(context ? { taskMessageInjectionLedgerFilePath: context.taskMessageInjectionLedgerFilePath } : {}),
				}
			: {}),
		...(notice ? { notice } : {}),
	};
	const guidance = [
		"检索指导（只读）：",
		context
			? "1. 读取 queuedTaskPromptDeliveriesFilePath 指向的文件。"
			: "1. 按 workspaceId 找到对应运行实例的 workspace 存储目录，读取 queued-task-prompt-deliveries.json。",
		`2. 在 entriesByTaskId[${JSON.stringify(projection.taskId)}] 中精确匹配 queueEntryId=${JSON.stringify(projection.queueEntryId)}。会话 ID 与看板任务 ID 可能不同。`,
		...(link
			? [
					"3. 在该实例的 task-message-injections.json 中按 task_id=injectionLedgerTaskId 与 idempotency_key=injectionLedgerIdempotencyKey 检索自动注入回执；有 dispatchIdempotencyKey 时可用它关联投递记录。",
				]
			: []),
		"这是采集时的快照。条目可能被移除或按保留期清理；未命中不证明它从未入队或从未尝试。过期截止时间以 expiresAt 为准。",
	];
	return { text: `Prompt Queue 调试引用\n${JSON.stringify(snapshot, null, 2)}\n\n${guidance.join("\n")}`, notice };
}
