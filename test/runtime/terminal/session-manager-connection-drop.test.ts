import type { deliverAutomaticAgentFailureContinuationNativePrompt } from "../../../src/terminal/automatic-agent-failure-continuation-native-delivery";

const nativeFailureContinuationDeliveryMock = vi.hoisted(() =>
	vi.fn<typeof deliverAutomaticAgentFailureContinuationNativePrompt>(),
);
vi.mock("../../../src/terminal/automatic-agent-failure-continuation-native-delivery", () => ({
	deliverAutomaticAgentFailureContinuationNativePrompt: nativeFailureContinuationDeliveryMock,
	buildAutomaticAgentFailureContinuationPrompt: () => "核对上一步执行结果，避免重复操作，并继续原任务。",
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const ensureInstructionsFileMock = vi.hoisted(() => vi.fn(async () => "/tmp/network-interruption-resume.md"));
const inspectCodexNativeRetryReadinessMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/codex-native-connection-retry-continuation-readiness", () => ({
	inspectCodexNativeConnectionRetryContinuationReadiness: inspectCodexNativeRetryReadinessMock,
}));

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	// 分离写：框架与提交 CR 分两次发出（见 session-manager 的摄入门控）。这里给真实实现，
	// 保证注入体框定与提交字节都是真的。
	toBracketedPasteFramingWithoutTrailingSubmit: (command: string) => `\u001b[200~${command}\u001b[201~`,
	BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN: "\u000d",
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

// 避免向真实 home 目录写续跑指令文件，并固定注入路径便于断言。
vi.mock("../../../src/terminal/output-reactions/network-interruption-continuation-instructions.js", () => ({
	ensureNetworkInterruptionResumeInstructionsFile: ensureInstructionsFileMock,
	getNetworkInterruptionResumeInstructionsPath: () => "/tmp/network-interruption-resume.md",
	buildNetworkInterruptionContinuationLine: (path: string) => `继续：请先按 ${path} 自查并恢复，再继续。`,
}));

import { resolveSessionFacets } from "../../../src/core/session-activity";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function requireSummary(manager: TerminalSessionManager, taskId: string) {
	const summary = manager.getSummary(taskId);
	if (!summary) throw new Error("缺少测试会话");
	return summary;
}

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		hasExited: vi.fn(() => false),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

// 同时含连接错误行与 Claude 输入框（提示符就绪信号）。
const CLAUDE_ERROR_WITH_PROMPT =
	"[31m\r⏺ API Error: Connection closed mid-response. The response above may be incomplete.[0m\r\n" +
	"╭──────────────────────╮\n│ > │\n╰──────────────────────╯";

// 输出重分析(连接错误检测等)按 session-manager 的 OUTPUT_ANALYSIS_BATCH_WINDOW_MS(50ms)攒批;
// 喂完输出后先推进该窗口,让检测结果落地,再做断言/推进退避档位。
const OUTPUT_ANALYSIS_BATCH_WINDOW_MS = 50;
async function settleOutputAnalysisBatch(): Promise<void> {
	await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
}

function spawnManagerWithSession(pid: number) {
	let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
		// 不产出 deferredStartupPromptText，避免与续跑注入混淆。
	}));
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		spawnedSession = createMockPtySession(pid, request);
		return spawnedSession;
	});
	return () => spawnedSession;
}

