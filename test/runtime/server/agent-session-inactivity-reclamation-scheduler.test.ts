// 会话回收调度器：到期判定、重启恢复三分支、陈旧定时器双重防护（四种独立失效方式）、
// 退避重试、崩溃中断的回收重跑、以及扫描重入保护。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentSessionReclamationOutcome, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	type AgentSessionReclamationRequest,
	computeReclaimRetryBackoffMs,
	createAgentSessionInactivityReclamationScheduler,
} from "../../../src/server/agent-session-inactivity-reclamation-scheduler";
import type {
	AgentSessionReclamationState,
	PersistedAgentSessionReclamationDeadlineRecord,
	UpdateAgentSessionReclamationProgressInput,
} from "../../../src/state/agent-session-reclamation-deadline-store";

const NOW = 1_700_000_000_000;
const ONE_HOUR_MS = 60 * 60_000;
const WORKSPACE_ID = "ws-1";
const INCARNATION = "incarnation-1";

function makeRecord(
	overrides: Partial<PersistedAgentSessionReclamationDeadlineRecord> = {},
): PersistedAgentSessionReclamationDeadlineRecord {
	return {
		recordId: `task-a:${INCARNATION}:1`,
		taskId: "task-a",
		agentId: "claude",
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: INCARNATION,
		agentResponseGenerationTurnSequence: 1,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: NOW - ONE_HOUR_MS,
		responseGenerationStopSignalConfidence: "harness_turn_complete",
		reclamationEligibleAt: NOW,
		reclamationState: "grace_running",
		reclamationAttemptCount: 0,
		nextReclaimRetryAt: null,
		lastReclaimFailureReason: null,
		createdAt: NOW - ONE_HOUR_MS,
		updatedAt: NOW - ONE_HOUR_MS,
		schemaVersion: 1,
		...overrides,
	};
}

// 处于计时态的 summary：等人回合 + 进程仍活着 + 活体与回合序号匹配。
function makeDeadlineBearingSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-a",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/repo",
		pid: 4242,
		startedAt: NOW - 2 * ONE_HOUR_MS,
		updatedAt: NOW - ONE_HOUR_MS,
		lastOutputAt: NOW - ONE_HOUR_MS,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: INCARNATION,
		agentResponseGenerationTurnSequence: 1,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		...overrides,
	};
}

function successOutcome(request: AgentSessionReclamationRequest): RuntimeAgentSessionReclamationOutcome {
	return {
		runtimeSessionIncarnationId: request.record.runtimeSessionIncarnationId,
		sessionTransport: request.record.sessionTransport,
		reclamationTrigger: "response_generation_grace_period_expired",
		attemptedAt: request.attemptedAt,
		completedAt: request.attemptedAt + 10,
		rootProcessExitConfirmed: true,
		descendantProcessesExitConfirmed: true,
		survivingDescendantPids: [],
		usedForcefulEscalation: false,
		releasedResources: ["pty"],
		failureReason: null,
		nextRetryAt: null,
	};
}

interface SchedulerHarness {
	records: PersistedAgentSessionReclamationDeadlineRecord[];
	summaryByTaskId: Map<string, RuntimeTaskSessionSummary | null>;
	progressUpdates: Array<{ recordId: string } & UpdateAgentSessionReclamationProgressInput>;
	supersededTaskIds: string[];
	reclaimRequests: AgentSessionReclamationRequest[];
	pendingUserDecisionReclaimMarkings: Array<{ workspaceId: string; taskId: string; reclaimedAt: number }>;
	// 「标记待答决策」与「真正动手回收」的相对先后，用来钉死计划 §7.2 要求的时序。
	reclamationStepOrder: Array<"mark-pending-user-decisions" | "reclaim-agent-session">;
}

function createHarness(): SchedulerHarness {
	return {
		records: [],
		summaryByTaskId: new Map(),
		progressUpdates: [],
		supersededTaskIds: [],
		reclaimRequests: [],
		pendingUserDecisionReclaimMarkings: [],
		reclamationStepOrder: [],
	};
}

