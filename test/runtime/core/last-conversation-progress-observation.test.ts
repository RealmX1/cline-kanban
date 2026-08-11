// 「对话上次推进」观测合并 reducer 的不变量：稳态单调前进、incarnation 边界的转录 rebaseline、
// 未来时刻拒收 / 夹取、同刻标签升级。这四条各自对应一个真实故障模式，见被测模块的模块注释。
import { describe, expect, it, vi } from "vitest";

import type { RuntimeLastConversationProgressObservation } from "../../../src/core/api-contract";
import {
	isLowConfidenceLastConversationProgressEvidence,
	LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS,
	type MergeLastConversationProgressObservationOptions,
	mergeLastConversationProgressObservation,
} from "../../../src/core/last-conversation-progress-observation";

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60_000;
// 转录探针的冷却周期（src/server/persisted-agent-transcript-conversation-progress-observer.ts），
// 振荡序列按它推进时间轴，好让「每个探测周期抖一次」这件事在用例里是照着现实节拍复现的。
const TRANSCRIPT_PROBE_COOLDOWN_MS = 30_000;

function observation(
	observedAtMs: number,
	evidenceKind: RuntimeLastConversationProgressObservation["evidenceKind"],
): RuntimeLastConversationProgressObservation {
	return { observedAtMs, evidenceKind };
}

// 已有既存值时 merge 不可能返回 null（坏 incoming 最多退回 previous），用它把返回类型收窄，
// 免得振荡序列每一步都要处理一个不可能出现的 null 分支。
function mergeExpectingObservation(
	previous: RuntimeLastConversationProgressObservation,
	incoming: RuntimeLastConversationProgressObservation,
	options: MergeLastConversationProgressObservationOptions,
): RuntimeLastConversationProgressObservation {
	const merged = mergeLastConversationProgressObservation(previous, incoming, options);
	if (merged === null) {
		throw new Error("既存值非空时 merge 绝不应返回 null");
	}
	return merged;
}

describe("对话推进观测 · 稳态单调前进", () => {
	it("无既有值时直接采信 incoming", () => {
		const merged = mergeLastConversationProgressObservation(
			null,
			observation(NOW - HOUR_MS, "agent_lifecycle_hook_event"),
			{ nowMs: NOW },
		);
		expect(merged).toEqual(observation(NOW - HOUR_MS, "agent_lifecycle_hook_event"));
	});

	it("更新的 incoming 前进，无论证据档位高低", () => {
		const previous = observation(NOW - 2 * HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(NOW - HOUR_MS, "terminal_output_heuristic_classification"),
			{ nowMs: NOW },
		);
		expect(merged).toEqual(observation(NOW - HOUR_MS, "terminal_output_heuristic_classification"));
	});

	it("更高置信但更旧的 incoming 不得把值拉回去（转录滞后于生成中的这一轮）", () => {
		// 这正是「agent 正在生成 / 正在等命令执行完，JSONL 还没落这一轮」的稳态：
		// 转录说停在 2 小时前，hook 说 1 分钟前刚推进过——必须保留 hook 的前进，否则卡片来回跳。
		const previous = observation(NOW - 60_000, "agent_lifecycle_hook_event");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(NOW - 2 * HOUR_MS, "persisted_agent_transcript"),
			{ nowMs: NOW },
		);
		expect(merged).toEqual(previous);
	});

	it("同刻被更可信证据复述：时间不动，仅升级标签", () => {
		const previous = observation(NOW - HOUR_MS, "terminal_output_heuristic_classification");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(NOW - HOUR_MS, "persisted_agent_transcript"),
			{ nowMs: NOW },
		);
		expect(merged).toEqual(observation(NOW - HOUR_MS, "persisted_agent_transcript"));
	});

	it("同刻被更低置信证据复述：原样保留，不降级标签", () => {
		const previous = observation(NOW - HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(NOW - HOUR_MS, "terminal_output_heuristic_classification"),
			{ nowMs: NOW },
		);
		expect(merged).toEqual(previous);
	});
});

