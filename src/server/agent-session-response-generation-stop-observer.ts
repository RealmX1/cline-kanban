// 「agent 停止生成响应」的归一化边沿观察器：三种 session transport（PTY 终端 / 进程内 Cline SDK /
// ACP 子进程）的 summary 流在此汇成**同一个**领域事件，并把回收期限落进 durable 账本。
//
// 为什么放在 server 层而不是各 transport 内部：
//   - runtime-state-hub 已经同时订阅了三条 summary 流，是全仓唯一的跨 transport 汇聚点；
//   - 它的持久化发生在「0 客户端提前返回」之前，故本观察器天然与「有没有人在看」解耦——
//     浏览器标签关闭 / 项目切换 / 侧栏折叠都不会影响计时，这正是本机制的硬性要求。
//
// 本模块只做两件事：边沿检测（纯函数，可单测）+ 落库。不杀进程、不碰 UI、不发通知。

import { resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS,
	computeAgentSessionRuntimeReclamationEligibleAt,
	deriveAgentResponseGenerationStopSignalConfidence,
	hasReclaimableAgentSessionRuntime,
	isAgentSessionCurrentlyGeneratingResponse,
	isParkedAwaitingDispatchedBackgroundWork,
	PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS,
	resolveSessionFacets,
} from "../core/session-activity";
import {
	type RecordAgentSessionRetentionDeadlineInput,
	recordAgentSessionRetentionDeadline,
	supersedeAgentSessionRetentionDeadlinesForTask,
} from "../state/agent-session-reclamation-deadline-store";

// 「这条 summary 此刻应当持有一份回收期限吗」——即计时器该不该在跑。
// 三个条件同时满足才成立：
//   ① 不在生成响应（agent 回合 = 球在 agent 手上，一律不计时；park 是刻意的例外，走独立轨道）；
//   ② 还占着值得回收的运行时资源（liveness==="live"）——否则回收无事可做，落记录只是噪音；
//   ③ 有 agentId 与 incarnation id——没有它们就既判定不了 transport、也做不了陈旧定时器防护，
//      此时刻意不计时（fail-safe 方向：宁可漏回收，绝不误杀）。裸 shell 终端 agentId 为 null，
//      正好被这一条排除在外。
export function isAgentSessionRetentionDeadlineBearing(summary: RuntimeTaskSessionSummary): boolean {
	const facets = resolveSessionFacets(summary);
	if (isAgentSessionCurrentlyGeneratingResponse(facets, summary)) {
		return false;
	}
	if (!hasReclaimableAgentSessionRuntime(facets)) {
		return false;
	}
	return summary.agentId !== null && summary.runtimeSessionIncarnationId != null;
}

// 置信度判定已上提到 src/core/session-activity.ts——写侧（summary 里的 agentResponseGenerationStopped）
// 与回收侧（本模块落进期限账本）必须共用同一份判定，否则两处标签会各自漂移。此处仅转出，保持既有
// import 路径可用。
export { deriveAgentResponseGenerationStopSignalConfidence };

export type AgentSessionRetentionDeadlineTransition =
	| { kind: "none" }
	| { kind: "supersede_retention_deadlines" }
	| { kind: "start_retention_deadline"; input: Omit<RecordAgentSessionRetentionDeadlineInput, "recordedAt"> };

export interface DeriveAgentSessionRetentionDeadlineTransitionOptions {
	nowMs: number;
	gracePeriodMs?: number;
	parkDefaultMaxRetentionMs?: number;
}