function createScheduler(
	harness: SchedulerHarness,
	options: {
		nowMs?: number;
		reclaim?: (request: AgentSessionReclamationRequest) => Promise<RuntimeAgentSessionReclamationOutcome>;
		markPendingUserDecisionsReclaimed?: (workspaceId: string, taskId: string, reclaimedAt: number) => Promise<number>;
	} = {},
) {
	const nowMs = options.nowMs ?? NOW;
	return createAgentSessionInactivityReclamationScheduler({
		now: () => nowMs,
		getTaskSessionSummary: (_workspaceId, taskId) => harness.summaryByTaskId.get(taskId) ?? null,
		reclaimAgentSession: async (request) => {
			harness.reclaimRequests.push(request);
			harness.reclamationStepOrder.push("reclaim-agent-session");
			return await (options.reclaim ?? (async (r) => successOutcome(r)))(request);
		},
		markPendingUserDecisionsReclaimed: async (workspaceId, taskId, reclaimedAt) => {
			harness.pendingUserDecisionReclaimMarkings.push({ workspaceId, taskId, reclaimedAt });
			harness.reclamationStepOrder.push("mark-pending-user-decisions");
			return await (options.markPendingUserDecisionsReclaimed ?? (async () => 1))(workspaceId, taskId, reclaimedAt);
		},
		readAllDeadlineRecords: async (): Promise<Record<string, PersistedAgentSessionReclamationDeadlineRecord[]>> =>
			harness.records.length > 0 ? { [WORKSPACE_ID]: harness.records } : {},
		updateReclamationProgress: async (_workspaceId, recordId, input) => {
			harness.progressUpdates.push({ recordId, ...input });
			const index = harness.records.findIndex((candidate) => candidate.recordId === recordId);
			const existing = harness.records[index];
			if (existing === undefined) {
				return null;
			}
			// 与真实 store 同语义：替换成新对象而非原地改，故调度器本轮持有的 record 引用不被篡改。
			const updated: PersistedAgentSessionReclamationDeadlineRecord = {
				...existing,
				reclamationState: input.reclamationState,
				reclamationAttemptCount:
					input.incrementAttemptCount === true
						? existing.reclamationAttemptCount + 1
						: existing.reclamationAttemptCount,
			};
			harness.records[index] = updated;
			return updated;
		},
		supersedeRetentionDeadlines: async (_workspaceId, taskId) => {
			harness.supersededTaskIds.push(taskId);
			harness.records = harness.records.map((record) =>
				record.taskId === taskId ? { ...record, reclamationState: "superseded" as const } : record,
			);
			return 1;
		},
	});
}

describe("computeReclaimRetryBackoffMs（指数退避 + 封顶）", () => {
	it("首次 4 秒、逐次翻倍、30 分钟封顶", () => {
		expect(computeReclaimRetryBackoffMs(1)).toBe(4_000);
		expect(computeReclaimRetryBackoffMs(2)).toBe(8_000);
		expect(computeReclaimRetryBackoffMs(3)).toBe(16_000);
		expect(computeReclaimRetryBackoffMs(99)).toBe(30 * 60_000);
	});
});

describe("到期判定", () => {
	let harness: SchedulerHarness;

	beforeEach(() => {
		harness = createHarness();
	});

	it("已到期且判据仍成立 → 执行回收并标 reclaimed", async () => {
		harness.records = [makeRecord()];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();

		expect(result.reclaimedCount).toBe(1);
		expect(harness.reclaimRequests).toHaveLength(1);
		// 先落 reclaiming（崩溃恢复的标记），再落 reclaimed。
		expect(harness.progressUpdates.map((update) => update.reclamationState)).toEqual(["reclaiming", "reclaimed"]);
	});

	it("未到期 → 跳过，不动进程也不动账本", async () => {
		harness.records = [makeRecord({ reclamationEligibleAt: NOW + 1 })];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();

		expect(result.skippedNotDueCount).toBe(1);
		expect(harness.reclaimRequests).toEqual([]);
		expect(harness.progressUpdates).toEqual([]);
	});

	it("显式无期限（park --no-expiry）→ 永不到期", async () => {
		harness.records = [
			makeRecord({
				retentionAnchorKind: "session_parked_awaiting_dispatched_background_work",
				responseGenerationStopSignalConfidence: null,
				reclamationEligibleAt: null,
			}),
		];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();

		expect(result.skippedNotDueCount).toBe(1);
		expect(harness.reclaimRequests).toEqual([]);
	});

	it.each(["reclaimed", "superseded"] as AgentSessionReclamationState[])("终态记录（%s）不再被扫描", async (state) => {
		harness.records = [makeRecord({ reclamationState: state })];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();

		expect(result.inspectedRecordCount).toBe(0);
		expect(harness.reclaimRequests).toEqual([]);
	});
});

