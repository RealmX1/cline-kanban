// 「主对话最后一次向模型发出请求」观测的唯一合并 reducer（纯函数、零运行时依赖）。
//
// 字段语义见 api-contract.ts 的 runtimeMainAgentConversationModelRequestDispatchEvidenceKindSchema 注释。
// 规则比「对话上次推进」那个 reducer 简单得多：这里只有一类证据（hook ingest 时刻），没有滞后的
// 高置信来源需要纠偏，所以**只单调前进、拒收非法与未来时刻**，没有任何往回拉的授权。
//
// 「哪些 hook 事件该写」不在这里判定（见 main-agent-conversation-model-request-dispatch-hook-event-classification.ts）；
// 本模块只保证无论哪个写点、以什么顺序到达，存下来的值都不会倒退、不会跑到未来。

import type { RuntimeLastMainAgentConversationModelRequestDispatchObservation } from "./api-contract.js";
import { LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS } from "./last-conversation-progress-observation.js";

export function mergeLastMainAgentConversationModelRequestDispatchObservation(
	previous: RuntimeLastMainAgentConversationModelRequestDispatchObservation | null | undefined,
	incoming: RuntimeLastMainAgentConversationModelRequestDispatchObservation,
	options: { nowMs: number },
): RuntimeLastMainAgentConversationModelRequestDispatchObservation | null {
	if (!Number.isFinite(incoming.observedAtMs) || incoming.observedAtMs <= 0) {
		return previous ?? null;
	}
	if (incoming.observedAtMs > options.nowMs + LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS) {
		return previous ?? null;
	}
	// 容忍窗口内的小幅超前按时钟偏斜处理，夹到 nowMs——绝不让「未来时刻」流进倒计时。
	const normalizedIncoming =
		incoming.observedAtMs > options.nowMs ? { ...incoming, observedAtMs: options.nowMs } : incoming;
	if (previous == null || normalizedIncoming.observedAtMs > previous.observedAtMs) {
		return normalizedIncoming;
	}
	return previous;
}
