import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { CodexRvfCloseoutCompactionAwareConfirmation } from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";
import type {
	CodexNativePromptDeliveryInput,
	CodexNativePromptDeliveryResult,
} from "../../../src/terminal/codex-native-prompt-delivery";
import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../../src/terminal/session-manager";
import {
	createTerminalInputBoxOccupancyTrackerState,
	recordTerminalInputBytesIntoOccupancyTracker,
} from "../../../src/terminal/terminal-input-box-occupancy";

const INCARNATION = "e96aa879-02a4-480e-bbd6-97b7e5e83843";
function installSession(manager: TerminalSessionManager, draft = "HUMAN_DRAFT") {
	const tracker = createTerminalInputBoxOccupancyTrackerState();
	if (draft) recordTerminalInputBytesIntoOccupancyTracker(tracker, Buffer.from(draft), 1);
	const write = vi.fn();
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "conversation-1",
		agentId: "codex",
		workspacePath: "/workspace",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		state: "awaiting_review",
		reviewReason: "hook",
		exitCode: null,
		runtimeSessionIncarnationId: INCARNATION,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "thread-1",
			transcriptPath: null,
			observedAt: 1,
		},
		codexNativeSessionControlEndpoint: {
			socketPath: "/isolated/control.sock",
			workspaceId: "workspace-1",
			conversationSessionId: "conversation-1",
			runtimeSessionIncarnationId: INCARNATION,
		},
	});
	const active = {
		codexAutomaticCompactionPhaseHooksConfigured: true,
		nativeCompactionAwareConfirmation: null,
		terminalSessionIncarnationSpawnedAtEpochMs: 1,
		session: { write },
		inputBoxOccupancyTracker: tracker,
		lastUserInputAt: null as number | null,
		deferredStartupPromptText: null,
		taskChatInputDeliveryTimer: null,
		taskChatInputDeliveryGeneration: 0,
		submitConfirmTimer: null,
		submitConfirmGeneration: 0,
		programmaticDeliveryReceipt: null,
		outputReactionScanBuffer: null,
		ptyOutputChunkArrivalSequenceNumber: 0,
		awaitingCodexPromptAfterEnter: false,
		suppressSubstantiveOutputUntilContinues: false,
		terminalSessionIncarnationToken: INCARNATION,
	};
	const entry = {
		summary,
		active,
		listeners: new Map(),
		restartRequest: { kind: "task", request: { workspaceId: "workspace-1" } },
		terminalStateMirror: {
			getScreenSnapshot: async () => ({
				columnCount: 80,
				cursorRow: 0,
				cursorColumn: draft ? draft.length + 2 : 2,
				lines: [
					{
						text: `› ${draft || "Ask Codex to do anything"}`,
						isWrapped: false,
						dimmedTextColumnRanges: draft ? [] : [[2, 80]],
					},
				],
			}),
			getViewportSnapshot: async () => ({
				snapshot: `› ${draft || "Ask Codex to do anything"}`,
				rows: 24,
				cols: 80,
			}),
		},
	};
	(manager as unknown as { entries: Map<string, unknown> }).entries.set("conversation-1", entry);
	return { entry, active, tracker, write };
}