describe("共用故障恢复的会话接线", () => {
	it.each([
		"question",
		"plan_review",
		"permission",
		"needs_input",
		"park",
		"human_input",
		"new_chat_message",
		"native_identity",
		"session_ended",
	] as const)("原生发送核验在途时发生 %s，迟到结果不能恢复旧 episode 或写 PTY", async (intervention) => {
		const getSession = spawnManagerWithSession(1201);
		const manager = new TerminalSessionManager({
			prepareCodexNativeSessionControlHostLaunch: async (request) => ({
				binary: request.binary,
				args: [...request.arguments],
				env: request.environment,
				endpoint: {
					workspaceId: request.workspaceId,
					conversationSessionId: request.conversationSessionId,
					runtimeSessionIncarnationId: request.runtimeSessionIncarnationId,
					socketPath: "/isolated/native-control.sock",
				},
				cleanup: async () => {},
			}),
		});
		await manager.startTaskSession({
			taskId: "native-recovery",
			workspaceId: "isolated",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/isolated/native-recovery",
			prompt: "执行任务",
		});
		manager.applyAgentNativeConversationSessionIdentity("native-recovery", {
			sourceAgentId: "codex",
			nativeSessionId: "original",
			transcriptPath: "/isolated/native.jsonl",
			observedAt: Date.now(),
		});
		let finish: (value: { outcome: "accepted_running" }) => void = () => {};
		nativeFailureContinuationDeliveryMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const session = getSession();
		if (!session) throw new Error("缺少测试终端");
		session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(nativeFailureContinuationDeliveryMock).toHaveBeenCalledOnce();
		if (intervention === "human_input") manager.writeInput("native-recovery", Buffer.from("人工接管"));
		else if (intervention === "new_chat_message")
			manager.submitTaskChatInputWhenReady("native-recovery", "人工新目标");
		else if (intervention === "session_ended") manager.stopTaskSession("native-recovery");
		else if (intervention === "native_identity")
			manager.applyAgentNativeConversationSessionIdentity("native-recovery", {
				sourceAgentId: "codex",
				nativeSessionId: "replacement",
				transcriptPath: "/isolated/replacement.jsonl",
				observedAt: Date.now(),
			});
		else if (intervention === "park") manager.parkTaskSessionAwaitingDispatchedBackgroundWork("native-recovery");
		else manager.transitionToReview("native-recovery", "hook", intervention);
		finish({ outcome: "accepted_running" });
		await vi.advanceTimersByTimeAsync(0);
		const summary = manager.getSummary("native-recovery");
		if (!summary) throw new Error("缺少会话");
		const phase = summary.automaticAgentFailureContinuation?.phase;
		const modal =
			intervention === "question" ||
			intervention === "plan_review" ||
			intervention === "permission" ||
			intervention === "needs_input";
		expect(phase).not.toBe("executing");
		if (modal) {
			expect(phase).not.toBe("cancelled");
			expect(resolveSessionFacets(summary)).toEqual({
				turnOwner: "user",
				liveness: "live",
				userTurnKind: intervention,
			});
		} else if (intervention === "native_identity") expect(summary.automaticAgentFailureContinuation).toBeNull();
		else expect(phase).toBe("cancelled");
		const automaticWrites = session.write.mock.calls.filter(
			([text]) => String(text).includes("[200~") || text === "\r",
		);
		expect(automaticWrites).toEqual([]);
		manager.stopTaskSession("native-recovery");
		manager.dispose();
	});

	async function startCodexRecovery(taskId: string) {
		const getSession = spawnManagerWithSession(1203);
		const manager = new TerminalSessionManager({
			prepareCodexNativeSessionControlHostLaunch: async (request) => ({
				binary: request.binary,
				args: [...request.arguments],
				env: request.environment,
				endpoint: {
					workspaceId: request.workspaceId,
					conversationSessionId: request.conversationSessionId,
					runtimeSessionIncarnationId: request.runtimeSessionIncarnationId,
					socketPath: "/isolated/native-control.sock",
				},
				cleanup: async () => {},
			}),
		});
		await manager.startTaskSession({
			taskId,
			workspaceId: "isolated",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: `/isolated/${taskId}`,
			prompt: "执行任务",
		});
		manager.applyAgentNativeConversationSessionIdentity(taskId, {
			sourceAgentId: "codex",
			nativeSessionId: "original",
			transcriptPath: "/isolated/native.jsonl",
			observedAt: Date.now(),
		});
		const session = getSession();
		if (!session) throw new Error("缺少测试终端");
		return { manager, session };
	}

	it.each([
		"before_delivery_registration",
		"after_delivery_registration",
		"delayed_old_stop",
		"accepted_result_without_callback",
	] as const)("%s 的旧故障 Stop 不得在新续跑工具活动时重放成 Review", async (stopTiming) => {
		const taskId = `stale-fault-stop-${stopTiming}`;
		const { manager, session } = await startCodexRecovery(taskId);
		let startSubmission = () => {};
		let finishDelivery = () => {};
		nativeFailureContinuationDeliveryMock.mockImplementation(
			(input) =>
				new Promise((resolve) => {
					startSubmission = () => input.onSubmissionStarted?.();
					finishDelivery = () => resolve({ outcome: "accepted_running", nativeTurnId: "retry-turn" });
				}),
		);
		try {
			session.triggerData("Error: read ECONNRESET\n› ");
			await settleOutputAnalysisBatch();
			const failedTurnStopObservedAtMs = Date.now();
			if (stopTiming === "before_delivery_registration" || stopTiming === "accepted_result_without_callback")
				manager.transitionToReview(taskId, "hook");
			await vi.advanceTimersByTimeAsync(4_000);
			expect(nativeFailureContinuationDeliveryMock).toHaveBeenCalledOnce();
			if (stopTiming === "after_delivery_registration") {
				expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation?.activeDeliveryId).toBeTruthy();
				manager.transitionToReview(taskId, "hook");
			}
			if (stopTiming !== "accepted_result_without_callback") startSubmission();
			finishDelivery();
			await vi.advanceTimersByTimeAsync(1);
			expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation?.phase).toBe("executing");
			if (stopTiming === "delayed_old_stop")
				manager.transitionToReview(taskId, "hook", undefined, {
					domainEventObservedAtEpochMs: failedTurnStopObservedAtMs,
				});
			manager.recordEffectiveAgentConversationActivity(taskId, {
				observedAtMs: Date.now(),
				evidenceKind: "persisted_agent_transcript",
				activityKind: "tool_activity",
				eventId: "new-retry-turn-tool-activity",
				nativeSessionId: "original",
			});
			expect(manager.getSummary(taskId)).toMatchObject({
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				automaticAgentFailureContinuation: { phase: "recovered" },
			});
		} finally {
			manager.stopTaskSession(taskId);
			manager.dispose();
		}
	});

	it("Claude 已 paste 但尚未 Enter 的旧 Stop 不能交棒后来被接受的续跑回合", async () => {
		const getSession = spawnManagerWithSession(1209);
		const manager = new TerminalSessionManager();
		const taskId = "claude-stop-before-enter";
		await manager.startTaskSession({
			taskId,
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: `/isolated/${taskId}`,
			prompt: "继续任务",
		});
		try {
			const session = getSession();
			if (!session) throw new Error("缺少终端");
			session.triggerData(CLAUDE_ERROR_WITH_PROMPT);
			await settleOutputAnalysisBatch();
			await vi.advanceTimersByTimeAsync(4_000);
			expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(1);
			expect(session.write.mock.calls.some(([text]) => text === "\r")).toBe(false);
			manager.transitionToReview(taskId, "hook");
			await vi.advanceTimersByTimeAsync(2_000);
			expect(session.write.mock.calls.some(([text]) => text === "\r")).toBe(true);
			// biome-ignore lint/complexity/useLiteralKeys: 复用私有核对端口模拟真实原生接受。
			const coordinator = manager["getAutomaticFailureContinuationCoordinator"](taskId);
			const deliveryId = coordinator.snapshot()?.activeDeliveryId;
			if (!deliveryId) throw new Error("缺少投递引用");
			expect(coordinator.snapshot()?.pendingCompletionReview).toBeUndefined();
			coordinator.recordNativeAcceptanceConfirmed(deliveryId);
			await vi.advanceTimersByTimeAsync(20_000);
			manager.recordEffectiveAgentConversationActivity(taskId, {
				observedAtMs: Date.now(),
				evidenceKind: "persisted_agent_transcript",
				activityKind: "tool_activity",
				eventId: "current-claude-retry-tool-activity",
			});
			expect(manager.getSummary(taskId)).toMatchObject({
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				automaticAgentFailureContinuation: { phase: "recovered" },
			});
		} finally {
			manager.stopTaskSession(taskId);
			manager.dispose();
		}
	});

	it.each(["hook", "idle_stall"] as const)("Claude 已接受续跑后的 %s 交棒会在恢复后进入 Review", async (reason) => {
		const getSession = spawnManagerWithSession(1207);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "claude-completion",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/isolated/claude-completion",
			prompt: "继续任务",
		});
		const session = getSession();
		if (!session) throw new Error("缺少终端");
		session.triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		// 原生接受只能发生在 Enter 写出后，不能把仍在输入框中的 paste 当成已提交。
		await vi.advanceTimersByTimeAsync(6_000);
		expect(session.write.mock.calls.some(([text]) => text === "\r")).toBe(true);
		// biome-ignore lint/complexity/useLiteralKeys: 测试通过私有端口模拟真实回执，不开放产品 API。
		const coordinator = manager["getAutomaticFailureContinuationCoordinator"]("claude-completion");
		const deliveryId = coordinator.snapshot()?.activeDeliveryId;
		if (!deliveryId) throw new Error("缺少投递引用");
		coordinator.recordNativeAcceptanceConfirmed(deliveryId);
		// 接受事实已持久登记，但尚未完成执行核对时收到 Stop，也不能丢掉交棒。
		manager.transitionToReview("claude-completion", reason);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(coordinator.snapshot()?.phase).toBe("recovered");
		expect(resolveSessionFacets(requireSummary(manager, "claude-completion"))).toEqual({
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
		});
		manager.dispose();
	});

	it("Claude 已接受提示后再次网络失败，保留 episode 并安排下一档新的投递", async () => {
		const getSession = spawnManagerWithSession(1208);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "claude-repeat",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/isolated/claude-repeat",
			prompt: "继续任务",
		});
		const session = getSession();
		if (!session) throw new Error("缺少终端");
		session.triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		// biome-ignore lint/complexity/useLiteralKeys: 测试通过私有端口模拟真实回执，不开放产品 API。
		const coordinator = manager["getAutomaticFailureContinuationCoordinator"]("claude-repeat");
		const original = coordinator.snapshot();
		if (!original?.activeDeliveryId) throw new Error("缺少投递引用");
		coordinator.recordNativeAcceptanceConfirmed(original.activeDeliveryId);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(coordinator.snapshot()?.activeDeliveryWasAccepted).toBe(true);
		session.triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(1);
		expect(coordinator.snapshot()).toMatchObject({
			episodeId: original.episodeId,
			phase: "waiting_backoff",
			activeDeliveryId: null,
			attemptCount: 1,
			acceptedCount: 1,
		});
		const nextCheckAtMs = coordinator.snapshot()?.nextCheckAtMs;
		if (!nextCheckAtMs) throw new Error("没有安排网络退避");
		expect(nextCheckAtMs - (coordinator.snapshot()?.lastCheckAtMs ?? 0)).toBe(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(coordinator.snapshot()?.activeDeliveryId).not.toBe(original.activeDeliveryId);
		expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(2);
		manager.dispose();
	});

	it("暂时没有原生失败证据时保持同一 episode，随后继续尝试", async () => {
		const { manager, session } = await startCodexRecovery("readiness-gap");
		nativeFailureContinuationDeliveryMock
			.mockResolvedValueOnce({ outcome: "deferred", blockingReason: "waiting_for_failed_native_turn_evidence" })
			.mockResolvedValueOnce({ outcome: "accepted_running" });
		session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		const first = manager.getSummary("readiness-gap")?.automaticAgentFailureContinuation;
		expect(first?.phase).toBe("waiting_machine_evidence");
		expect(nativeFailureContinuationDeliveryMock).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(5_000);
		const second = manager.getSummary("readiness-gap")?.automaticAgentFailureContinuation;
		expect(nativeFailureContinuationDeliveryMock).toHaveBeenCalledTimes(2);
		expect(second).toMatchObject({ episodeId: first?.episodeId, phase: "executing" });
		manager.dispose();
	});

	it("执行中的自然 Stop 进入 Review，等待中的故障 Stop 与用户停止不会被当成成功", async () => {
		const waiting = await startCodexRecovery("stop-while-waiting");
		waiting.session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		waiting.manager.transitionToReview("stop-while-waiting", "hook");
		expect(waiting.manager.getSummary("stop-while-waiting")?.automaticAgentFailureContinuation?.phase).toBe(
			"waiting_backoff",
		);
		expect(resolveSessionFacets(requireSummary(waiting.manager, "stop-while-waiting")).turnOwner).toBe("agent");
		waiting.manager.stopTaskSession("stop-while-waiting");
		expect(waiting.manager.getSummary("stop-while-waiting")?.automaticAgentFailureContinuation?.phase).toBe(
			"cancelled",
		);
		waiting.session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		expect(waiting.manager.getSummary("stop-while-waiting")?.automaticAgentFailureContinuation?.phase).toBe(
			"cancelled",
		);
		waiting.manager.dispose();

		const running = await startCodexRecovery("stop-while-executing");
		nativeFailureContinuationDeliveryMock.mockResolvedValue({ outcome: "accepted_running" });
		running.session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(running.manager.getSummary("stop-while-executing")?.automaticAgentFailureContinuation?.phase).toBe(
			"executing",
		);
		running.manager.transitionToReview("stop-while-executing", "hook");
		expect(running.manager.getSummary("stop-while-executing")?.automaticAgentFailureContinuation?.phase).toBe(
			"executing",
		);
		nativeFailureContinuationDeliveryMock.mockResolvedValue({ outcome: "accepted_finished" });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(running.manager.getSummary("stop-while-executing")?.automaticAgentFailureContinuation?.phase).toBe(
			"recovered",
		);
		expect(resolveSessionFacets(requireSummary(running.manager, "stop-while-executing"))).toEqual({
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
		});
		running.manager.dispose();

		const failedAgain = await startCodexRecovery("stop-after-repeat-failure");
		nativeFailureContinuationDeliveryMock.mockResolvedValue({ outcome: "accepted_running" });
		failedAgain.session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		failedAgain.session.triggerData("Error: read ECONNRESET\n再次中断\n› ");
		await settleOutputAnalysisBatch();
		failedAgain.manager.transitionToReview("stop-after-repeat-failure", "hook");
		expect(
			failedAgain.manager.getSummary("stop-after-repeat-failure")?.automaticAgentFailureContinuation?.phase,
		).not.toBe("recovered");
		expect(resolveSessionFacets(requireSummary(failedAgain.manager, "stop-after-repeat-failure")).turnOwner).toBe(
			"agent",
		);
		failedAgain.manager.dispose();
	});

	it("取消后旧错误重绘不能复活，错误 episode 标识不匹配时拒绝操作", async () => {
		const getSession = spawnManagerWithSession(1202);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "cancel-repaint",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/isolated",
			prompt: "执行",
		});
		const session = getSession();
		if (!session) throw new Error("缺少测试终端");
		session.triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		const recovery = manager.getSummary("cancel-repaint")?.automaticAgentFailureContinuation;
		if (!recovery) throw new Error("缺少恢复意图");
		expect(await manager.actOnAutomaticFailureContinuation("cancel-repaint", "stale-episode", "cancel")).toBe(false);
		expect(await manager.actOnAutomaticFailureContinuation("cancel-repaint", recovery.episodeId, "cancel")).toBe(
			true,
		);
		session.triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(session.write).not.toHaveBeenCalled();
		expect(manager.getSummary("cancel-repaint")?.automaticAgentFailureContinuation?.phase).toBe("cancelled");
		manager.dispose();
	});

	it.each(["tool_activity", "agent_output", "context_compaction"] as const)(
		"错误之后的可信 %s 清理重连状态，即使终端没有空闲提示符",
		async (activityKind) => {
			const getSession = spawnManagerWithSession(1101);
			const manager = new TerminalSessionManager();
			await manager.startTaskSession({
				taskId: "semantic-recovery",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/isolated/semantic-recovery",
				prompt: "验证恢复",
			});
			const session = getSession();
			if (!session) throw new Error("缺少隔离 PTY");
			session.triggerData("Error: read ECONNRESET\n");
			await settleOutputAnalysisBatch();
			const errorAt = manager.getSummary("semantic-recovery")?.connectionRetry?.firstErrorAt;
			if (!errorAt) throw new Error("缺少重试 episode");
			manager.recordEffectiveAgentConversationActivity("semantic-recovery", {
				observedAtMs: errorAt - 1,
				evidenceKind: "agent_lifecycle_hook_event",
				activityKind,
			});
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("retrying");
			manager.recordEffectiveAgentConversationActivity(
				"semantic-recovery",
				{
					observedAtMs: errorAt + 60_001,
					evidenceKind: "agent_lifecycle_hook_event",
					activityKind,
				},
				{
					nativeAgentResponsePromptCacheReferenceObservation: {
						observedAtMs: errorAt,
						evidenceKind: "post_tool_use_hook_event",
					},
				},
			);
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("retrying");
			await vi.advanceTimersByTimeAsync(1);
			manager.recordEffectiveAgentConversationActivity("semantic-recovery", {
				observedAtMs: errorAt + 1,
				evidenceKind: "native_user_prompt_acceptance",
				activityKind: "accepted_user_input",
			});
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("retrying");
			await vi.advanceTimersByTimeAsync(1);
			manager.recordEffectiveAgentConversationActivity("semantic-recovery", {
				observedAtMs: errorAt + 2,
				evidenceKind: "agent_lifecycle_hook_event",
				activityKind,
			});
			expect(manager.getSummary("semantic-recovery")?.connectionRetry).toBeNull();
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("live");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(session.write).not.toHaveBeenCalled();
			manager.stopTaskSession("semantic-recovery");
		},
	);

	beforeEach(() => {
		inspectCodexNativeRetryReadinessMock.mockReset();
		nativeFailureContinuationDeliveryMock.mockReset().mockResolvedValue({ outcome: "deferred" });
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		ensureInstructionsFileMock.mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("injects a continuation referencing the instructions file after a transient connection error", async () => {
		const getSession = spawnManagerWithSession(1001);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		expect(session).not.toBeNull();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		// 检测到错误即进入重试状态，但不立即注入。
		expect(write).not.toHaveBeenCalled();
		expect(manager.getSummary("task-conn-drop")?.connectionRetry?.status).toBe("retrying");

		// 推进过首个退避档位 → 注入一次续跑（引用指令文件路径）。
		await vi.advanceTimersByTimeAsync(4_000);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("核对上一步");
		expect(write.mock.calls[0]?.[0]).toContain("[200~");

		manager.stopTaskSession("task-conn-drop");
	});

	it("续跑注入末尾 CR 被吞（输出仍静默）→ 写后确认补发裸 `\\r`，绝不重发整段 paste（防文本翻倍回归）", async () => {
		// 连接中断路径旧病：CR 被吞 → 退避重试重新整段 paste → 输入框文本叠两份。写后确认闭环改为补发裸回车：
		// 注入续跑 paste 后保持输出静默（模拟 CR 被吞、框卡 idle），过 SUBMIT_CONFIRM_DELAY_MS 应只补发一个 `"\r"`，
		// 而非又一段 `[200~…[201~`。
		const SUBMIT_CONFIRM_DELAY_MS = 2_500;
		const getSession = spawnManagerWithSession(1009);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-resend-cr",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-resend-cr",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000); // 首档退避 → 注入续跑 paste。
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("[200~");

		// 不再喂任何输出（CR 被吞、框静止）→ 过确认延时应补发裸回车。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");
		// 关键回归断言：补发的不是又一段 bracketed paste（绝不重发整段续跑文本 → 不翻倍）。
		expect(write.mock.calls[1]?.[0]).not.toContain("[200~");

		manager.stopTaskSession("task-conn-drop-resend-cr");
	});

	it("bridges an error line split across two flush windows via the carryover tail", async () => {
		// 错误行跨 flush 边界被切断:前半批 flush 后留 slice(-256) carryover,后半批与之拼接
		// 后正则仍命中 → episode 照常开启(与旧 per-chunk 语义下的跨 chunk 桥接同构)。
		const getSession = spawnManagerWithSession(1011);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-split-flush",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-split-flush",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		expect(session).not.toBeNull();

		// 前半段(错误短语「connection closed」被拦腰切断)→ 独立 flush 为第一批。
		(session as NonNullable<typeof session>).triggerData("\r⏺ API Error: Conn");
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-split-flush")?.connectionRetry ?? null).toBeNull();

		// 后半段 + 提示符框 → 第二批;与 carryover 拼接后命中 transient 正则。
		(session as NonNullable<typeof session>).triggerData(
			"ection closed mid-response. The response above may be incomplete.\r\n╭──────────────────────╮\n│ > │\n╰──────────────────────╯",
		);
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-split-flush")?.connectionRetry?.status).toBe("retrying");

		manager.stopTaskSession("task-conn-drop-split-flush");
	});

	it("does not inject when the auto-continue flag is disabled", async () => {
		const getSession = spawnManagerWithSession(1002);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-off",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-off",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: false,
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(write).not.toHaveBeenCalled();
		expect(manager.getSummary("task-conn-drop-off")?.connectionRetry ?? null).toBeNull();

		manager.stopTaskSession("task-conn-drop-off");
	});

	it("没有新错误仍须核对原发送，不能据静默宣告恢复", async () => {
		const getSession = spawnManagerWithSession(1003);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-recover",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-recover",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000); // first injection
		expect(write).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-conn-drop-recover")?.connectionRetry?.status).toBe("retrying");

		// 没有接受或进展证据，保持对原发送的核对，不能再次粘贴。
		await vi.advanceTimersByTimeAsync(20_000);
		// 只数「续跑 paste 注入」（含 bracketed-paste 框 `[200~`）：写后确认闭环在 mock 始终静默（无后续输出回流）下
		// 会补发裸 `\r`，那是另一条安全层、非续跑注入；恢复后续跑注入数应恒为 1。
		const continuationInjections = write.mock.calls.filter((call) => String(call[0]).includes("[200~"));
		expect(continuationInjections).toHaveLength(1);
		expect(manager.getSummary("task-conn-drop-recover")?.automaticAgentFailureContinuation?.phase).toBe(
			"reconciling_acceptance",
		);

		manager.stopTaskSession("task-conn-drop-recover");
	});

	it("stops the retry timer after the session is stopped", async () => {
		const getSession = spawnManagerWithSession(1004);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-stop",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-stop",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		manager.stopTaskSession("task-conn-drop-stop");
		await vi.advanceTimersByTimeAsync(30_000);
		// 计时器已清理：永远不会注入。
		expect(write).not.toHaveBeenCalled();
	});

	it("manual continue-now triggers a single injection for a retrying session", async () => {
		const getSession = spawnManagerWithSession(1005);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-manual",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-manual",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		const triggered = manager.continueConnectionRetrySessions(["task-conn-drop-manual"]);
		expect(triggered).toEqual(["task-conn-drop-manual"]);
		await vi.advanceTimersByTimeAsync(0);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("核对上一步");

		// 不在重试列表里的任务 id 不应被触发。
		const none = manager.continueConnectionRetrySessions(["nonexistent-task"]);
		expect(none).toEqual([]);

		manager.stopTaskSession("task-conn-drop-manual");
	});

	it("stands down (clears retry state, no injection) when the turn flips to the user mid-episode", async () => {
		// 竞态：PTY 输出先于 hook 落地 → episode 已起（retrying）；随后 agent 向用户提问，
		// hook 经 transitionToReview 把回合翻成 user → 检测器即时让位、清「重连中」、绝不注入。
		const getSession = spawnManagerWithSession(1007);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-standdown",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-standdown",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-standdown")?.connectionRetry?.status).toBe("retrying");

		// agent 向用户提问 → hook 翻入 user 回合（question）。
		manager.transitionToReview("task-conn-drop-standdown", "hook", "question");
		const standdown = manager.getSummary("task-conn-drop-standdown");
		if (!standdown) throw new Error("缺少会话");
		expect(standdown.connectionRetry ?? null).toBeNull();
		expect(standdown.automaticAgentFailureContinuation?.phase).not.toBe("cancelled");
		expect(resolveSessionFacets(standdown)).toEqual({
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "question",
		});

		// 退避定时器到点也不会注入（episode 已让位结束、定时器已清）。
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		manager.stopTaskSession("task-conn-drop-standdown");
	});

	it("does not enter retry when a transient pattern arrives after the turn already flipped to the user", async () => {
		// 常见路径：hook 先于问题 UI 文本落地 → turnOwner 已是 user。问题 / 选项文本里命中瞬时
		// 正则（如 agent 在讨论 econnreset）也不起 episode、不置「重连中」、不注入。
		const getSession = spawnManagerWithSession(1008);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-user-first",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-user-first",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		// 先翻入 user 回合（提问），再让带连接错误措辞的「问题文本」流过检测器。
		manager.transitionToReview("task-conn-drop-user-first", "hook", "question");
		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();

		expect(manager.getSummary("task-conn-drop-user-first")?.connectionRetry ?? null).toBeNull();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		manager.stopTaskSession("task-conn-drop-user-first");
	});

	it("manual dismiss removes a retrying session from the list without injecting", async () => {
		const getSession = spawnManagerWithSession(1006);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-dismiss",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-dismiss",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-dismiss")?.connectionRetry?.status).toBe("retrying");

		// 手动移出列表：结束 episode、清重连状态、不注入。
		const dismissed = manager.dismissConnectionRetrySessions(["task-conn-drop-dismiss"]);
		expect(dismissed).toEqual(["task-conn-drop-dismiss"]);
		expect(manager.getSummary("task-conn-drop-dismiss")?.connectionRetry ?? null).toBeNull();

		// 移出后退避定时器再触发也不应注入（episode 已结束、定时器已清）。
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		// 不在重试列表里的任务 id 不应被移出。
		const none = manager.dismissConnectionRetrySessions(["nonexistent-task"]);
		expect(none).toEqual([]);

		manager.stopTaskSession("task-conn-drop-dismiss");
	});
});