describe("陈旧定时器防护（四种独立失效方式，任一命中都不得回收）", () => {
	let harness: SchedulerHarness;

	beforeEach(() => {
		harness = createHarness();
		harness.records = [makeRecord()];
	});

	async function expectSupersededWithoutReclaim() {
		const result = await createScheduler(harness).runSweepNow();
		expect(result.supersededStaleCount).toBe(1);
		expect(result.reclaimedCount).toBe(0);
		expect(harness.reclaimRequests).toEqual([]);
		expect(harness.supersededTaskIds).toEqual(["task-a"]);
		// 没动手回收 ⇒ 待答决策也不得被标成「会话已被回收」（否则 UI 会去恢复一个还活着的会话）。
		expect(harness.pendingUserDecisionReclaimMarkings).toEqual([]);
	}

	it("活体变了（会话被重启过）", async () => {
		harness.summaryByTaskId.set(
			"task-a",
			makeDeadlineBearingSummary({ runtimeSessionIncarnationId: "incarnation-2" }),
		);
		await expectSupersededWithoutReclaim();
	});

	it("回合序号推进了（用户又发了一句）", async () => {
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary({ agentResponseGenerationTurnSequence: 2 }));
		await expectSupersededWithoutReclaim();
	});

	it("会话已回到 agent 回合（agent 复生）", async () => {
		harness.summaryByTaskId.set(
			"task-a",
			makeDeadlineBearingSummary({ state: "running", turnOwner: "agent", userTurnKind: null, reviewReason: null }),
		);
		await expectSupersededWithoutReclaim();
	});

	it("进程已经退出了（没有可回收的运行时）", async () => {
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary({ liveness: "exited", pid: null }));
		await expectSupersededWithoutReclaim();
	});

	it("summary 已经不在内存里（服务重启 / 项目被移除）", async () => {
		harness.summaryByTaskId.set("task-a", null);
		await expectSupersededWithoutReclaim();
	});
});

describe("重启恢复", () => {
	let harness: SchedulerHarness;

	beforeEach(() => {
		harness = createHarness();
	});

	it("停机期间早已到期的记录，启动扫描立刻处理（绝对期限，无需补偿逻辑）", async () => {
		harness.records = [makeRecord({ reclamationEligibleAt: NOW - 3 * ONE_HOUR_MS })];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();
		expect(result.reclaimedCount).toBe(1);
	});

	it("状态卡在 reclaiming（回收执行到一半进程没了）→ 重跑幂等回收，不看是否到期", async () => {
		harness.records = [
			makeRecord({
				reclamationState: "reclaiming",
				reclamationAttemptCount: 1,
				reclamationEligibleAt: NOW + ONE_HOUR_MS,
			}),
		];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();
		expect(result.reclaimedCount).toBe(1);
		expect(result.skippedNotDueCount).toBe(0);
	});
});

describe("回收失败与退避", () => {
	let harness: SchedulerHarness;

	beforeEach(() => {
		harness = createHarness();
	});

	it("执行器返回 failureReason → reclaim_failed + 退避时刻", async () => {
		harness.records = [makeRecord()];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness, {
			reclaim: async (request) => ({
				...successOutcome(request),
				rootProcessExitConfirmed: false,
				survivingDescendantPids: [999],
				failureReason: "SIGKILL 后仍存活",
			}),
		}).runSweepNow();

		expect(result.failedCount).toBe(1);
		const failedUpdate = harness.progressUpdates.at(-1);
		expect(failedUpdate?.reclamationState).toBe("reclaim_failed");
		expect(failedUpdate?.nextReclaimRetryAt).toBe(NOW + 4_000);
		expect(failedUpdate?.lastReclaimFailureReason).toBe("SIGKILL 后仍存活");
	});

	it("执行器抛异常 → 同样落 reclaim_failed，不掀翻整轮扫描", async () => {
		harness.records = [makeRecord(), makeRecord({ recordId: `task-b:${INCARNATION}:1`, taskId: "task-b" })];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		harness.summaryByTaskId.set("task-b", makeDeadlineBearingSummary({ taskId: "task-b" }));
		const result = await createScheduler(harness, {
			reclaim: async (request) => {
				if (request.record.taskId === "task-a") {
					throw new Error("PTY 已消失");
				}
				return successOutcome(request);
			},
		}).runSweepNow();

		expect(result.failedCount).toBe(1);
		expect(result.reclaimedCount).toBe(1);
	});

	it("退避窗口内不重试", async () => {
		harness.records = [
			makeRecord({
				reclamationState: "reclaim_failed",
				reclamationAttemptCount: 1,
				nextReclaimRetryAt: NOW + 1_000,
			}),
		];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness).runSweepNow();
		expect(result.skippedBackoffCount).toBe(1);
		expect(harness.reclaimRequests).toEqual([]);
	});

	it("退避窗口已过 → 重试并累加尝试次数", async () => {
		harness.records = [
			makeRecord({
				reclamationState: "reclaim_failed",
				reclamationAttemptCount: 2,
				nextReclaimRetryAt: NOW - 1,
			}),
		];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const result = await createScheduler(harness, {
			reclaim: async (request) => ({ ...successOutcome(request), failureReason: "仍然失败" }),
		}).runSweepNow();

		expect(result.failedCount).toBe(1);
		// 第 3 次尝试 → 退避 16 秒。
		expect(harness.progressUpdates.at(-1)?.nextReclaimRetryAt).toBe(NOW + 16_000);
	});
});