describe("session manager 的 Codex 原生投递", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(600_000);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("草稿存在仍走原生通道，不写 PTY、不调用暂存，并保留输入账本", async () => {
		const native = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
			expect(await input.beforeSubmit()).toBe(true);
			input.onRequestAttempted();
			return {
				status: "confirmed",
				evidence: {
					clientUserMessageId: input.clientUserMessageId,
					nativeSessionId: "thread-1",
					nativeTurnId: "turn-2",
					nativeUserMessageId: "user-2",
				},
			};
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { tracker, write } = installSession(manager);
		const stash = vi.fn();
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			preemptivelyStashHumanInputBox: stash,
			mayAutoStashAbsentHumanInputBox: true,
		});
		await vi.advanceTimersByTimeAsync(1100);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(stash).not.toHaveBeenCalled();
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		expect(outcomes[0]).toMatchObject({
			status: "delivered_and_submit_confirmed",
			reason: null,
			codexNativePromptDeliveryEvidence: { nativeTurnId: "turn-2", nativeUserMessageId: "user-2" },
		});
	});

	it("原生写出后确认失败时不切回 PTY，也不重发", async () => {
		const native = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
			input.onRequestAttempted();
			return { status: "unconfirmed" };
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager, "");
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(20_000);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "codex_native_prompt_delivery_unconfirmed" }]);
	});

	it("人在当前终端打字时仍然让路", async () => {
		const native = vi.fn();
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { active, write } = installSession(manager);
		active.lastUserInputAt = Date.now();
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION");
		await vi.advanceTimersByTimeAsync(3000);
		expect(native).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("模态待答时不发起原生投递", async () => {
		const native = vi.fn();
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { entry, write } = installSession(manager);
		Object.assign(entry.summary, { turnOwner: "user", liveness: "live", userTurnKind: "question" });
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", { deferWhileUserTurn: true });
		await vi.advanceTimersByTimeAsync(3000);
		expect(native).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("原生能力不可用且框非空时，不抢占草稿或盲写 PTY", async () => {
		const native = vi.fn(async (): Promise<CodexNativePromptDeliveryResult> => ({ status: "unavailable" }));
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const stash = vi.fn();
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			preemptivelyStashHumanInputBox: stash,
			mayAutoStashAbsentHumanInputBox: true,
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(write).not.toHaveBeenCalled();
		expect(stash).not.toHaveBeenCalled();
	});

	it("原生不可用但当前屏幕确证为空时，仍可使用既有 PTY 后备", async () => {
		const native = vi.fn(async (): Promise<CodexNativePromptDeliveryResult> => ({ status: "unavailable" }));
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager, "");
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION");
		await vi.advanceTimersByTimeAsync(1100);
		expect(write.mock.calls.some(([text]) => String(text).includes("INJECTION"))).toBe(true);
		expect(write.mock.calls.some(([text]) => text === "\u0013")).toBe(false);
	});

	it("删至空框后，连续可信空框读数能解除输入侧的残留争用闩", async () => {
		const manager = new TerminalSessionManager();
		const { tracker } = installSession(manager, "");
		recordTerminalInputBytesIntoOccupancyTracker(tracker, Buffer.from("abc\u007f\u007f\u007f"), 1);
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		await manager.resolveTaskTerminalInputBoxOccupancy("conversation-1");
		await manager.resolveTaskTerminalInputBoxOccupancy("conversation-1");
		const occupancy = await manager.resolveTaskTerminalInputBoxOccupancy("conversation-1");
		expect(occupancy?.hasUncommittedInput).toBe(false);
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	it("原生预检期间取消后，提交回调不能越过代际检查", async () => {
		let submittedInput: CodexNativePromptDeliveryInput | undefined;
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			submittedInput = input;
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			idempotencyKey: "native-key",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		expect(manager.cancelTaskChatInputDelivery("conversation-1", "native-key")).toBe("cancelled_before_delivery");
		expect(await submittedInput?.beforeSubmit()).toBe(false);
		finishNative({ status: "cancelled" });
		await vi.advanceTimersByTimeAsync(2000);
		expect(write).not.toHaveBeenCalled();
		expect(native).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "cancelled_before_delivery" }]);
	});

	it("原生请求已尝试后不能声称取消成功，确认仍只收敛一次", async () => {
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			idempotencyKey: "native-key",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		expect(manager.cancelTaskChatInputDelivery("conversation-1", "native-key")).toBe("already_delivered");
		expect(outcomes).toEqual([]);
		finishNative({ status: "unconfirmed" });
		await vi.advanceTimersByTimeAsync(2000);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "codex_native_prompt_delivery_unconfirmed" }]);
	});

	it("另起 PTY 确认链及其预算终态都不能结算原生回执", async () => {
		let nativeInput!: CodexNativePromptDeliveryInput;
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			nativeInput = input;
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { active } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		// 复现独立连接续跑占用 PTY 确认通道，覆盖其清理旧回执及确认超时两个出口。
		(
			manager as unknown as {
				writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): void;
			}
		).writePasteSubmissionWithConfirm("conversation-1", active, "独立 PTY 续跑");
		expect(outcomes).toEqual([]);
		await vi.advanceTimersByTimeAsync(70_000);
		expect(outcomes).toEqual([]);
		const evidence = {
			clientUserMessageId: nativeInput.clientUserMessageId,
			nativeSessionId: "thread-1",
			nativeTurnId: "turn-2",
			nativeUserMessageId: "user-2",
		};
		finishNative({ status: "confirmed", evidence });
		await vi.advanceTimersByTimeAsync(0);
		expect(native).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([
			{ status: "delivered_and_submit_confirmed", reason: null, codexNativePromptDeliveryEvidence: evidence },
		]);
	});

	it("后续投递取代原生请求后，迟到接受不能确认后续回执", async () => {
		let nativeInput!: CodexNativePromptDeliveryInput;
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			nativeInput = input;
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const originalOutcomes: TaskChatInputDeliveryOutcome[] = [];
		const laterOutcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => originalOutcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		manager.submitTaskChatInputWhenReady("conversation-1", "LATER", {
			idempotencyKey: "later-key",
			onDeliveryOutcome: (outcome) => laterOutcomes.push(outcome),
		});
		expect(nativeInput.isCurrent()).toBe(false);
		finishNative({
			status: "confirmed",
			evidence: {
				clientUserMessageId: nativeInput.clientUserMessageId,
				nativeSessionId: "thread-1",
				nativeTurnId: "turn-2",
				nativeUserMessageId: "user-2",
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(originalOutcomes).toEqual([{ status: "delivery_failed", reason: "superseded_by_later_delivery" }]);
		expect(laterOutcomes).toEqual([]);
		expect(manager.cancelTaskChatInputDelivery("conversation-1", "later-key")).toBe("cancelled_before_delivery");
		expect(laterOutcomes).toEqual([{ status: "delivery_failed", reason: "cancelled_before_delivery" }]);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
	});

	it.each([
		"native_session",
		"transcript_path",
		"runtime_incarnation",
		"started_at",
		"workspace_path",
		"control_endpoint",
	])("原生查询返回的同时 %s 改变时，不把旧会话的确认记给新绑定", async (change) => {
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { entry, write } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		if (change === "native_session")
			Object.assign(entry.summary.agentNativeConversationSessionIdentity ?? {}, {
				nativeSessionId: "another-thread",
			});
		else if (change === "transcript_path")
			Object.assign(entry.summary.agentNativeConversationSessionIdentity ?? {}, {
				transcriptPath: "/another/rollout.jsonl",
			});
		else if (change === "runtime_incarnation") entry.summary.runtimeSessionIncarnationId = "another-incarnation";
		else if (change === "started_at") entry.summary.startedAt = 2;
		else if (change === "workspace_path") entry.summary.workspacePath = "/another/workspace";
		else
			Object.assign(entry.summary.codexNativeSessionControlEndpoint ?? {}, { socketPath: "/another/control.sock" });
		finishNative({
			status: "confirmed",
			evidence: {
				clientUserMessageId: "client-1",
				nativeSessionId: "thread-1",
				nativeTurnId: "turn-2",
				nativeUserMessageId: "user-2",
			},
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "codex_native_prompt_delivery_unconfirmed" }]);
	});
	it.each([true, false])(
		"原生请求必须等快照持久化，写入成功=%s；失败不能改成延长或发送",
		async (persistenceSucceeds) => {
			const snapshots: CodexRvfCloseoutCompactionAwareConfirmation[] = [];
			const persist = vi.fn(async (snapshot: CodexRvfCloseoutCompactionAwareConfirmation) => {
				if (persistenceSucceeds) snapshots.push(snapshot);
				return persistenceSucceeds;
			});
			let submitted = false;
			const native = vi.fn(
				async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
					expect(await input.beforeSubmit()).toBe(true);
					try {
						await input.onRequestAttempted({ predecessorNativeTurnId: "prior-turn" });
					} catch {
						return { status: "unconfirmed" };
					}
					submitted = true;
					expect(snapshots).toHaveLength(1);
					expect(await input.confirmationDeadlineAtEpochMs?.()).toBe(616_000);
					await input.onNativeTurnStarted?.("new-turn");
					return {
						status: "confirmed",
						evidence: {
							clientUserMessageId: input.clientUserMessageId,
							nativeSessionId: "thread-1",
							nativeTurnId: "new-turn",
							nativeUserMessageId: "message-1",
						},
					};
				},
			);
			const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
			const { write } = installSession(manager);
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
				idempotencyKey: "bound-closeout",
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
				rvfCloseoutCompactionConfirmationPersistence: {
					binding: {
						workspaceId: "workspace-1",
						taskId: "card",
						conversationSessionId: "conversation-1",
						decisionToken: "token",
						runId: "run",
						handoffSha256: "a".repeat(64),
						idempotencyKey: "bound-closeout",
						promptSha256: "b".repeat(64),
						nativeSessionId: "thread-1",
						runtimeSessionIncarnationId: INCARNATION,
						controlHostSocketPath: "/isolated/control.sock",
					},
					promptText: "INJECTION",
					validateStillAuthorized: async () => true,
					persistSnapshot: persist,
				},
			});
			await vi.advanceTimersByTimeAsync(1100);
			expect(submitted).toBe(persistenceSucceeds);
			expect(persist).toHaveBeenCalledTimes(persistenceSucceeds ? 2 : 1);
			if (persistenceSucceeds)
				expect(snapshots.at(-1)).toMatchObject({ nativeTurnIdReturnedBySubmissionRequest: "new-turn" });
			expect(outcomes[0]?.status).toBe(persistenceSucceeds ? "delivered_and_submit_confirmed" : "delivery_failed");
			expect(write).not.toHaveBeenCalled();
		},
	);
});
