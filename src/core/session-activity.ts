import {
	mergeLastEffectiveAgentConversationActivityObservation,
	resolveCurrentAgentProcessUserTurnIdleRetentionStarted,
	resolveLastAgentConversationPromptCacheReferenceObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "./agent-conversation-activity-observation";
import { mergeWorkPhaseGoalConversationOwnership } from "./agent-current-work-phase-goal";

export { resolveAgentCurrentWorkPhaseGoalForDisplay } from "./agent-current-work-phase-goal";
export {
	doesConversationSessionBelongToTask,
	resolveMainTaskConversationSessionId,
	resolveMainTaskConversationSessionSummary,
} from "./task-main-conversation-session-binding";
export { isTaskMainSessionHandoverSuspendingAutomaticActions } from "./task-main-session-handover-contract";

// 会话 facet、语义活动新鲜度及进程生命周期的纯函数真相源。
// PTY 新鲜度只服务 I/O 沉降；业务活动、回合归属和资源期限分别读取各自投影。

import type {
	RuntimeAgentId,
	RuntimeAgentResponseGenerationStopSignalConfidence,
	RuntimeTaskSessionLiveness,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionTurnOwner,
	RuntimeTaskSessionUserTurnKind,
} from "./api-contract.js";

export {
	collectTaskConversationSessionActivityObservations,
	resolveCurrentAgentProcessUserTurnIdleRetentionStarted,
	resolveLastAgentConversationPromptCacheReferenceObservation,
	resolveLastAgentConversationUserHandoffObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "./agent-conversation-activity-observation";

// 「agent 仍在持续产出」的活跃窗口阈值（毫秒）。前后端有意取不同值、语义相反，故分别命名、
// 不强行统一为一个常量：
//  - 前端 Validation 停留判据取更保守的 5s：把「仍活跃」误判为真只会稍微推迟卡片停留（代价低），
//    而把刚结束 / 思考间隙误判为活跃从而打回 In Progress，体验更差。
//  - 后端自动续跑（connection-drop-auto-continue）取更激进的 2s：越早确认「已静默」越早可安全
//    注入续跑指令。
// 详见各自调用点注释。切勿误以为二者重复而合并。
export const VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS = 5_000;
export const AGENT_OUTPUT_QUIET_THRESHOLD_MS = 2_000;

// 写权限与卡片生命周期权限正交：By the way 只读，协作会话可写，两者都不是主会话。
export function isTaskConversationSessionWithoutTaskLifecycleAuthority(
	summary: Pick<RuntimeTaskSessionSummary, "taskConversationSessionMetadata">,
): boolean {
	const metadata = summary.taskConversationSessionMetadata;
	return metadata !== undefined && metadata.taskConversationSessionRole !== "main";
}

// 首次侧问 fork 与协作会话共用目录时，前后端必须采用同一份寻址判据。
export function resolveTaskConversationSessionMainContextForkSelection(input: {
	sessionRole?: "by_the_way" | "task_collaborator";
	workspaceTaskId: string;
	launchAgentId: RuntimeAgentId;
	mainSessionSummary: RuntimeTaskSessionSummary | null | undefined;
	mainSessionWorkingDirectoryPath: string | null;
	existingTaskConversationSessionSummaries: readonly RuntimeTaskSessionSummary[];
}): { forkRejectionReason: string | null; mainSessionNativeConversationSessionId?: string } {
	const sessions = input.existingTaskConversationSessionSummaries;
	const isTaskCollaborator = input.sessionRole === "task_collaborator";
	if (isTaskCollaborator) {
		if (!["claude", "codex", "omp"].includes(input.launchAgentId)) {
			return { forkRejectionReason: "当前 Agent 不支持复刻主会话，请使用全新上下文。" };
		}
		if (input.mainSessionSummary?.startedAt == null) {
			return { forkRejectionReason: "主会话尚未建立，请使用全新上下文。" };
		}
	}
	if (
		!isTaskCollaborator &&
		sessions.some(
			(summary) =>
				summary.taskConversationSessionMetadata?.workspaceTaskId === input.workspaceTaskId &&
				summary.taskConversationSessionMetadata.taskConversationSessionRole === "by_the_way",
		)
	) {
		return { forkRejectionReason: "已有 By the way 会话，后续侧问请从全新上下文开始。" };
	}
	// Cline 按宿主任务 id 加载消息，不使用 cwd-latest。
	if (!isTaskCollaborator && input.launchAgentId !== "claude" && input.launchAgentId !== "codex") {
		return { forkRejectionReason: null };
	}
	const mainSummary = input.mainSessionSummary;
	if (mainSummary?.agentId && mainSummary.agentId !== input.launchAgentId) {
		return {
			forkRejectionReason: isTaskCollaborator
				? "所选 Agent 与主会话不同，无法复刻主会话，请使用全新上下文。"
				: "主会话的 agent 与当前 By the way agent 不同，无法 fork 主对话，请从全新上下文开始。",
		};
	}
	const identity = mainSummary?.agentNativeConversationSessionIdentity;
	if (identity?.sourceAgentId === input.launchAgentId) {
		const nativeSessionId = identity.nativeSessionId.trim();
		if (
			!nativeSessionId ||
			nativeSessionId.startsWith("-") ||
			Array.from(nativeSessionId).some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			)
		) {
			return { forkRejectionReason: "主会话记录的原生会话 ID 无效，无法安全 fork，请从全新上下文开始。" };
		}
		return { forkRejectionReason: null, mainSessionNativeConversationSessionId: nativeSessionId };
	}
	if (isTaskCollaborator) {
		return { forkRejectionReason: "主会话尚未记录可靠的原生会话 ID，无法安全复刻，请使用全新上下文。" };
	}
	const hasCompetingSession = sessions.some(
		(summary) =>
			summary.taskId !== input.workspaceTaskId &&
			summary.agentId === input.launchAgentId &&
			(summary.taskConversationSessionMetadata?.workspaceTaskId === input.workspaceTaskId ||
				(input.mainSessionWorkingDirectoryPath !== null &&
					summary.workspacePath === input.mainSessionWorkingDirectoryPath)),
	);
	return {
		forkRejectionReason: hasCompetingSession
			? `主会话尚未记录可用的 ${input.launchAgentId} 原生会话 ID，且同一工作目录存在其他 ${input.launchAgentId} 会话，无法安全 fork 主对话，请从全新上下文开始。`
			: null,
	};
}

// 保留既有侧问入口及其次数规则；协作会话必须显式声明角色并满足更严格的身份要求。
export function resolveByTheWayMainSessionForkSelection(
	input: Omit<Parameters<typeof resolveTaskConversationSessionMainContextForkSelection>[0], "sessionRole">,
): ReturnType<typeof resolveTaskConversationSessionMainContextForkSelection> {
	return resolveTaskConversationSessionMainContextForkSelection({ ...input, sessionRole: "by_the_way" });
}

// 旧展示时间窗常量保留兼容；Running 成员现在由 facet 和进程存活判定。
export const RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS = 5 * 60_000;

// 原始 I/O 新鲜度原语；不能据此判断对话推进或模型正在计算。
export function isAgentOutputWithinActiveWindow(
	lastOutputAt: number | null | undefined,
	nowMs: number,
	activeWindowMs: number,
): boolean {
	return lastOutputAt !== null && lastOutputAt !== undefined && nowMs - lastOutputAt < activeWindowMs;
}

// 取反语义：距最近输出已 >= quietThresholdMs（或从未产出）→ 视为「已静默」。
// 后端自动续跑注入门控用；从未产出（null）视为静默，避免「无 lastOutputAt」永久卡住注入。
export function isAgentOutputQuiet(
	lastOutputAt: number | null | undefined,
	nowMs: number,
	quietThresholdMs: number = AGENT_OUTPUT_QUIET_THRESHOLD_MS,
): boolean {
	return !isAgentOutputWithinActiveWindow(lastOutputAt, nowMs, quietThresholdMs);
}

// Validation 的持续活动判据与卡片近期活动共用可信观测；PTY 字节与实质 TUI 戳不参与。
export function isAgentConversationRecentlyEffectivelyActive(
	summary: RuntimeTaskSessionSummary | null | undefined,
	nowMs: number,
): boolean {
	if (
		summary == null ||
		resolveSessionFacets(summary).turnOwner !== "agent" ||
		isParkedAwaitingDispatchedBackgroundWork(summary)
	)
		return false;
	return isAgentOutputWithinActiveWindow(
		resolveLastEffectiveAgentConversationActivityObservation(summary)?.observedAtMs,
		nowMs,
		VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
	);
}

// 已接受输入由服务端一次性边沿移列；持续判据只处理卡片最近更新之后的新工作。
export function isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow(
	summary: RuntimeTaskSessionSummary | null | undefined,
	nowMs: number,
	taskCardUpdatedAtMs?: number,
): boolean {
	if (!isAgentConversationRecentlyEffectivelyActive(summary, nowMs)) return false;
	const activity = resolveLastEffectiveAgentConversationActivityObservation(summary);
	return (
		activity != null &&
		activity.activityKind !== "accepted_user_input" &&
		(taskCardUpdatedAtMs === undefined || activity.observedAtMs >= taskCardUpdatedAtMs)
	);
}

// 兼容原消费者的入口名，判据只读取统一活动。
export const isAgentActivelyProducingOutput = isAgentConversationRecentlyEffectivelyActive;

// ── 双轴会话状态 facet 的派生真相源 ─────────────────────────────────────────────
// 枚举/类型定义在 src/core/api-contract.ts（含 superRefine 组合护栏）；此处是其求值逻辑：
//   - deriveUserTurnKind / deriveSessionFacetsFromLegacyState：old→new（dual-write 与读时回填共用）
//   - projectLegacyState：new→old 的唯一 reducer（live/exited 在此被有损压扁）
//   - applySessionFacets：单一构造，所有写点经 updateSummary 漏斗统一 stamp facet
// 三者满足 projectLegacyState(deriveSessionFacetsFromLegacyState(state, …)) === state（投影可逆），
// 这正是 Stage 1「零行为漂移」承诺的命门，由黄金转移单测逐路径断言。

// per-session facet schema 版本（随 dual-write 落盘的可选字段；Stage 2 据此判定是否需读时回填）。
// 故意定义在本纯函数模块而非 api-contract：若从 api-contract 取值 import，会把整套 Zod schema 拖进
// 浏览器 bundle（api-contract 当前仅被 web-ui 以 type-only 引用、不在运行时 bundle）。
export const SESSION_SUMMARY_SCHEMA_VERSION = 1;

// 三 facet 组合（合法组合由 api-contract 的 superRefine 护栏在校验边界硬化）。
export interface SessionFacets {
	turnOwner: RuntimeTaskSessionTurnOwner;
	liveness: RuntimeTaskSessionLiveness;
	userTurnKind: RuntimeTaskSessionUserTurnKind | null;
}

// reviewReason → 人轴种类。仅 turnOwner==="user" 时取用，恒返回非 null（满足「user 回合 userTurnKind
// 不可为 null」不变量）。三分：error=运行错；interrupted=被中断；exit/completion/hook/manual_review/idle_stall=待审(review)；
// attention/兜底=needs_input。注：question / plan_review / permission 需 harness 级采集，归后续 Stage。
export function deriveUserTurnKind(reviewReason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionUserTurnKind {
	switch (reviewReason) {
		case "error":
			return "error";
		case "interrupted":
			return "interrupted";
		case "exit":
		case "completion":
		case "hook":
		case "manual_review":
		case "idle_stall":
			// manual_review：用户手动翻入审查回合；idle_stall：完工不退出的空闲会话被 scanForStalls 自愈翻入。
			// 二者与 agent 自然完成同归「待审」人轴。
			return "review";
		default:
			// "attention" 及 null/未知：兜底待输入
			return "needs_input";
	}
}

// old→new：把 legacy 一维 state（+ 同刻上下文）映射为三 facet。dual-write（Stage 1）与读时回填
// （Stage 2 migrateLegacyState）共用此唯一映射。关键增益：awaiting_review 借 agentId+pid 区分
// live↔exited（legacy state 表达不了，故此方向无损；Cline SDK 恒 live，见下），running 借
// connectionRetry 区分 live↔retrying。
export function deriveSessionFacetsFromLegacyState(
	state: RuntimeTaskSessionState,
	context: {
		reviewReason: RuntimeTaskSessionReviewReason;
		pid: number | null;
		connectionRetryActive: boolean;
		agentId: RuntimeAgentId | null;
	},
): SessionFacets {
	switch (state) {
		case "idle":
			return { turnOwner: null, liveness: "none", userTurnKind: null };
		case "running":
			return {
				turnOwner: "agent",
				liveness: context.connectionRetryActive ? "retrying" : "live",
				userTurnKind: null,
			};
		case "failed":
			// spawn 失败（终端启动失败）：等人处理、进程未起。
			return { turnOwner: "user", liveness: "failed", userTurnKind: "error" };
		case "interrupted":
			return { turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" };
		case "awaiting_review":
			return {
				turnOwner: "user",
				// harness-aware「进程已退」判定（解阻塞 distinction ②）：Cline SDK 在进程内运行、无 OS pid
				// 概念（pid 恒 null），awaiting 仅表示 SDK 会话仍存活 → 一律 live；终端/PTY agent 才有真实
				// pid，pid===null 才表示其进程已退 → exited。旧实现只看 pid===null，会把所有 Cline awaiting
				// 误标 exited（即此区阻塞根因）。agentId 未知(null) 时保守回退旧 pid 规则（按 pid 判）。
				liveness: context.agentId === "cline" || context.pid !== null ? "live" : "exited",
				userTurnKind: deriveUserTurnKind(context.reviewReason),
			};
	}
}

// new→old 的唯一 legacy reducer（禁止消费者各自手写投影）。live/exited 在此被压扁回
// awaiting_review——这是有损方向，故依赖「进程已退」的决策型消费者自 Stage 2 起须直接读 liveness。
export function projectLegacyState(facets: SessionFacets): RuntimeTaskSessionState {
	if (facets.turnOwner === null) {
		return "idle";
	}
	if (facets.turnOwner === "agent") {
		return "running";
	}
	// turnOwner === "user"
	if (facets.liveness === "failed") {
		return "failed";
	}
	if (facets.liveness === "interrupted") {
		return "interrupted";
	}
	return "awaiting_review";
}

// 单一构造：给「已合并好的 summary」打上与其 legacy state 自洽的三 facet + schemaVersion。
// 所有 dual-write 经两处 updateSummary 漏斗（src/cline-sdk/cline-session-state.ts、
// src/terminal/session-manager.ts）统一走此函数，故 facet 恒由当刻 state/reviewReason/pid/
// connectionRetry 派生、与 state 投影可逆——无需在每个写点手填 facet，也杜绝漂移。
export function applySessionFacets(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	const facets = deriveSessionFacetsFromLegacyState(summary.state, {
		reviewReason: summary.reviewReason,
		pid: summary.pid,
		connectionRetryActive: summary.connectionRetry != null,
		agentId: summary.agentId,
	});
	return {
		...summary,
		turnOwner: facets.turnOwner,
		liveness: facets.liveness,
		userTurnKind: facets.userTurnKind,
		schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
	};
}

// 写入时刻（updatedAt）之外，本次写所对应的领域事件真实发生的时刻。只有经 agent session PTY host spool
// 晚送达的 hook 会让两者分开（runtime 缺席期间 agent 停下了，几小时后 runtime 回来才收到 Stop）；
// 缺省时两者相同。只影响「本轮何时开始 / 停止生成」两个边沿章，updatedAt 仍是写入墙钟。
export interface SummaryWriteDomainEventTiming {
	domainEventObservedAtEpochMs?: number;
}

// 原生接受核验可能落后于无工具回合的完成 hook。完成信号证明发生过工作，提交状态仍保持待确认。
export function canObserveCompletedAgentTurnForCurrentUnacceptedPromptSubmission(
	summary: RuntimeTaskSessionSummary,
	completedAtMs: number,
): boolean {
	const facets = resolveSessionFacets(summary);
	const submission = summary.agentConversationPromptSubmissionAcceptance;
	return (
		facets.turnOwner === "user" &&
		facets.liveness === "live" &&
		facets.userTurnKind === "review" &&
		!isParkedAwaitingDispatchedBackgroundWork(summary) &&
		summary.runtimeSessionIncarnationId != null &&
		submission != null &&
		submission.status !== "accepted" &&
		submission.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
		Number.isFinite(completedAtMs) &&
		submission.attemptedAtMs >= (summary.startedAt ?? 0) &&
		completedAtMs >= submission.attemptedAtMs &&
		(summary.lastAgentConversationUserHandoffObservation?.observedAtMs ?? 0) < submission.attemptedAtMs
	);
}

// 晚于写入时刻的值按写入时刻截断：跑到未来的时钟不可信，边沿章也不该比记下它的那次写更晚。
function resolveDomainEventObservedAtEpochMs(
	summaryUpdatedAt: number,
	domainEventTiming: SummaryWriteDomainEventTiming | undefined,
): number {
	const domainEventObservedAtEpochMs = domainEventTiming?.domainEventObservedAtEpochMs;
	if (domainEventObservedAtEpochMs === undefined || !Number.isFinite(domainEventObservedAtEpochMs)) {
		return summaryUpdatedAt;
	}
	return Math.min(domainEventObservedAtEpochMs, summaryUpdatedAt);
}

// ── 写侧主真相源派发器（Stage 4 全写侧反转）────────────────────────────────────
// 单一 per-patch 派发器：按 patch 形状决定 facet 与 legacy state 谁是权威，产出「三 facet 与 state
// 自洽」的 summary。两个 updateSummary 漏斗（cline-session-state.ts / session-manager.ts）统一经此写。
//
// 反转后 facet 是**写时主真相源**：
//   - patch 带 facet 且无 state → **facet 权威**：state = projectLegacyState(facets)（写侧主路径；
//     facet 写恒经 statePatch/facetPatch 发完整三元组，故 merged 必带完整三 facet）。
//   - patch 带 state（含同时带 facet 的 constructor seed）→ **legacy 向**：applySessionFacets 从
//     state 反推 facet（旧路兼容 / shutdown 持久化 / seed 数据，state 权威）。
//   - patch 两者皆无（metadata-only：lastOutputAt / latestHookActivity / connectionRetry-only）→
//     从 state+ctx 重派生 turnOwner/liveness（保 connectionRetry→retrying、exited 等元数据驱动的
//     活性变化），但 **preserve 已采集的 userTurnKind**——它可能是采集增强写入的 question /
//     plan_review / permission，无法从 reviewReason 反推，绝不能被 applySessionFacets 冲回
//     review / needs_input（两腿评审同判最致命缺陷）。facet 全缺的旧盘数据走 applySessionFacets。
//
// A1 零行为漂移保证：迁移前全库仍只发 state-only / metadata-only patch。state-only → applySessionFacets
// （同今日）；metadata-only 分支「重派 turnOwner/liveness + preserve userTurnKind」在「facet 恒由 state
// 反推」的迁移前世界里与 applySessionFacets 逐字等价（preserved userTurnKind === 重派 userTurnKind）。
export function mergeSummaryWithFacets(
	prev: RuntimeTaskSessionSummary,
	patch: Partial<RuntimeTaskSessionSummary>,
	domainEventTiming?: SummaryWriteDomainEventTiming,
): RuntimeTaskSessionSummary {
	const merged = mergeWorkPhaseGoalConversationOwnership(prev, { ...prev, ...patch });
	const patchHasFacet =
		patch.turnOwner !== undefined || patch.liveness !== undefined || patch.userTurnKind !== undefined;
	const patchHasState = patch.state !== undefined;

	const mergedWithFacets = ((): RuntimeTaskSessionSummary => {
		if (patchHasFacet && !patchHasState) {
			// facet 权威：state 由唯一 reducer 投影；三 facet 直接采信（merged 必完整）。
			const facets = resolveSessionFacets(merged);
			return {
				...merged,
				turnOwner: facets.turnOwner,
				liveness: facets.liveness,
				userTurnKind: facets.userTurnKind,
				state: projectLegacyState(facets),
				schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
			};
		}

		if (patchHasState) {
			// legacy 向（state 权威）：旧路兼容 / shutdown 持久化 / constructor seed（state+facet 同在）。
			return applySessionFacets(merged);
		}

		// metadata-only：重派 agent 轴（turnOwner/liveness），preserve 已采集的 userTurnKind。
		const refreshed = applySessionFacets(merged);
		if (merged.userTurnKind !== undefined) {
			return { ...refreshed, userTurnKind: merged.userTurnKind };
		}
		return refreshed;
	})();

	const domainEventObservedAtEpochMs = resolveDomainEventObservedAtEpochMs(
		mergedWithFacets.updatedAt,
		domainEventTiming,
	);
	const withTurnSequence = didEnterAgentTurn(prev, patch, mergedWithFacets)
		? stampAgentResponseGenerationTurnStarted(
				patch,
				{
					...mergedWithFacets,
					agentResponseGenerationTurnSequence: (prev.agentResponseGenerationTurnSequence ?? 0) + 1,
				},
				domainEventObservedAtEpochMs,
			)
		: // 没有开始新的 agent 回合：序号原样透传（含「从未开始过任何回合、字段仍缺失」这一态）。
			// 回合开始事件同理：不在边沿上就不碰它（离开 agent 回合后保留原值，缺失就继续缺失）。
			// 刻意不在此把缺失字段补成 0——那会给每一条历史 summary 平白加一个字段、也让
			// mergeSummaryWithFacets 与 applySessionFacets 的既有等价关系产生无谓差异。
			mergedWithFacets;

	const withActivity = mergeAgentConversationActivityProjections(prev, patch, withTurnSequence);
	const withRetention = resolveCurrentProcessIdleRetentionPatch(
		prev,
		patch,
		withActivity,
		domainEventObservedAtEpochMs,
	);
	const withHandoff = resolveHistoricalUserHandoffPatch(prev, patch, withRetention, domainEventObservedAtEpochMs);
	// 旧字段仅用于兼容读取；后续持久化只写新投影，防止多套时间重新分叉。
	const result = { ...withHandoff };
	delete result.lastSubstantiveOutputAt;
	delete result.lastConversationProgressObservation;
	delete result.lastMainAgentConversationModelRequestDispatchObservation;
	delete result.agentResponseGenerationStopped;
	return result;
}

function mergeAgentConversationActivityProjections(
	prev: RuntimeTaskSessionSummary,
	patch: Partial<RuntimeTaskSessionSummary>,
	merged: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	let result = merged;
	const previousActivity =
		prev.lastEffectiveAgentConversationActivityObservation ??
		resolveLastEffectiveAgentConversationActivityObservation(prev);
	const incomingActivity =
		patch.lastEffectiveAgentConversationActivityObservation ??
		resolveLastEffectiveAgentConversationActivityObservation(patch);
	const shouldClearActivity =
		patch.lastEffectiveAgentConversationActivityObservation === null ||
		(patch.lastEffectiveAgentConversationActivityObservation === undefined &&
			patch.lastConversationProgressObservation === null);
	const activity = shouldClearActivity
		? null
		: incomingActivity
			? mergeLastEffectiveAgentConversationActivityObservation(previousActivity, incomingActivity, {
					nowMs: merged.updatedAt,
					allowCorrectionOfPreviousTerminalHeuristic: true,
					isAgentResponseGenerationTurnInProgress: resolveSessionFacets(merged).turnOwner === "agent",
				})
			: previousActivity;
	if (
		activity != null ||
		shouldClearActivity ||
		prev.lastEffectiveAgentConversationActivityObservation !== undefined ||
		patch.lastEffectiveAgentConversationActivityObservation !== undefined
	) {
		result = { ...result, lastEffectiveAgentConversationActivityObservation: activity };
	}
	const previousCacheReference = resolveLastAgentConversationPromptCacheReferenceObservation(prev);
	const incomingCacheReference = resolveLastAgentConversationPromptCacheReferenceObservation(patch);
	const shouldClearCache =
		patch.lastAgentConversationPromptCacheReferenceObservation === null ||
		(patch.lastAgentConversationPromptCacheReferenceObservation === undefined &&
			patch.lastMainAgentConversationModelRequestDispatchObservation === null);
	let cacheReference = previousCacheReference;
	if (shouldClearCache) cacheReference = null;
	else if (
		incomingCacheReference &&
		Number.isFinite(incomingCacheReference.observedAtMs) &&
		incomingCacheReference.observedAtMs > 0 &&
		incomingCacheReference.observedAtMs <= merged.updatedAt + 60_000
	) {
		const normalized =
			incomingCacheReference.observedAtMs > merged.updatedAt
				? { ...incomingCacheReference, observedAtMs: merged.updatedAt }
				: incomingCacheReference;
		if (!cacheReference || normalized.observedAtMs > cacheReference.observedAtMs) cacheReference = normalized;
	}
	if (
		cacheReference != null ||
		shouldClearCache ||
		prev.lastAgentConversationPromptCacheReferenceObservation !== undefined ||
		patch.lastAgentConversationPromptCacheReferenceObservation !== undefined
	) {
		result = { ...result, lastAgentConversationPromptCacheReferenceObservation: cacheReference };
	}
	return result;
}

function resolveCurrentProcessIdleRetentionPatch(
	prev: RuntimeTaskSessionSummary,
	patch: Partial<RuntimeTaskSessionSummary>,
	merged: RuntimeTaskSessionSummary,
	domainEventObservedAtEpochMs: number,
): RuntimeTaskSessionSummary {
	if (patch.currentAgentProcessUserTurnIdleRetentionStarted !== undefined) return merged;
	if (patch.agentResponseGenerationStopped !== undefined) {
		return { ...merged, currentAgentProcessUserTurnIdleRetentionStarted: patch.agentResponseGenerationStopped };
	}
	const previous = resolveCurrentAgentProcessUserTurnIdleRetentionStarted(prev);
	if (resolveSessionFacets(merged).turnOwner !== "user") {
		return previous == null ? merged : { ...merged, currentAgentProcessUserTurnIdleRetentionStarted: null };
	}
	if (
		resolveSessionFacets(prev).turnOwner !== "user" ||
		prev.runtimeSessionIncarnationId !== merged.runtimeSessionIncarnationId
	) {
		return {
			...merged,
			currentAgentProcessUserTurnIdleRetentionStarted: {
				stoppedAt: domainEventObservedAtEpochMs,
				signalConfidence: deriveAgentResponseGenerationStopSignalConfidence(merged),
				turnSequence: merged.agentResponseGenerationTurnSequence ?? 0,
			},
		};
	}
	return previous == null ? merged : { ...merged, currentAgentProcessUserTurnIdleRetentionStarted: previous };
}

function resolveHistoricalUserHandoffPatch(
	prev: RuntimeTaskSessionSummary,
	patch: Partial<RuntimeTaskSessionSummary>,
	merged: RuntimeTaskSessionSummary,
	domainEventObservedAtEpochMs: number,
): RuntimeTaskSessionSummary {
	if (patch.lastAgentConversationUserHandoffObservation !== undefined) {
		const incoming = patch.lastAgentConversationUserHandoffObservation;
		const previous = prev.lastAgentConversationUserHandoffObservation;
		if (
			incoming &&
			(!Number.isFinite(incoming.observedAtMs) ||
				incoming.observedAtMs <= 0 ||
				incoming.observedAtMs > merged.updatedAt + 60_000 ||
				(previous && previous.observedAtMs > incoming.observedAtMs))
		) {
			return { ...merged, lastAgentConversationUserHandoffObservation: previous ?? null };
		}
		return merged;
	}
	const previousFacets = resolveSessionFacets(prev);
	const currentFacets = resolveSessionFacets(merged);
	const isEndingCurrentProcess =
		merged.runtimeSessionIncarnationId == null &&
		prev.runtimeSessionIncarnationId != null &&
		(currentFacets.liveness === "interrupted" || currentFacets.liveness === "exited");
	if (
		previousFacets.turnOwner !== "agent" ||
		previousFacets.liveness === "starting" ||
		resolveSessionFacets(merged).turnOwner !== "user" ||
		resolveSessionFacets(merged).liveness === "failed" ||
		(prev.runtimeSessionIncarnationId !== merged.runtimeSessionIncarnationId && !isEndingCurrentProcess) ||
		isParkedAwaitingDispatchedBackgroundWork(merged) ||
		merged.reviewReason === "manual_review" ||
		(merged.agentResponseGenerationTurnSequence ?? 0) === 0
	)
		return merged;
	const confidence = deriveAgentResponseGenerationStopSignalConfidence(merged);
	if (confidence === "session_ready_never_prompted") return merged;
	const previous = prev.lastAgentConversationUserHandoffObservation;
	if (previous && previous.observedAtMs > domainEventObservedAtEpochMs) return merged;
	return {
		...merged,
		lastAgentConversationUserHandoffObservation: {
			observedAtMs: domainEventObservedAtEpochMs,
			signalConfidence: confidence,
			turnSequence: merged.agentResponseGenerationTurnSequence ?? 0,
		},
	};
}

// 「本轮何时开始生成」边沿事件的唯一写点：与回合序号 +1 同一分支，故三条 transport 自动一致，且只在
// 「非 agent → agent」那一次写上盖章——agent 回合内的 lastOutputAt bump / hook activity / connectionRetry
// 等元数据写都不经过这里，跨项目切换面板 Running 区的顺序因此不随 spinner 抖动。
// EXPERIMENT_NODE: 模态决策（permission/question/plan_review）往返后是否保留原 startedAt（当前：重新盖章，排到 Running 末尾）
function stampAgentResponseGenerationTurnStarted(
	patch: Partial<RuntimeTaskSessionSummary>,
	withTurnSequence: RuntimeTaskSessionSummary,
	domainEventObservedAtEpochMs: number,
): RuntimeTaskSessionSummary {
	if (patch.agentResponseGenerationTurnStarted !== undefined) {
		// 显式覆写优先：磁盘水合、测试构造按原值采信（已在 merged 里），不在此重新盖章。
		return withTurnSequence;
	}
	return {
		...withTurnSequence,
		agentResponseGenerationTurnStarted: {
			// 与停止事件同口径：取翻入 agent 回合的瞬间（通常即本次写入时刻，spool 晚送达时取捕获时刻）。
			startedAt: domainEventObservedAtEpochMs,
			turnSequence: withTurnSequence.agentResponseGenerationTurnSequence ?? 0,
		},
	};
}

// 回合序号推进：本函数是终端 / Cline SDK / ACP **三条 transport 共用**的唯一 summary 写漏斗，
// 故序号只在这里推进一次，三侧自动一致，不需要各写一份（也就不会各自漂移）。
//
// 语义精确定义：`agentResponseGenerationTurnSequence` = 「这个会话条目至今开始过多少个 agent 回合」。
// 判据是一次 facet 转移（非 agent 回合 → agent 回合），因此用户手敲、程序化投递、hook 的
// UserPromptSubmit、自动续跑、崩溃重启后重跑——凡是让球回到 agent 手上的路径，全部计入，
// 无一遗漏。它与 runtimeSessionIncarnationId 正交：incarnation 分辨「还是不是同一个活体」，
// 序号分辨「同一活体内是不是同一轮」，两者共同构成陈旧回收定时器的双重防护。
function didEnterAgentTurn(
	prev: RuntimeTaskSessionSummary,
	patch: Partial<RuntimeTaskSessionSummary>,
	mergedWithFacets: RuntimeTaskSessionSummary,
): boolean {
	if (patch.agentResponseGenerationTurnSequence !== undefined) {
		// 显式覆写优先：磁盘水合、测试构造等按原值采信（已在 merged 里），不在此重新推算。
		return false;
	}
	return (
		resolveSessionFacets(prev).turnOwner !== "agent" && resolveSessionFacets(mergedWithFacets).turnOwner === "agent"
	);
}

// ── 读侧 facet 权威解析（Stage 2 翻转真相源）─────────────────────────────────────
// 决策型消费者一律经此读 facet、不再读 legacy `state`，从而绕开 projectLegacyState 对
// live↔exited 的有损压扁（投影只在 new→old 方向有损；facet 本身保真）。
//
// 解析优先级：
//   - summary 已带三 facet（经 applySessionFacets 漏斗 / 读时回填 backfillSessionFacets）→ 直接采信；
//   - facet 全缺（未迁移旧盘残留、或 web-ui 无-facet 构造点）→ 即时从 legacy state 派生（与读时
//     回填同一映射 deriveSessionFacetsFromLegacyState，故「在线派生」与「落盘回填」结果恒一致）。
// 三 facet 由 superRefine 护栏保证共生（要么全置、要么全缺），故仅以 turnOwner 是否 undefined 判定
// 「已带 facet」即可；为容错对另两者也作显式 defined 收窄。
export function resolveSessionFacets(summary: RuntimeTaskSessionSummary): SessionFacets {
	if (summary.turnOwner !== undefined && summary.liveness !== undefined && summary.userTurnKind !== undefined) {
		return {
			turnOwner: summary.turnOwner,
			liveness: summary.liveness,
			userTurnKind: summary.userTurnKind,
		};
	}
	return deriveSessionFacetsFromLegacyState(summary.state, {
		reviewReason: summary.reviewReason,
		pid: summary.pid,
		connectionRetryActive: summary.connectionRetry != null,
		agentId: summary.agentId,
	});
}

// 「从未启动过的空白占位」判据：与 session-manager 的 `createDefaultSummary` 逐字段同形。
//
// 这条谓词存在的唯一原因是它是**数据损坏的形状**，不是一个正常的会话状态。链路是：
// 硬中断让 sessions.json 里没有该 task 的条目 → 前端聚焦卡片触发 attach → `ensureEntry` 就地造出一条
// 全 null 的默认 summary → 它带着**最新的 updatedAt** 被广播出去 → 前端按 updatedAt 单调合并接受了它
// → 下一次客户端 saveState 把它写进 sessions.json。至此「这个 task 用的是哪个 agent」被一条空壳
// 永久覆盖，后续重启不再自愈，用户看到的就是全白 TUI 加一个灰掉的「重启终端会话」。
//
// 因此凡是「用新记录覆盖旧记录」的接缝，都要用它拦一道：占位记录携带的信息严格少于任何真实记录，
// 它更新的 updatedAt 表达的是「刚被凭空造出来」，而不是「掌握了更新的事实」。
//
// 判据取 createDefaultSummary 的完整形状而非其中一两个字段：宁可漏判一条形状略有出入的记录
// （退化成现状，不会更糟），也不能误判一条真实记录并把它钉死（那会挡住合法更新）。
export function isNeverStartedPlaceholderTaskSessionSummary(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "idle" &&
		summary.agentId === null &&
		summary.workspacePath === null &&
		summary.pid === null &&
		summary.startedAt === null &&
		summary.lastOutputAt === null &&
		summary.lastHookAt === null &&
		summary.exitCode === null &&
		summary.latestTurnCheckpoint == null
	);
}

// 决策型「会话是否处于活跃回合」判据（facet 权威，绕开有损 legacy 投影）。
// 严格等价于 legacy `state ∈ {running, awaiting_review}`：有回合主（turnOwner 非 null）且未落入
// 终止态（failed=spawn 失败 / interrupted=被中断）。
//   - 全表等价证明见 session-facets.test.ts（全 state×pid×retry×reviewReason 与旧判据逐项对照）。
//   - 关键：exited（进程已退但仍等人审）仍判活跃——这正是 legacy 投影压扁、而 facet 保真的区分点。
//     未来「进程已退」类 UX（Terminal stream closed / 标记被打断会话）据 liveness="exited" 细分，
//     而本活跃判据对 live/exited 不敏感，故此处迁移为纯重构、零行为漂移。
export function isSessionInActiveTurn(facets: SessionFacets): boolean {
	return facets.turnOwner !== null && facets.liveness !== "failed" && facets.liveness !== "interrupted";
}

// 决策型「会话处于等人审查回合」判据（facet 权威）。严格等价于 legacy `state==="awaiting_review"`：
// user 回合（turnOwner==="user"）且未落终止态（failed/interrupted）——即 user 回合的活跃态。
//   - 等价于 projectLegacyState(facets)==="awaiting_review"；全表证明见 session-facets.test.ts。
//   - 涵盖 user+live 与 user+exited（旧 projectLegacyState 把两者压扁为 awaiting_review），故对
//     live↔exited 不敏感，凡读它的消费者迁移皆为零行为漂移、且不会偷渡 distinction ②。
//   - 单一真相源：项目计数叠加、claude/codex prompt-ready 检测器、hook 事件转换闸（hooks-api）等
//     共用本判据，避免各自手写 `turnOwner==="user" && liveness∉{failed,interrupted}` 子集
//     （计划反对的「每消费者维护子集」反模式）。
export function isAwaitingUserReviewTurn(facets: SessionFacets): boolean {
	return facets.turnOwner === "user" && isSessionInActiveTurn(facets);
}

// 决策型「该回合是否触发 ready-for-review 系统通知」判据（facet 权威，单一真相源）。
// 用户拍板「广·阻塞即提醒」（2026-06-22）：凡进入「等人审查回合」（isAwaitingUserReviewTurn）且
// userTurnKind 非 interrupted（被中断/终止不打扰）即触发——涵盖 review（含完成/exit/hook）、error
// （运行错）、needs_input（含 attention/兜底），以及未来采集增强后才会产出的 question/plan_review/
// permission（均属「agent 阻塞等你」，broad 策略一律提醒）。故判据写成「awaiting 回合 ∧ 非
// interrupted」而非枚举白名单，既精确编码决策、又对后续采集增强前向兼容。
//   - 相对旧 reviewReason∈{hook,attention,error} 白名单的有意差异（属修正、非回归）：reviewReason
//     "exit"/"completion"/null 的等人回合（→review/needs_input）此前不通知，现纳入广播。
//   - 决策型判据：只读事件置位 facet，不读 computing/quiet 派生叠加（见 freshness 分层）。
export function isNotifiableUserTurn(facets: SessionFacets): boolean {
	return isAwaitingUserReviewTurn(facets) && facets.userTurnKind !== "interrupted";
}

// ── 「agent 停在模态待答、正等用户拍板」的唯一被认可判据 ──────────────────────────────────────
// 集合有意**只**收这四种模态待答，**绝不含 `review`**：`review` 是 agent 自然完工、输入框空闲的
// 状态，恰恰是程序化投递（RVF followup、排队 prompt）的**目标态**。把 review 也算「等用户」会让
// 每次投递都让位、永不落地——这正是 2026-08-08 事故的第二条根因（当时的实现用的是
// `turnOwner !== "agent"`，一并把 review 吞了进去）。
//
// 定义在这里而不是 session-manager：两类消费者必须共用同一份集合——
//   ① PTY 投递让位门控（session-manager 的 runTaskChatInputDeliveryAttempt）；
//   ② 排队 prompt 投递的出队门控（queued-task-prompt-delivery-dispatch-eligibility）。
// 两处各持一份副本，迟早在其中一份里漂移出「review 又被算进去了」的同一个 bug，而它上一次的代价
// 是 49 分钟静默挂起。
export const MODAL_USER_DECISION_TURN_KINDS: ReadonlySet<RuntimeTaskSessionUserTurnKind> =
	new Set<RuntimeTaskSessionUserTurnKind>(["question", "plan_review", "permission", "needs_input"]);

export function isAgentAwaitingModalUserDecision(facets: SessionFacets): boolean {
	return facets.userTurnKind !== null && MODAL_USER_DECISION_TURN_KINDS.has(facets.userTurnKind);
}

// ── 恢复守卫：「这条会话正在重建历史对话，还没有人真正让它继续」的唯一被认可判据 ────────────────
// 恢复一个落盘会话只负责重建上下文，绝不等价于开始新一轮生成。守卫有**两个**武装态，缺一不可：
//   restoring_…            spawn 前置位，覆盖「子进程一起来就恢复后台通知并同步触发 UserPromptSubmit」；
//   restored_…_waiting_…   summary 装载时置位，覆盖恢复重放跑完之后、人还没开口的那整段。
// 只有货真价实的用户提交（UserPromptSubmit 源的 to_in_progress）或显式 disarm 才解除。
//
// 定义在这里而不是 session-manager：判「守卫是否武装」的消费者不止 PTY 自己——排队 prompt 的出队门控
// 也必须用同一份判据，而这条判据的**唯一**正确写法就是「两个枚举值都算」。在别处照抄一个枚举比较，
// 漏掉第二个值的后果是确定性的：`--continue` 恢复重放自己那次 Stop hook 会落在第二个状态上，于是
// 「用户只是点开了一张卡片」就足以把几小时前排的队全部引爆。
//
// 只吃 summary 不吃 facets：守卫是 sidecar 字段，不参与 facet 派生（facet 描述「球在谁手上」，
// 守卫描述「这一局到底算不算开始了」，两者正交）。
// 恢复守卫的最长武装时长。守卫本该在恢复后的**首个**用户回合就解除，这条兜底只防「解除信号因任何
// 未预见的路径没能送达」——那种情况下它会永久武装，把 agent 自己 dispatch 的后台工作唤醒信号一并吞掉
// （2026-08 实测 38 条会话记录已无解除路径）。它真正要防的「恢复瞬间 harness 重放旧通知自动续跑」只
// 发生在 spawn 后的头几分钟，30 分钟足够宽松，不削弱保护强度。
export const RESTORATION_CONTINUATION_GUARD_MAXIMUM_ARMED_DURATION_MS = 30 * 60 * 1000;

// 计时锚点用 summary.startedAt——那正是本活体 spawn 的时刻，每次真实 spawn 都会重置。
// startedAt 为 null = 这条记录从未真正 spawn 过（durable 重建出的壳）。没有可信计时锚点就不判过期；
// 这类记录也没有 entry.active，hook 根本到不了，不构成永久武装的实际风险。
export function hasRestorationContinuationGuardOutlivedItsMaximumArmedDuration(
	summary: RuntimeTaskSessionSummary,
	nowEpochMs: number,
): boolean {
	if (summary.startedAt === null) {
		return false;
	}
	return nowEpochMs - summary.startedAt >= RESTORATION_CONTINUATION_GUARD_MAXIMUM_ARMED_DURATION_MS;
}

// 守卫**声明上**是否武装（两个武装态之一），不看 30 分钟兜底过期。
//
// 为什么要把「声明」单独导出：兜底过期是为「拦截 harness 自己的唤醒通知」这件事设的——守卫永久武装会把
// agent 自己派发的后台工作唤醒信号无限期吞掉，所以宁可 30 分钟后放行。排队 prompt 的方向恰好相反：
// 放行 = 在用户从没继续过对话的情况下，把几小时前排的一句话发进一个刚恢复的会话。那一侧的代价是「不提醒
// 就发」，而等下去的代价只是「队列一直等到用户继续」（面板如实写着原因）。所以排队门控读声明态，
// 不读带兜底过期的那一个。两态的枚举仍只在这里定义一次。
//
// 「等到用户继续」成立的前提：**解除侧也只看声明态**。解除只走 session-manager 的
// disarmRestorationContinuationGuard 一个漏斗，它绝不能读带兜底的谓词——那样首个真人提交一旦晚于启动
// 30 分钟就清不掉声明态，队列永远等不到（2026-10-11 a768a，d0304b47 与 f1d61259 两次修复叠出的接缝）。
//
// EXPERIMENT_NODE: 门控 5 是否叠加「本次 spawn 之后已有真人提交」的独立证据作纵深防御。现成候选
// lastMainAgentConversationModelRequestDispatchObservation 不合格：它的 user_prompt_submit 证据包含 harness
// task-notification（兜底过期后放行的正是孤儿通知），且只存最后一次观测、会被 PostToolUse 覆盖。
export function isRestorationContinuationGuardDeclaredArmedIgnoringMaximumArmedDuration(
	summary: RuntimeTaskSessionSummary,
): boolean {
	return (
		summary.restorationContinuationGuardState === "restoring_agent_conversation_without_starting_new_turn" ||
		summary.restorationContinuationGuardState === "restored_agent_conversation_waiting_for_explicit_user_input"
	);
}

// 取 nowEpochMs 而不是自己读 Date.now()：本模块是纯函数真相源，且 session-manager 有自己的可注入
// 时间源 now()，两边各读一次系统时钟会让「同一判定在同一刻给出两个答案」成为可能。
export function isRestorationContinuationGuardArmed(summary: RuntimeTaskSessionSummary, nowEpochMs: number): boolean {
	return (
		isRestorationContinuationGuardDeclaredArmedIgnoringMaximumArmedDuration(summary) &&
		!hasRestorationContinuationGuardOutlivedItsMaximumArmedDuration(summary, nowEpochMs)
	);
}

// ── park：「已 park、正在等待已派发后台工作」的唯一被认可判据 ────────────────────────────────
// 主 agent 以非 native 方式 dispatch 一个后台任务（例：把 reviewer 计划作为独立 Kanban 任务发出）后，结束自己
// 这一轮去等它完成。Claude 此刻只发一个裸 Stop（它不知道刚才那是子 agent，不发 SubagentStop），裸 Stop 经
// to_review 会被当成「等人审查」误发 ready-for-review 通知。parked 的主 agent 真相就是普通 running 三元组
// {turnOwner:"agent", liveness:"live", userTurnKind:null}——它**不是** user 回合，故无法用 facet 表达「在等后台、
// 别提醒」；改用一个 connectionRetry 式 sidecar `awaitingDispatchedBackgroundWork`（present = parked）表达。
//
// 本谓词是 gate（hook-event-task-transition-gate.ts 的 to_review 前置抑制）/ UI（task-card-body 抑制 computing 脉冲、
// 渲染 parked 徽标）/ RVF（is-parked 查询）/ session-manager（isAgentTurnActive、scanForStalls、shouldAutoRestart
// 四处空闲守卫）共用的**唯一** park 判据——读 sidecar 而非 facet（facet 仍是普通 agent 回合），故不绕开任何 facet
// 真相源。纯函数、读单字段，Node-dep-free（可被 web-ui 经 @runtime-session-activity 直接 import）。
export function isParkedAwaitingDispatchedBackgroundWork(
	summary: RuntimeTaskSessionSummary | null | undefined,
): boolean {
	return summary != null && summary.awaitingDispatchedBackgroundWork != null;
}

// ── 「停止生成响应后固定宽限期」回收：领域常量与纯判据 ────────────────────────────────────
// 完整设计与核验见 .plan/docs/cross-harness-agent-session-inactivity-grace-period-reclamation-
// and-pending-user-decision-carry-forward-implementation-plan.md。
//
// 与本文件既有五个时间常量的关系（全部保留、互不替代，切勿合并）：
//   2s  AGENT_OUTPUT_QUIET_THRESHOLD_MS            读 lastOutputAt        自动续跑注入门控
//   5s  VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS 读 lastSubstantiveOutputAt Validation 列自动打回
//   5min RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS      读 lastOutputAt        Active/Stale 二分
//   5min IDLE_STALL_AUTO_REVIEW_THRESHOLD_MS（session-manager） 读实质戳   停在提示符时自愈翻人回合
//   5h   本常量                                     读**离散停止事件**      回收 agent 进程 + 其 MCP 后代
// 关键区别：上面四个都读「时间戳新鲜度」，本常量读的是一次明确的状态转移（agentResponseGenerationStopped）。
// spinner 重绘会推进 lastOutputAt、实质分类器有节流窗口，二者都不表达「这一轮已经结束」。
//
// 5 小时统一适用于 task 会话、sidebar 项目会话（__home_agent__:*）、以及 error / interrupted / failed
// 等人回合——单一常数、零 per-kind 分档（用户拍板）。
export const AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS = 5 * 60 * 60_000;

// park 轨道的独立兜底上限（默认值）：park 不走上面的宽限期——它表示「主 agent 正在等自己派发的
// 后台工作」，那本就可能跑很久。24h 只是**未显式声明期限时**的兜底；`kanban task park --max-retention`
// / `--no-expiry` / `--renew` 可覆盖（见 park 兜底一节）。到期不静默杀，走可审计的 park_abandoned。
export const PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS = 24 * 60 * 60_000;

// 由「进入非生成态的时刻」算出「可回收时刻」。刻意返回绝对 epoch ms 而非剩余时长：
// 记录落盘后，Kanban / OS 停机期间流逝的墙钟时间自然计入，重启恢复时按同一口径判定。
export function computeAgentSessionRuntimeReclamationEligibleAt(
	retentionAnchorAt: number,
	gracePeriodMs: number = AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS,
): number {
	return retentionAnchorAt + gracePeriodMs;
}

// 是否已到可回收时刻。eligibleAt 为 null = 调用方显式声明「无期限」（park --no-expiry）⇒ 恒不到期。
// 取「大于等于」：恰好等于期限视为已到期（与上面新鲜度判据的「严格小于」互补，边界不重叠）。
export function isAgentSessionRuntimeReclamationDue(eligibleAt: number | null | undefined, nowMs: number): boolean {
	return eligibleAt !== null && eligibleAt !== undefined && nowMs >= eligibleAt;
}

// 保守判据：这个会话此刻是否仍被认为「在生成响应」（⇒ 绝不起算宽限期、任何既有期限立即作废）。
// agent 回合 = 球在 agent 那边，即便它其实卡死了也一律按仍在生成处理——宁可漏回收，不可杀掉正在
// 干活的会话。park 是例外：parked 的主 agent 真相是普通 agent 三元组，但它已经结束了自己这一轮，
// 走 park 独立轨道（见 PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS）。
export function isAgentSessionCurrentlyGeneratingResponse(
	facets: SessionFacets,
	summary: RuntimeTaskSessionSummary | null | undefined,
): boolean {
	return facets.turnOwner === "agent" && !isParkedAwaitingDispatchedBackgroundWork(summary);
}

// 停止信号的置信度标签。**纯诊断 / 展示用**：它不改变宽限期长度、不改变回收行为，只让「这一次停止是
// 靠什么信号看出来的」在账本、排查与卡片药丸上可见。因此这里读 reviewReason 是刻意的、且仅限于打标签——
// 任何**决策**仍只读 facet（见本文件 freshness 分层约定）。
//
// 放在 core 而非 server 的原因：写侧（mergeSummaryWithFacets 在停止边沿把它连同 stoppedAt 写进 summary）
// 与回收侧（agent-session-response-generation-stop-observer 落进期限账本）必须用**同一份**判定，
// 否则「卡片说是 harness_turn_complete、账本说是 prompt_ready_fallback」这类漂移迟早出现。
export function deriveAgentResponseGenerationStopSignalConfidence(
	summary: RuntimeTaskSessionSummary,
): RuntimeAgentResponseGenerationStopSignalConfidence {
	if ((summary.agentResponseGenerationTurnSequence ?? 0) === 0) {
		// 会话已就绪但从未开始过任何 agent 回合。锚点是「就绪」而非「产出过什么」——
		// 刻意不伪造一个 lastOutputAt 式的时间戳。
		return "session_ready_never_prompted";
	}
	if (isAgentAwaitingModalUserDecision(resolveSessionFacets(summary))) {
		return "structured_user_turn";
	}
	if (summary.reviewReason === "idle_stall") {
		// scanForStalls 的自愈兜底：harness 没给回合结束信号，靠「停在交互提示符 + 实质静默 5 分钟」推断。
		return "prompt_ready_fallback";
	}
	if (summary.reviewReason === "hook" || summary.reviewReason === "completion" || summary.reviewReason === "exit") {
		// harness 明确宣告了本轮结束（Claude Stop / Codex agent-turn-complete / Cline SDK 回合结束 / 进程退出）。
		return "harness_turn_complete";
	}
	return "structured_user_turn";
}

// 「这个会话此刻还占着值得回收的运行时资源吗」——即回收动作真有事可做。
// 只认 liveness==="live"：
//   - starting / retrying 只出现在 agent 回合，已被上面的「仍在生成」判据挡在门外；
//   - exited / failed / interrupted 表示 agent 进程侧已终结（终端 agent 完工退出后等人审查即属此列），
//     回收无进程可杀、无连接可关，起算宽限期只会产生噪音记录；
//   - none 表示压根没有会话。
// 这条判据同时天然处理了「进程重启后水合出的历史会话」：hydrateFromRecord 会把无法恢复的
// running-agent 声称对账掉，那些记录的 liveness 不是 live，于是不会被起算期限。
export function hasReclaimableAgentSessionRuntime(facets: SessionFacets): boolean {
	return facets.liveness === "live";
}

// 陈旧定时器防护：一条已落盘的回收期限记录，是否仍然说的是「当前这个活体的这一轮」。
// 双重判据（incarnation + turnSequence）缺一不可：
//   - incarnation 变了 ⇒ 会话被重启过，旧期限指向的是一个已经不存在的活体；
//   - incarnation 没变但 turnSequence 变了 ⇒ 同一活体内用户又发了一句、agent 已经继续跑过。
// 任一不匹配即返回 false，调用方必须放弃回收并把记录置 superseded。
export function isReclamationDeadlineStillCurrentForSession(
	deadline: { runtimeSessionIncarnationId: string; agentResponseGenerationTurnSequence: number },
	summary: RuntimeTaskSessionSummary | null | undefined,
): boolean {
	if (summary == null) {
		return false;
	}
	if (summary.runtimeSessionIncarnationId !== deadline.runtimeSessionIncarnationId) {
		return false;
	}
	return (summary.agentResponseGenerationTurnSequence ?? 0) === deadline.agentResponseGenerationTurnSequence;
}

// ── 展示叠加：把存储基值 liveness 的 "live" 按新鲜度细分为 computing / quiet ──────────────
// 双轴模型里 computing（仍在产出）/ quiet（活着但静默）是「随时间漂移的派生叠加」，故意不进存储/
// 不进 superRefine 枚举（summary 只在事件时广播、无周期 tick，存它一写即 stale）。本函数即计划所称
// 的 deriveLiveness：对 liveness==="live" 用共享新鲜度原语叠加出 computing|quiet，其余基值原样透传。
//
// **只供「有重渲染 tick」的展示型消费者**（board-card / agent-terminal-panel）。决策型消费者
// （通知、Validation 打回、active 判定、shutdown）**绝不读 computing/quiet**——它们只读事件置位的
// liveness 基值（见计划 freshness 分层）。本函数对任意 turnOwner 的 live 都会拆分；「computing 仅对
// agent 回合有意义」由消费者自行收窄（user 回合的 live=终端 agent 在 prompt 待命，不应被当作在算）。
export type SessionDisplayLiveness = Exclude<RuntimeTaskSessionLiveness, "live"> | "computing" | "quiet";

// 旧接口保留兼容；产品展示应使用 deriveSessionRecentEffectiveActivityDisplayLiveness。
export function deriveDisplayLiveness(
	facets: SessionFacets,
	lastOutputAt: number | null | undefined,
	nowMs: number,
	options: { activeWindowMs?: number } = {},
): SessionDisplayLiveness {
	if (facets.liveness !== "live") {
		return facets.liveness;
	}
	const activeWindowMs = options.activeWindowMs ?? VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS;
	return isAgentOutputWithinActiveWindow(lastOutputAt, nowMs, activeWindowMs) ? "computing" : "quiet";
}

// 展示的是可信活动的新鲜度，不能将其解释成模型此刻正在计算。
export type SessionRecentEffectiveActivityDisplayLiveness =
	| Exclude<RuntimeTaskSessionLiveness, "live">
	| "recent_effective_activity"
	| "quiet";

export function deriveSessionRecentEffectiveActivityDisplayLiveness(
	summary: RuntimeTaskSessionSummary,
	nowMs: number,
	options: { activeWindowMs?: number } = {},
): SessionRecentEffectiveActivityDisplayLiveness {
	const facets = resolveSessionFacets(summary);
	if (facets.liveness !== "live") return facets.liveness;
	return facets.turnOwner === "agent" &&
		isAgentOutputWithinActiveWindow(
			resolveLastEffectiveAgentConversationActivityObservation(summary)?.observedAtMs,
			nowMs,
			options.activeWindowMs ?? VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
		)
		? "recent_effective_activity"
		: "quiet";
}
