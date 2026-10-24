import { projectUniqueNativeInProgressWorkPhaseGoal } from "../core/agent-current-work-phase-goal";
// 协议翻译层：把一条 ACP SessionUpdate 变成 summary facet 补丁 + 聊天消息 mutation。
// 单一入口 applyAcpSessionUpdate，对位 src/cline-sdk/cline-event-adapter.ts。
//
// 三条从 Cline 侧原样继承的铁律（那边的注释已论证，此处同样适用）：
//  1. 绝不裸写单个 userTurnKind —— 必须经 deriveAcpFacetPatch 发完整 {turnOwner, liveness, userTurnKind}
//     三元组，否则撞 api-contract 的 superRefine 共生护栏。
//  2. 任何构造 entry 的地方都要过 applySessionFacets 重新 stamp，不能只 spread 默认 summary。
//  3. 「只推进存活度」的事件必须显式带上当前实质戳，否则会把卡片的「agent 上次响应」刷成「刚刚」。
import type {
	RuntimeAgentId,
	RuntimeEffectiveAgentConversationActivityKind,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../core/session-activity";
import { recordTaskAgentConversationModelTokenUsageCumulativeSnapshotToJournal } from "../diagnostics/task-agent-conversation-model-token-usage-journal-recorder";
import type { AcpSessionNotification, AcpSessionUpdate, AcpStopReason } from "./acp-protocol-boundary";
import {
	type AcpTaskMessage,
	type AcpTaskSessionEntry,
	appendAcpMessage,
	appendAcpStreamedChunk,
	clearAcpStreamingGrouping,
	createAcpMessage,
	deriveAcpFacetPatch,
	finishAcpStreamedReasoningMessages,
	now,
	replaceAcpMessage,
	updateAcpSummary,
	withEffectiveAgentConversationActivity,
} from "./acp-session-state";
import {
	renderAcpContentBlockAsText,
	renderAcpPlanEntriesAsMarkdown,
	renderAcpToolCallContentAsMarkdown,
	renderAcpToolCallLocationsAsMarkdown,
} from "./acp-session-update-rendering";
import { ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK } from "./acp-task-session-park-awaiting-dispatched-background-work";

export interface AcpSessionUpdateContext {
	taskId: string;
	agentId: RuntimeAgentId;
	pid: number | null;
	entry: AcpTaskSessionEntry;
	// 这一批 update 是否来自 session/load 的**历史重播**（而不是 agent 此刻正在产出）。
	// omp 的 #replaySessionHistory 把整段既往对话当成普通 agent_message_chunk / tool_call 重发，
	// 与真实产出在协议层完全同形，只能靠「我们正处在 session/load 之中」这个外部事实区分。
	// 它是终端侧 suppressSubstantiveOutputUntilContinues 的对位物：重播必须只补消息、
	// 不推进 lastSubstantiveOutputAt、不把卡片翻成 running（否则每次切到 ACP 都会把一张
	// 停在 Review 的卡片凭空推回 In Progress，并把「agent 上次响应」刷成刚刚）。
	isReplayingPersistedConversationHistory: boolean;
	emitSummary(summary: RuntimeTaskSessionSummary): void;
	emitMessage(message: AcpTaskMessage): void;
}

export function applyAcpSessionUpdate(context: AcpSessionUpdateContext, notification: AcpSessionNotification): void {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			applyStreamedChunk(context, update, "assistant");
			return;
		case "agent_thought_chunk":
			applyStreamedChunk(context, update, "reasoning");
			return;
		case "user_message_chunk":
			// 只在 session/load 的历史重播里出现。重播不是「agent 刚刚响应」，故不推进产出时间戳。
			applyReplayedUserChunk(context, update);
			return;
		case "tool_call":
		case "tool_call_update":
			applyToolCall(context, update);
			return;
		case "plan":
			applyPlan(context, update.entries);
			return;
		case "current_mode_update":
			applyStatusMessage(context, `Mode: ${readCurrentModeId(update)}`, "mode");
			return;
		case "usage_update":
			// 资源占用采集：上下文占用与 harness 自报的累计 cost 落 journal；不进聊天流，也不改变回合归属。
			if (!context.isReplayingPersistedConversationHistory) {
				recordAcpUsageUpdateToJournal(context, update);
			}
			return;
		case "available_commands_update":
		case "config_option_update":
		case "session_info_update":
		case "plan_update":
		case "plan_removed":
			// 会话元数据：不进聊天流，也不改变回合归属。
			return;
	}
}

