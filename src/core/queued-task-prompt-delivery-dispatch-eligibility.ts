// 排队 prompt 出队门控——**纯谓词、零 IO**。出队引擎（src/server/queued-task-prompt-delivery-dispatcher.ts）
// 只负责编排与副作用，「此刻能不能发」这件事的全部判据都在这里，于是它可以被表格化单测钉死。
//
// ## 为什么门控这么密
//
// 队列坐在既有 sendTaskChatMessage 出口**之上**，而那条出口自带就绪门控与诚实失败。理论上把所有
// 判断都交给它也能跑。不这么做的理由是：出口的「诚实失败」会消耗一次投递尝试并留下一条失败记录，
// 而队列的语义是「等到能发的时候再发」——把「agent 还在干活」这种必然会好的情况变成一次失败尝试，
// 等于让用户看着自己的队列反复报错。门控在前，出口在后，两者不是重复而是分工。
//
// ## 判据全部读 facet / sidecar，绝不臆测 pid 或 state 字面量
//
// 本仓铁律。三条 transport 的 summary 由同一个漏斗写出，facet 是它们唯一对等的语言。

import { resolveLastAgentConversationUserHandoffObservation } from "./agent-conversation-activity-observation";
import type {
	QueuedTaskPromptDeliveryEntry,
	QueuedTaskPromptDispatchBlockReason,
	RuntimeTaskSessionSummary,
} from "./api-contract";
import {
	hasReclaimableAgentSessionRuntime,
	isAgentAwaitingModalUserDecision,
	isAgentSessionCurrentlyGeneratingResponse,
	isParkedAwaitingDispatchedBackgroundWork,
	isRestorationContinuationGuardDeclaredArmedIgnoringMaximumArmedDuration,
	resolveSessionFacets,
} from "./session-activity";

// 排队意图的保质期。超过它的条目转 expired 并在 UI 上可见，**绝不**静默发射。
//
// 24h 是「隔夜还算数、隔周不算数」这条直觉的落点。真正兜住风险的不是这个数值本身，而是它存的是
// 绝对时刻（entry.expiresAt）：停机期间流逝的墙钟时间自然计入，系统关机三天再开机，条目已经过期。
export const QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS = 24 * 60 * 60 * 1000;

// 这条条目此刻还算不算「在排队等发」。
// expired 由它就地判定而不是等某个定时器去改状态：状态改写是副作用，而「过没过期」是时间的函数——
// 让读侧自己算，就不存在「定时器没跑到、于是一条早该过期的条目被发了出去」这种窗口。
export function isQueuedTaskPromptDeliveryAwaitingDispatch(
	entry: QueuedTaskPromptDeliveryEntry,
	nowEpochMs: number,
): boolean {
	return entry.deliveryState === "queued" && nowEpochMs < entry.expiresAt;
}

export interface QueuedTaskPromptDispatchEligibilityInput {
	// 队首候选条目。链上后续条目不参与门控——它们跟着 head 一起走。
	headEntry: QueuedTaskPromptDeliveryEntry;
	// 该 task 此刻的会话摘要。null = 运行时压根没有这个会话的条目。
	sessionSummary: RuntimeTaskSessionSummary | null | undefined;
	// 仅 PTY 有意义：单飞槽此刻是否被另一条程序化投递（例：RVF followup）占着。
	// 非 PTY transport 由调用方恒传 false——它们没有输入框可抢。
	hasPendingProgrammaticTaskChatInputDelivery: boolean;
	nowEpochMs: number;
	// 做这次判定的 runtime 进程实例。给了就启用托管门：条目由**别的**实例托管时，本实例不发它。
	// 不给（纯投影 / 旧调用方）时不启用——托管判定只有持有进程身份的一方做得了。
	thisRuntimeProcessInstanceId?: string | null;
}