// 纯边沿检测。只在**状态边沿**产出动作，绝不在每条 summary 上都动账本——agent 回合期间 summary
// 以 50ms 攒批的节奏刷新，逐条读写文件会把一个人类尺度的机制变成 IO 风暴。
export function deriveAgentSessionRetentionDeadlineTransition(
	previousSummary: RuntimeTaskSessionSummary | null,
	summary: RuntimeTaskSessionSummary,
	options: DeriveAgentSessionRetentionDeadlineTransitionOptions,
): AgentSessionRetentionDeadlineTransition {
	const isBearing = isAgentSessionRetentionDeadlineBearing(summary);
	const wasBearing = previousSummary !== null && isAgentSessionRetentionDeadlineBearing(previousSummary);

	if (!isBearing) {
		// 离开计时态（用户又发了一句 / agent 复生 / 进程退出 / unpark）：作废该 task 的全部 live 期限。
		// 首次观测到一个本就不计时的会话不需要动账本。
		return wasBearing ? { kind: "supersede_retention_deadlines" } : { kind: "none" };
	}

	if (wasBearing && previousSummary !== null && isSameRetentionIdentity(previousSummary, summary)) {
		// 仍停在同一个活体的同一轮：期限已经在跑，不重复落库。
		return { kind: "none" };
	}

	return { kind: "start_retention_deadline", input: buildRetentionDeadlineInput(summary, options) };
}

function isSameRetentionIdentity(a: RuntimeTaskSessionSummary, b: RuntimeTaskSessionSummary): boolean {
	return (
		a.runtimeSessionIncarnationId === b.runtimeSessionIncarnationId &&
		(a.agentResponseGenerationTurnSequence ?? 0) === (b.agentResponseGenerationTurnSequence ?? 0) &&
		isParkedAwaitingDispatchedBackgroundWork(a) === isParkedAwaitingDispatchedBackgroundWork(b)
	);
}

function buildRetentionDeadlineInput(
	summary: RuntimeTaskSessionSummary,
	options: DeriveAgentSessionRetentionDeadlineTransitionOptions,
): Omit<RecordAgentSessionRetentionDeadlineInput, "recordedAt"> {
	// isAgentSessionRetentionDeadlineBearing 已经保证了这两个字段非空。
	const agentId = summary.agentId as NonNullable<RuntimeTaskSessionSummary["agentId"]>;
	const runtimeSessionIncarnationId = summary.runtimeSessionIncarnationId as string;
	const shared = {
		taskId: summary.taskId,
		agentId,
		// 快照的是**这条会话当刻在用的通道**，不是该 agent 的默认通道：omp 可在 TUI ⇄ ACP 之间切换，
		// 按 agentId 派生会让回收走错分支（去杀一个不存在的 PTY / 放过一个还活着的 ACP 子进程）。
		sessionTransport: resolveRuntimeAgentSessionTransportFromSummary(summary),
		runtimeSessionIncarnationId,
		agentResponseGenerationTurnSequence: summary.agentResponseGenerationTurnSequence ?? 0,
	};

	const park = summary.awaitingDispatchedBackgroundWork;
	if (park != null) {
		// park 轨道：锚点是 park 置位时刻，期限走独立的兜底上限。maxRetentionUntilMs 显式为 null 表示
		// 调用方声明了「无期限」（合法的超长后台工作），此时永不到期。
		const parkDefaultMaxRetentionMs =
			options.parkDefaultMaxRetentionMs ?? PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS;
		return {
			...shared,
			retentionAnchorKind: "session_parked_awaiting_dispatched_background_work",
			retentionAnchorAt: park.sinceMs,
			responseGenerationStopSignalConfidence: null,
			reclamationEligibleAt:
				park.maxRetentionUntilMs !== undefined
					? park.maxRetentionUntilMs
					: computeAgentSessionRuntimeReclamationEligibleAt(park.sinceMs, parkDefaultMaxRetentionMs),
		};
	}

	// 停止生成轨道：锚点取 summary 的写入时刻——那正是这次状态转移发生的瞬间，比观测时刻更准确
	// （观测可能因批处理迟到几十毫秒）。刻意不取 lastOutputAt / lastSubstantiveOutputAt：前者被
	// spinner 重绘推进，后者有节流窗口，二者都不表达「这一轮结束了」。
	const gracePeriodMs =
		options.gracePeriodMs ?? AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS;
	const retentionAnchorAt = Math.min(summary.updatedAt, options.nowMs);
	return {
		...shared,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt,
		responseGenerationStopSignalConfidence: deriveAgentResponseGenerationStopSignalConfidence(summary),
		reclamationEligibleAt: computeAgentSessionRuntimeReclamationEligibleAt(retentionAnchorAt, gracePeriodMs),
	};
}