function applyStreamedChunk(
	context: AcpSessionUpdateContext,
	update: Extract<AcpSessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>,
	role: "assistant" | "reasoning",
): void {
	const text = renderAcpContentBlockAsText(update.content);
	if (!text) {
		return;
	}
	const message = appendAcpStreamedChunk(context.entry, context.taskId, {
		role,
		acpMessageId: update.messageId ?? null,
		chunk: text,
	});
	context.emitMessage(message);
	emitRunningSummary(context);
}

function applyReplayedUserChunk(
	context: AcpSessionUpdateContext,
	update: Extract<AcpSessionUpdate, { sessionUpdate: "user_message_chunk" }>,
): void {
	const text = renderAcpContentBlockAsText(update.content);
	if (!text) {
		return;
	}
	context.emitMessage(
		appendAcpMessage(context.entry, createAcpMessage(context.taskId, "user", text, { source: "acp_replay" })),
	);
}

function applyToolCall(
	context: AcpSessionUpdateContext,
	update: Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): void {
	const existingMessageId = context.entry.toolMessageIdByToolCallId.get(update.toolCallId);
	const status = update.status ?? (update.sessionUpdate === "tool_call" ? "pending" : null);
	const content = buildToolCallMessageContent(update);

	if (existingMessageId) {
		// content / locations 在 ACP 里是整体替换语义，不是追加——所以这里整条重写而不是拼接。
		const updated = replaceAcpMessage(context.entry, existingMessageId, (message) => ({
			...message,
			content: content || message.content,
			meta: {
				...(message.meta ?? {}),
				...(update.kind ? { toolKind: update.kind } : {}),
				...(status ? { toolCallStatus: status } : {}),
			},
		}));
		if (updated) {
			context.emitMessage(updated);
			emitRunningSummary(context, "tool_activity");
			return;
		}
	}

	const created = appendAcpMessage(
		context.entry,
		createAcpMessage(context.taskId, "tool", content, {
			toolCallId: update.toolCallId,
			toolName: update.title ?? null,
			toolKind: update.kind ?? null,
			toolCallStatus: status,
			source: "acp",
		}),
	);
	context.entry.toolMessageIdByToolCallId.set(update.toolCallId, created.id);
	context.emitMessage(created);
	emitRunningSummary(context, "tool_activity");
}

function buildToolCallMessageContent(
	update: Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): string {
	const sections: string[] = [];
	if (update.title) {
		sections.push(update.title);
	}
	const locations = renderAcpToolCallLocationsAsMarkdown(update.locations ?? []);
	if (locations) {
		sections.push(locations);
	}
	const renderedContent = renderAcpToolCallContentAsMarkdown(update.content ?? []);
	if (renderedContent) {
		sections.push(renderedContent);
	}
	return sections.join("\n\n");
}

