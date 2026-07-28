// ACP 会话的纯状态原语：内存 entry / 消息形状 + 唯一的 summary 写漏斗。
// 对位 src/cline-sdk/cline-session-state.ts，但消息分组模型不同——ACP 用协议自带的
// `messageId` 给流式 chunk 分组（omp 全程在发），而不是 Cline 那套 activeAssistantMessageId。
import type {
	RuntimeAgentId,
	RuntimeTaskChatMessage,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "../core/api-contract";
import {
	applySessionFacets,
	deriveSessionFacetsFromLegacyState,
	mergeSummaryWithFacets,
} from "../core/session-activity";

export type AcpTaskMessage = RuntimeTaskChatMessage;

export interface AcpTaskSessionEntry {
	summary: RuntimeTaskSessionSummary;
	messages: AcpTaskMessage[];
	// ACP 的 ContentChunk 带 messageId：同一条 agent 消息的所有 chunk 共享它，变了就是新消息。
	// 没带 messageId 的 agent 只能退化成「本回合一条」，用 fallback 槽兜住。
	assistantMessageIdByAcpMessageId: Map<string, string>;
	reasoningMessageIdByAcpMessageId: Map<string, string>;
	fallbackAssistantMessageId: string | null;
	fallbackReasoningMessageId: string | null;
	toolMessageIdByToolCallId: Map<string, string>;
	// plan（todo 列表）每次都是全量替换，所以只保留一条消息反复重写。
	planMessageId: string | null;
}

export function now(): number {
	return Date.now();
}

// 写侧 facet 补丁。与 Cline 版的唯一区别是 pid 不写死 null：ACP agent 是真子进程，
// 有真实 pid，于是 awaiting_review 能借 pid 正确区分 live（进程还在）与 exited（进程没了）。
export function deriveAcpFacetPatch(
	state: RuntimeTaskSessionState,
	reviewReason: RuntimeTaskSessionReviewReason,
	context: { pid: number | null; agentId: RuntimeAgentId },
	userTurnKindOverride?: RuntimeTaskSessionUserTurnKind | null,
): Partial<RuntimeTaskSessionSummary> {
	const facets = deriveSessionFacetsFromLegacyState(state, {
		reviewReason,
		pid: context.pid,
		connectionRetryActive: false,
		agentId: context.agentId,
	});
	const userTurnKind =
		userTurnKindOverride !== undefined && facets.turnOwner === "user" ? userTurnKindOverride : facets.userTurnKind;
	return { turnOwner: facets.turnOwner, liveness: facets.liveness, userTurnKind };
}

export function createDefaultAcpSummary(taskId: string, agentId: RuntimeAgentId): RuntimeTaskSessionSummary {
	return applySessionFacets({
		taskId,
		state: "idle",
		mode: null,
		agentId,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	});
}

export function createAcpTaskSessionEntry(taskId: string, agentId: RuntimeAgentId): AcpTaskSessionEntry {
	return {
		summary: createDefaultAcpSummary(taskId, agentId),
		messages: [],
		assistantMessageIdByAcpMessageId: new Map(),
		reasoningMessageIdByAcpMessageId: new Map(),
		fallbackAssistantMessageId: null,
		fallbackReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map(),
		planMessageId: null,
	};
}

export function cloneAcpSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
		latestHookActivity: summary.latestHookActivity ? { ...summary.latestHookActivity } : null,
		latestTurnCheckpoint: summary.latestTurnCheckpoint ? { ...summary.latestTurnCheckpoint } : null,
		previousTurnCheckpoint: summary.previousTurnCheckpoint ? { ...summary.previousTurnCheckpoint } : null,
	};
}

export function cloneAcpMessage(message: AcpTaskMessage): AcpTaskMessage {
	return {
		...message,
		images: message.images ? message.images.map((image) => ({ ...image })) : message.images,
		meta: message.meta ? { ...message.meta } : message.meta,
	};
}

