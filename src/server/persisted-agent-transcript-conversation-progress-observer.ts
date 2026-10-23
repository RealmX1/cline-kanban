// summary 流驱动的精确原生转录纠偏：按 workspace＋会话联合计账，保留单飞、冷却、
// 代次/身份变化优先、公平调度和全局并发上限。异步返回后复核当前身份，旧活体结果不得写进新会话。
// 此观察器只补录历史 assistant 输出；实时输入接受与工具/压缩活动由 native-agent-conversation-activity-observer 处理。

import {
	probePersistedAgentTranscriptLastConversationProgress,
	supportsPersistedAgentTranscriptConversationProgressProbe,
} from "../agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";

// 历史纠偏最多每 30s 一次；精确目标文件的 stat 与签名缓存避免重复解析。实时接受不走这条慢路径。
export const PERSISTED_AGENT_TRANSCRIPT_PROBE_COOLDOWN_MS = 30_000;

// 闸门④：同时在途的探测数上限。取 4 的理由不是「怕慢」，而是 Node 的 libuv 线程池默认就是 4——
// 超出这个数的并发 fs 调用只是排在同一个池子后面，买不到任何吞吐，却把待决 promise、fd 压力与 GC
// 负担按任务数线性放大。压到 4 之后，瞬时 fs 调用量的上界从「任务数 × 文件数」变成「4 × 文件数」。
export const MAX_CONCURRENT_PERSISTED_AGENT_TRANSCRIPT_PROBES = 4;

// 优先车道连续发车多少次后必须让出一个名额给常规车道。
// 为什么需要这条：换活体的纠偏走优先车道（见下面 resolveProbeSchedulingLane），而「多个 project 的
// 会话在同一段时间里接连重开」是完全现实的形状——纯优先级会让优先车道长期非空，把水合回填永久压在
// 队尾。而回填对「已被回收 / 停在等人审查、不会再产出任何 summary」的任务是**一辈子仅有的一次**探测
// 机会，饿死等于那些卡片永远没有推进值。取 3 ⇒ 常规车道至少能拿到 1/4 的发车配额。
export const IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE = 3;

// 优先车道只留给「换活体」这一种情形（低置信值刚被重播刷错、纠偏最要紧的那一刻）；其余一律常规车道，
// 水合回填与活跃任务的首探在常规车道里按 FIFO 排队，谁也不越过谁。
type TranscriptProbeSchedulingLane = "incarnation_change_immediate" | "regular";

interface WorkspaceScopedTaskProbeState {
	latestSummary: RuntimeTaskSessionSummary;
	lastProbedNativeConversationIdentityKey: string;
	// 记的是**入队**时刻而非真正开始读盘的时刻：闸门③要防的是「同一任务被 summary 流反复触发」，
	// 该从触发那一刻起算；用实际起跑时刻反而会让排队时间白白延长冷却窗口。
	lastProbeScheduledAtMs: number;
	// 上次探测时这个任务处在哪个活体。变了就立刻重探，不等冷却。
	lastProbedRuntimeSessionIncarnationId: string | null;
	// 「已入队或在途」——闸门④把发车推迟到有名额时，闸门②的去重必须从入队那一刻就生效，
	// 否则排队期间涌进来的 summary 会把同一个任务重复塞进队列，限流就只是把风暴推迟而已。
	isProbeQueuedOrInFlight: boolean;
}

interface QueuedTranscriptProbe {
	probeStateKey: string;
	workspaceId: string;
	taskId: string;
	summary: RuntimeTaskSessionSummary;
	manager: TerminalSessionManager;
	probeState: WorkspaceScopedTaskProbeState;
}