describe("对话推进观测 · incarnation 边界 rebaseline", () => {
	it("重开会话时，持久转录可把上一轮 TUI 猜错的值拉回真相", () => {
		// 复现生产样本 ce120：卡片被刷成「刚刚」，转录里最后一条 agent 产出其实在 7 天前。
		const bogusFromReplay = observation(NOW - 60_000, "terminal_output_heuristic_classification");
		const merged = mergeLastConversationProgressObservation(
			bogusFromReplay,
			observation(NOW - 7 * 24 * HOUR_MS, "persisted_agent_transcript"),
			{ nowMs: NOW, allowRebaselineToEarlierObservation: true },
		);
		expect(merged).toEqual(observation(NOW - 7 * 24 * HOUR_MS, "persisted_agent_transcript"));
	});

	it("rebaseline 授权只对持久转录生效：hook / TUI 证据即便在边界上也只能前进", () => {
		const previous = observation(NOW - 60_000, "persisted_agent_transcript");
		for (const evidenceKind of [
			"agent_lifecycle_hook_event",
			"structured_agent_session_event",
			"terminal_output_heuristic_classification",
		] as const) {
			const merged = mergeLastConversationProgressObservation(
				previous,
				observation(NOW - 7 * 24 * HOUR_MS, evidenceKind),
				{ nowMs: NOW, allowRebaselineToEarlierObservation: true },
			);
			expect(merged, evidenceKind).toEqual(previous);
		}
	});

	// 无需任何外部状态的第二条纠偏授权：**已存值本身就是低置信的 TUI 猜测、且此刻不在 agent 回合中**时，
	// 转录可以直接把它拉回去。这正是本 bug 的成因形状——会话重开、旧对话被重播进新 TUI、行签名记忆是空的，
	// 整段旧内容被判成「新产出」，于是留下一个被刷到「刚刚」的 terminal_output_heuristic_classification 值。
	// 有了这条，纠偏不再依赖调用方「记得」在 incarnation 边界传 allowRebaselineToEarlierObservation。
	it("已存值是低置信 TUI 猜测时，转录无需额外授权即可纠偏（把被重播刷到「刚刚」的值拉回真相）", () => {
		const replayInflatedGuess = observation(NOW - 60_000, "terminal_output_heuristic_classification");
		const transcriptTruth = observation(NOW - 7 * 24 * HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(replayInflatedGuess, transcriptTruth, { nowMs: NOW });
		expect(merged).toEqual(transcriptTruth);
	});

	// 对位保护：高置信已存值绝不被转录回拉。转录相对 hook / 结构化事件天然滞后（agent 正在生成、
	// 或正在等一条命令执行完时 JSONL 里还没这一轮），允许回拉会让卡片在两者之间来回跳。
	it.each(["agent_lifecycle_hook_event", "structured_agent_session_event", "persisted_agent_transcript"] as const)(
		"已存值是 %s（非低置信）时，更早的转录只能被忽略，绝不回拉",
		(previousEvidenceKind) => {
			const previous = observation(NOW - 60_000, previousEvidenceKind);
			const merged = mergeLastConversationProgressObservation(
				previous,
				observation(NOW - 7 * 24 * HOUR_MS, "persisted_agent_transcript"),
				{ nowMs: NOW },
			);
			expect(merged).toEqual(previous);
		},
	);
});

describe("对话推进观测 · agent 回合进行中不得被转录回拉", () => {
	// 回归本条振荡缺陷：TUI 分类器只在 agent 回合里写低置信值，而转录在同一段时间里天然滞后
	// （JSONL 还没落这一轮）。若回合进行中仍允许「低置信已存值可被转录纠偏」，两者就会每个探测周期
	// 互相拉扯一次，卡片 Progress 药丸在 now 与更旧读数之间来回跳。
	it("「低置信推进 → 更旧转录 → 再低置信推进」交替多轮，值绝不回跳", () => {
		const inAgentTurn = { isAgentResponseGenerationTurnInProgress: true } as const;
		// 转录停在这一轮开始之前——回合进行中它就是这么滞后的，探针每次都报回同一个更旧的时刻。
		const laggingTranscript = observation(NOW - 20 * 60_000, "persisted_agent_transcript");
		let current = observation(NOW, "terminal_output_heuristic_classification");
		const observedSeries = [current.observedAtMs];

		for (let probeRound = 1; probeRound <= 4; probeRound += 1) {
			const probedAtMs = NOW + probeRound * TRANSCRIPT_PROBE_COOLDOWN_MS;
			current = mergeExpectingObservation(current, laggingTranscript, { nowMs: probedAtMs, ...inAgentTurn });
			observedSeries.push(current.observedAtMs);

			const classifiedAtMs = probedAtMs + 1_000;
			current = mergeExpectingObservation(
				current,
				observation(classifiedAtMs, "terminal_output_heuristic_classification"),
				{ nowMs: classifiedAtMs, ...inAgentTurn },
			);
			observedSeries.push(current.observedAtMs);
		}

		// 单调不减 ＝ 整条序列里没有任何一次回跳（有振荡时这里会出现 now → 更旧 → now 的锯齿）。
		expect(observedSeries).toEqual([...observedSeries].sort((left, right) => left - right));
		expect(current).toEqual(
			observation(NOW + 4 * TRANSCRIPT_PROBE_COOLDOWN_MS + 1_000, "terminal_output_heuristic_classification"),
		);
	});

	it("回合交回用户后，转录照旧能纠偏——纠偏能力只被推迟，不被取消", () => {
		const replayInflatedGuess = observation(NOW - 60_000, "terminal_output_heuristic_classification");
		const transcriptTruth = observation(NOW - 7 * 24 * HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(replayInflatedGuess, transcriptTruth, {
			nowMs: NOW,
			isAgentResponseGenerationTurnInProgress: false,
		});
		expect(merged).toEqual(transcriptTruth);
	});

	// incarnation 边界那条显式授权与本门无关：它由调用方为「会话刚重开」这一刻专门声明，
	// 不能被「此刻恰好在 agent 回合里」顺手吞掉（重播正是发生在回合里的）。
	it("incarnation 边界的显式 rebaseline 授权在回合进行中依然生效", () => {
		const replayInflatedGuess = observation(NOW - 60_000, "terminal_output_heuristic_classification");
		const transcriptTruth = observation(NOW - 7 * 24 * HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(replayInflatedGuess, transcriptTruth, {
			nowMs: NOW,
			allowRebaselineToEarlierObservation: true,
			isAgentResponseGenerationTurnInProgress: true,
		});
		expect(merged).toEqual(transcriptTruth);
	});

	it("回合进行中更新的转录仍照常前进（这道门只挡回拉，不挡前进）", () => {
		const previous = observation(NOW - 2 * HOUR_MS, "terminal_output_heuristic_classification");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(NOW - HOUR_MS, "persisted_agent_transcript"),
			{ nowMs: NOW, isAgentResponseGenerationTurnInProgress: true },
		);
		expect(merged).toEqual(observation(NOW - HOUR_MS, "persisted_agent_transcript"));
	});
});

describe("对话推进观测 · 坏时间戳", () => {
	it("容忍窗口内的小幅超前夹到 nowMs（时钟偏斜）", () => {
		const merged = mergeLastConversationProgressObservation(
			null,
			observation(NOW + 5_000, "persisted_agent_transcript"),
			{
				nowMs: NOW,
			},
		);
		expect(merged).toEqual(observation(NOW, "persisted_agent_transcript"));
	});

	it("超出容忍窗口的未来时刻整条丢弃并告警，保留既有值", () => {
		const onRejectedObservation = vi.fn();
		const previous = observation(NOW - HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(
				NOW + LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS + 1,
				"persisted_agent_transcript",
			),
			{ nowMs: NOW, onRejectedObservation },
		);
		expect(merged).toEqual(previous);
		expect(onRejectedObservation).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "implausible_future_timestamp" }),
		);
	});

	it("NaN / 0 / 负数一律丢弃并告警，绝不 throw", () => {
		const onRejectedObservation = vi.fn();
		for (const badTimestamp of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
			const merged = mergeLastConversationProgressObservation(
				null,
				observation(badTimestamp, "persisted_agent_transcript"),
				{ nowMs: NOW, onRejectedObservation },
			);
			expect(merged, String(badTimestamp)).toBeNull();
		}
		expect(onRejectedObservation).toHaveBeenCalledTimes(4);
	});

	it("坏观测在 rebaseline 授权下同样不得抹掉既有值", () => {
		const previous = observation(NOW - HOUR_MS, "persisted_agent_transcript");
		const merged = mergeLastConversationProgressObservation(
			previous,
			observation(Number.NaN, "persisted_agent_transcript"),
			{ nowMs: NOW, allowRebaselineToEarlierObservation: true },
		);
		expect(merged).toEqual(previous);
	});
});

describe("对话推进观测 · 证据置信度分档", () => {
	it("仅 TUI 启发式判为低置信（UI 据此加 `~` 前缀）", () => {
		expect(isLowConfidenceLastConversationProgressEvidence("terminal_output_heuristic_classification")).toBe(true);
		expect(isLowConfidenceLastConversationProgressEvidence("persisted_agent_transcript")).toBe(false);
		expect(isLowConfidenceLastConversationProgressEvidence("agent_lifecycle_hook_event")).toBe(false);
		expect(isLowConfidenceLastConversationProgressEvidence("structured_agent_session_event")).toBe(false);
	});
});
