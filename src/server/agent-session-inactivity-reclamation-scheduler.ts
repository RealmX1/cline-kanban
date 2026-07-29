// 会话回收调度器：按固定 tick 扫描 durable 期限账本，对到期且仍然有效的记录执行回收。
//
// 三条刻意的设计决定：
//  1. **单一 setInterval 而非每 task 一个 timer**。task 数量无上界，per-task timer 意味着无上界的
//     timer 与 unref 管理；tick 时按账本快照批量判定更简单，也天然能处理「进程重启后账本里躺着一堆
//     早已到期的记录」。
//  2. **账本里存的是绝对 eligibleAt**，所以 Kanban / OS 停机期间流逝的墙钟时间自然计入——重启恢复
//     不需要任何补偿逻辑，扫描到「已过期」直接执行即可。
//  3. **陈旧定时器双重防护**：真正动手前重新比对 (incarnationId, turnSequence) 与当前 summary，并复查
//     该会话此刻是否仍处于计时态。任一不匹配一律置 superseded 并放弃回收——宁可漏回收，绝不误杀一个
//     已经继续跑起来的会话。
import type { RuntimeAgentSessionReclamationOutcome, RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	isAgentSessionRuntimeReclamationDue,
	isReclamationDeadlineStillCurrentForSession,
} from "../core/session-activity";
import {
	logAgentSessionRetentionInfo,
	logAgentSessionRetentionWarning,
} from "../diagnostics/agent-session-retention-logger";
import { markAgentRaisedPendingUserDecisionsReclaimed } from "../state/agent-raised-pending-user-decision-store";
import {
	isLiveAgentSessionReclamationState,
	type PersistedAgentSessionReclamationDeadlineRecord,
	readAllAgentSessionReclamationDeadlineRecords,
	supersedeAgentSessionRetentionDeadlinesForTask,
	updateAgentSessionReclamationProgress,
} from "../state/agent-session-reclamation-deadline-store";
import { isAgentSessionRetentionDeadlineBearing } from "./agent-session-response-generation-stop-observer";

// tick 间隔：1 小时的宽限期下，60 秒的判定粒度绰绰有余，而扫描成本（每 workspace 读一个小 JSON）
// 可以忽略。刻意不做成可配置——粒度不是产品决策。
export const AGENT_SESSION_RECLAMATION_SWEEP_INTERVAL_MS = 60_000;

// 回收失败后的指数退避：4s 起步、逐次翻倍、30 分钟封顶。封顶是为了让「宿主机层面卡住的僵尸进程」
// 保持低频重试而不是永久刷日志。
const RECLAIM_RETRY_INITIAL_BACKOFF_MS = 4_000;
const RECLAIM_RETRY_MAX_BACKOFF_MS = 30 * 60_000;

export function computeReclaimRetryBackoffMs(attemptCount: number): number {
	const exponent = Math.max(0, attemptCount - 1);
	// 2 ** exponent 在 attemptCount 很大时会溢出成 Infinity，Math.min 仍然给出封顶值，故无需额外守卫。
	return Math.min(RECLAIM_RETRY_INITIAL_BACKOFF_MS * 2 ** exponent, RECLAIM_RETRY_MAX_BACKOFF_MS);
}

export interface AgentSessionReclamationRequest {
	workspaceId: string;
	record: PersistedAgentSessionReclamationDeadlineRecord;
	summary: RuntimeTaskSessionSummary;
	attemptedAt: number;
}

export type AgentSessionReclamationExecutor = (
	request: AgentSessionReclamationRequest,
) => Promise<RuntimeAgentSessionReclamationOutcome>;

// 一次扫描的结果，供测试断言与诊断日志使用（不落盘——账本里已有逐条记录）。
export interface AgentSessionReclamationSweepResult {
	inspectedRecordCount: number;
	skippedNotDueCount: number;
	skippedBackoffCount: number;
	supersededStaleCount: number;
	reclaimedCount: number;
	failedCount: number;
}

