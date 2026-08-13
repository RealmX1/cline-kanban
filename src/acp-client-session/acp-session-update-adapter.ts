// 协议翻译层：把一条 ACP SessionUpdate 变成 summary facet 补丁 + 聊天消息 mutation。
// 单一入口 applyAcpSessionUpdate，对位 src/cline-sdk/cline-event-adapter.ts。
//
// 三条从 Cline 侧原样继承的铁律（那边的注释已论证，此处同样适用）：
//  1. 绝不裸写单个 userTurnKind —— 必须经 deriveAcpFacetPatch 发完整 {turnOwner, liveness, userTurnKind}
//     三元组，否则撞 api-contract 的 superRefine 共生护栏。
//  2. 任何构造 entry 的地方都要过 applySessionFacets 重新 stamp，不能只 spread 默认 summary。
//  3. 「只推进存活度」的事件必须显式带上当前实质戳，否则会把卡片的「agent 上次响应」刷成「刚刚」。
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
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
	withAgentSubstantiveOutputTimestamp,
} from "./acp-session-state";
import {
	renderAcpContentBlockAsText,
	renderAcpPlanEntriesAsMarkdown,
	renderAcpToolCallContentAsMarkdown,
	renderAcpToolCallLocationsAsMarkdown,
} from "./acp-session-update-rendering";

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
		case "available_commands_update":
		case "config_option_update":
		case "session_info_update":
		case "usage_update":
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
			emitRunningSummary(context);
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
	emitRunningSummary(context);
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

// 流式更新推进存活度，但**绝不能无条件夺回回合**。两个真实场景会因此丢掉「等人拍板」状态：
//  (a) broker 因 session/request_permission 或 plan elicitation 刚把卡片置成 awaiting_review +
//      permission/plan_review，随后任一 tool_call_update / plan 更新就把它刷回 running——agent 实际
//      阻塞等人，卡片却显示在跑，用户根本注意不到有待决策；
//  (b) 迟到的 tool_call_update（clearAcpStreamingGrouping 的注释已自陈会发生）会把
//      applyAcpPromptTurnCompletion 写好的 awaiting_review 永久改回 running。终端侧还有
//      scanForStalls 兜底，ACP 侧没有，改回去就再也回不来。
// 因此回合归属为「用户」时只推进 lastOutputAt，facet 三元组保持原样。
//
// 本函数是 ACP 侧**唯一**推进 lastSubstantiveOutputAt 的地方：它的调用方全是携带新内容的流式
// SessionUpdate（agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / plan）。
// 两条分支都要推进——「回合归属已是用户」只影响要不要夺回 facet，不改变「agent 确实刚吐了东西」这个事实。
function emitRunningSummary(context: AcpSessionUpdateContext): void {
	// 重播守卫的**唯一**闸口：历史重播只往聊天流里补消息，绝不碰回合归属与产出时间戳。
	// 放在这里而不是每个 apply* 分支里，是因为所有「有产出」的分支最终都汇到这一个函数。
	if (context.isReplayingPersistedConversationHistory) {
		return;
	}
	const timestamp = now();
	if (isAwaitingUserTurn(context.entry.summary)) {
		context.emitSummary(
			updateAcpSummary(context.entry, withAgentSubstantiveOutputTimestamp({ lastOutputAt: timestamp })),
		);
		return;
	}
	context.emitSummary(
		updateAcpSummary(
			context.entry,
			withAgentSubstantiveOutputTimestamp({
				...deriveAcpFacetPatch("running", null, { pid: context.pid, agentId: context.agentId }),
				reviewReason: null,
				lastOutputAt: timestamp,
			}),
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

	// 三条分支都不推进实质产出戳：stopReason 是**回合边界**，本轮正文早已由流式 SessionUpdate 经
	// emitRunningSummary 逐条打过戳，边界本身不带新内容。这与 Cline 侧 endedEvent 的处置同构。
	// 反转前 refusal / end_turn 两条会经漏斗隐式镜像而误推进（cancelled 当时靠显式 opt-out 才躲过），
	// 于是「续跑一个旧 ACP 会话、它立刻以 end_turn 收束」就会把卡片刷成「agent 刚刚响应」。
	if (stopReason === "cancelled") {
		// 用户主动取消不是错误：也不落成 error 人轴。
		return updateAcpSummary(context.entry, {
			...deriveAcpFacetPatch("interrupted", null, { pid: context.pid, agentId: context.agentId }),
			reviewReason: null,
			lastOutputAt: timestamp,
		});
	}

	if (stopReason === "refusal") {
		return updateAcpSummary(context.entry, {
			...deriveAcpFacetPatch("awaiting_review", "error", { pid: context.pid, agentId: context.agentId }),
			reviewReason: "error",
			lastOutputAt: timestamp,
		});
	}

	// end_turn / max_tokens / max_turn_requests：回合正常收束，交回用户。
	return updateAcpSummary(context.entry, {
		...deriveAcpFacetPatch("awaiting_review", "completion", { pid: context.pid, agentId: context.agentId }),
		reviewReason: "completion",
		lastOutputAt: timestamp,
	});
}

// 会话进程消失。进程退出不是 agent 产出，故不经 withAgentSubstantiveOutputTimestamp——漏斗默认就不
// 推进实质戳（反转前这里必须显式带当前实质戳来 opt-out，现在那道手续没必要了）。
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
		pid: null,
		exitCode: detail.exitCode,
		reviewReason: detail.errorMessage ? "error" : "completion",
	});
}