// 返回 null = 此刻可以出队。返回枚举值 = 被这条挡住了。
//
// **顺序是语义的一部分**：同时命中多条时返回最靠前的那条，而 UI 直接显示它。所以顺序按「最该让用户
// 先看见的排前面」定，不是按判断成本排。
export function resolveQueuedPromptDispatchBlockReason(
	input: QueuedTaskPromptDispatchEligibilityInput,
): QueuedTaskPromptDispatchBlockReason | null {
	const { headEntry, sessionSummary, hasPendingProgrammaticTaskChatInputDelivery } = input;

	// -1. 由另一个此刻活着的实例托管。同机多实例共享 workspaces 根，只有托管者该发它——否则两个实例会各自
	// 在自己的会话边沿上认领同一条队列。托管者死了之后，调用方（dispatcher）会先盖章并接管托管权，这条
	// 就转成下面的门控 0；所以走到这里时「托管者不是我」恒等于「托管者还活着」。旧条目没有托管者，不设防。
	const custodianRuntimeProcessInstanceId = headEntry.custodianRuntimeProcessInstanceId ?? null;
	if (
		input.thisRuntimeProcessInstanceId != null &&
		custodianRuntimeProcessInstanceId !== null &&
		custodianRuntimeProcessInstanceId !== input.thisRuntimeProcessInstanceId
	) {
		return "queued_under_another_live_kanban_runtime_instance";
	}

	// 0. kanban 重启跨过来、人还没在重启后看见过。
	//
	// 排在最前有两个理由：① 重启后此刻 agent 必然不在生成（会话刚被水合成 idle），后面几条本来也都
	// 不会命中，排后面只是让它永远显示不出来；② 它是**唯一一条不会自行解除**的阻塞——其余都随会话
	// 状态自然变化，只有这条要人动手，所以必须第一时间显示成可操作项而不是被别的原因盖住。
	if (
		headEntry.survivedRuntimeRestartAtEpochMs !== null &&
		headEntry.humanReconfirmedAfterRuntimeRestartAtEpochMs === null
	) {
		return "awaiting_human_reconfirmation_after_runtime_restart";
	}

	// 会话条目都没有 ⇒ 没有「下一轮」可等，但**保持 queued 不判失败**：用户要的就是下一轮，而一个
	// 此刻不在跑的会话随时可能被续跑起来（聚焦卡片就会）。
	if (sessionSummary == null) {
		return "session_not_live";
	}
	if (sessionSummary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover) {
		return "task_main_session_handover_awaiting_user";
	}
	const facets = resolveSessionFacets(sessionSummary);

	// 1. agent 还在干活。这是最常见的一条，也是整个特性存在的理由。
	if (isAgentSessionCurrentlyGeneratingResponse(facets, sessionSummary)) {
		return "agent_still_generating";
	}

	// 2. park。**必须单列**：上一条谓词对 parked 恒返回 false（park 走独立轨道），而
	// submitTaskChatInputWhenReady 一进门就 unparkTaskSession——不在这里拦下，队列就会把 RVF 派发的
	// 后台等待直接 unpark 掉，主 agent 于是在子任务还没回来的时候被推着往下跑。
	if (isParkedAwaitingDispatchedBackgroundWork(sessionSummary)) {
		return "session_parked_awaiting_dispatched_background_work";
	}

	// 3. agent 停在模态待答（问问题 / 等计划评审 / 等授权 / 等补充输入）。
	// **review 绝不在这个集合里**——它恰是本特性的目标态，判据的唯一真相在 session-activity.ts。
	if (isAgentAwaitingModalUserDecision(facets)) {
		return "agent_awaiting_modal_user_decision";
	}

	// 4. 会话不在跑（liveness !== "live"）。runtime 重启后水合出来的历史会话全部落在这里。
	if (!hasReclaimableAgentSessionRuntime(facets)) {
		return "session_not_live";
	}

	// 5. 恢复守卫武装中。`--continue` 只重建上下文，不等于有人让它继续。
	// 判据必须是完整的两态谓词——恢复重放自己那次 Stop hook 落在第二个状态上，只比第一个值等于不设防。
	// 读**声明态**、不读带 30 分钟兜底过期的那个：兜底过期是为「别永久吞掉 harness 唤醒通知」设的，对排队
	// 投递而言放行 = 用户从没继续过对话，几小时前排的话就发进了刚恢复的会话（理由详见 session-activity.ts）。
	if (isRestorationContinuationGuardDeclaredArmedIgnoringMaximumArmedDuration(sessionSummary)) {
		return "session_restoring_conversation";
	}

	// 6. PTY 单飞槽被占。这是防「队列与 RVF 投递对撞」的门；它有 TOCTOU 窗口，故失败路由里
	// superseded_by_later_delivery 被归入**可重试**——两个方向都不静默丢消息。
	if (hasPendingProgrammaticTaskChatInputDelivery) {
		return "another_programmatic_delivery_in_flight";
	}

	// 7. 跨过重启、人已确认，但确认之后 agent 还没停下过一次。用户要的是「提醒我确认，然后在**下一次** stop
	// hook 注入」。确认那一刻 agent 往往已经闲着（Cline SDK / ACP 没有恢复守卫，停止事件是重启前留下的），
	// 不设这道门，确认一落地队列就会在那个旧停止事件上立刻发出——5 秒高亮还没播完，prompt 已经发了。
	// 排在最后：确认之后 agent 在干活 / 在问问题 / 在恢复时，那些更具体的原因更值得显示。
	const humanReconfirmedAfterRuntimeRestartAtEpochMs = headEntry.humanReconfirmedAfterRuntimeRestartAtEpochMs;
	if (headEntry.survivedRuntimeRestartAtEpochMs !== null && humanReconfirmedAfterRuntimeRestartAtEpochMs !== null) {
		const stoppedAt = resolveLastAgentConversationUserHandoffObservation(sessionSummary)?.observedAtMs ?? null;
		if (stoppedAt === null || stoppedAt <= humanReconfirmedAfterRuntimeRestartAtEpochMs) {
			return "awaiting_first_agent_turn_end_after_restart_reconfirmation";
		}
	}

	return null;
}

