// 盯梢：续跑因对话被 harness 后台会话（Claude `/background` 或空输入框按 ←）占着、当时不能安全收回而被拒后，等它能安全收回时
// 自动再续一次（用户选定的「自动盯梢 + 一键接管」里的前一半；判据见
// claude-code-background-session-ownership-preflight-before-resume.ts）。
//
// 每一拍只观察、不动手：能安全收回（或已不被占着）就把被拒那一次的启动请求交回启动漏斗——真正的 `claude stop`
// 由漏斗里的预检执行，判据只有一份。不能就记下最新原因（busy → waiting 之类的变化要让终端面板看得见），等下一拍。
//
// 状态挂在 session manager 的每个会话条目上（三个字段同生同灭：武装时一起写、取消时一起清；另有一个只增不减的
// 取消代际，给已交给启动链、还在排队的那次续跑复查用），取消点与自动重启
// 同源：人工 start / stop / refresh、manager 关停，以及预检放行。运行时重启后不恢复（计时器只在内存里），由
// hydrate 把观测上的「正在盯」复位，下次续跑被拒时重新武装。

import type { RuntimeAgentNativeConversationHeldByHarnessBackgroundSessionObservation } from "../core/api-contract";
import type { ClaudeCodeResumeTargetBackgroundSessionReclaimability } from "./claude-code-background-session-ownership-preflight-before-resume";

// 每拍一次 `claude agents --json`（实测 0.14s），idle 时再加一次 `claude logs`。
// EXPERIMENT_NODE: 盯梢间隔 5s / 时限 2h——间隔越短接回越快但空转越多；时限过后要等用户再打开这张卡才重新武装。
const HARNESS_BACKGROUND_SESSION_RECLAIM_WATCH_POLL_INTERVAL_MS = 5_000;
const HARNESS_BACKGROUND_SESSION_RECLAIM_WATCH_MAXIMUM_DURATION_MS = 2 * 60 * 60 * 1_000;

export interface HarnessBackgroundSessionReclaimWatchState<TWatchedStartRequest> {
	pendingTickTimer: NodeJS.Timeout | null;
	deadlineAt: number | null;
	// 被拒那一次的启动请求快照；到点就原样交回启动漏斗。
	watchedTaskSessionStartRequest: TWatchedStartRequest | null;
	// 每次取消 +1。交给启动链的那次续跑要排队等 per-task 启动闸门，排队期间的取消（人工 stop / 关停）
	// 清得掉上面三个字段，却拦不住已经排进链里的那一次——它拿到闸门后靠比对这个代际自行放弃。
	// 与 session manager 上自动重启的 autoRestartCancellationGeneration 同一个形状。
	watchCancellationGeneration: number;
}

export function createIdleHarnessBackgroundSessionReclaimWatchState<
	TWatchedStartRequest,
>(): HarnessBackgroundSessionReclaimWatchState<TWatchedStartRequest> {
	return {
		pendingTickTimer: null,
		deadlineAt: null,
		watchedTaskSessionStartRequest: null,
		watchCancellationGeneration: 0,
	};
}

export interface HarnessBackgroundSessionReclaimWatchDependencies<TWatchedStartRequest> {
	readCurrentObservation(): RuntimeAgentNativeConversationHeldByHarnessBackgroundSessionObservation | null | undefined;
	publishObservation(observation: RuntimeAgentNativeConversationHeldByHarnessBackgroundSessionObservation): void;
	// null = 守护进程客户端没注入，盯不了。
	inspectReclaimability(input: {
		watchedTaskSessionStartRequest: TWatchedStartRequest;
		resumeTargetNativeSessionId: string;
	}): Promise<ClaudeCodeResumeTargetBackgroundSessionReclaimability> | null;
	// 实现方必须在拿到启动闸门之后、做任何销毁或 spawn 之前调一次 isWatchStillNotCancelledSinceHandoff，
	// 返回 false（排队期间盯梢被取消了）就放弃这次启动。
	startWatchedTaskSession(
		watchedTaskSessionStartRequest: TWatchedStartRequest,
		isWatchStillNotCancelledSinceHandoff: () => boolean,
	): Promise<unknown>;
	logWarning(message: string): void;
	now(): number;
}

