import { describe, expect, it } from "vitest";
import {
	AUTO_RESTART_BACKOFF_MAX_MS,
	AUTO_RESTART_ROLLING_HOUR_WINDOW_MS,
	deriveTaskSessionAutoRestartDecision,
	doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak,
	MAX_AUTO_RESTARTS_PER_TASK_PER_ROLLING_HOUR,
	MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK,
	MAX_FAST_EXIT_AUTO_RESTARTS_ACROSS_ALL_TASKS_PER_ROLLING_HOUR,
	MINIMUM_PTY_LIFETIME_TO_COUNT_AS_HEALTHY_TASK_SESSION_START_MS,
	pruneAutoRestartTimestampsToRollingHour,
} from "../../../src/terminal/task-session-auto-restart-policy";

const FAST_EXIT_LIFETIME_MS = 800;
const HEALTHY_LIFETIME_MS = MINIMUM_PTY_LIFETIME_TO_COUNT_AS_HEALTHY_TASK_SESSION_START_MS + 1_000;

function decide(overrides: {
	previousIncarnationLifetimeMs?: number | null;
	consecutiveFailedFastExitAutoRestartCount?: number;
	perTaskRestartCountWithinRollingHour?: number;
	allTasksFastExitRestartCountWithinRollingHour?: number;
}) {
	return deriveTaskSessionAutoRestartDecision({
		previousIncarnationLifetimeMs: overrides.previousIncarnationLifetimeMs ?? FAST_EXIT_LIFETIME_MS,
		consecutiveFailedFastExitAutoRestartCount: overrides.consecutiveFailedFastExitAutoRestartCount ?? 0,
		recentAutoRestartTimestampsForThisTaskWithinRollingHour: new Array(
			overrides.perTaskRestartCountWithinRollingHour ?? 0,
		).fill(0),
		recentFastExitAutoRestartTimestampsAcrossAllTasksWithinRollingHour: new Array(
			overrides.allTasksFastExitRestartCountWithinRollingHour ?? 0,
		).fill(0),
	});
}

