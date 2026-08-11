// 「对话上次推进」观测的唯一合并 reducer（纯函数、零运行时依赖，可被后端 / 前端 / 探针共享 import）。
//
// 字段语义、以及它与 lastSubstantiveOutputAt（「此刻在不在吐东西」）、agentResponseGenerationStopped
// （「本轮何时停止生成」）三者为何必须分开，见 api-contract.ts 的
// runtimeLastConversationProgressObservationSchema 注释。本模块只负责一件事：**多路证据汇成一个值时
// 该听谁的**。
//
// 设计取舍（这是整个修复的命门，改动前请先读完）：
//
//   1) **稳态一律单调前进（取 max），绝不因为「来了个更高置信的证据」就把值拉回去。**
//      理由：持久转录（最高置信）天然滞后——agent 正在生成、或正在等一条命令执行完时，JSONL 里还没有
//      这一轮的记录。若让高置信覆盖低置信，卡片就会在「hook 说刚推进过」与「转录说还停在上一轮」之间
//      来回跳。单调前进把这种滞后降级为「暂时不前进」，永远不会表现为「往回跳」。
//
//   2) **唯一的例外：允许持久转录把「猜错的」既有值往回拉一次。** 授权只有两个来源，范围都刻意
//      收得极窄——只有 persisted_agent_transcript 这一档证据能触发，别的场合一律只能前进：
//        a) 调用方明确声明这是 incarnation 边界的一次性 rebaseline；
//        b) 已存值本身就是低置信的 TUI 猜测，**且此刻不在 agent 回合中**。
//      (b) 的理由：会话重开时，旧对话会被重播进一个全新的 TUI，而 TUI 实质分类器的行签名记忆是空的，
//      整段旧内容会被判成「新产出」——这正是历史上卡片被刷成 now 的成因。此刻转录给出的是真相基线，
//      必须允许它把上一轮猜错的值拉回来。
//      而 (b) 里「不在 agent 回合中」这道门是**非要不可**的，缺了它纠偏就退化成来回拉扯：TUI 分类器
//      只在 agent 回合里写值（见 session-manager.ts flushPendingOutputAnalysis 的门控 ①），而转录恰恰
//      在同一段时间里天然滞后（agent 正在生成、或正在等命令执行完时 JSONL 里还没这一轮）。两者相遇的
//      稳态是：分类器把值推到 now → 一个探测周期后转录报回一个更旧的时刻、命中 (b) 把值拉回 → 分类器
//      再推到 now → 循环，药丸每个探测周期抖一次。加上这道门后，回合进行中的「更旧」一律按滞后处理
//      （只是不前进），回合交回用户后转录照旧能纠偏——纠偏能力只被推迟，不被取消。
//
//   3) **拒收未来时刻。** 时钟偏斜 / 转录里的坏时间戳一旦被采信，前端 formatCompactElapsedSince 的
//      `Math.max(0, …)` 会把它静默渲染成 `now`——又变成同一个 bug 的另一副面孔。宁可丢弃并告警。
//
//   4) **违反不变量一律归一化 + 告警，绝不 throw。** 这是纯展示字段：让一条坏观测掀翻整批 summary
//      的广播或持久化，代价远大于少显示一颗药丸。

import type {
	RuntimeLastConversationProgressEvidenceKind,
	RuntimeLastConversationProgressObservation,
} from "./api-contract.js";

// 证据置信度偏序（数值越大越可信）。**只用于两处**：同刻并列时挑更可信的标签、以及判定谁有 rebaseline
// 授权。刻意不用它决定「谁覆盖谁」的时间值——那是上面第 1 条明确否决的做法。
const EVIDENCE_KIND_CONFIDENCE_RANK: Record<RuntimeLastConversationProgressEvidenceKind, number> = {
	persisted_agent_transcript: 3,
	agent_lifecycle_hook_event: 2,
	structured_agent_session_event: 2,
	terminal_output_heuristic_classification: 1,
};

// 唯一被授权做 rebaseline（往回拉）的证据档位（见模块注释第 2 条）。
const REBASELINE_AUTHORITATIVE_EVIDENCE_KIND: RuntimeLastConversationProgressEvidenceKind =
	"persisted_agent_transcript";

// 时钟偏斜容忍窗口：incoming 比 nowMs 还新出这么多以内视为偏斜、按 nowMs 采信；超出即丢弃。
// 取 1 分钟——转录时间戳来自本机同一时钟，正常偏差在毫秒级；1 分钟只为吸收 NTP 跳变与批处理迟到。
export const LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS = 60_000;

// 低置信来源在 UI 上以 `~` 前缀降级展示（「大约」）。判据集中在此，避免前端各处手写枚举比对。
export function isLowConfidenceLastConversationProgressEvidence(
	evidenceKind: RuntimeLastConversationProgressEvidenceKind,
): boolean {
	return EVIDENCE_KIND_CONFIDENCE_RANK[evidenceKind] <= 1;
}

export type LastConversationProgressObservationRejectionReason =
	// observedAtMs 不是有限正数（NaN / Infinity / <= 0）。
	| "non_finite_or_non_positive_timestamp"
	// observedAtMs 超出 nowMs + 容忍窗口：坏时钟或坏解析，采信它会渲染成假的 `now`。
	| "implausible_future_timestamp";

