import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../../../src/core/codex-native-agent-turn-execution-observation";
import { resolveSessionFacets } from "../../../src/core/session-activity";
import { createIdleHarnessBackgroundSessionReclaimWatchState } from "../../../src/terminal/harness-background-session-reclaim-watch-after-unsafe-resume-refusal";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

const nativeExecutionRead = vi.hoisted(() => vi.fn());
vi.mock("../../../src/agent-session-history/codex-native-agent-turn-execution-reader", () => ({
	readCodexNativeAgentTurnExecution: nativeExecutionRead,
}));
vi.mock("../../../src/diagnostics/tui-freeze-logger", () => ({
	logTuiFreezeWarning: vi.fn(),
	logTuiFreezeError: vi.fn(),
}));

const NOW = 1_790_000_000_000;
const managers: TerminalSessionManager[] = [];

function execution(
	overrides: Partial<CodexNativeAgentTurnExecutionObservation> = {},
): CodexNativeAgentTurnExecutionObservation {
	return {
		workspaceId: "isolated",
		conversationSessionId: "background-wait",
		runtimeSessionIncarnationId: "incarnation-1",
		nativeSessionId: "native",
		nativeTurnId: "native-turn",
		nativeTurnStartedAtMs: NOW - 600_000,
		observedAtMs: Date.now(),
		threadStatus: "active",
		nativeTurnStatus: "inProgress",
		activeFlags: [],
		canAcceptDirectInput: true,
		executionStatus: "running",
		...overrides,
	};
}
function fixture(isMisclassified = false) {
	const summary: RuntimeTaskSessionSummary = {
		taskId: "background-wait",
		agentId: "codex",
		state: isMisclassified ? "awaiting_review" : "running",
		turnOwner: isMisclassified ? "user" : "agent",
		liveness: "live",
		userTurnKind: isMisclassified ? "review" : null,
		workspacePath: "/isolated/background-wait",
		pid: 1234,
		startedAt: NOW - 900_000,
		updatedAt: NOW,
		lastOutputAt: NOW,
		lastHookAt: null,
		latestHookActivity: null,
		reviewReason: isMisclassified ? "idle_stall" : null,
		exitCode: null,
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 7,
		agentResponseGenerationTurnStarted: { startedAt: NOW - 600_000, turnSequence: 7 },
		lastEffectiveAgentConversationActivityObservation: {
			observedAtMs: NOW - 400_000,
			activityKind: "tool_activity",
			evidenceKind: "persisted_agent_transcript",
			nativeSessionId: "native",
			eventId: "codex:native:native-turn:last-tool",
		},
		lastAgentConversationPromptCacheReferenceObservation: {
			observedAtMs: NOW - 500_000,
			evidenceKind: "post_tool_use_hook_event",
		},
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: "/isolated/background-wait/native.jsonl",
			observedAt: NOW - 900_000,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId: "isolated",
			conversationSessionId: "background-wait",
			runtimeSessionIncarnationId: "incarnation-1",
			socketPath: "/isolated/control.sock",
		},
		agentConversationPromptSubmissionAcceptance: {
			status: "accepted",
			attemptedAtMs: NOW - 600_000,
			confirmedAtMs: NOW - 599_000,
			runtimeSessionIncarnationId: "incarnation-1",
			nativeSessionId: "native",
			eventId: "codex:native:native-turn:input",
		},
		...(isMisclassified
			? {
					currentAgentProcessUserTurnIdleRetentionStarted: {
						stoppedAt: NOW - 200_000,
						signalConfidence: "prompt_ready_fallback" as const,
						turnSequence: 7,
					},
					lastAgentConversationUserHandoffObservation: {
						observedAtMs: NOW - 200_000,
						signalConfidence: "prompt_ready_fallback" as const,
						turnSequence: 7,
					},
				}
			: {}),
	};
	const manager = new TerminalSessionManager();
	managers.push(manager);
	const entry = {
		summary,
		active: {
			session: { write: vi.fn() },
			outputReactionEngine: null,
			outputReactionSession: null,
			outputReactionScanBuffer: null,
			awaitingCodexPromptAfterEnter: false,
		},
		listeners: new Map(),
		lastStallLoggedAt: null,
		harnessBackgroundSessionReclaimWatchState: createIdleHarnessBackgroundSessionReclaimWatchState(),
	};
	(manager as unknown as { entries: Map<string, typeof entry> }).entries.set(summary.taskId, entry);
	const readiness = vi
		.spyOn(
			manager as unknown as { resolveInteractivePromptReadiness: () => Promise<"prompt"> },
			"resolveInteractivePromptReadiness",
		)
		.mockResolvedValue("prompt");
	const scan = () => (manager as unknown as { scanForStalls: () => Promise<void> }).scanForStalls();
	return { manager, entry, readiness, scan };
}

