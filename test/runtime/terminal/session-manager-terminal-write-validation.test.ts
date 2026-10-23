import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	NativeIndependentUserTurnDeliveryError,
	NativeIndependentUserTurnMessageAlreadyAccepted,
} from "../../../src/rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTerminalInputBoxOccupancyTrackerState } from "../../../src/terminal/terminal-input-box-occupancy";

const readNativeActivityMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/agent-session-history/native-agent-conversation-activity-reader", () => ({
	readNativeAgentConversationActivity: readNativeActivityMock,
}));

function installIsolatedFakeTerminal(manager: TerminalSessionManager) {
	const write = vi.fn();
	const entry = {
		summary: {
			taskId: "guarded-answer",
			agentId: "codex",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			state: "awaiting_review",
			workspacePath: "/isolated",
			pid: 12,
			startedAt: 1,
			updatedAt: 1,
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				transcriptPath: "/isolated/native.jsonl",
				observedAt: 1,
			},
			lastOutputAt: null,
			runtimeSessionIncarnationId: "resumed-incarnation",
		} as unknown as RuntimeTaskSessionSummary,
		active: {
			session: { write },
			deferredStartupPromptText: null,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null,
			lastUserInputAt: null,
			outputReactionScanBuffer: null,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			ptyOutputChunkArrivalSequenceNumber: 0,
		},
		terminalStateMirror: null as {
			getScreenSnapshot: () => Promise<{ lines: Array<{ text: string; isWrapped: boolean }>; columnCount: number }>;
		} | null,
		listeners: new Map(),
		listenerIdCounter: 1,
	};
	const internals = manager as unknown as {
		entries: Map<string, typeof entry>;
		resolveInteractivePromptReadiness: () => Promise<"prompt">;
		resolveProgrammaticDeliveryInputBoxContentionForTask: () => Promise<null>;
		invalidateCurrentWorkPhaseGoalAfterDeliveredUserPrompt: () => void;
	};
	internals.entries.set("guarded-answer", entry);
	vi.spyOn(internals, "resolveInteractivePromptReadiness").mockResolvedValue("prompt");
	vi.spyOn(internals, "invalidateCurrentWorkPhaseGoalAfterDeliveredUserPrompt").mockImplementation(() => undefined);
	vi.spyOn(internals, "resolveProgrammaticDeliveryInputBoxContentionForTask").mockResolvedValue(null);
	return { write, entry, internals };
}

function showOwnedUnsubmittedPrompt(
	entry: ReturnType<typeof installIsolatedFakeTerminal>["entry"],
	text: string,
): void {
	entry.terminalStateMirror = {
		getScreenSnapshot: async () => ({
			lines: [
				{ text: "model: test", isWrapped: false },
				{ text: `› ${text}`, isWrapped: false },
			],
			columnCount: 80,
		}),
	};
}

