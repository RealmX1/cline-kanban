// PTY 退出后「要不要自动重启、退避多久、什么时候该彻底停手」的判定策略。
//
// 从 manager 里抽成**纯函数**：输入是上一代活了多久 / 连续失败数 / 两个滚动小时窗 / 当前时刻，
// 输出是一个判定，不碰计时器、不碰会话状态、不做 IO。理由是这套判定的全部风险都在极端时序上
// （慢环、快环、健康存活后又崩、贴顶熔断、熔断后人工解除），而那些时序在带计时器的实现里只能靠
// 等待与巧合去凑；抽成纯函数后可以直接重放。范式照抄 diagnostics/event-loop-delay-monitor.ts 的
// deriveEventLoopDelayDegradationReport。
//
// 为什么原来的限速器不够（它是本模块要替换掉的东西）：
//   - 它是「5 秒内最多 3 次」的滑动窗口，无退避、无总量上限。0.6 次/秒的理论上限恰好覆盖当年那次
//     故障的实测速率——也就是说，一个顶着限速器空转的任务完全解释得了 13 小时上万次 pty 创建。
//   - 更要命的是它对**慢环**完全无效：只要每轮周期超过 1.67 秒，窗口里永远凑不满 3 次，限速器一次
//     都不会触发，可以无限空转下去。
//
// 于是这里把两件事拆开：
//   - **节流**（退避）按「连续快退次数」指数增长，负责把快环拉开；
//   - **熔断**分三道，其中两道滚动小时上限**与存活时长无关**，专治退避拉不住的慢环。
//
import type { TaskSessionStartOrigin } from "../diagnostics/pty-session-spawn-attribution-probe";

// 「健康存活即清零」这条直觉必须避开：慢环里每一代都活得够久、每一代都判健康，清零的话连续计数
// 永远回不到阈值，熔断形同虚设。这里改成健康存活只让连续计数**衰减一格**。但要说清楚：衰减本身
// 也治不了慢环（慢环里计数压根不增长，减一是空转），真正治慢环的是滚动小时上限。

// 活够这个时长才算一次「健康启动」。
//
// 取 30 秒的依据：所有启动路径的时间常数都 ≤5 秒（claude-readiness.ts 的就绪超时 5_000、
// claude-workspace-trust.ts 的信任确认 100），30 秒留了 6 倍余量，不会把「启动慢但确实起来了」
// 误判成快退。另一头，30 秒门对应的最坏慢环是每小时 120 次，正落在 per-task 20 次/小时的射程内。
export const MINIMUM_PTY_LIFETIME_TO_COUNT_AS_HEALTHY_TASK_SESSION_START_MS = 30_000;

// 退避基数与上限。首次重启退避 0ms（见 deriveTaskSessionAutoRestartBackoffMs 的注释）。
export const AUTO_RESTART_BACKOFF_BASE_MS = 1_000;
export const AUTO_RESTART_BACKOFF_MAX_MS = 60_000;

// 连续多少次「快退后重启」之后彻底停手。配 0/0/1/2/4/8 秒的退避，累计约 15 秒即熔断；
// 同时给「用户手滑连按两三次重启」留出空间。
export const MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK = 5;

// per-task 的滚动小时上限，**与存活时长无关**。实测峰值是 1 次/小时，20 有 20 倍余量；
// 它同时是「刚好活过 30 秒门的慢环」（最坏 120 次/小时）的唯一兜底，不可省。
export const MAX_AUTO_RESTARTS_PER_TASK_PER_ROLLING_HOUR = 20;

// 进程级的滚动小时上限，**只数没通过存活门的那些重启**。
//
// 口径必须是 fast-exit 而不是「全部自动重启」：本机可达的并发 in_progress 上限是 36，一次合盖 /
// 网络中断 / 上游代理重启就可能同时产生数十次**合法**重启，按全量计数两波就掐死全进程的自愈能力，
// 而且健康任务会被无关任务饿死。只数 fast-exit 之后误伤面归零，60 这个值反而更严更准。
export const MAX_FAST_EXIT_AUTO_RESTARTS_ACROSS_ALL_TASKS_PER_ROLLING_HOUR = 60;