// 真实交棒的事件身份跨进程恢复保持不变；当前活体的待命期限不构成新的出队边沿。
export function buildAgentResponseGenerationStopEventIdentity(
	summary: RuntimeTaskSessionSummary | null | undefined,
): string | null {
	if (
		!summary ||
		resolveSessionFacets(summary).turnOwner !== "user" ||
		isParkedAwaitingDispatchedBackgroundWork(summary)
	)
		return null;
	const handoff = resolveLastAgentConversationUserHandoffObservation(summary);
	return handoff ? `${handoff.turnSequence}:${handoff.observedAtMs}` : null;
}

// 「这一轮」的键。dispatcher 用它实现「一轮至多交出一次」：一次交付无论结果如何都记下当时的轮次键，
// 同一轮内不再出队，直到 agent 开始新的一轮。
//
// 双判据与回收侧的陈旧定时器防护同源：incarnation 分辨「还是不是同一个活体」，turnSequence 分辨
// 「同一活体内是不是同一轮」。返回 null = 这份 summary 还不构成一个可去重的身份（缺 incarnation），
// 调用方应当跳过而不是编一个键出来。
export function buildAgentResponseGenerationStopEdgeDedupeKey(
	summary: RuntimeTaskSessionSummary | null | undefined,
): string | null {
	if (summary?.runtimeSessionIncarnationId == null) {
		return null;
	}
	return `${summary.runtimeSessionIncarnationId}:${summary.agentResponseGenerationTurnSequence ?? 0}`;
}

// 认领之后、真正 send 之前的陈旧复核：这条认领说的还是不是「当时那个活体的那一轮」。
// 任一不符即释放认领回 queued 并放弃本次（**不计一次尝试**——什么都没发生过，不该消耗重试预算）。
export function isQueuedTaskPromptDeliveryClaimStillCurrentForSession(
	entry: QueuedTaskPromptDeliveryEntry,
	summary: RuntimeTaskSessionSummary | null | undefined,
): boolean {
	if (summary == null || entry.claimedForSessionIncarnationId === null) {
		return false;
	}
	if (summary.runtimeSessionIncarnationId !== entry.claimedForSessionIncarnationId) {
		return false;
	}
	return (summary.agentResponseGenerationTurnSequence ?? 0) === (entry.claimedAtTurnSequence ?? 0);
}