function applyPlan(
	context: AcpSessionUpdateContext,
	entries: ReadonlyArray<{ content: string; status: string; priority: string }>,
): void {
	const nativeSessionId = context.entry.summary.agentNativeConversationSessionIdentity?.nativeSessionId;
	if (
		!context.isReplayingPersistedConversationHistory &&
		nativeSessionId &&
		resolveSessionFacets(context.entry.summary).turnOwner === "agent"
	) {
		const goalText = projectUniqueNativeInProgressWorkPhaseGoal(entries);
		context.emitSummary(
			updateAcpSummary(context.entry, {
				agentNativeCurrentWorkPhaseGoal: goalText
					? {
							goalText,
							source: "acp_structured_plan",
							updatedAt: Math.max(
								now(),
								(context.entry.summary.agentCurrentWorkPhaseGoalInvalidatedAt ?? 0) + 1,
							),
							owningNativeConversationSessionId: nativeSessionId,
							owningKanbanTaskConversationSessionId: context.taskId,
							owningRuntimeSessionIncarnationId: context.entry.summary.runtimeSessionIncarnationId ?? null,
						}
					: null,
			}),
		);
	}
	// plan 每次都是全量列表、客户端整体替换，所以只维护一条消息反复重写。
	const content = renderAcpPlanEntriesAsMarkdown(entries);
	if (context.entry.planMessageId) {
		const updated = replaceAcpMessage(context.entry, context.entry.planMessageId, (message) => ({
			...message,
			content,
		}));
		if (updated) {
			context.emitMessage(updated);
			emitRunningSummary(context);
			return;
		}
	}
	const created = appendAcpMessage(
		context.entry,
		createAcpMessage(context.taskId, "status", content, { messageKind: "plan", source: "acp" }),
	);
	context.entry.planMessageId = created.id;
	context.emitMessage(created);
	emitRunningSummary(context);
}

function applyStatusMessage(context: AcpSessionUpdateContext, content: string, messageKind: string): void {
	context.emitMessage(
		appendAcpMessage(
			context.entry,
			createAcpMessage(context.taskId, "status", content, { messageKind, source: "acp" }),
		),
	);
}

// omp 发的是 currentModeId；规范示例里出现过 modeId，两种都兜一下。
function readCurrentModeId(update: Extract<AcpSessionUpdate, { sessionUpdate: "current_mode_update" }>): string {
	const record = update as unknown as { currentModeId?: unknown; modeId?: unknown };
	if (typeof record.currentModeId === "string") {
		return record.currentModeId;
	}
	if (typeof record.modeId === "string") {
		return record.modeId;
	}
	return "(unknown)";
}

// 活动与回合归属独立：可信新内容推进活动，但迟到工具更新不能夺回待答或已结束回合。
// 提交接受的 agent 边沿由 service 在可靠协议证据到达时单独确认。
function emitRunningSummary(
	context: AcpSessionUpdateContext,
	activityKind: RuntimeEffectiveAgentConversationActivityKind = "agent_output",
): void {
	// 重播守卫的**唯一**闸口：历史重播只往聊天流里补消息，绝不碰回合归属与产出时间戳。
	// 放在这里而不是每个 apply* 分支里，是因为所有「有产出」的分支最终都汇到这一个函数。
	if (context.isReplayingPersistedConversationHistory) {
		return;
	}
	const timestamp = now();
	if (isAwaitingUserTurn(context.entry.summary)) {
		context.emitSummary(
			updateAcpSummary(
				context.entry,
				withEffectiveAgentConversationActivity({ lastOutputAt: timestamp }, activityKind),
			),
		);
		return;
	}
	context.emitSummary(
		updateAcpSummary(
			context.entry,
			withEffectiveAgentConversationActivity(
				{
					...deriveAcpFacetPatch("running", null, { pid: context.pid, agentId: context.agentId }),
					reviewReason: null,
					lastOutputAt: timestamp,
				},
				activityKind,
			),
		),
	);
}

function isAwaitingUserTurn(summary: RuntimeTaskSessionSummary): boolean {
	return resolveSessionFacets(summary).turnOwner === "user";
}