export const AUTO_RESTART_ROLLING_HOUR_WINDOW_MS = 60 * 60_000;

// 哪些启动来源算「人干预了」，从而可以给熔断计数清账。
//
// 刻意用白名单，而不是「来源不是 auto_restart_after_pty_exit 就算人干预」：前端有两条**自动**创建路径
// （陈旧会话自动续跑、Home 面板启动 effect），服务端还有一条 durable 重建续跑，它们都不是人点的。
// 用取反式判据的话，这三条每跑一次就把熔断计数清一次——等于给「反复自动续跑」这种成环形态发了一张
// 永久免熔断通行证，而那恰恰是本轮嫌疑最大的形态之一。
//
// 反过来，人因入口必须**能**解除熔断：三条人因入口此前一条都不复位计数，而 manager 的 entries 全仓
// 没有 delete/clear，熔断态会一直挂到进程重启，用户按刷新按不动它。
export function doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak(
	taskSessionStartOrigin: TaskSessionStartOrigin,
): boolean {
	switch (taskSessionStartOrigin) {
		case "external_entry_point":
		case "refresh_task_terminal":
		case "resume_reclaimed_task_session_for_pending_user_decision_answer_delivery":
			return true;
		case "auto_restart_after_pty_exit":
		case "stale_session_client_auto_resume":
		case "home_agent_panel_auto_start":
		case "durable_record_rebuilt_resume":
			return false;
	}
}

export type TaskSessionAutoRestartCircuitBreakReason =
	| "consecutive_fast_exit_auto_restarts_exhausted"
	| "per_task_rolling_hour_auto_restart_cap_reached"
	| "all_tasks_rolling_hour_fast_exit_auto_restart_cap_reached";

export interface TaskSessionAutoRestartDecisionInput {
	// 刚退出的那一代活了多久。null = 无从判断（该代从未装载完成），按**不健康**处理：
	// 一条连装载都没走完就死掉的会话，正是最该被计入失败的那种。
	previousIncarnationLifetimeMs: number | null;
	consecutiveFailedFastExitAutoRestartCount: number;
	// 两个窗口都必须由调用方先按 AUTO_RESTART_ROLLING_HOUR_WINDOW_MS 裁剪过（用 pruneAutoRestart…）。
	recentAutoRestartTimestampsForThisTaskWithinRollingHour: readonly number[];
	recentFastExitAutoRestartTimestampsAcrossAllTasksWithinRollingHour: readonly number[];
}

export type TaskSessionAutoRestartDecision =
	| {
			kind: "restart_after_backoff";
			backoffMs: number;
			previousIncarnationCountsAsHealthy: boolean;
			nextConsecutiveFailedFastExitAutoRestartCount: number;
	  }
	| {
			kind: "circuit_broken";
			circuitBreakReason: TaskSessionAutoRestartCircuitBreakReason;
			previousIncarnationCountsAsHealthy: boolean;
			nextConsecutiveFailedFastExitAutoRestartCount: number;
	  };

export function pruneAutoRestartTimestampsToRollingHour(
	timestamps: readonly number[],
	currentTimeEpochMs: number,
): number[] {
	return timestamps.filter((timestamp) => currentTimeEpochMs - timestamp < AUTO_RESTART_ROLLING_HOUR_WINDOW_MS);
}

// 首次重启退避 0ms 是有意的：崩溃瞬间自愈是现有的 UX，也让既有的两条自动重启用例无需改动。
// 从第 2 次连续快退起 1/2/4/8… 秒指数增长，已足够把任何快环拉开到人能察觉、日志能看清的程度。
export function deriveTaskSessionAutoRestartBackoffMs(nextConsecutiveFailedFastExitAutoRestartCount: number): number {
	if (nextConsecutiveFailedFastExitAutoRestartCount <= 1) {
		return 0;
	}
	return Math.min(
		AUTO_RESTART_BACKOFF_BASE_MS * 2 ** (nextConsecutiveFailedFastExitAutoRestartCount - 2),
		AUTO_RESTART_BACKOFF_MAX_MS,
	);
}