describe("扫描重入保护", () => {
	it("上一轮扫描未结束时，再次触发返回同一个 promise，不会把同一条记录回收两次", async () => {
		const harness = createHarness();
		harness.records = [makeRecord()];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		// 同步建好闸门，免得「执行器什么时候被调用」影响释放时机。
		let releaseReclaim: () => void = () => undefined;
		const reclaimGate = new Promise<void>((resolve) => {
			releaseReclaim = resolve;
		});
		const scheduler = createScheduler(harness, {
			reclaim: async (request) => {
				await reclaimGate;
				return successOutcome(request);
			},
		});

		const firstSweep = scheduler.runSweepNow();
		const secondSweep = scheduler.runSweepNow();
		expect(secondSweep).toBe(firstSweep);
		releaseReclaim();
		await firstSweep;
		expect(harness.reclaimRequests).toHaveLength(1);
	});
});

// 计划 §7.2：「回收前：把该 task 所有 status==="pending" 记录标 reclaimedAt」。
// 漏标的后果不是显示瑕疵——下游会以为还能把答案直接投给一个已经死掉的会话。
describe("回收前标记待答决策为已回收", () => {
	let harness: SchedulerHarness;

	beforeEach(() => {
		harness = createHarness();
		harness.records = [makeRecord()];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
	});

	it("动手回收之前先标记，时刻取本轮扫描时刻", async () => {
		const result = await createScheduler(harness).runSweepNow();

		expect(result.reclaimedCount).toBe(1);
		expect(harness.pendingUserDecisionReclaimMarkings).toEqual([
			{ workspaceId: WORKSPACE_ID, taskId: "task-a", reclaimedAt: NOW },
		]);
		expect(harness.reclamationStepOrder).toEqual(["mark-pending-user-decisions", "reclaim-agent-session"]);
	});

	it("回收判失败（进程仍存活）同样已标记——宁可多标一次恢复，也不漏标丢答案", async () => {
		const result = await createScheduler(harness, {
			reclaim: async (request) => ({
				...successOutcome(request),
				rootProcessExitConfirmed: false,
				failureReason: "SIGKILL 后仍存活",
			}),
		}).runSweepNow();

		expect(result.failedCount).toBe(1);
		expect(harness.pendingUserDecisionReclaimMarkings).toHaveLength(1);
	});

	it("执行器抛异常同样已标记（标记发生在动手之前）", async () => {
		const result = await createScheduler(harness, {
			reclaim: async () => {
				throw new Error("PTY 已消失");
			},
		}).runSweepNow();

		expect(result.failedCount).toBe(1);
		expect(harness.pendingUserDecisionReclaimMarkings).toHaveLength(1);
	});

	it("标记写盘失败不掀翻回收，也不产生 unhandled rejection", async () => {
		const result = await createScheduler(harness, {
			markPendingUserDecisionsReclaimed: async () => {
				throw new Error("决策账本写入失败");
			},
		}).runSweepNow();

		expect(result.reclaimedCount).toBe(1);
		expect(result.failedCount).toBe(0);
		expect(harness.reclaimRequests).toHaveLength(1);
	});
});

describe("回收结果回调", () => {
	it("成功与失败都上报 outcome，供 UI 的「会话已被回收」标注使用", async () => {
		const harness = createHarness();
		harness.records = [makeRecord()];
		harness.summaryByTaskId.set("task-a", makeDeadlineBearingSummary());
		const onReclamationOutcome = vi.fn();
		await createAgentSessionInactivityReclamationScheduler({
			now: () => NOW,
			getTaskSessionSummary: (_workspaceId, taskId) => harness.summaryByTaskId.get(taskId) ?? null,
			reclaimAgentSession: async (request) => successOutcome(request),
			readAllDeadlineRecords: async () => ({ [WORKSPACE_ID]: harness.records }),
			updateReclamationProgress: async () => null,
			supersedeRetentionDeadlines: async () => 0,
			markPendingUserDecisionsReclaimed: async () => 0,
			onReclamationOutcome,
		}).runSweepNow();

		expect(onReclamationOutcome).toHaveBeenCalledTimes(1);
		expect(onReclamationOutcome.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_ID);
		expect(onReclamationOutcome.mock.calls[0]?.[0]?.outcome?.rootProcessExitConfirmed).toBe(true);
	});
});