function createEmptySweepResult(): AgentSessionReclamationSweepResult {
	return {
		inspectedRecordCount: 0,
		skippedNotDueCount: 0,
		skippedBackoffCount: 0,
		supersededStaleCount: 0,
		reclaimedCount: 0,
		failedCount: 0,
	};
}

export interface CreateAgentSessionInactivityReclamationSchedulerOptions {
	// 按 workspaceId + taskId 取当前内存里的会话 summary。返回 null = 该会话已不在内存中
	// （服务重启、项目被移除、会话已被清理）⇒ 没有可回收的运行时，记录置 superseded。
	getTaskSessionSummary: (workspaceId: string, taskId: string) => RuntimeTaskSessionSummary | null;
	reclaimAgentSession: AgentSessionReclamationExecutor;
	now?: () => number;
	sweepIntervalMs?: number;
	readAllDeadlineRecords?: typeof readAllAgentSessionReclamationDeadlineRecords;
	updateReclamationProgress?: typeof updateAgentSessionReclamationProgress;
	supersedeRetentionDeadlines?: typeof supersedeAgentSessionRetentionDeadlinesForTask;
	markPendingUserDecisionsReclaimed?: typeof markAgentRaisedPendingUserDecisionsReclaimed;
	onReclamationOutcome?: (input: {
		workspaceId: string;
		record: PersistedAgentSessionReclamationDeadlineRecord;
		outcome: RuntimeAgentSessionReclamationOutcome;
	}) => void;
}

export interface AgentSessionInactivityReclamationScheduler {
	// 启动：立即跑一次扫描（重启恢复），随后按 tick 周期扫描。
	start(): void;
	stop(): void;
	// 测试与手动触发用：跑一次扫描并返回统计。
	runSweepNow(): Promise<AgentSessionReclamationSweepResult>;
}