// 账本键：workspace 前缀 + board-local taskId。与同目录 agent-session-response-generation-stop-observer 的
// observationKey 同构——两者都是「跨 workspace 共享的单例观察器」，也都由 hub 的 disposeWorkspace 统一退场。
function buildWorkspaceScopedTaskProbeStateKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}::${taskId}`;
}

function nativeConversationIdentityKey(summary: RuntimeTaskSessionSummary): string {
	const identity = summary.agentNativeConversationSessionIdentity;
	return JSON.stringify([identity?.sourceAgentId, identity?.nativeSessionId, identity?.transcriptPath]);
}

function sameNativeConversationIncarnation(
	first: RuntimeTaskSessionSummary,
	latest: RuntimeTaskSessionSummary,
): boolean {
	return (
		first.startedAt === latest.startedAt &&
		first.runtimeSessionIncarnationId === latest.runtimeSessionIncarnationId &&
		nativeConversationIdentityKey(first) === nativeConversationIdentityKey(latest)
	);
}

export interface PersistedAgentTranscriptConversationProgressObserver {
	observeTaskSessionSummary(
		workspaceId: string,
		summary: RuntimeTaskSessionSummary,
		manager: TerminalSessionManager,
	): void;
	// 与 hub 的 disposeWorkspace 对位：project 被移除后，该 workspace 的探测账本必须一并退场，
	// 否则条目会随「加了又删的 project」永久驻留在这个进程级单例里。
	forgetWorkspace(workspaceId: string): void;
	dispose(): void;
}

export interface CreatePersistedAgentTranscriptConversationProgressObserverOptions {
	nowMs?: () => number;
	cooldownMs?: number;
	// 注入探测实现，供测试用假转录驱动而无需铺真实文件系统。
	probe?: typeof probePersistedAgentTranscriptLastConversationProgress;
	// 调低上限供测试把「让名额给谁」这件事变成可逐次观察的序列；生产不传。
	maxConcurrentProbes?: number;
	// 失败上下文必须带 workspaceId：taskId 是 board-local 的，单独出现在告警里指认不到具体是哪个任务。
	onProbeFailed?: (error: unknown, context: { workspaceId: string; taskId: string }) => void;
}

export function createPersistedAgentTranscriptConversationProgressObserver(
	options: CreatePersistedAgentTranscriptConversationProgressObserverOptions = {},
): PersistedAgentTranscriptConversationProgressObserver {
	const nowMs = options.nowMs ?? (() => Date.now());
	const cooldownMs = options.cooldownMs ?? PERSISTED_AGENT_TRANSCRIPT_PROBE_COOLDOWN_MS;
	const probe = options.probe ?? probePersistedAgentTranscriptLastConversationProgress;
	const maxConcurrentProbes = Math.max(
		1,
		options.maxConcurrentProbes ?? MAX_CONCURRENT_PERSISTED_AGENT_TRANSCRIPT_PROBES,
	);
	const probeStateByWorkspaceScopedTaskProbeStateKey = new Map<string, WorkspaceScopedTaskProbeState>();
	const immediateLaneProbeQueue: QueuedTranscriptProbe[] = [];
	const regularLaneProbeQueue: QueuedTranscriptProbe[] = [];
	let inFlightProbeCount = 0;
	let consecutiveImmediateLaneDispatchCount = 0;
	let disposed = false;

	// 返回 null = 这次不探；否则给出该走哪条车道。
	function resolveProbeSchedulingLane(
		probeStateKey: string,
		summary: RuntimeTaskSessionSummary,
		at: number,
	): TranscriptProbeSchedulingLane | null {
		const state = probeStateByWorkspaceScopedTaskProbeStateKey.get(probeStateKey);
		if (!state) {
			return "regular";
		}
		if (state.isProbeQueuedOrInFlight) {
			return null;
		}
		const incarnationId = summary.runtimeSessionIncarnationId ?? null;
		if (
			incarnationId !== state.lastProbedRuntimeSessionIncarnationId ||
			nativeConversationIdentityKey(summary) !== state.lastProbedNativeConversationIdentityKey
		) {
			// 换活体 = 会话被重开 / 进程重启，正是低置信值最可能被重播刷错的一刻，绕过冷却立刻纠偏。
			// 走优先车道：限流让出的下一个名额归它，而不是排在几百条水合回填后面——那会把「及时纠偏」
			// 这条语义拖成分钟级，等于闸门④把闸门③的例外条款抵消掉。
			return "incarnation_change_immediate";
		}
		return at - state.lastProbeScheduledAtMs >= cooldownMs ? "regular" : null;
	}

	// 谁上车：优先车道优先，但连续发够配额后必须让一个名额给常规车道（见上面那条常量的理由）。
	function takeNextQueuedProbe(): QueuedTranscriptProbe | undefined {
		if (immediateLaneProbeQueue.length === 0) {
			consecutiveImmediateLaneDispatchCount = 0;
			return regularLaneProbeQueue.shift();
		}
		if (
			regularLaneProbeQueue.length > 0 &&
			consecutiveImmediateLaneDispatchCount >= IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE
		) {
			consecutiveImmediateLaneDispatchCount = 0;
			return regularLaneProbeQueue.shift();
		}
		consecutiveImmediateLaneDispatchCount += 1;
		return immediateLaneProbeQueue.shift();
	}

	function dispatchQueuedProbesWithinConcurrencyLimit(): void {
		while (inFlightProbeCount < maxConcurrentProbes) {
			const queuedProbe = takeNextQueuedProbe();
			if (!queuedProbe) {
				return;
			}
			inFlightProbeCount += 1;
			startQueuedProbe(queuedProbe);
		}
	}

	function startQueuedProbe(queuedProbe: QueuedTranscriptProbe): void {
		const { probeStateKey, workspaceId, taskId, summary, manager, probeState } = queuedProbe;
		void probe({
			agentId: summary.agentId,
			workspacePath: summary.workspacePath,
			agentNativeConversationSessionIdentity: summary.agentNativeConversationSessionIdentity,
		})
			.then((observation) => {
				// 探测返回 null 的含义是「这次问不出结论」，绝不是「对话没推进过」——保持原值即可。
				if (observation === null || disposed) {
					return;
				}
				// 账本条目在探测在途期间消失，只可能是 forgetWorkspace 把这个 workspace 清了 = project 已被
				// 移除、管理器正在拆。此刻写回等于往一个不再推流的管理器里塞值，与 dispose 后不写回同理。
				if (probeStateByWorkspaceScopedTaskProbeStateKey.get(probeStateKey) !== probeState) return;
				const latest =
					typeof manager.getSummary === "function" ? manager.getSummary(taskId) : probeState.latestSummary;
				if (!latest || !sameNativeConversationIncarnation(summary, latest)) return;
				manager.recordPersistedAgentTranscriptConversationProgress(taskId, observation);
			})
			.catch((error: unknown) => {
				// 读盘失败对展示字段而言是可忽略事件：下次 summary 到达时冷却已过，自然重试。
				options.onProbeFailed?.(error, { workspaceId, taskId });
			})
			.finally(() => {
				inFlightProbeCount -= 1;
				const state = probeStateByWorkspaceScopedTaskProbeStateKey.get(probeStateKey);
				if (state === probeState) {
					state.isProbeQueuedOrInFlight = false;
					if (!sameNativeConversationIncarnation(summary, state.latestSummary)) {
						observer.observeTaskSessionSummary(workspaceId, state.latestSummary, manager);
					}
				}
				// 让出的名额立刻交给下一个排队者，队列因此是自驱的：入队时发一次车，每次落地再发一次。
				dispatchQueuedProbesWithinConcurrencyLimit();
			});
	}

	function removeQueuedProbesForWorkspace(workspaceId: string): void {
		for (const queue of [immediateLaneProbeQueue, regularLaneProbeQueue]) {
			for (let index = queue.length - 1; index >= 0; index -= 1) {
				if (queue[index]?.workspaceId === workspaceId) {
					queue.splice(index, 1);
				}
			}
		}
	}

	const observer: PersistedAgentTranscriptConversationProgressObserver = {
		observeTaskSessionSummary(workspaceId, summary, manager) {
			if (
				disposed ||
				!summary.agentNativeConversationSessionIdentity?.transcriptPath ||
				!supportsPersistedAgentTranscriptConversationProgressProbe(summary.agentId)
			) {
				return;
			}
			const at = nowMs();
			const taskId = summary.taskId;
			const probeStateKey = buildWorkspaceScopedTaskProbeStateKey(workspaceId, taskId);
			const previousState = probeStateByWorkspaceScopedTaskProbeStateKey.get(probeStateKey);
			if (previousState) previousState.latestSummary = summary;
			const lane = resolveProbeSchedulingLane(probeStateKey, summary, at);
			if (lane === null) {
				return;
			}
			const probeState: WorkspaceScopedTaskProbeState = {
				latestSummary: summary,
				lastProbedNativeConversationIdentityKey: nativeConversationIdentityKey(summary),
				lastProbeScheduledAtMs: at,
				lastProbedRuntimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
				isProbeQueuedOrInFlight: true,
			};
			probeStateByWorkspaceScopedTaskProbeStateKey.set(probeStateKey, probeState);
			const capturedSummary = {
				...summary,
				agentNativeConversationSessionIdentity: { ...summary.agentNativeConversationSessionIdentity },
			};
			const queuedProbe: QueuedTranscriptProbe = {
				probeStateKey,
				workspaceId,
				taskId,
				summary: capturedSummary,
				manager,
				probeState,
			};
			if (lane === "incarnation_change_immediate") {
				immediateLaneProbeQueue.push(queuedProbe);
			} else {
				regularLaneProbeQueue.push(queuedProbe);
			}
			dispatchQueuedProbesWithinConcurrencyLimit();
		},
		forgetWorkspace(workspaceId) {
			const probeStateKeyPrefix = buildWorkspaceScopedTaskProbeStateKey(workspaceId, "");
			for (const probeStateKey of probeStateByWorkspaceScopedTaskProbeStateKey.keys()) {
				if (probeStateKey.startsWith(probeStateKeyPrefix)) {
					probeStateByWorkspaceScopedTaskProbeStateKey.delete(probeStateKey);
				}
			}
			// 还没发车的排队条目一并丢弃：它们的写回目标管理器正在被拆，跑完也只会被上面那道「账本条目
			// 已消失就不写回」的守卫扔掉，白占名额还白读一趟盘。
			removeQueuedProbesForWorkspace(workspaceId);
		},
		dispose() {
			disposed = true;
			probeStateByWorkspaceScopedTaskProbeStateKey.clear();
			immediateLaneProbeQueue.length = 0;
			regularLaneProbeQueue.length = 0;
			consecutiveImmediateLaneDispatchCount = 0;
		},
	};
	return observer;
}