// 唯一 summary 写漏斗。与 Cline 侧同构地镜像 lastSubstantiveOutputAt = lastOutputAt：
// ACP 的 SessionUpdate 都是结构化事件（不是 TUI 重绘），所以每条都算真实产出。
// 「只推进存活度」的事件（连接关闭、回合取消）必须显式带上当前实质戳来退出镜像，
// 见 emitAcpLivenessOnlySummaryPatch——否则卡片的「agent 上次响应」会被刷成「刚刚」。
export function updateAcpSummary(
	entry: AcpTaskSessionEntry,
	patch: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	const mirroredPatch =
		patch.lastOutputAt !== undefined && patch.lastSubstantiveOutputAt === undefined
			? { ...patch, lastSubstantiveOutputAt: patch.lastOutputAt }
			: patch;
	entry.summary = mergeSummaryWithFacets(entry.summary, { ...mirroredPatch, updatedAt: now() });
	return cloneAcpSummary(entry.summary);
}

// 显式带上当前实质戳，使 updateAcpSummary 的镜像不生效。
export function withCurrentSubstantiveOutputTimestamp(
	entry: AcpTaskSessionEntry,
	patch: Partial<RuntimeTaskSessionSummary>,
): Partial<RuntimeTaskSessionSummary> {
	return { ...patch, lastSubstantiveOutputAt: entry.summary.lastSubstantiveOutputAt ?? null };
}

export function createAcpMessage(
	taskId: string,
	role: AcpTaskMessage["role"],
	content: string,
	meta?: AcpTaskMessage["meta"],
	images?: RuntimeTaskImage[],
): AcpTaskMessage {
	return {
		id: `${taskId}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
		role,
		content,
		images: images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined,
		createdAt: now(),
		...(meta ? { meta } : {}),
	};
}

export function appendAcpMessage(entry: AcpTaskSessionEntry, message: AcpTaskMessage): AcpTaskMessage {
	entry.messages.push(message);
	return cloneAcpMessage(message);
}

export function replaceAcpMessage(
	entry: AcpTaskSessionEntry,
	messageId: string,
	update: (message: AcpTaskMessage) => AcpTaskMessage,
): AcpTaskMessage | null {
	const index = entry.messages.findIndex((message) => message.id === messageId);
	if (index === -1) {
		return null;
	}
	const nextMessage = update(entry.messages[index]);
	entry.messages[index] = nextMessage;
	return cloneAcpMessage(nextMessage);
}

// 按 ACP 的 messageId 把流式 chunk 归并到同一条消息；agent 没给 messageId 时退化到
// 「当前回合一条」的 fallback 槽。
export function appendAcpStreamedChunk(
	entry: AcpTaskSessionEntry,
	taskId: string,
	input: {
		role: Extract<AcpTaskMessage["role"], "assistant" | "reasoning">;
		acpMessageId: string | null;
		chunk: string;
	},
): AcpTaskMessage {
	const groupingMap =
		input.role === "assistant" ? entry.assistantMessageIdByAcpMessageId : entry.reasoningMessageIdByAcpMessageId;
	const existingMessageId = input.acpMessageId
		? groupingMap.get(input.acpMessageId)
		: input.role === "assistant"
			? entry.fallbackAssistantMessageId
			: entry.fallbackReasoningMessageId;

	if (existingMessageId) {
		const updated = replaceAcpMessage(entry, existingMessageId, (message) => ({
			...message,
			content: `${message.content}${input.chunk}`,
		}));
		if (updated) {
			return updated;
		}
	}

	const created = createAcpMessage(taskId, input.role, input.chunk, {
		streamType: input.role === "reasoning" ? "reasoning" : null,
		source: "acp",
	});
	entry.messages.push(created);
	if (input.acpMessageId) {
		groupingMap.set(input.acpMessageId, created.id);
	} else if (input.role === "assistant") {
		entry.fallbackAssistantMessageId = created.id;
	} else {
		entry.fallbackReasoningMessageId = created.id;
	}
	return cloneAcpMessage(created);
}

// 回合边界：清掉流式分组，使下一回合从新消息开始。工具映射不清——tool_call_update
// 可能在回合结束后才到（例如 release 之后仍在渲染的终端输出）。
export function clearAcpStreamingGrouping(entry: AcpTaskSessionEntry): void {
	entry.assistantMessageIdByAcpMessageId.clear();
	entry.reasoningMessageIdByAcpMessageId.clear();
	entry.fallbackAssistantMessageId = null;
	entry.fallbackReasoningMessageId = null;
}

export function canAcpSessionReturnToRunning(reviewReason: RuntimeTaskSessionSummary["reviewReason"]): boolean {
	return reviewReason === "attention" || reviewReason === "hook" || reviewReason === "error";
}