export function createAgentSessionInactivityReclamationScheduler(
	options: CreateAgentSessionInactivityReclamationSchedulerOptions,
): AgentSessionInactivityReclamationScheduler {
	const now = options.now ?? (() => Date.now());
	const sweepIntervalMs = options.sweepIntervalMs ?? AGENT_SESSION_RECLAMATION_SWEEP_INTERVAL_MS;
	const readAllDeadlineRecords = options.readAllDeadlineRecords ?? readAllAgentSessionReclamationDeadlineRecords;
	const updateReclamationProgress = options.updateReclamationProgress ?? updateAgentSessionReclamationProgress;
	const supersedeRetentionDeadlines =
		options.supersedeRetentionDeadlines ?? supersedeAgentSessionRetentionDeadlinesForTask;
	const markPendingUserDecisionsReclaimed =
		options.markPendingUserDecisionsReclaimed ?? markAgentRaisedPendingUserDecisionsReclaimed;

	let sweepTimer: NodeJS.Timeout | null = null;
	// 单次扫描可能跨越多个 await（读账本、执行回收），必须防止 tick 重入把同一条记录回收两次。
	let inFlightSweep: Promise<AgentSessionReclamationSweepResult> | null = null;

	const supersedeStaleRecord = async (
		workspaceId: string,
		record: PersistedAgentSessionReclamationDeadlineRecord,
		reason: string,
		nowMs: number,
	): Promise<void> => {
		logAgentSessionRetentionInfo(
			`stale-deadline-superseded workspaceId=${workspaceId} taskId=${record.taskId} recordId=${record.recordId} reason=${reason}`,
		);
		await supersedeRetentionDeadlines(workspaceId, record.taskId, nowMs);
	};

	// 计划 §7.2 的「回收前标记」：把该 task 所有 status==="pending" 的待答决策标上 reclaimedAt，
	// 于是 UI 与答案投递侧能区分「提问它的会话还活着、可以直接答」与「会话已被回收、必须先恢复再投递」。
	//
	// 刻意放在**动手回收之前**、且**不区分回收成败**，方向是「宁可多标、绝不漏标」：
	//  - 漏标（先杀后标，中间崩溃 / 标记失败）会让下游误以为还能直接投递给一个已经死掉的会话，
	//    答案静默丢失；
	//  - 多标（回收最终判失败、进程侥幸还在）最坏只是多做一次会话恢复。何况三种 transport 的失败态
	//    都发生在「SIGTERM/SIGKILL 或 stop 会话已经执行过」之后，那个会话本来就不再可依赖。
	// 标记本身是幂等的（只改 reclaimedAt===null 的 pending 记录），故 reclaiming 重跑不会覆盖首次时刻。
	//
	// 该函数写盘，失败绝不允许掀翻回收流程：捕获后只记一行结构化诊断（隐私红线：不含问题正文 /
	// 选项 / 工具参数正文）。
	const markPendingUserDecisionsAsReclaimed = async (
		workspaceId: string,
		taskId: string,
		reclaimedAt: number,
	): Promise<void> => {
		try {
			const markedDecisionCount = await markPendingUserDecisionsReclaimed(workspaceId, taskId, reclaimedAt);
			if (markedDecisionCount > 0) {
				logAgentSessionRetentionInfo(
					`pending-user-decisions-marked-reclaimed workspaceId=${workspaceId} taskId=${taskId} markedCount=${markedDecisionCount}`,
				);
			}
		} catch (error) {
			logAgentSessionRetentionWarning(
				`pending-user-decision-reclaim-marking-failed workspaceId=${workspaceId} taskId=${taskId} reason=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	};

	const reclaimOneRecord = async (
		workspaceId: string,
		record: PersistedAgentSessionReclamationDeadlineRecord,
		summary: RuntimeTaskSessionSummary,
		result: AgentSessionReclamationSweepResult,
		nowMs: number,
	): Promise<void> => {
		// 本次是第几次尝试。**必须在写账本之前算好**：账本实现可能返回同一个记录对象，
		// 事后再读 record.reclamationAttemptCount 会把已经自增过的值又加一次，退避时长直接翻倍。
		const attemptCount = record.reclamationAttemptCount + 1;
		// 先落 reclaiming：进程若在回收中途崩溃，重启扫描看到这个状态就知道要重跑幂等回收。
		await updateReclamationProgress(workspaceId, record.recordId, {
			reclamationState: "reclaiming",
			updatedAt: nowMs,
			incrementAttemptCount: true,
		});
		await markPendingUserDecisionsAsReclaimed(workspaceId, record.taskId, nowMs);
		let outcome: RuntimeAgentSessionReclamationOutcome;
		try {
			outcome = await options.reclaimAgentSession({ workspaceId, record, summary, attemptedAt: nowMs });
		} catch (error) {
			const failureReason = error instanceof Error ? error.message : String(error);
			const nextReclaimRetryAt = now() + computeReclaimRetryBackoffMs(attemptCount);
			await updateReclamationProgress(workspaceId, record.recordId, {
				reclamationState: "reclaim_failed",
				updatedAt: now(),
				nextReclaimRetryAt,
				lastReclaimFailureReason: failureReason,
			});
			result.failedCount += 1;
			logAgentSessionRetentionWarning(
				`reclaim-threw workspaceId=${workspaceId} taskId=${record.taskId} attempt=${attemptCount} nextRetryAt=${nextReclaimRetryAt} reason=${failureReason}`,
			);
			return;
		}
		options.onReclamationOutcome?.({ workspaceId, record, outcome });
		if (outcome.failureReason !== null) {
			const nextReclaimRetryAt = outcome.nextRetryAt ?? now() + computeReclaimRetryBackoffMs(attemptCount);
			await updateReclamationProgress(workspaceId, record.recordId, {
				reclamationState: "reclaim_failed",
				updatedAt: now(),
				nextReclaimRetryAt,
				lastReclaimFailureReason: outcome.failureReason,
			});
			result.failedCount += 1;
			logAgentSessionRetentionWarning(
				`reclaim-failed workspaceId=${workspaceId} taskId=${record.taskId} transport=${record.sessionTransport} attempt=${attemptCount} survivingDescendants=${outcome.survivingDescendantPids.length} nextRetryAt=${nextReclaimRetryAt} reason=${outcome.failureReason}`,
			);
			return;
		}
		await updateReclamationProgress(workspaceId, record.recordId, {
			reclamationState: "reclaimed",
			updatedAt: now(),
			nextReclaimRetryAt: null,
			lastReclaimFailureReason: null,
		});
		result.reclaimedCount += 1;
		logAgentSessionRetentionInfo(
			`reclaimed workspaceId=${workspaceId} taskId=${record.taskId} transport=${record.sessionTransport} trigger=${outcome.reclamationTrigger} rootExitConfirmed=${outcome.rootProcessExitConfirmed} descendantsExitConfirmed=${outcome.descendantProcessesExitConfirmed} forceful=${outcome.usedForcefulEscalation} released=${outcome.releasedResources.join("|")}`,
		);
	};

	const sweep = async (): Promise<AgentSessionReclamationSweepResult> => {
		const result = createEmptySweepResult();
		const recordsByWorkspaceId = await readAllDeadlineRecords();
		for (const [workspaceId, records] of Object.entries(recordsByWorkspaceId)) {
			for (const record of records) {
				if (!isLiveAgentSessionReclamationState(record.reclamationState)) {
					continue;
				}
				result.inspectedRecordCount += 1;
				const nowMs = now();

				// 回收失败后的退避窗口内不重试。
				if (
					record.reclamationState === "reclaim_failed" &&
					record.nextReclaimRetryAt !== null &&
					nowMs < record.nextReclaimRetryAt
				) {
					result.skippedBackoffCount += 1;
					continue;
				}

				// "reclaiming" = 上次回收执行到一半进程就没了，必须重跑幂等回收（不再看是否到期）。
				const mustResumeInterruptedReclamation = record.reclamationState === "reclaiming";
				if (
					!mustResumeInterruptedReclamation &&
					!isAgentSessionRuntimeReclamationDue(record.reclamationEligibleAt, nowMs)
				) {
					result.skippedNotDueCount += 1;
					continue;
				}

				const summary = options.getTaskSessionSummary(workspaceId, record.taskId);
				// 防护一：活体 / 回合序号必须仍然对得上（会话没被重启、也没继续跑过）。
				if (!isReclamationDeadlineStillCurrentForSession(record, summary)) {
					result.supersededStaleCount += 1;
					await supersedeStaleRecord(workspaceId, record, "incarnation-or-turn-sequence-mismatch", nowMs);
					continue;
				}
				// 防护二：此刻仍处于计时态（没有回到 agent 回合、运行时资源还在）。
				// summary 在上一句已被证明非空，这里的断言只是取窄类型。
				const currentSummary = summary as RuntimeTaskSessionSummary;
				if (!isAgentSessionRetentionDeadlineBearing(currentSummary)) {
					result.supersededStaleCount += 1;
					await supersedeStaleRecord(workspaceId, record, "session-no-longer-deadline-bearing", nowMs);
					continue;
				}

				await reclaimOneRecord(workspaceId, record, currentSummary, result, nowMs);
			}
		}
		return result;
	};

	const runSweepNow = (): Promise<AgentSessionReclamationSweepResult> => {
		if (inFlightSweep) {
			return inFlightSweep;
		}
		const started = sweep()
			.catch((error: unknown) => {
				logAgentSessionRetentionWarning(
					`sweep-failed reason=${error instanceof Error ? error.message : String(error)}`,
				);
				return createEmptySweepResult();
			})
			.finally(() => {
				inFlightSweep = null;
			});
		inFlightSweep = started;
		return started;
	};

	return {
		start() {
			if (sweepTimer !== null) {
				return;
			}
			// 重启恢复：立刻扫一次，把停机期间已经到期的记录处理掉。
			void runSweepNow();
			const timer = setInterval(() => {
				void runSweepNow();
			}, sweepIntervalMs);
			// 不为这个探针把 Node 进程钉住；生产环境另有引用。
			timer.unref?.();
			sweepTimer = timer;
		},
		stop() {
			if (sweepTimer === null) {
				return;
			}
			clearInterval(sweepTimer);
			sweepTimer = null;
		},
		runSweepNow,
	};
}