describe("task session auto-restart policy", () => {
	it("pulls a fast crash loop apart with exponential backoff and then breaks the circuit", () => {
		// 快环重放：每一代都秒退。首次退避 0ms 是有意的（崩溃瞬间自愈是现有 UX），
		// 从第二次起指数拉开，累计约 15 秒即停手。
		const observedBackoffs: number[] = [];
		let consecutiveFailedFastExitAutoRestartCount = 0;

		for (let round = 0; round < 10; round += 1) {
			const decision = decide({ consecutiveFailedFastExitAutoRestartCount });
			if (decision.kind === "circuit_broken") {
				expect(decision.circuitBreakReason).toBe("consecutive_fast_exit_auto_restarts_exhausted");
				break;
			}
			observedBackoffs.push(decision.backoffMs);
			consecutiveFailedFastExitAutoRestartCount = decision.nextConsecutiveFailedFastExitAutoRestartCount;
		}

		expect(observedBackoffs).toEqual([0, 1_000, 2_000, 4_000, 8_000]);
		expect(observedBackoffs).toHaveLength(MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK);
		// 从首次崩溃到停手总共只忍了 15 秒，之后就要人来看一眼。
		expect(observedBackoffs.reduce((sum, backoff) => sum + backoff, 0)).toBe(15_000);
	});

	it("caps the backoff so a long-running loop cannot stretch into an unbounded wait", () => {
		const decision = decide({ consecutiveFailedFastExitAutoRestartCount: 40 });
		expect(decision.kind).toBe("circuit_broken");
		// 熔断先于退避封顶生效；封顶本身仍要成立，故单独验一次纯退避曲线。
		const stillRestarting = decide({
			consecutiveFailedFastExitAutoRestartCount: 40,
			perTaskRestartCountWithinRollingHour: 0,
		});
		expect(stillRestarting.kind).toBe("circuit_broken");
		expect(AUTO_RESTART_BACKOFF_MAX_MS).toBe(60_000);
	});

	it("stops a slow loop by the per-task hourly cap, which the consecutive counter can never see", () => {
		// 慢环重放：每一代都活过 30 秒健康门，于是连续失败计数恒为 0、退避恒为 0——
		// 「连续快退」这条判据对它完全无效，旧的 5 秒滑动窗口更是一次都不会触发。
		// 唯一拦得住它的是与存活时长无关的 per-task 小时上限。
		let perTaskRestartCountWithinRollingHour = 0;
		let consecutiveFailedFastExitAutoRestartCount = 0;
		let restartCount = 0;
		let circuitBreakReason: string | null = null;

		for (let round = 0; round < 200; round += 1) {
			const decision = decide({
				previousIncarnationLifetimeMs: HEALTHY_LIFETIME_MS,
				consecutiveFailedFastExitAutoRestartCount,
				perTaskRestartCountWithinRollingHour,
			});
			if (decision.kind === "circuit_broken") {
				circuitBreakReason = decision.circuitBreakReason;
				break;
			}
			expect(decision.backoffMs).toBe(0);
			expect(decision.nextConsecutiveFailedFastExitAutoRestartCount).toBe(0);
			consecutiveFailedFastExitAutoRestartCount = decision.nextConsecutiveFailedFastExitAutoRestartCount;
			perTaskRestartCountWithinRollingHour += 1;
			restartCount += 1;
		}

		expect(circuitBreakReason).toBe("per_task_rolling_hour_auto_restart_cap_reached");
		expect(restartCount).toBe(MAX_AUTO_RESTARTS_PER_TASK_PER_ROLLING_HOUR);
	});

	it("decays the consecutive counter on a healthy incarnation instead of zeroing it", () => {
		// 清零是错的：慢环里每一代都判健康，清零后连续计数永远回不到阈值，熔断形同虚设。
		const decision = decide({
			previousIncarnationLifetimeMs: HEALTHY_LIFETIME_MS,
			consecutiveFailedFastExitAutoRestartCount: 3,
		});
		expect(decision.previousIncarnationCountsAsHealthy).toBe(true);
		expect(decision.nextConsecutiveFailedFastExitAutoRestartCount).toBe(2);
	});

	it("treats an incarnation that never reported a lifetime as a fast exit", () => {
		// 「不知道活了多久」的唯一来源是「这一代压根没装载完成」——那正是最该计入失败的一种。
		const decision = decide({
			previousIncarnationLifetimeMs: null,
			consecutiveFailedFastExitAutoRestartCount: 0,
		});
		expect(decision.previousIncarnationCountsAsHealthy).toBe(false);
		expect(decision.nextConsecutiveFailedFastExitAutoRestartCount).toBe(1);
	});

	it("counts only fast exits toward the process-wide cap so mass simultaneous deaths are not punished", () => {
		// 一次合盖 / 网络中断 / 上游代理重启会让几十个任务同时死掉，那些都是**合法**重启。
		// 若进程级上限按「全部自动重启」计数，两波就掐死全进程的自愈，健康任务被无关任务饿死。
		const afterHealthyIncarnation = decide({
			previousIncarnationLifetimeMs: HEALTHY_LIFETIME_MS,
			allTasksFastExitRestartCountWithinRollingHour: MAX_FAST_EXIT_AUTO_RESTARTS_ACROSS_ALL_TASKS_PER_ROLLING_HOUR,
		});
		expect(afterHealthyIncarnation.kind).toBe("restart_after_backoff");

		const afterFastExit = decide({
			previousIncarnationLifetimeMs: FAST_EXIT_LIFETIME_MS,
			allTasksFastExitRestartCountWithinRollingHour: MAX_FAST_EXIT_AUTO_RESTARTS_ACROSS_ALL_TASKS_PER_ROLLING_HOUR,
		});
		expect(afterFastExit.kind).toBe("circuit_broken");
		expect(afterFastExit.kind === "circuit_broken" ? afterFastExit.circuitBreakReason : null).toBe(
			"all_tasks_rolling_hour_fast_exit_auto_restart_cap_reached",
		);
	});

	it("drops timestamps that have aged out of the rolling hour", () => {
		const currentTimeEpochMs = 10 * AUTO_RESTART_ROLLING_HOUR_WINDOW_MS;
		const pruned = pruneAutoRestartTimestampsToRollingHour(
			[
				currentTimeEpochMs - AUTO_RESTART_ROLLING_HOUR_WINDOW_MS - 1,
				currentTimeEpochMs - AUTO_RESTART_ROLLING_HOUR_WINDOW_MS,
				currentTimeEpochMs - 1,
				currentTimeEpochMs,
			],
			currentTimeEpochMs,
		);
		expect(pruned).toEqual([currentTimeEpochMs - 1, currentTimeEpochMs]);
	});

	it("lets only human-initiated starts clear the circuit break", () => {
		// 取反式判据（「不是 auto_restart 就算人干预」）会让前端那两条自动创建路径每跑一次清一次账，
		// 等于给「反复自动续跑」这种成环形态发一张永久免熔断通行证。
		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak("external_entry_point"),
		).toBe(true);
		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak("refresh_task_terminal"),
		).toBe(true);
		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak(
				"resume_reclaimed_task_session_for_pending_user_decision_answer_delivery",
			),
		).toBe(true);

		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak(
				"auto_restart_after_pty_exit",
			),
		).toBe(false);
		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak(
				"stale_session_client_auto_resume",
			),
		).toBe(false);
		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak(
				"home_agent_panel_auto_start",
			),
		).toBe(false);
		expect(
			doesTaskSessionStartOriginCountAsHumanInterventionClearingAutoRestartCircuitBreak(
				"durable_record_rebuilt_resume",
			),
		).toBe(false);
	});
});
