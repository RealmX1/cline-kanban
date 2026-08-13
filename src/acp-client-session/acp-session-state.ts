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
		// 通道盖章：这条会话是 ACP 的。omp 的 agentId 在 TUI 与 ACP 两条通道上是同一个，
		// 故一切「这条会话长什么样」的判断都必须读它，不能再从 agentId 派生。
		sessionTransport: "acp_stdio_subprocess",
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

// ACP 侧唯一 summary 写漏斗。与 Cline 侧同构：**不对 lastSubstantiveOutputAt 做任何隐式推断**，
// 推进它只能靠调用方显式经 withAgentSubstantiveOutputTimestamp 声明。
// 反转前这里默认把 lastSubstantiveOutputAt 镜像成 lastOutputAt、靠写点 opt-out，
// 完整的代价与理由见 src/cline-sdk/cline-session-state.ts updateSummary 的注释（两侧同因同修）。
export function updateAcpSummary(
	entry: AcpTaskSessionEntry,
	patch: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	entry.summary = mergeSummaryWithFacets(entry.summary, { ...patch, updatedAt: now() });
	return cloneAcpSummary(entry.summary);
}

// 显式声明「这一次写带来了新的 agent 实质产出」——推进 lastSubstantiveOutputAt 的唯一方式。
// ACP 侧真正符合的只有流式 SessionUpdate（agent_message_chunk / agent_thought_chunk / tool_call /
// tool_call_update / plan），见 acp-session-update-adapter.ts 的 emitRunningSummary。
// 回合完成的 stopReason（end_turn / refusal / cancelled）是**回合边界**，正文早已由上面那些流式事件
// 打过戳，不再重复推进；连接关闭、进程失败、用户发消息、会话回收同理。
// 同时记一条「对话上次推进」观测：ACP 的 SessionUpdate 是**结构化**协议事件（不是刮 TUI 猜出来的），
// 故与 Cline 侧同取 structured_agent_session_event。合并规则由 mergeSummaryWithFacets 统一执行，
// 此处只如实上报一次观测、不做裁决。
export function withAgentSubstantiveOutputTimestamp(
	patch: Partial<RuntimeTaskSessionSummary>,
): Partial<RuntimeTaskSessionSummary> {
	const observedAtMs = now();
	return {
		...patch,
		lastSubstantiveOutputAt: observedAtMs,
		lastConversationProgressObservation: { observedAtMs, evidenceKind: "structured_agent_session_event" },
	};
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
		// reasoning 用两个取值区分「仍在流」与「已收束」：面板据此决定要不要自动展开思考块，
		// 并在流结束时自动收起（对位 Cline 侧的 hookEventName reasoning_delta）。
		// 收束由 finishAcpStreamedReasoningMessages 在回合边界统一改写，见那里的注释。
		streamType: input.role === "reasoning" ? ACP_REASONING_STREAM_TYPE_WHILE_STREAMING : null,
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
// reasoning 消息的两种流式阶段。ACP 协议本身不区分「这段思考还在写」与「写完了」——
// agent_thought_chunk 只管追加。唯一能观测到收束的时刻是回合边界（session/prompt 的 stopReason），
// 于是在那里把仍挂在分组表里的 reasoning 消息统一改写成已收束。
export const ACP_REASONING_STREAM_TYPE_WHILE_STREAMING = "reasoning_streaming";
export const ACP_REASONING_STREAM_TYPE_AFTER_STREAM_COMPLETED = "reasoning";

// 把本回合仍标记为「在流」的 reasoning 消息改写成已收束，返回被改写的消息（调用方负责发出去）。
// 必须在 clearAcpStreamingGrouping **之前**调用：分组表正是「本回合有哪些 reasoning 消息」的唯一记录。
export function finishAcpStreamedReasoningMessages(entry: AcpTaskSessionEntry): AcpTaskMessage[] {
	const reasoningMessageIds = new Set<string>(entry.reasoningMessageIdByAcpMessageId.values());
	if (entry.fallbackReasoningMessageId) {
		reasoningMessageIds.add(entry.fallbackReasoningMessageId);
	}
	const finishedMessages: AcpTaskMessage[] = [];
	for (const messageId of reasoningMessageIds) {
		const updated = replaceAcpMessage(entry, messageId, (message) =>
			message.meta?.streamType === ACP_REASONING_STREAM_TYPE_WHILE_STREAMING
				? {
						...message,
						meta: { ...message.meta, streamType: ACP_REASONING_STREAM_TYPE_AFTER_STREAM_COMPLETED },
					}
				: message,
		);
		if (updated && updated.meta?.streamType === ACP_REASONING_STREAM_TYPE_AFTER_STREAM_COMPLETED) {
			finishedMessages.push(updated);
		}
	}
	return finishedMessages;
}

export function clearAcpStreamingGrouping(entry: AcpTaskSessionEntry): void {
	entry.assistantMessageIdByAcpMessageId.clear();
	entry.reasoningMessageIdByAcpMessageId.clear();
	entry.fallbackAssistantMessageId = null;
	entry.fallbackReasoningMessageId = null;
}

export function canAcpSessionReturnToRunning(reviewReason: RuntimeTaskSessionSummary["reviewReason"]): boolean {
	return reviewReason === "attention" || reviewReason === "hook" || reviewReason === "error";
}