export interface MergeLastConversationProgressObservationOptions {
	nowMs: number;
	// 仅在「会话 incarnation 刚刚变更」且 incoming 来自持久转录时置 true（见模块注释第 2 条 a）。
	// 调用方负责判定 incarnation 是否变更——本模块不持有任何会话状态。
	allowRebaselineToEarlierObservation?: boolean;
	// 本次合并发生时，这个会话是否正处在 agent 回合中（球在 agent 手上）。**唯一用途**是关掉模块注释
	// 第 2 条 (b) 那条低置信纠偏授权：回合进行中转录天然滞后，此刻的「更旧」不是真相而是滞后。
	// 缺省 false（＝不在回合中）是刻意的 fail-open——调用方忘了传，最坏结果只是纠偏照旧生效（回到本
	// 字段引入前的行为），而不是静默丢掉纠偏能力；后者才是本模块赔不起的那一侧。
	isAgentResponseGenerationTurnInProgress?: boolean;
	futureObservationToleranceMs?: number;
	// 归一化 / 丢弃时的告警回调（结构化日志）。不提供即静默丢弃——本模块绝不 throw。
	onRejectedObservation?: (rejection: {
		reason: LastConversationProgressObservationRejectionReason;
		observation: RuntimeLastConversationProgressObservation;
		nowMs: number;
	}) => void;
}

// 多路证据汇成一个值的唯一入口。返回**新的应存值**（可能就是 previous 原对象）。
export function mergeLastConversationProgressObservation(
	previous: RuntimeLastConversationProgressObservation | null | undefined,
	incoming: RuntimeLastConversationProgressObservation,
	options: MergeLastConversationProgressObservationOptions,
): RuntimeLastConversationProgressObservation | null {
	const normalizedIncoming = normalizeIncomingObservation(incoming, options);
	if (normalizedIncoming === null) {
		return previous ?? null;
	}
	if (previous == null) {
		return normalizedIncoming;
	}

	if (
		normalizedIncoming.evidenceKind === REBASELINE_AUTHORITATIVE_EVIDENCE_KIND &&
		(options.allowRebaselineToEarlierObservation === true ||
			isTranscriptAuthorizedToCorrectLowConfidenceGuess(previous, options))
	) {
		// 纠偏（唯一允许往回走的路径），两种授权来源见模块注释第 2 条。
		// 这里同样精确地**不**踩另一个坑：hook / 结构化会话事件属高置信，转录相对它们天然滞后
		// （agent 正在生成、或正在等命令执行完时 JSONL 里还没这一轮），若允许转录回拉它们，卡片就会在
		// 两者间来回跳——所以对高置信已存值仍只走下面的单调取 max。
		return normalizedIncoming;
	}

	if (normalizedIncoming.observedAtMs > previous.observedAtMs) {
		return normalizedIncoming;
	}
	if (
		normalizedIncoming.observedAtMs === previous.observedAtMs &&
		EVIDENCE_KIND_CONFIDENCE_RANK[normalizedIncoming.evidenceKind] >
			EVIDENCE_KIND_CONFIDENCE_RANK[previous.evidenceKind]
	) {
		// 同一时刻被更可信的证据复述：时间不动，只把标签升级（UI 据此摘掉 `~`）。
		return { ...previous, evidenceKind: normalizedIncoming.evidenceKind };
	}
	return previous;
}

// 模块注释第 2 条 (b) 的授权判定：**已存值本身就是低置信的 TUI 猜测、且此刻不在 agent 回合中**时，
// 持久转录无需任何外部授权即可把它拉回真相。
//
// 两个条件缺一不可，各自挡住一类故障：
//   - 「已存值低置信」挡住「转录回拉 hook / 结构化事件」——那两档不会被重播刷错，回拉它们纯属倒退；
//   - 「不在 agent 回合中」挡住「回合进行中转录与 TUI 分类器来回拉扯」——回合里转录必然滞后于分类器，
//     此时的「更旧」是滞后不是真相（详见模块注释第 2 条）。
function isTranscriptAuthorizedToCorrectLowConfidenceGuess(
	previous: RuntimeLastConversationProgressObservation,
	options: MergeLastConversationProgressObservationOptions,
): boolean {
	if (!isLowConfidenceLastConversationProgressEvidence(previous.evidenceKind)) {
		return false;
	}
	return options.isAgentResponseGenerationTurnInProgress !== true;
}

// 校验 + 归一化。返回 null 表示这条观测应被整条丢弃。
function normalizeIncomingObservation(
	incoming: RuntimeLastConversationProgressObservation,
	options: MergeLastConversationProgressObservationOptions,
): RuntimeLastConversationProgressObservation | null {
	if (!Number.isFinite(incoming.observedAtMs) || incoming.observedAtMs <= 0) {
		options.onRejectedObservation?.({
			reason: "non_finite_or_non_positive_timestamp",
			observation: incoming,
			nowMs: options.nowMs,
		});
		return null;
	}
	const toleranceMs =
		options.futureObservationToleranceMs ?? LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS;
	if (incoming.observedAtMs > options.nowMs + toleranceMs) {
		options.onRejectedObservation?.({
			reason: "implausible_future_timestamp",
			observation: incoming,
			nowMs: options.nowMs,
		});
		return null;
	}
	if (incoming.observedAtMs > options.nowMs) {
		// 容忍窗口内的小幅超前：判为时钟偏斜，夹到 nowMs——绝不让「未来时刻」流进前端。
		return { ...incoming, observedAtMs: options.nowMs };
	}
	return incoming;
}
