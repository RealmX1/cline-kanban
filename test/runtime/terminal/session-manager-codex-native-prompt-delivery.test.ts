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
import type { PendingProgrammaticDeliveryReceipt } from "../../../src/terminal/terminal-session-active-process-state";

const INCARNATION = "e96aa879-02a4-480e-bbd6-97b7e5e83843";
const managedRecording = vi.hoisted(() => ({ begin: vi.fn(), settle: vi.fn() }));
const readNativeActivity = vi.hoisted(() => vi.fn());
vi.mock("../../../src/agent-session-history/native-agent-conversation-activity-reader", () => ({
	readNativeAgentConversationActivity: readNativeActivity,
}));
vi.mock("../../../src/state/managed-task-prompt-delivery-coordinator", () => ({
	beginManagedTaskPromptDelivery: managedRecording.begin,
	settleManagedTaskPromptDeliveryWithoutBlocking: managedRecording.settle,
}));
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
		programmaticDeliveryReceipt: null as PendingProgrammaticDeliveryReceipt | null,
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
	return {
		entry,
		active,
		tracker,
		write,
		setDraft: (value: string) => {
			draft = value;
		},
	};
}

describe("session manager 的 Codex 原生投递", () => {
	it.each(["claude", "codex"] as const)("%s 的原始按键不充当空侧会话的用户消息接受证据", (agentId) => {
		for (const role of ["by_the_way", "task_collaborator"] as const) {
			for (const rawInput of ["y\r", "1\r", "\r", "\n", "尚未被接受的真实正文\r"]) {
				const manager = new TerminalSessionManager();
				const { entry, write } = installSession(manager, "");
				entry.summary.agentId = agentId;
				entry.summary.agentNativeConversationSessionIdentity = null;
				entry.summary.taskConversationSessionMetadata = {
					workspaceTaskId: "host-task",
					taskConversationSessionRole: role,
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: 1,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				};
				entry.summary.taskConversationSessionNativeIdentityRecovery = {
					runtimeSessionIncarnationId: INCARNATION,
					forkSourceNativeSessionId: null,
					resumeRequestedAtMs: Date.now(),
					consecutiveUnchangedProbeCount: 0,
					lastEvidenceFingerprint: null,
					nextProbeAtMs: 0,
				};
				manager.writeInput("conversation-1", Buffer.from(rawInput));
				const summary = manager.getSummary("conversation-1");
				expect(summary?.taskConversationSessionMetadata?.latestUserMessagePreview).toBeNull();
				expect(summary?.agentConversationPromptSubmissionAcceptance ?? null).toBeNull();
				expect(summary?.taskConversationSessionNativeIdentityRecovery).toMatchObject({
					runtimeSessionIncarnationId: INCARNATION,
					resumeRequestedAtMs: null,
				});
				expect(write).toHaveBeenCalledExactlyOnceWith(Buffer.from(rawInput));
			}
		}
	});

	it.each(["claude", "codex"] as const)("%s 的空侧会话在首次真实接受后显示用户原文预览", (agentId) => {
		for (const role of ["by_the_way", "task_collaborator"] as const) {
			const manager = new TerminalSessionManager();
			const { entry } = installSession(manager, "");
			entry.summary.agentId = agentId;
			if (entry.summary.agentNativeConversationSessionIdentity)
				entry.summary.agentNativeConversationSessionIdentity.sourceAgentId = agentId;
			entry.summary.taskConversationSessionMetadata = {
				workspaceTaskId: "host-task",
				taskConversationSessionRole: role,
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: null,
			};
			const acceptedInput = {
				observedAtMs: Date.now(),
				eventId: "first-real-user-input",
				nativeSessionId: "thread-1",
				runtimeSessionIncarnationId: INCARNATION,
				submittedPromptText: "  首次真实消息  ",
			};
			manager.confirmAcceptedAgentConversationInput("conversation-1", {
				...acceptedInput,
				runtimeSessionIncarnationId: "stale-incarnation",
			});
			expect(
				manager.getSummary("conversation-1")?.taskConversationSessionMetadata?.latestUserMessagePreview,
			).toBeNull();
			manager.confirmAcceptedAgentConversationInput("conversation-1", acceptedInput);
			expect(manager.getSummary("conversation-1")?.taskConversationSessionMetadata?.latestUserMessagePreview).toBe(
				"首次真实消息",
			);
		}
	});

	it("纯 /plan 只初始化模式，不登记投递、不记接受、不增加回合", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { active, write } = installSession(manager, "");
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "/plan" });
		const summaryBefore = manager.getSummary("conversation-1");
		expect(
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1"),
		).toBe(true);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(write.mock.calls).toEqual([["\x1b[200~/plan\x1b[201~"], ["\r"]]);
		expect(managedRecording.begin).not.toHaveBeenCalled();
		expect(readNativeActivity).not.toHaveBeenCalled();
		expect(manager.getSummary("conversation-1")).toEqual(summaryBefore);
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
	});

	it("已受理但尚未写入的首条消息等待 Plan 初始化，不形成互相等待", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { active, write } = installSession(manager, "");
		const observer = vi.fn();
		const queuedFirstPrompt: PendingProgrammaticDeliveryReceipt = {
			idempotencyKey: "first-input",
			phase: "awaiting_readiness",
			promptText: "首条真实消息",
			outputChunkArrivalSequenceNumberAtSubmitCarriageReturn: null,
			queuedBehindActiveAgentTurn: false,
			settled: false,
			observer,
		};
		Object.assign(active, {
			workspaceTrustBuffer: null,
			deferredStartupPromptText: "/plan",
			programmaticDeliveryReceipt: queuedFirstPrompt,
		});
		expect(
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1"),
		).toBe(true);
		expect(active.deferredStartupPromptText).toBe("/plan");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(active.deferredStartupPromptText).toBeNull();
		expect(active.programmaticDeliveryReceipt).toBe(queuedFirstPrompt);
		expect(write.mock.calls).toEqual([["\x1b[200~/plan\x1b[201~"], ["\r"]]);
		expect(observer).not.toHaveBeenCalled();
		expect(managedRecording.begin).not.toHaveBeenCalled();
	});

	it("输入框有草稿时纯 /plan 等待，随后只初始化一次", async () => {
		const manager = new TerminalSessionManager();
		const { active, write, tracker, setDraft } = installSession(manager, "草稿");
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "/plan" });
		const tryInitialize = () =>
			(
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1");
		expect(await tryInitialize()).toBe(false);
		expect(write).not.toHaveBeenCalled();
		Object.assign(tracker, createTerminalInputBoxOccupancyTrackerState());
		setDraft("");
		expect(await tryInitialize()).toBe(true);
		expect(await tryInitialize()).toBe(false);
	});
	beforeEach(() => {
		managedRecording.begin.mockReset();
		managedRecording.settle.mockReset();
		readNativeActivity.mockReset();
		readNativeActivity.mockResolvedValue({
			events: [],
			cursor: { transport: "codex_control", predecessorTurnId: "prior-turn", seenEventIds: ["prior-input"] },
		});
		vi.useFakeTimers();
		vi.setSystemTime(600_000);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it.each([true, false])("自动 PTY 投递 startup=%s：原生接受才释放确认回执", async (startup) => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		const handle = { deliveryId: "automatic-delivery", settle: vi.fn() };
		managedRecording.begin.mockResolvedValue({ handle });
		const promptText = startup ? "初始提示正文" : "连接恢复正文";
		if (startup) {
			Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: promptText });
			expect(
				await (
					manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
				).trySubmitDeferredStartupPrompt("conversation-1"),
			).toBe(true);
		} else {
			expect(
				await (
					manager as unknown as {
						writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): Promise<boolean>;
					}
				).writePasteSubmissionWithConfirm("conversation-1", active, promptText),
			).toBe(true);
		}
		expect(write).toHaveBeenCalledOnce();
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(true);
		await vi.advanceTimersByTimeAsync(1600);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(readNativeActivity).toHaveBeenCalledOnce();
		expect(managedRecording.settle).not.toHaveBeenCalled();
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(true);
		manager.confirmAcceptedAgentConversationInput("conversation-1", {
			observedAtMs: Date.now(),
			eventId: "new-automatic-input",
			nativeSessionId: "thread-1",
			runtimeSessionIncarnationId: INCARNATION,
			submittedPromptText: promptText,
		});
		expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
			status: "delivered_and_submit_confirmed",
			reason: null,
		});
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
		await vi.advanceTimersByTimeAsync(70_000);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(managedRecording.settle).toHaveBeenCalledOnce();
	});

	it.each([true, false])("自动 PTY 投递 startup=%s：确认预算耗尽后诚实失败", async (startup) => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		const handle = { deliveryId: "unconfirmed-automatic-delivery", settle: vi.fn() };
		managedRecording.begin.mockResolvedValue({ handle });
		await (
			manager as unknown as {
				writePasteSubmissionWithConfirm(
					taskId: string,
					target: unknown,
					text: string,
					options: { waitsForStartupCompletion: boolean },
				): Promise<boolean>;
			}
		).writePasteSubmissionWithConfirm("conversation-1", active, "无法确认的正文", {
			waitsForStartupCompletion: startup,
		});
		await vi.advanceTimersByTimeAsync(70_000);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
			status: "delivery_failed",
			reason: "submit_confirmation_budget_exhausted",
		});
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
	});

	it("自动首发不使用另一条待发 RVF 消息的压缩确认持久化", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { active, write } = installSession(manager, "");
		Object.assign(active, { deferredStartupPromptText: "本次自动首发" });
		const persistSnapshot = vi.fn(async () => true);
		const validateStillAuthorized = vi.fn(async () => false);
		manager.submitTaskChatInputWhenReady("conversation-1", "原来待发的 RVF 消息", {
			idempotencyKey: "pending-rvf-closeout",
			onDeliveryOutcome: vi.fn(),
			rvfCloseoutCompactionConfirmationPersistence: {
				binding: {
					workspaceId: "workspace-1",
					taskId: "card",
					conversationSessionId: "conversation-1",
					decisionToken: "token",
					runId: "run",
					handoffSha256: "a".repeat(64),
					idempotencyKey: "pending-rvf-closeout",
					promptSha256: "b".repeat(64),
					nativeSessionId: "thread-1",
					runtimeSessionIncarnationId: INCARNATION,
					controlHostSocketPath: "/isolated/control.sock",
				},
				promptText: "原来待发的 RVF 消息",
				validateStillAuthorized,
				persistSnapshot,
			},
		});
		const pendingReceipt = active.programmaticDeliveryReceipt;
		managedRecording.begin.mockResolvedValue({ handle: { deliveryId: "automatic-startup", settle: vi.fn() } });
		await (
			manager as unknown as {
				writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): Promise<boolean>;
			}
		).writePasteSubmissionWithConfirm("conversation-1", active, "本次自动首发");
		await vi.advanceTimersByTimeAsync(4100);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(active.programmaticDeliveryReceipt).toBe(pendingReceipt);
		expect(persistSnapshot).not.toHaveBeenCalled();
		expect(validateStillAuthorized).not.toHaveBeenCalled();
		expect(active.nativeCompactionAwareConfirmation).toBeNull();
	});

	it.each([
		{ startup: true, confirmsAutomaticInput: true },
		{ startup: false, confirmsAutomaticInput: true },
		{ startup: true, confirmsAutomaticInput: false },
		{ startup: false, confirmsAutomaticInput: false },
	])(
		"自动 writer startup=$startup、确认=$confirmsAutomaticInput：旧 intent 在自动投递落定后继续",
		async ({ startup, confirmsAutomaticInput }) => {
			const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
			const { entry, active, write } = installSession(manager, "");
			entry.summary.agentId = "claude";
			entry.terminalStateMirror.getViewportSnapshot = async () => ({
				snapshot: "╭──────────────────────╮\n│ > │\n╰──────────────────────╯",
				cols: 80,
				rows: 24,
			});
			Object.assign(active, {
				workspaceTrustBuffer: null,
				deferredStartupPromptText: startup ? "必须先发送的首发" : null,
			});
			const handle = { deliveryId: "startup-before-pending-message", settle: vi.fn() };
			managedRecording.begin.mockResolvedValue({ handle });
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("conversation-1", "原来尚未写出的消息", {
				idempotencyKey: "original-pending-message",
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			const originalReceipt = active.programmaticDeliveryReceipt;
			const originalDeliveryGeneration = active.taskChatInputDeliveryGeneration;
			if (startup)
				await (
					manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
				).trySubmitDeferredStartupPrompt("conversation-1");
			else
				await (
					manager as unknown as {
						writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): Promise<boolean>;
					}
				).writePasteSubmissionWithConfirm("conversation-1", active, "必须先发送的首发");
			expect(outcomes).toEqual([]);
			expect(active.programmaticDeliveryReceipt).toBe(originalReceipt);
			expect(active.taskChatInputDeliveryGeneration).toBe(originalDeliveryGeneration);
			await vi.advanceTimersByTimeAsync(1600);
			expect(write.mock.calls.filter(([text]) => String(text).includes("原来尚未写出的消息"))).toHaveLength(0);
			if (confirmsAutomaticInput)
				manager.confirmAcceptedAgentConversationInput("conversation-1", {
					observedAtMs: Date.now(),
					eventId: "accepted-startup-input",
					nativeSessionId: "thread-1",
					runtimeSessionIncarnationId: INCARNATION,
					submittedPromptText: "必须先发送的首发",
				});
			else {
				for (
					let confirmationTick = 0;
					confirmationTick < 30 && !managedRecording.settle.mock.calls.length;
					confirmationTick++
				)
					await vi.advanceTimersByTimeAsync(2500);
			}
			expect(outcomes).toEqual([]);
			expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
				status: confirmsAutomaticInput ? "delivered_and_submit_confirmed" : "delivery_failed",
				reason: confirmsAutomaticInput ? null : "submit_confirmation_budget_exhausted",
			});
			await vi.advanceTimersByTimeAsync(2500);
			expect(write.mock.calls.filter(([text]) => String(text).includes("原来尚未写出的消息"))).toHaveLength(1);
			manager.confirmAcceptedAgentConversationInput("conversation-1", {
				observedAtMs: Date.now(),
				eventId: "accepted-original-pending-input",
				nativeSessionId: "thread-1",
				runtimeSessionIncarnationId: INCARNATION,
				submittedPromptText: "原来尚未写出的消息",
			});
			expect(outcomes).toEqual([
				{
					status: confirmsAutomaticInput
						? "delivered_queued_behind_active_agent_turn"
						: "delivered_and_submit_confirmed",
					reason: null,
				},
			]);
			expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
		},
	);

	it.each(["human_input", "native_identity", "submit_generation"] as const)(
		"自动 writer 读取原生基线期间 %s 改变，不再写 CR 或结算尚未写出的消息",
		async (change) => {
			const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
			const { entry, active, write } = installSession(manager, "");
			entry.summary.agentId = "claude";
			Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "必须先发送的首发" });
			const handle = { deliveryId: "automatic-read-in-flight", settle: vi.fn() };
			managedRecording.begin.mockResolvedValue({ handle });
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("conversation-1", "仍待发送的消息", {
				idempotencyKey: "preserved-pending-message",
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			let releaseNativeBaseline: (value: unknown) => void = () => {};
			readNativeActivity.mockReturnValueOnce(
				new Promise((resolveBaseline) => {
					releaseNativeBaseline = resolveBaseline;
				}),
			);
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1");
			await vi.advanceTimersByTimeAsync(1600);
			expect(readNativeActivity).toHaveBeenCalledOnce();
			if (change === "human_input") manager.writeInput("conversation-1", Buffer.from("人工草稿"));
			else if (change === "native_identity")
				Object.assign(entry.summary.agentNativeConversationSessionIdentity ?? {}, { nativeSessionId: "changed" });
			else active.submitConfirmGeneration += 1;
			releaseNativeBaseline({
				events: [],
				cursor: { transport: "codex_control", predecessorTurnId: "prior-turn", seenEventIds: [] },
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(0);
			expect(outcomes).toEqual([]);
			expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
				status: "delivery_failed",
				reason: change === "human_input" ? "submit_confirmation_budget_exhausted" : "session_ended_before_delivery",
			});
		},
	);

	it("deferred 启动提示在首字节写出前登记，粘贴本身不冒充确认", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "初始提示正文" });
		let releaseRegistration: (value: unknown) => void = () => {};
		managedRecording.begin.mockReturnValueOnce(
			new Promise((resolveRegistration) => {
				releaseRegistration = resolveRegistration;
			}),
		);
		const submitting = (
			manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
		).trySubmitDeferredStartupPrompt("conversation-1");
		expect(write).not.toHaveBeenCalled();
		expect(managedRecording.begin).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "初始提示正文",
				deliveryStrategy: "session_startup",
				origin: expect.objectContaining({ messageType: "session_startup" }),
			}),
		);
		const handle = { deliveryId: "startup-record", settle: vi.fn() };
		releaseRegistration({ handle });
		expect(await submitting).toBe(true);
		expect(write).toHaveBeenCalledOnce();
		expect(handle.settle).not.toHaveBeenCalled();
	});

	it("首发登记期间人开始输入则取消，不覆盖人工草稿", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "初始提示正文" });
		const handle = { deliveryId: "cancelled-startup", settle: vi.fn(async () => {}) };
		managedRecording.begin.mockImplementationOnce(async () => {
			active.lastUserInputAt = 600_001;
			return { handle };
		});
		expect(
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1"),
		).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(handle.settle).toHaveBeenCalledWith({ status: "delivery_failed", reason: "cancelled_before_delivery" });
	});

	it("首发登记失败保留正文并有界重试，三次后不随屏幕重绘无限重试", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "仍需提交的初始正文" });
		managedRecording.begin.mockRejectedValue(new Error("登记文件暂不可写"));
		const submit = () =>
			(
				manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1");
		await expect(submit()).rejects.toThrow("登记文件暂不可写");
		await vi.advanceTimersByTimeAsync(3001);
		expect(managedRecording.begin).toHaveBeenCalledTimes(3);
		expect(await submit()).toBe(false);
		expect(active.deferredStartupPromptText).toBe("仍需提交的初始正文");
		expect(write).not.toHaveBeenCalled();
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