export function deriveTaskSessionAutoRestartDecision(
	input: TaskSessionAutoRestartDecisionInput,
): TaskSessionAutoRestartDecision {
	const previousIncarnationCountsAsHealthy =
		input.previousIncarnationLifetimeMs !== null &&
		input.previousIncarnationLifetimeMs >= MINIMUM_PTY_LIFETIME_TO_COUNT_AS_HEALTHY_TASK_SESSION_START_MS;

	// 健康存活只**衰减一格**，不清零：清零会让慢环（每代都活得够久、每代都判健康）里的连续计数
	// 永远回不到阈值。但衰减本身也治不了慢环——慢环里计数压根不增长，减一是空转；治慢环的是下面
	// 那两道与存活时长无关的滚动小时上限。
	const nextConsecutiveFailedFastExitAutoRestartCount = previousIncarnationCountsAsHealthy
		? Math.max(0, input.consecutiveFailedFastExitAutoRestartCount - 1)
		: input.consecutiveFailedFastExitAutoRestartCount + 1;

	// 顺序有讲究：两道小时上限排在连续计数之前判。它们与存活时长无关，是慢环唯一的兜底，
	// 而慢环恰恰永远走不到连续计数那一格。
	if (
		input.recentAutoRestartTimestampsForThisTaskWithinRollingHour.length >=
		MAX_AUTO_RESTARTS_PER_TASK_PER_ROLLING_HOUR
	) {
		return {
			kind: "circuit_broken",
			circuitBreakReason: "per_task_rolling_hour_auto_restart_cap_reached",
			previousIncarnationCountsAsHealthy,
			nextConsecutiveFailedFastExitAutoRestartCount,
		};
	}
	if (
		!previousIncarnationCountsAsHealthy &&
		input.recentFastExitAutoRestartTimestampsAcrossAllTasksWithinRollingHour.length >=
			MAX_FAST_EXIT_AUTO_RESTARTS_ACROSS_ALL_TASKS_PER_ROLLING_HOUR
	) {
		return {
			kind: "circuit_broken",
			circuitBreakReason: "all_tasks_rolling_hour_fast_exit_auto_restart_cap_reached",
			previousIncarnationCountsAsHealthy,
			nextConsecutiveFailedFastExitAutoRestartCount,
		};
	}
	if (
		nextConsecutiveFailedFastExitAutoRestartCount >
		MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK
	) {
		return {
			kind: "circuit_broken",
			circuitBreakReason: "consecutive_fast_exit_auto_restarts_exhausted",
			previousIncarnationCountsAsHealthy,
			nextConsecutiveFailedFastExitAutoRestartCount,
		};
	}

	return {
		kind: "restart_after_backoff",
		backoffMs: deriveTaskSessionAutoRestartBackoffMs(nextConsecutiveFailedFastExitAutoRestartCount),
		previousIncarnationCountsAsHealthy,
		nextConsecutiveFailedFastExitAutoRestartCount,
	};
}

export function describeTaskSessionAutoRestartCircuitBreak(reason: TaskSessionAutoRestartCircuitBreakReason): string {
	switch (reason) {
		case "consecutive_fast_exit_auto_restarts_exhausted":
			return `会话连续 ${MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK} 次启动后都在 ${Math.round(MINIMUM_PTY_LIFETIME_TO_COUNT_AS_HEALTHY_TASK_SESSION_START_MS / 1000)} 秒内退出，已停止自动重启。请手动刷新终端。`;
		case "per_task_rolling_hour_auto_restart_cap_reached":
			return `该任务一小时内已自动重启 ${MAX_AUTO_RESTARTS_PER_TASK_PER_ROLLING_HOUR} 次，已停止自动重启。请手动刷新终端。`;
		case "all_tasks_rolling_hour_fast_exit_auto_restart_cap_reached":
			return `本进程一小时内的秒退自动重启已达 ${MAX_FAST_EXIT_AUTO_RESTARTS_ACROSS_ALL_TASKS_PER_ROLLING_HOUR} 次，已停止自动重启。请手动刷新终端。`;
	}
}
