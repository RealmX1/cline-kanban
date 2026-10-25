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

describe("Codex 后台终端执行状态与误判纠正", () => {
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
		manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(entry.summary.taskId, before, execution());
		expect(entry.summary).toEqual(corrected);
	});
	it.each(["manual_review", "hook", "interrupted"] as const)("不覆盖 %s 或真实 Stop", (reviewReason) => {
		const { entry, manager } = fixture(true);
		entry.summary = { ...entry.summary, reviewReason };
		const before = structuredClone(entry.summary);
		manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(entry.summary.taskId, before, execution());
		expect(entry.summary).toEqual(before);
	});
	it.each(["question", "permission", "plan_review", "needs_input"] as const)("不覆盖真实 %s", (userTurnKind) => {
		const { entry, manager } = fixture(true);
		entry.summary = { ...entry.summary, userTurnKind };
		const before = structuredClone(entry.summary);
		manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(entry.summary.taskId, before, execution());
		expect(entry.summary).toEqual(before);
	});
	it("旧 incarnation、另一个 native turn 与晚到 Stop 都不能纠偏", () => {
		const { entry, manager } = fixture(true);
		const before = structuredClone(entry.summary);
		manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution({ runtimeSessionIncarnationId: "old" }),
		);
		manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(
			entry.summary.taskId,
			before,
			execution({ nativeTurnId: "other" }),
		);
		expect(entry.summary).toEqual(before);
		entry.summary = { ...entry.summary, reviewReason: "hook", lastHookAt: NOW + 1 };
		const stopped = structuredClone(entry.summary);
		manager.reconcileCodexIdleStallWithNativeAgentTurnExecution(entry.summary.taskId, before, execution());
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
			expect(await manager.inspectCodexNativeTurnBeforeIdleStallSessionReclamation(entry.summary.taskId)).toBe(
				"defer_reclamation",
			);
		expect(nativeExecutionRead).toHaveBeenCalledTimes(1);
		nativeExecutionRead.mockImplementation(async () => execution());
		await vi.advanceTimersByTimeAsync(15_000);
		await manager.inspectCodexNativeTurnBeforeIdleStallSessionReclamation(entry.summary.taskId);
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