export interface AgentSessionResponseGenerationStopObserver {
	observeTaskSessionSummary(workspaceId: string, summary: RuntimeTaskSessionSummary): void;
	forgetWorkspace(workspaceId: string): void;
	// 测试与关闭流程用：等待所有已排队的落库完成。
	whenSettled(): Promise<void>;
}

export interface CreateAgentSessionResponseGenerationStopObserverOptions {
	now?: () => number;
	gracePeriodMs?: number;
	parkDefaultMaxRetentionMs?: number;
	recordRetentionDeadline?: typeof recordAgentSessionRetentionDeadline;
	supersedeRetentionDeadlines?: typeof supersedeAgentSessionRetentionDeadlinesForTask;
	onPersistError?: (error: unknown, context: { workspaceId: string; taskId: string }) => void;
}

export function createAgentSessionResponseGenerationStopObserver(
	options: CreateAgentSessionResponseGenerationStopObserverOptions = {},
): AgentSessionResponseGenerationStopObserver {
	const now = options.now ?? (() => Date.now());
	const recordRetentionDeadline = options.recordRetentionDeadline ?? recordAgentSessionRetentionDeadline;
	const supersedeRetentionDeadlines =
		options.supersedeRetentionDeadlines ?? supersedeAgentSessionRetentionDeadlinesForTask;
	// 上一帧 summary 快照，按 `${workspaceId}::${taskId}` 索引。边沿检测的唯一状态。
	const previousSummaryByObservationKey = new Map<string, RuntimeTaskSessionSummary>();
	const pendingPersistOperations = new Set<Promise<unknown>>();

	const trackPersistOperation = (operation: Promise<unknown>, context: { workspaceId: string; taskId: string }) => {
		const tracked = operation.catch((error: unknown) => {
			// 落库失败绝不能掀翻 summary 广播链路：记下来，下一次边沿会再试。
			options.onPersistError?.(error, context);
		});
		pendingPersistOperations.add(tracked);
		void tracked.finally(() => {
			pendingPersistOperations.delete(tracked);
		});
	};

	return {
		observeTaskSessionSummary(workspaceId, summary) {
			const observationKey = `${workspaceId}::${summary.taskId}`;
			const previousSummary = previousSummaryByObservationKey.get(observationKey) ?? null;
			previousSummaryByObservationKey.set(observationKey, summary);
			const nowMs = now();
			const transition = deriveAgentSessionRetentionDeadlineTransition(previousSummary, summary, {
				nowMs,
				gracePeriodMs: options.gracePeriodMs,
				parkDefaultMaxRetentionMs: options.parkDefaultMaxRetentionMs,
			});
			if (transition.kind === "none") {
				return;
			}
			const context = { workspaceId, taskId: summary.taskId };
			if (transition.kind === "supersede_retention_deadlines") {
				trackPersistOperation(supersedeRetentionDeadlines(workspaceId, summary.taskId, nowMs), context);
				return;
			}
			trackPersistOperation(
				recordRetentionDeadline(workspaceId, { ...transition.input, recordedAt: nowMs }),
				context,
			);
		},
		forgetWorkspace(workspaceId) {
			const prefix = `${workspaceId}::`;
			for (const key of previousSummaryByObservationKey.keys()) {
				if (key.startsWith(prefix)) {
					previousSummaryByObservationKey.delete(key);
				}
			}
		},
		async whenSettled() {
			while (pendingPersistOperations.size > 0) {
				await Promise.all([...pendingPersistOperations]);
			}
		},
	};
}