describe("程序化终端投递的实际写入前核验", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		readNativeActivityMock.mockReset().mockResolvedValue(null);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("readiness 挂起期间问题已作答时，不写入旧答案并结算失败", async () => {
		const manager = new TerminalSessionManager();
		const { write, internals } = installIsolatedFakeTerminal(manager);
		let releaseReadiness: (value: "prompt") => void = () => undefined;
		const readiness = {
			promise: new Promise<"prompt">((resolve) => {
				releaseReadiness = resolve;
			}),
		};
		vi.mocked(internals.resolveInteractivePromptReadiness).mockReturnValue(readiness.promise);
		let alreadyAnswered = false;
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("guarded-answer", "旧问题的答案", {
			validateBeforeTerminalWrite: async () => {
				if (alreadyAnswered) throw new Error("原问题已有真实答案");
			},
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1000);
		alreadyAnswered = true;
		releaseReadiness("prompt");
		await vi.advanceTimersByTimeAsync(0);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "cancelled_before_delivery" }]);
	});
	it("争用检查挂起期间出现新问题时，不粘贴旧答案", async () => {
		const manager = new TerminalSessionManager();
		const { write, internals } = installIsolatedFakeTerminal(manager);
		let releaseContention: (value: null) => void = () => undefined;
		vi.mocked(internals.resolveProgrammaticDeliveryInputBoxContentionForTask).mockReturnValue(
			new Promise<null>((resolve) => {
				releaseContention = resolve;
			}),
		);
		let hasSuccessorQuestion = false;
		manager.submitTaskChatInputWhenReady("guarded-answer", "旧答案", {
			validateBeforeTerminalWrite: async () => {
				if (hasSuccessorQuestion) throw new Error("已出现后继问题");
			},
		});
		await vi.advanceTimersByTimeAsync(1000);
		hasSuccessorQuestion = true;
		releaseContention(null);
		await vi.advanceTimersByTimeAsync(0);
		expect(write).not.toHaveBeenCalled();
	});

	it.each(["session_replaced", "delivery_superseded"])("领域核验等待期间 %s，旧投递不写入", async (change) => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installIsolatedFakeTerminal(manager);
		let releaseValidation: () => void = () => undefined;
		manager.submitTaskChatInputWhenReady("guarded-answer", "旧答案", {
			validateBeforeTerminalWrite: () =>
				new Promise<void>((resolve) => {
					releaseValidation = resolve;
				}),
		});
		await vi.advanceTimersByTimeAsync(1000);
		if (change === "session_replaced") entry.active = { ...entry.active, session: { write: vi.fn() } };
		else manager.submitTaskChatInputWhenReady("guarded-answer", "新投递");
		releaseValidation();
		await vi.advanceTimersByTimeAsync(0);
		expect(write).not.toHaveBeenCalled();
	});

	it.each(["first_submit", "resend_submit"])("粘贴后 %s 前核验失败，绝不向新选择器发送 Enter", async (phase) => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installIsolatedFakeTerminal(manager);
		if (phase === "resend_submit") showOwnedUnsubmittedPrompt(entry, "旧答案");
		let mayWrite = true;
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("guarded-answer", "旧答案", {
			validateBeforeTerminalWrite: async () => {
				if (!mayWrite) throw new Error("新选择器已出现");
			},
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(write).toHaveBeenCalledTimes(1);
		entry.active.ptyOutputChunkArrivalSequenceNumber++;
		if (phase === "resend_submit") await vi.advanceTimersByTimeAsync(60);
		mayWrite = false;
		await vi.advanceTimersByTimeAsync(3000);
		expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(phase === "first_submit" ? 0 : 1);
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" }]);
	});

	for (const nativeIndependentUserTurnDeliveryFailureReason of [
		"native_independent_user_turn_capability_unavailable",
		"native_independent_user_turn_session_replaced",
	] as const) {
		it.each(["before_paste", "first_submit", "resend_submit"] as const)(
			`${nativeIndependentUserTurnDeliveryFailureReason} 在 %s 拒绝写入后保留准确原因，不再粘贴或补发 Enter`,
			async (terminalWriteValidationPhase) => {
				const terminalSessionManager = new TerminalSessionManager();
				const { write: writeToIsolatedTerminal, entry: isolatedTerminalSessionEntry } =
					installIsolatedFakeTerminal(terminalSessionManager);
				if (terminalWriteValidationPhase === "resend_submit")
					showOwnedUnsubmittedPrompt(isolatedTerminalSessionEntry, "独立原生回合正文");
				let rejectNativeIndependentUserTurnWrite = terminalWriteValidationPhase === "before_paste";
				const terminalDeliveryOutcomes: TaskChatInputDeliveryOutcome[] = [];
				terminalSessionManager.submitTaskChatInputWhenReady("guarded-answer", "独立原生回合正文", {
					validateBeforeTerminalWrite: async () => {
						if (rejectNativeIndependentUserTurnWrite)
							throw new NativeIndependentUserTurnDeliveryError(
								nativeIndependentUserTurnDeliveryFailureReason,
								"测试原生独立回合门禁拒绝写入",
							);
					},
					onDeliveryOutcome: (outcome) => terminalDeliveryOutcomes.push(outcome),
				});
				await vi.advanceTimersByTimeAsync(1000);
				if (terminalWriteValidationPhase !== "before_paste") {
					expect(writeToIsolatedTerminal).toHaveBeenCalledTimes(1);
					isolatedTerminalSessionEntry.active.ptyOutputChunkArrivalSequenceNumber++;
					if (terminalWriteValidationPhase === "resend_submit") await vi.advanceTimersByTimeAsync(60);
					rejectNativeIndependentUserTurnWrite = true;
				}
				await vi.advanceTimersByTimeAsync(3000);
				const expectedTerminalWriteCount =
					terminalWriteValidationPhase === "before_paste"
						? 0
						: terminalWriteValidationPhase === "first_submit"
							? 1
							: 2;
				expect(writeToIsolatedTerminal).toHaveBeenCalledTimes(expectedTerminalWriteCount);
				expect(writeToIsolatedTerminal.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(
					terminalWriteValidationPhase === "resend_submit" ? 1 : 0,
				);
				expect(terminalDeliveryOutcomes).toEqual([
					{ status: "delivery_failed", reason: nativeIndependentUserTurnDeliveryFailureReason },
				]);
				await vi.advanceTimersByTimeAsync(10_000);
				expect(writeToIsolatedTerminal).toHaveBeenCalledTimes(expectedTerminalWriteCount);
				expect(terminalDeliveryOutcomes).toEqual([
					{ status: "delivery_failed", reason: nativeIndependentUserTurnDeliveryFailureReason },
				]);
			},
		);
	}

	it("没有领域 guard 的 Claude 调用沿用原有粘贴与提交行为", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installIsolatedFakeTerminal(manager);
		entry.summary.agentId = "claude";
		manager.submitTaskChatInputWhenReady("guarded-answer", "普通输入");
		await vi.advanceTimersByTimeAsync(1000);
		entry.active.ptyOutputChunkArrivalSequenceNumber++;
		await vi.advanceTimersByTimeAsync(60);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");
	});
	for (const phase of ["first_submit", "resend_submit"] as const) {
		it.each([
			"session_replaced",
			"delivery_superseded",
			"native_session_rebound",
			"native_session_rebound_then_rejected",
		])(`${phase} 核验等待期间 %s，旧确认链不再写 Enter`, async (change) => {
			const manager = new TerminalSessionManager();
			const { write, entry } = installIsolatedFakeTerminal(manager);
			if (phase === "resend_submit") showOwnedUnsubmittedPrompt(entry, "旧答案");
			let validationCount = 0;
			let releaseValidation: () => void = () => undefined;
			let rejectValidation: (error: Error) => void = () => undefined;
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("guarded-answer", "旧答案", {
				validateBeforeTerminalWrite: async () => {
					validationCount++;
					if (validationCount === (phase === "first_submit" ? 2 : 3))
						await new Promise<void>((resolve, reject) => {
							releaseValidation = resolve;
							rejectValidation = reject;
						});
				},
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			await vi.advanceTimersByTimeAsync(1000);
			entry.active.ptyOutputChunkArrivalSequenceNumber++;
			await vi.advanceTimersByTimeAsync(60);
			if (phase === "resend_submit") await vi.advanceTimersByTimeAsync(2500);
			expect(validationCount).toBe(phase === "first_submit" ? 2 : 3);
			if (change === "session_replaced") entry.active = { ...entry.active, session: { write: vi.fn() } };
			else if (change === "delivery_superseded") manager.submitTaskChatInputWhenReady("guarded-answer", "新投递");
			else
				entry.summary.agentNativeConversationSessionIdentity = {
					sourceAgentId: "codex",
					nativeSessionId: "new-native",
					transcriptPath: "/isolated/new-native.jsonl",
					observedAt: Date.now(),
				};
			if (change === "native_session_rebound_then_rejected") rejectValidation(new Error("原生查询断开"));
			else releaseValidation();
			await vi.advanceTimersByTimeAsync(0);
			expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(phase === "first_submit" ? 0 : 1);
			if (change.startsWith("native_session_rebound"))
				expect(outcomes).toEqual([{ status: "delivery_failed", reason: "session_ended_before_delivery" }]);
		});
	}
	it("首个 CR 已摄入本条唯一原生消息时停止补发，回执仍为确认送达", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installIsolatedFakeTerminal(manager);
		let accepted = false;
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("guarded-answer", "独立边界", {
			validateBeforeTerminalWrite: async () => {
				if (accepted) throw new NativeIndependentUserTurnMessageAlreadyAccepted();
			},
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1000);
		entry.active.ptyOutputChunkArrivalSequenceNumber++;
		await vi.advanceTimersByTimeAsync(60);
		expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(1);
		accepted = true;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(1);
		expect(outcomes).toEqual([{ status: "delivered_and_submit_confirmed", reason: null }]);
	});

	it.each(["unchanged", "native_session", "transcript_path", "control_endpoint", "incarnation", "started_at"])(
		"首个 CR 后原生目标 %s，同正文接受只能确认写前绑定的回执",
		async (change) => {
			const manager = new TerminalSessionManager();
			const { write, entry } = installIsolatedFakeTerminal(manager);
			readNativeActivityMock.mockResolvedValue({
				events: [],
				cursor: { transport: "codex_control", predecessorTurnId: "previous", seenEventIds: ["previous-message"] },
			});
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("guarded-answer", "同一段正文", {
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			await vi.advanceTimersByTimeAsync(1000);
			entry.active.ptyOutputChunkArrivalSequenceNumber++;
			await vi.advanceTimersByTimeAsync(60);
			expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(1);
			const originalActive = entry.active;
			if (change === "incarnation") entry.summary.runtimeSessionIncarnationId = "next-incarnation";
			else if (change === "started_at") entry.summary.startedAt = 2;
			else if (change === "control_endpoint")
				entry.summary.codexNativeSessionControlEndpoint = {
					socketPath: "/isolated/rebound-socket",
					workspaceId: "workspace",
					conversationSessionId: "guarded-answer",
					runtimeSessionIncarnationId: "resumed-incarnation",
				};
			else if (change !== "unchanged")
				entry.summary.agentNativeConversationSessionIdentity = {
					sourceAgentId: "codex",
					nativeSessionId: change === "native_session" ? "rebound-native" : "native",
					transcriptPath: "/isolated/rebound-transcript.jsonl",
					observedAt: Date.now(),
				};
			manager.confirmAcceptedAgentConversationInput("guarded-answer", {
				eventId: "new-message-with-same-text",
				nativeSessionId: entry.summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
				runtimeSessionIncarnationId: entry.summary.runtimeSessionIncarnationId ?? "",
				observedAtMs: Date.now(),
				submittedPromptText: "同一段正文",
			});
			expect(entry.active).toBe(originalActive);
			if (change === "unchanged")
				expect(outcomes).toEqual([{ status: "delivered_and_submit_confirmed", reason: null }]);
			else {
				expect(outcomes).toEqual([]);
				await vi.advanceTimersByTimeAsync(2500);
				expect(outcomes).toEqual([{ status: "delivery_failed", reason: "session_ended_before_delivery" }]);
			}
			await vi.advanceTimersByTimeAsync(20_000);
			expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(1);
			expect(outcomes).toHaveLength(1);
		},
	);

	it.each(["native_session", "transcript_path", "incarnation", "started_at", "control_endpoint", "read_rejected"])(
		"读取原生前驱时同一 PTY 的 %s 改变，旧输入不写 CR、不借用前驱",
		async (change) => {
			const manager = new TerminalSessionManager();
			const { write, entry } = installIsolatedFakeTerminal(manager);
			let finishRead: (value: null) => void = () => undefined;
			let rejectRead: (error: Error) => void = () => undefined;
			readNativeActivityMock.mockImplementationOnce(
				() =>
					new Promise((resolve, reject) => {
						finishRead = resolve;
						rejectRead = reject;
					}),
			);
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("guarded-answer", "旧会话正文", {
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect(write).toHaveBeenCalledTimes(1);
			entry.active.ptyOutputChunkArrivalSequenceNumber++;
			await vi.advanceTimersByTimeAsync(60);
			expect(readNativeActivityMock).toHaveBeenCalledTimes(1);
			const originalActive = entry.active;
			if (change === "incarnation") entry.summary.runtimeSessionIncarnationId = "new-incarnation";
			else if (change === "started_at") entry.summary.startedAt = 2;
			else if (change === "control_endpoint")
				entry.summary.codexNativeSessionControlEndpoint = {
					socketPath: "/isolated/new-socket",
					workspaceId: "workspace",
					conversationSessionId: "guarded-answer",
					runtimeSessionIncarnationId: "resumed-incarnation",
				};
			else
				entry.summary.agentNativeConversationSessionIdentity = {
					sourceAgentId: "codex",
					nativeSessionId: change === "transcript_path" ? "native" : "new-native",
					transcriptPath: "/isolated/new-transcript.jsonl",
					observedAt: Date.now(),
				};
			if (change === "read_rejected") rejectRead(new Error("原生查询已断开"));
			else finishRead(null);
			await vi.advanceTimersByTimeAsync(0);
			expect(entry.active).toBe(originalActive);
			expect(write.mock.calls.filter(([bytes]) => bytes === "\r")).toHaveLength(0);
			expect(outcomes).toEqual([{ status: "delivery_failed", reason: "session_ended_before_delivery" }]);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(write).toHaveBeenCalledTimes(1);
		},
	);
});
