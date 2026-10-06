// 热重启 P3：runtime 缺席期间的 hook 事件先进 agent session PTY host 的 spool，runtime 回来后才送达。
// 两条契约只有把 hook 摄入与真实 TerminalSessionManager 串起来才验得出来：
//   1) 领域时刻（停止 / 开始 / 对话推进 / 提问）按 hooks CLI 的捕获时刻记，而不是送达时刻；
//   2) 同一事件送达两次（CLI 重试、或旧 runtime 已应用却没回响应、CLI 随后 spool 了它）只应用一次。

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../../src/core/api-contract";
import { createHooksApi } from "../../../src/trpc/hooks-api";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN: "\r",
	prepareAgentLaunch: prepareAgentLaunchMock,
	toBracketedPasteFramingWithoutTrailingSubmit: (text: string) => `SUBMIT[${text}]`,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockPtySpawnRequest {
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockPtySpawnRequest) {
	let exited = false;
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(() => {
			if (exited) {
				return;
			}
			exited = true;
			request.onExit?.({ exitCode: 0 });
		}),
		hasExited: () => exited,
		wasInterrupted: vi.fn(() => false),
	};
}

const WORKSPACE_PATH = "/tmp/late-delivered-hook-event-capture-time-regression";
const TASK_ID = "task-late-delivered-hook";
const RUNTIME_ABSENT_STARTED_AT_EPOCH_MS = Date.UTC(2026, 9, 5, 8, 0, 0);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe("late-delivered hook events (hook ingest × real TerminalSessionManager)", () => {
	let manager: TerminalSessionManager;
	let recordAgentRaisedPendingUserDecision: ReturnType<typeof vi.fn>;
	let broadcastTaskReadyForReview: Mock<Parameters<typeof createHooksApi>[0]["broadcastTaskReadyForReview"]>;
	let api: ReturnType<typeof createHooksApi>;

	beforeEach(async () => {
		vi.useFakeTimers({ now: RUNTIME_ABSENT_STARTED_AT_EPOCH_MS });
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation((request: MockPtySpawnRequest) => createMockPtySession(4321, request));
		manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: TASK_ID,
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: WORKSPACE_PATH,
			prompt: "",
		});
		recordAgentRaisedPendingUserDecision = vi.fn(async () => undefined);
		broadcastTaskReadyForReview = vi.fn<Parameters<typeof createHooksApi>[0]["broadcastTaskReadyForReview"]>();
		api = createHooksApi({
			getWorkspacePathById: vi.fn(() => WORKSPACE_PATH),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: `refs/kanban/checkpoints/${TASK_ID}/turn/1`,
				commit: "1111111",
				createdAt: 1,
			})),
			recordAgentRaisedPendingUserDecision: recordAgentRaisedPendingUserDecision as unknown as NonNullable<
				Parameters<typeof createHooksApi>[0]["recordAgentRaisedPendingUserDecision"]
			>,
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
		});
	});

	afterEach(() => {
		manager.markInterruptedAndStopAll();
		vi.useRealTimers();
	});

	function buildClaudeStopHookIngestRequest(overrides: Partial<RuntimeHookIngestRequest>): RuntimeHookIngestRequest {
		return {
			taskId: TASK_ID,
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
			...overrides,
		};
	}

	it("a Stop delivered two hours late stamps the stop edge, conversation progress and reclamation anchor at capture time", async () => {
		const hookEventCapturedAtEpochMs = RUNTIME_ABSENT_STARTED_AT_EPOCH_MS + 5 * 60 * 1000;
		vi.setSystemTime(RUNTIME_ABSENT_STARTED_AT_EPOCH_MS + TWO_HOURS_MS);

		const response = await api.ingest(
			buildClaudeStopHookIngestRequest({
				hookEventCapturedAtEpochMs,
				hookEventDeliveryIdempotencyKey: "stop-delivered-late",
			}),
		);

		expect(response.ok).toBe(true);
		const summary = manager.getSummary(TASK_ID);
		expect(summary?.turnOwner).toBe("user");
		expect(summary?.agentResponseGenerationStopped?.stoppedAt).toBe(hookEventCapturedAtEpochMs);
		expect(summary?.lastConversationProgressObservation?.observedAtMs).toBe(hookEventCapturedAtEpochMs);
		// updatedAt 仍是写入墙钟。
		expect(summary?.updatedAt).toBe(RUNTIME_ABSENT_STARTED_AT_EPOCH_MS + TWO_HOURS_MS);
		// 就绪通知照常发出，并带上「晚到了多久」：前端据此不朗读过时语音。
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			TASK_ID,
			"review",
			expect.objectContaining({
				agentEventDeliveredLateToRuntimeByMilliseconds: TWO_HOURS_MS - 5 * 60 * 1000,
			}),
		);
	});

	it("a capture time later than delivery is clamped to delivery time", async () => {
		const deliveredAtEpochMs = RUNTIME_ABSENT_STARTED_AT_EPOCH_MS + 60_000;
		vi.setSystemTime(deliveredAtEpochMs);

		await api.ingest(buildClaudeStopHookIngestRequest({ hookEventCapturedAtEpochMs: deliveredAtEpochMs + 10_000 }));

		expect(manager.getSummary(TASK_ID)?.agentResponseGenerationStopped?.stoppedAt).toBe(deliveredAtEpochMs);
	});

	it("a UserPromptSubmit delivered late stamps the turn start at capture time", async () => {
		await api.ingest(buildClaudeStopHookIngestRequest({}));
		const hookEventCapturedAtEpochMs = RUNTIME_ABSENT_STARTED_AT_EPOCH_MS + 10 * 60 * 1000;
		vi.setSystemTime(RUNTIME_ABSENT_STARTED_AT_EPOCH_MS + TWO_HOURS_MS);

		await api.ingest({
			taskId: TASK_ID,
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: "接着做",
			hookEventCapturedAtEpochMs,
		});

		const summary = manager.getSummary(TASK_ID);
		expect(summary?.turnOwner).toBe("agent");
		expect(summary?.agentResponseGenerationTurnStarted?.startedAt).toBe(hookEventCapturedAtEpochMs);
	});

	it("a second delivery of an already applied event is acknowledged without being applied again", async () => {
		await api.ingest(buildClaudeStopHookIngestRequest({ hookEventDeliveryIdempotencyKey: "stop-1" }));
		await api.ingest({
			taskId: TASK_ID,
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: "继续",
			hookEventDeliveryIdempotencyKey: "prompt-1",
		});
		const turnSequenceBeforeReplay = manager.getSummary(TASK_ID)?.agentResponseGenerationTurnSequence;
		expect(manager.getSummary(TASK_ID)?.turnOwner).toBe("agent");

		// 旧 runtime 已应用、没来得及回响应，CLI 把同一个 Stop spool 了：重放必须只确认、不把会话再翻回审查。
		const replayResponse = await api.ingest(
			buildClaudeStopHookIngestRequest({ hookEventDeliveryIdempotencyKey: "stop-1" }),
		);

		expect(replayResponse).toEqual({ ok: true });
		expect(manager.getSummary(TASK_ID)?.turnOwner).toBe("agent");
		expect(manager.getSummary(TASK_ID)?.agentResponseGenerationTurnSequence).toBe(turnSequenceBeforeReplay);
	});

	it("concurrent deliveries of the same event record the agent's question once", async () => {
		const questionHookIngestRequest = buildClaudeStopHookIngestRequest({
			metadata: { source: "claude", hookEventName: "PreToolUse", toolName: "AskUserQuestion" },
			agentRaisedUserQuestion: {
				decisionSourceId: "tool-use-ask-1",
				questionMarkdown: "选哪个方案？",
				options: [{ optionId: "a", label: "A" }],
				allowsFreeformAnswer: true,
				multiSelect: false,
				orderedQuestions: [],
			},
			hookEventDeliveryIdempotencyKey: "question-1",
		});

		const [firstResponse, retriedResponse] = await Promise.all([
			api.ingest(questionHookIngestRequest),
			api.ingest(questionHookIngestRequest),
		]);

		expect(firstResponse.ok).toBe(true);
		expect(retriedResponse.ok).toBe(true);
		expect(recordAgentRaisedPendingUserDecision).toHaveBeenCalledTimes(1);
	});

	it("keeps only the most recent applied delivery keys", () => {
		for (let deliveryIndex = 0; deliveryIndex < 40; deliveryIndex += 1) {
			manager.rememberAppliedHookEventDeliveryIdempotencyKey(TASK_ID, `delivery-${deliveryIndex}`, {
				publishAdoptionRecordImmediately: false,
			});
		}

		expect(manager.hasAppliedHookEventDeliveryIdempotencyKey(TASK_ID, "delivery-39")).toBe(true);
		expect(manager.hasAppliedHookEventDeliveryIdempotencyKey(TASK_ID, "delivery-8")).toBe(true);
		expect(manager.hasAppliedHookEventDeliveryIdempotencyKey(TASK_ID, "delivery-7")).toBe(false);
	});
});