function continuedAfterStopFixture() {
	const result = fixture(true);
	result.entry.summary = {
		...result.entry.summary,
		reviewReason: "hook",
		currentAgentProcessUserTurnIdleRetentionStarted: {
			stoppedAt: NOW - 200_000,
			signalConfidence: "harness_turn_complete",
			turnSequence: 7,
		},
		lastAgentConversationUserHandoffObservation: {
			observedAtMs: NOW - 200_000,
			signalConfidence: "harness_turn_complete",
			turnSequence: 7,
		},
		lastEffectiveAgentConversationActivityObservation: {
			observedAtMs: NOW - 100_000,
			activityKind: "tool_activity",
			evidenceKind: "persisted_agent_transcript",
			nativeSessionId: "native",
			eventId: "codex:native:native-turn:continued-tool",
		},
	};
	return result;
}

describe("Codex 后台终端执行状态与误判纠正", () => {
	it.each(["running", "unknown", "finished"] as const)(
		"detach 原生状态 %s 时只给确证结束的回合下发期限",
		async (executionStatus) => {
			const { manager, entry } = fixture(true);
			nativeExecutionRead.mockResolvedValue(execution({ executionStatus }));
			const publish = vi.fn();
			Object.assign(entry, { terminalStateMirror: null });
			Object.assign(entry.active, {
				recentlyAppliedHookEventDeliveryIdempotencyKeys: [],
				terminalProtocolFilter: { pendingChunk: null },
				taskChatInputDeliveryGeneration: 0,
				submitConfirmGeneration: 0,
				session: {
					write: vi.fn(),
					detachFromRuntimeForHandoverRestartWithoutSignallingProcess: vi.fn(),
					publishTerminalSessionAdoptionRecordForRuntimeRestart: publish,
				},
			});
			await manager.detachHostedPtySessionsForRuntimeHandover({
				readHostedSessionOrphanReclamationEligibleAtEpochMs: (summary) =>
					resolveSessionFacets(summary).turnOwner === "user" ? 1234 : null,
			});
			expect(nativeExecutionRead).toHaveBeenCalledOnce();
			expect(publish).toHaveBeenCalledWith(expect.anything(), executionStatus === "finished" ? 1234 : null);
		},
	);
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		nativeExecutionRead.mockReset();
		nativeExecutionRead.mockImplementation(async () => execution());
	});
	afterEach(() => {
		for (const manager of managers.splice(0)) manager.dispose();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	it("等待超过五分钟且提示符可用时持续 Running，不制造活动、缓存、交棒或回合", async () => {
		const { entry, scan, readiness } = fixture();
		const before = structuredClone(entry.summary);
		for (let minute = 0; minute < 20; minute += 1) {
			await vi.advanceTimersByTimeAsync(60_000);
			await scan();
		}
		expect(resolveSessionFacets(entry.summary)).toEqual({ turnOwner: "agent", liveness: "live", userTurnKind: null });
		expect(entry.summary.agentResponseGenerationTurnSequence).toBe(7);
		expect(entry.summary.agentResponseGenerationTurnStarted).toEqual(before.agentResponseGenerationTurnStarted);
		expect(entry.summary.lastEffectiveAgentConversationActivityObservation).toEqual(
			before.lastEffectiveAgentConversationActivityObservation,
		);
		expect(entry.summary.lastAgentConversationPromptCacheReferenceObservation).toEqual(
			before.lastAgentConversationPromptCacheReferenceObservation,
		);
		expect(entry.summary.lastAgentConversationUserHandoffObservation).toBeUndefined();
		expect(entry.summary.currentAgentProcessUserTurnIdleRetentionStarted).toBeUndefined();
		expect(readiness).not.toHaveBeenCalled();
	});
	it("同代同回合 idle_stall 自动纠正，保留开始、接受与计时事实，重复观察幂等", async () => {
		const { entry, manager, scan } = fixture(true);
		const before = structuredClone(entry.summary);
		await scan();
		expect(resolveSessionFacets(entry.summary)).toEqual({ turnOwner: "agent", liveness: "live", userTurnKind: null });
		expect(entry.summary.reviewReason).toBeNull();
		expect(entry.summary.agentResponseGenerationTurnSequence).toBe(7);
		expect(entry.summary.agentResponseGenerationTurnStarted).toEqual(before.agentResponseGenerationTurnStarted);
		expect(entry.summary.agentConversationPromptSubmissionAcceptance).toEqual(
			before.agentConversationPromptSubmissionAcceptance,
		);
		expect(entry.summary.lastAgentConversationPromptCacheReferenceObservation).toEqual(
			before.lastAgentConversationPromptCacheReferenceObservation,
		);
		expect(entry.summary.lastEffectiveAgentConversationActivityObservation).toEqual(
			before.lastEffectiveAgentConversationActivityObservation,
		);
		expect(entry.summary.currentAgentProcessUserTurnIdleRetentionStarted).toBeNull();
		expect(entry.summary.lastAgentConversationUserHandoffObservation).toBeNull();
		const corrected = structuredClone(entry.summary);
		manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution(),
		);
		expect(entry.summary).toEqual(corrected);
	});
	it("Stop 后同回合主工具继续执行时纠偏，保留原回合、接受、缓存与 Stop 记录", async () => {
		const { entry, scan } = continuedAfterStopFixture();
		const before = structuredClone(entry.summary);
		await scan();
		expect(resolveSessionFacets(entry.summary)).toEqual({ turnOwner: "agent", liveness: "live", userTurnKind: null });
		expect(entry.summary).toMatchObject({
			reviewReason: null,
			agentResponseGenerationTurnSequence: before.agentResponseGenerationTurnSequence,
			agentResponseGenerationTurnStarted: before.agentResponseGenerationTurnStarted,
			agentConversationPromptSubmissionAcceptance: before.agentConversationPromptSubmissionAcceptance,
			lastAgentConversationPromptCacheReferenceObservation:
				before.lastAgentConversationPromptCacheReferenceObservation,
			lastEffectiveAgentConversationActivityObservation: before.lastEffectiveAgentConversationActivityObservation,
			lastHookAt: before.lastHookAt,
			latestHookActivity: before.latestHookActivity,
			currentAgentProcessUserTurnIdleRetentionStarted: null,
			lastAgentConversationUserHandoffObservation: null,
		});
	});
	it("Stop 后才发现的结构化旧工具不能证明 Stop 后执行", async () => {
		const { entry, scan } = continuedAfterStopFixture();
		entry.summary.lastEffectiveAgentConversationActivityObservation = {
			activityKind: "tool_activity",
			nativeSessionId: "native",
			eventId: "codex:native:native-turn:old-tool",
			evidenceKind: "structured_agent_session_event",
			observedAtMs: NOW,
		};
		await scan();
		expect(entry.summary.turnOwner).toBe("user");
	});
	it("相同正文的新 Stop 仍建立独立边界，不能消费前一次续跑工具", async () => {
		const { entry, manager, scan } = fixture();
		const stop = { source: "codex", hookEventName: "Stop", finalMessage: "完成" };
		vi.setSystemTime(NOW - 200_000);
		manager.applyHookActivity(entry.summary.taskId, stop);
		manager.transitionToReview(entry.summary.taskId, "hook", undefined, {
			domainEventObservedAtEpochMs: NOW - 200_000,
			hookEventDeliveryIdempotencyKey: "first-stop",
		});
		vi.setSystemTime(NOW - 100_000);
		manager.recordEffectiveAgentConversationActivity(entry.summary.taskId, {
			observedAtMs: NOW - 100_000,
			activityKind: "tool_activity",
			evidenceKind: "persisted_agent_transcript",
			nativeSessionId: "native",
			eventId: "codex:native:native-turn:continued-tool",
		});
		vi.setSystemTime(NOW - 50_000);
		manager.applyHookActivity(entry.summary.taskId, stop);
		manager.transitionToReview(entry.summary.taskId, "hook", undefined, {
			domainEventObservedAtEpochMs: NOW - 50_000,
			hookEventDeliveryIdempotencyKey: "second-stop",
		});
		expect(entry.summary.currentAgentProcessUserTurnIdleRetentionStarted).toMatchObject({
			stoppedAt: NOW - 200_000,
			latestCodexStopHookBoundary: { observedAtMs: NOW - 50_000, hookEventDeliveryIdempotencyKey: "second-stop" },
		});
		manager.transitionToReview(entry.summary.taskId, "hook", undefined, {
			domainEventObservedAtEpochMs: NOW - 200_000,
			hookEventDeliveryIdempotencyKey: "first-stop",
		});
		vi.setSystemTime(NOW);
		await scan();
		expect(entry.summary.turnOwner).toBe("user");
	});
	it("延迟投递 Stop 按捕获时间核对原始工具，接收时刻不能阻挡纠偏", async () => {
		const { entry, manager, scan } = fixture();
		manager.transitionToReview(entry.summary.taskId, "hook", undefined, {
			domainEventObservedAtEpochMs: NOW - 200_000,
		});
		manager.applyHookActivity(entry.summary.taskId, { source: "codex", hookEventName: "Stop" });
		manager.recordEffectiveAgentConversationActivity(entry.summary.taskId, {
			observedAtMs: NOW - 100_000,
			activityKind: "tool_activity",
			evidenceKind: "persisted_agent_transcript",
			nativeSessionId: "native",
			eventId: "codex:native:native-turn:continued-tool",
		});
		await scan();
		expect(entry.summary.turnOwner).toBe("agent");
	});
	it("仅有旧 stopped 字段时仍在回收前查询原生状态，未知则延后回收", async () => {
		const { entry, manager } = fixture(true);
		entry.summary.agentResponseGenerationStopped = entry.summary.currentAgentProcessUserTurnIdleRetentionStarted;
		delete entry.summary.currentAgentProcessUserTurnIdleRetentionStarted;
		nativeExecutionRead.mockResolvedValue(null);
		expect(await manager.inspectCodexNativeTurnBeforeReviewSessionReclamation(entry.summary.taskId)).toBe(
			"defer_reclamation",
		);
		expect(nativeExecutionRead).toHaveBeenCalledOnce();
	});
	it("已误入用户回合后手动 Review 仍保留人的阶段选择", async () => {
		const { entry, manager, scan } = continuedAfterStopFixture();
		manager.transitionToReview(entry.summary.taskId, "manual_review");
		await scan();
		expect(entry.summary.turnOwner).toBe("user");
		expect(entry.summary.reviewReason).toBe("manual_review");
	});
	it("idle_stall 之后真实 Stop 到达也必须等 Stop 后主工具，active 本身不能撤销它", async () => {
		const { entry, manager, scan } = fixture(true);
		manager.transitionToReview(entry.summary.taskId, "hook", undefined, {
			domainEventObservedAtEpochMs: NOW - 50_000,
		});
		await scan();
		expect(entry.summary.turnOwner).toBe("user");
	});
	it.each(["question", "permission", "plan_review", "needs_input"] as const)(
		"Stop 后有工具证据也不能覆盖真实 %s",
		async (userTurnKind) => {
			const { entry, scan } = continuedAfterStopFixture();
			entry.summary.userTurnKind = userTurnKind;
			const before = structuredClone(entry.summary);
			await scan();
			expect(entry.summary).toEqual(before);
		},
	);
	it.each([
		["Stop 前工具", { observedAtMs: NOW - 300_000 }],
		["同毫秒工具", { observedAtMs: NOW - 200_000 }],
		["未来工具", { observedAtMs: NOW + 1 }],
		["其他原生回合", { eventId: "codex:native:other-turn:tool" }],
		["其他原生会话", { nativeSessionId: "other-native" }],
		["仅 hook 无原生关联", { evidenceKind: "agent_lifecycle_hook_event", eventId: "hook-only" }],
		["只有输出", { activityKind: "agent_output" }],
	] as const)("%s 不能证明 Stop 后主回合继续", async (_label, overrides) => {
		const { entry, scan } = continuedAfterStopFixture();
		entry.summary.lastEffectiveAgentConversationActivityObservation = {
			...(entry.summary.lastEffectiveAgentConversationActivityObservation as NonNullable<
				RuntimeTaskSessionSummary["lastEffectiveAgentConversationActivityObservation"]
			>),
			...overrides,
		};
		const before = structuredClone(entry.summary);
		await scan();
		expect(entry.summary).toEqual(before);
	});
	it.each<Partial<CodexNativeAgentTurnExecutionObservation>>([
		{ executionStatus: "finished", threadStatus: "idle", nativeTurnStatus: "completed" },
		{ executionStatus: "waiting_for_user", activeFlags: ["waitingOnUserInput"] },
		{ activeFlags: ["waitingOnApproval"] },
		{ activeFlags: ["futureUnknownFlag"] },
		{ nativeTurnId: "old-turn" },
		{ nativeTurnStartedAtMs: NOW - 50_000 },
		{ runtimeSessionIncarnationId: "old-incarnation" },
		{ workspaceId: "other-project" },
		{ conversationSessionId: "other-session" },
	])("Stop 后有工具也拒绝不匹配或非执行态的证明 %j", async (overrides) => {
		const { entry, scan } = continuedAfterStopFixture();
		const before = structuredClone(entry.summary);
		nativeExecutionRead.mockResolvedValue(execution(overrides));
		await scan();
		expect(entry.summary).toEqual(before);
	});
	it("新的 Stop 不能被前一次 Stop 后的工具证明覆盖", async () => {
		const { entry, manager, scan } = continuedAfterStopFixture();
		entry.summary.lastHookAt = NOW - 50_000;
		entry.summary.latestHookActivity = {
			source: "codex",
			hookEventName: "Stop",
			toolName: null,
			toolInputSummary: null,
			activityText: null,
			finalMessage: "真实完成",
			notificationType: null,
		};
		manager.transitionToReview(entry.summary.taskId, "hook", undefined, {
			domainEventObservedAtEpochMs: NOW - 50_000,
		});
		const before = structuredClone(entry.summary);
		await scan();
		expect(entry.summary).toEqual(before);
	});
	it("原生核验返回前发生新 Stop、park 或换代时拒绝迟到结果", async () => {
		for (const overrides of [{ lastHookAt: NOW + 1 }, { runtimeSessionIncarnationId: "new-incarnation" }]) {
			const { entry, manager } = continuedAfterStopFixture();
			const before = structuredClone(entry.summary);
			entry.summary = { ...entry.summary, ...overrides };
			const current = structuredClone(entry.summary);
			await manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
				entry.summary.taskId,
				before,
				execution(),
			);
			expect(entry.summary).toEqual(current);
		}
	});
	it("只撤销与误判精确匹配的派生交棒", async () => {
		const { entry, scan } = continuedAfterStopFixture();
		const handoff = {
			observedAtMs: NOW - 10_000,
			signalConfidence: "structured_user_turn" as const,
			turnSequence: 8,
		};
		entry.summary.lastAgentConversationUserHandoffObservation = handoff;
		await scan();
		expect(entry.summary.turnOwner).toBe("agent");
		expect(entry.summary.lastAgentConversationUserHandoffObservation).toEqual(handoff);
	});
	it("看板写入失败时不消费纠偏锚点，下一次观察自动恢复且重复核验幂等", async () => {
		const { entry, manager } = continuedAfterStopFixture();
		const before = structuredClone(entry.summary);
		const persist = vi
			.fn()
			.mockRejectedValueOnce(new Error("看板写入暂不可用"))
			.mockImplementation(async (_before, _execution, applyCorrection) => applyCorrection());
		manager.setCodexReviewMisclassificationPersistenceHandler(persist);
		await expect(
			manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
				entry.summary.taskId,
				before,
				execution(),
			),
		).rejects.toThrow("看板写入暂不可用");
		expect(entry.summary).toEqual(before);
		await manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution(),
		);
		const corrected = structuredClone(entry.summary);
		await manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution(),
		);
		expect(entry.summary).toEqual(corrected);
		expect(entry.summary.turnOwner).toBe("agent");
		expect(persist).toHaveBeenCalledTimes(2);
	});
	it.each(["manual_review", "hook", "interrupted"] as const)("不覆盖 %s 或真实 Stop", (reviewReason) => {
		const { entry, manager } = fixture(true);
		entry.summary = { ...entry.summary, reviewReason };
		const before = structuredClone(entry.summary);
		manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution(),
		);
		expect(entry.summary).toEqual(before);
	});
	it.each(["question", "permission", "plan_review", "needs_input"] as const)("不覆盖真实 %s", (userTurnKind) => {
		const { entry, manager } = fixture(true);
		entry.summary = { ...entry.summary, userTurnKind };
		const before = structuredClone(entry.summary);
		manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution(),
		);
		expect(entry.summary).toEqual(before);
	});
	it("旧 incarnation、另一个 native turn 与晚到 Stop 都不能纠偏", () => {
		const { entry, manager } = fixture(true);
		const before = structuredClone(entry.summary);
		manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution({ runtimeSessionIncarnationId: "old" }),
		);
		manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution({ nativeTurnId: "other" }),
		);
		expect(entry.summary).toEqual(before);
		entry.summary = { ...entry.summary, reviewReason: "hook", lastHookAt: NOW + 1 };
		const stopped = structuredClone(entry.summary);
		manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution(),
		);
		expect(entry.summary).toEqual(stopped);
	});
	it("原生问题与批准不会因可直接输入而恢复 Running", async () => {
		const { entry, scan } = fixture(true);
		nativeExecutionRead.mockResolvedValue(
			execution({ executionStatus: "waiting_for_user", activeFlags: ["waitingOnUserInput"] }),
		);
		await scan();
		expect(entry.summary.reviewReason).toBe("idle_stall");
	});
	it("明确完成后仍走既有静默和提示符兜底", async () => {
		const { entry, scan } = fixture();
		nativeExecutionRead.mockResolvedValue(
			execution({ executionStatus: "finished", threadStatus: "idle", nativeTurnStatus: "completed" }),
		);
		await scan();
		expect(entry.summary.reviewReason).toBe("idle_stall");
		expect(entry.summary.turnOwner).toBe("user");
	});
	it("查询未知时不交棒或回收，退避后恢复自动纠偏", async () => {
		const { entry, manager } = fixture(true);
		nativeExecutionRead.mockResolvedValue(null);
		for (let attempt = 0; attempt < 5; attempt += 1)
			expect(await manager.inspectCodexNativeTurnBeforeReviewSessionReclamation(entry.summary.taskId)).toBe(
				"defer_reclamation",
			);
		expect(nativeExecutionRead).toHaveBeenCalledTimes(1);
		nativeExecutionRead.mockImplementation(async () => execution());
		await vi.advanceTimersByTimeAsync(15_000);
		await manager.inspectCodexNativeTurnBeforeReviewSessionReclamation(entry.summary.taskId);
		expect(entry.summary.turnOwner).toBe("agent");
	});
	it("扫描单飞，原生等待查询不会随 tick 重入叠加", async () => {
		const { scan } = fixture();
		let finish: (value: CodexNativeAgentTurnExecutionObservation) => void = () => {};
		nativeExecutionRead.mockImplementation(
			() =>
				new Promise<CodexNativeAgentTurnExecutionObservation>((resolve) => {
					finish = resolve;
				}),
		);
		const first = scan();
		const second = scan();
		expect(first).toBe(second);
		expect(nativeExecutionRead).toHaveBeenCalledTimes(1);
		finish(execution());
		await first;
	});
});