// 武装（已在盯就只换成最新被拒的那次请求，时限不顺延）。
export function armHarnessBackgroundSessionReclaimWatch<TWatchedStartRequest>(
	state: HarnessBackgroundSessionReclaimWatchState<TWatchedStartRequest>,
	watchedTaskSessionStartRequest: TWatchedStartRequest,
	dependencies: HarnessBackgroundSessionReclaimWatchDependencies<TWatchedStartRequest>,
): void {
	state.watchedTaskSessionStartRequest = watchedTaskSessionStartRequest;
	state.deadlineAt ??= dependencies.now() + HARNESS_BACKGROUND_SESSION_RECLAIM_WATCH_MAXIMUM_DURATION_MS;
	if (state.pendingTickTimer === null) {
		scheduleHarnessBackgroundSessionReclaimWatchTick(state, dependencies);
	}
}

export function cancelHarnessBackgroundSessionReclaimWatch<TWatchedStartRequest>(
	state: HarnessBackgroundSessionReclaimWatchState<TWatchedStartRequest>,
): void {
	if (state.pendingTickTimer !== null) {
		clearTimeout(state.pendingTickTimer);
		state.pendingTickTimer = null;
	}
	state.deadlineAt = null;
	state.watchedTaskSessionStartRequest = null;
	state.watchCancellationGeneration += 1;
}

function scheduleHarnessBackgroundSessionReclaimWatchTick<TWatchedStartRequest>(
	state: HarnessBackgroundSessionReclaimWatchState<TWatchedStartRequest>,
	dependencies: HarnessBackgroundSessionReclaimWatchDependencies<TWatchedStartRequest>,
): void {
	state.pendingTickTimer = setTimeout(() => {
		state.pendingTickTimer = null;
		void runHarnessBackgroundSessionReclaimWatchTick(state, dependencies);
	}, HARNESS_BACKGROUND_SESSION_RECLAIM_WATCH_POLL_INTERVAL_MS);
}

async function runHarnessBackgroundSessionReclaimWatchTick<TWatchedStartRequest>(
	state: HarnessBackgroundSessionReclaimWatchState<TWatchedStartRequest>,
	dependencies: HarnessBackgroundSessionReclaimWatchDependencies<TWatchedStartRequest>,
): Promise<void> {
	const watchedTaskSessionStartRequest = state.watchedTaskSessionStartRequest;
	const deadlineAt = state.deadlineAt;
	const observation = dependencies.readCurrentObservation();
	if (!watchedTaskSessionStartRequest || deadlineAt === null || !observation) {
		cancelHarnessBackgroundSessionReclaimWatch(state);
		return;
	}
	if (dependencies.now() >= deadlineAt) {
		cancelHarnessBackgroundSessionReclaimWatch(state);
		dependencies.publishObservation({
			...observation,
			automaticReclaimWatchActive: false,
			observedAt: dependencies.now(),
		});
		return;
	}
	const pendingInspection = dependencies.inspectReclaimability({
		watchedTaskSessionStartRequest,
		resumeTargetNativeSessionId: observation.nativeSessionId,
	});
	if (!pendingInspection) {
		cancelHarnessBackgroundSessionReclaimWatch(state);
		return;
	}
	const reclaimability = await pendingInspection;
	// await 期间被取消（人工 start / stop / 关停）就到此为止。
	if (state.watchedTaskSessionStartRequest !== watchedTaskSessionStartRequest) {
		return;
	}
	const readyToResume =
		reclaimability.kind === "resume_target_not_held_by_live_background_session" ||
		(reclaimability.kind === "resume_target_held_by_live_background_session" &&
			reclaimability.reclaimSafety.safeToReclaim);
	if (readyToResume) {
		const watchCancellationGenerationAtHandoff = state.watchCancellationGeneration;
		const isWatchStillNotCancelledSinceHandoff = () =>
			state.watchCancellationGeneration === watchCancellationGenerationAtHandoff;
		dependencies
			.startWatchedTaskSession(watchedTaskSessionStartRequest, isWatchStillNotCancelledSinceHandoff)
			.catch((error) => {
				dependencies.logWarning(
					`[tui-freeze] harness-background-session-reclaim-watch-auto-resume-failed error=${error instanceof Error ? error.message : String(error)}`,
				);
			});
		return;
	}
	if (
		reclaimability.kind === "resume_target_held_by_live_background_session" &&
		!reclaimability.reclaimSafety.safeToReclaim &&
		reclaimability.reclaimSafety.reclaimBlockedReason !== observation.reclaimBlockedReason
	) {
		dependencies.publishObservation({
			...observation,
			reclaimBlockedReason: reclaimability.reclaimSafety.reclaimBlockedReason,
			observedAt: dependencies.now(),
		});
	}
	scheduleHarnessBackgroundSessionReclaimWatchTick(state, dependencies);
}