// session/prompt 的最终 stopReason → 回合归属。
export function applyAcpPromptTurnCompletion(
	context: AcpSessionUpdateContext,
	stopReason: AcpStopReason,
): RuntimeTaskSessionSummary {
	// 顺序承重：先把本回合的 reasoning 标成已收束（读的正是分组表），再清分组。
	for (const finishedReasoningMessage of finishAcpStreamedReasoningMessages(context.entry)) {
		context.emitMessage(finishedReasoningMessage);
	}
	clearAcpStreamingGrouping(context.entry);
	const timestamp = now();

	// 真实收束是回合边界活动，保持与正文、工具活动的种类区分。
	if (stopReason === "cancelled") {
		// 用户主动取消不是错误：也不落成 error 人轴。
		return updateAcpSummary(
			context.entry,
			withEffectiveAgentConversationActivity(
				{
					...deriveAcpFacetPatch("interrupted", null, { pid: context.pid, agentId: context.agentId }),
					...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
					reviewReason: null,
					lastOutputAt: timestamp,
				},
				"agent_turn_boundary",
			),
		);
	}

	if (stopReason === "refusal") {
		return updateAcpSummary(
			context.entry,
			withEffectiveAgentConversationActivity(
				{
					...deriveAcpFacetPatch("awaiting_review", "error", { pid: context.pid, agentId: context.agentId }),
					...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
					reviewReason: "error",
					lastOutputAt: timestamp,
				},
				"agent_turn_boundary",
			),
		);
	}

	// dd2db 2x：park 中正常收束 = 主 agent 结束本轮去等自己派发的后台工作，不是在等用户审查。facet 保持 agent 回合
	// （与 PTY 上 hook 的 to_review 闸抑制同义），由编排方之后发来的 prompt 恢复并清 park。
	if (isParkedAwaitingDispatchedBackgroundWork(context.entry.summary)) {
		return updateAcpSummary(
			context.entry,
			withEffectiveAgentConversationActivity({ lastOutputAt: timestamp }, "agent_turn_boundary"),
		);
	}

	// end_turn / max_tokens / max_turn_requests：回合正常收束，交回用户。
	return updateAcpSummary(
		context.entry,
		withEffectiveAgentConversationActivity(
			{
				...deriveAcpFacetPatch("awaiting_review", "completion", { pid: context.pid, agentId: context.agentId }),
				reviewReason: "completion",
				lastOutputAt: timestamp,
			},
			"agent_turn_boundary",
		),
	);
}

// 会话进程消失不是新正文；只记录终态，由共享漏斗判定真实交棒。
export function applyAcpConnectionClosed(
	context: AcpSessionUpdateContext,
	detail: { exitCode: number | null; errorMessage: string | null },
): RuntimeTaskSessionSummary {
	if (detail.errorMessage) {
		context.emitMessage(
			appendAcpMessage(
				context.entry,
				createAcpMessage(context.taskId, "system", detail.errorMessage, {
					messageKind: "error",
					source: "acp",
				}),
			),
		);
	}
	return updateAcpSummary(context.entry, {
		// pid 置空是「进程已退」的唯一真相源：facet 推导据此把 awaiting 判为 exited。
		...deriveAcpFacetPatch("awaiting_review", detail.errorMessage ? "error" : "completion", {
			pid: null,
			agentId: context.agentId,
		}),
		...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
		pid: null,
		exitCode: detail.exitCode,
		reviewReason: detail.errorMessage ? "error" : "completion",
	});
}

function recordAcpUsageUpdateToJournal(
	context: AcpSessionUpdateContext,
	update: { used?: unknown; size?: unknown; cost?: unknown },
): void {
	const cost =
		typeof update.cost === "object" && update.cost !== null ? (update.cost as Record<string, unknown>) : null;
	const costAmount = cost?.amount;
	const costCurrency = typeof cost?.currency === "string" ? cost.currency.toUpperCase() : null;
	recordTaskAgentConversationModelTokenUsageCumulativeSnapshotToJournal({
		workspaceId: null,
		attributedTaskCardId: context.taskId,
		sessionTaskId: context.taskId,
		agentId: context.agentId,
		modelTokenUsageSource: "acp_usage_update",
		nativeSessionId: context.entry.summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
		totals: { contextWindowSizeTokens: typeof update.size === "number" ? update.size : null },
		// 只认美元：其他币种不做换算（换算率同样会漂移）。
		harnessReportedCumulativeCostUsd: costCurrency === "USD" && typeof costAmount === "number" ? costAmount : null,
		contextWindowUsedTokens: typeof update.used === "number" ? update.used : null,
		subagentTranscriptCount: null,
	});
}
