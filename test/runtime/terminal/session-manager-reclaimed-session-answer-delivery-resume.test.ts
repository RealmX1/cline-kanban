// 会话被回收之后，把「agent 提问 → 会话被回收 → 用户回来作答」的答案投回去，前提是先把 PTY 真的拉回来。
// 这里钉死的正是那条最容易写错的就绪判据：回收只终止运行时、**不删账本**，所以 getSummary 仍然非空——
// 拿它当「会话可投递」的证据会得出假结论，随后 submitTaskChatInputWhenReady 必然返回 null、答案永远送不出去。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeTaskSessionUserTurnKind } from "../../../src/core/api-contract";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	toBracketedPasteFramingWithoutTrailingSubmit: (text: string) => `SUBMIT[${text}]`,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

// 回收路径（forceStopTaskSession）会 stop() 后轮询 hasExited()，并依赖 PTY 侧回调 onExit
// 把 entry.active 置空——桩必须把这两件事都做全，否则测的就不是回收后的真实状态。
function createMockPtySession(pid: number, request: MockSpawnRequest) {
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

const ORIGINAL_TASK_PROMPT = "Fix the bug";

function createPersistedPendingUserDecisionSummary(
	taskId: string,
	userTurnKind: RuntimeTaskSessionUserTurnKind,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "codex",
		workspacePath: "/tmp/reclaimed-answer-delivery",
		pid: null,
		startedAt: Date.now() - 60_000,
		updatedAt: Date.now() - 60_000,
		lastOutputAt: Date.now() - 60_000,
		reviewReason: "hook",
		exitCode: 0,
		lastHookAt: Date.now() - 60_000,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "exited",
		userTurnKind,
	};
}

async function startTaskSessionOn(manager: TerminalSessionManager, taskId: string): Promise<void> {
	await manager.startTaskSession({
		taskId,
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd: "/tmp/reclaimed-answer-delivery",
		prompt: ORIGINAL_TASK_PROMPT,
	});
}

async function startClaudeTaskSessionOn(manager: TerminalSessionManager, taskId: string): Promise<void> {
	await manager.startTaskSession({
		taskId,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: "/tmp/reclaimed-answer-delivery",
		prompt: ORIGINAL_TASK_PROMPT,
	});
}

describe("TerminalSessionManager 回收后为待答决策答案投递恢复会话", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) =>
			createMockPtySession(100 + ptySessionSpawnMock.mock.calls.length, request),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("回收后 summary 仍在但投递无处可写，恢复之后才重新可投", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-reclaimed");

		await manager.forceStopTaskSession("task-reclaimed", 50);

		// 回收只终止运行时：账本条目与 summary 原样保留，所以「summary 非空」不是就绪判据。
		expect(manager.getSummary("task-reclaimed")).not.toBeNull();
		expect(manager.submitTaskChatInputWhenReady("task-reclaimed", "我的答复")).toBeNull();

		expect(await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed")).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(manager.submitTaskChatInputWhenReady("task-reclaimed", "我的答复")).not.toBeNull();
	});

	it("恢复走的是续跑参数，绝不把原始任务 prompt 再跑一遍", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-reclaimed");
		await manager.forceStopTaskSession("task-reclaimed", 50);

		await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed");

		const firstLaunchInput = prepareAgentLaunchMock.mock.calls[0]?.[0];
		const resumeLaunchInput = prepareAgentLaunchMock.mock.calls[1]?.[0];
		expect(firstLaunchInput).toMatchObject({ prompt: ORIGINAL_TASK_PROMPT });
		expect(resumeLaunchInput).toMatchObject({ prompt: "", resumeFromTrash: true });
		expect(manager.getSummary("task-reclaimed")?.restorationContinuationGuardState).toBe(
			"restored_agent_conversation_waiting_for_explicit_user_input",
		);
	});

	it.each(["question", "permission"] as const)(
		"水合出的 %s 待答会话恢复成功后仍以原语义进入持久化载荷",
		async (userTurnKind) => {
			const taskId = `task-persisted-${userTurnKind}`;
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				[taskId]: createPersistedPendingUserDecisionSummary(taskId, userTurnKind),
			});

			await manager.startTaskSession({
				taskId,
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/reclaimed-answer-delivery",
				prompt: "",
				resumeFromTrash: true,
			});

			expect(manager.getSummary(taskId)).toMatchObject({
				state: "awaiting_review",
				reviewReason: "attention",
				turnOwner: "user",
				liveness: "live",
				userTurnKind,
			});
			expect(manager.listSummaries()).toContainEqual(expect.objectContaining({ taskId, userTurnKind }));
		},
	);

	it("恢复只重建会话，直到显式用户提交才解除续跑守卫", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-reclaimed");
		await manager.forceStopTaskSession("task-reclaimed", 50);
		await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed");

		expect(manager.isRestorationContinuationGuardArmed("task-reclaimed")).toBe(true);
		manager.transitionToRunning("task-reclaimed", { userInitiatedResume: false });
		expect(manager.isRestorationContinuationGuardArmed("task-reclaimed")).toBe(true);
		manager.transitionToRunning("task-reclaimed", { userInitiatedResume: true });
		expect(manager.isRestorationContinuationGuardArmed("task-reclaimed")).toBe(false);
	});

	it("Claude 真人恢复首轮结束前继续拦截迟到的 harness task-notification", async () => {
		const manager = new TerminalSessionManager();
		await startClaudeTaskSessionOn(manager, "task-reclaimed-claude");
		await manager.forceStopTaskSession("task-reclaimed-claude", 50);
		await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed-claude");

		expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive("task-reclaimed-claude")).toBe(
			true,
		);
		manager.transitionToRunning("task-reclaimed-claude", { userInitiatedResume: true });
		// 真人提交解除广义守卫，不影响连接恢复；窄通知拦截则持续到首轮自然 Stop。
		expect(manager.isRestorationContinuationGuardArmed("task-reclaimed-claude")).toBe(false);
		expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive("task-reclaimed-claude")).toBe(
			true,
		);

		manager.completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn(
			"task-reclaimed-claude",
		);
		expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive("task-reclaimed-claude")).toBe(
			false,
		);
	});

	it("恢复后的结构化答案实际写入 PTY 时解除续跑守卫", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-reclaimed");
		await manager.forceStopTaskSession("task-reclaimed", 50);
		await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed");

		expect(manager.isRestorationContinuationGuardArmed("task-reclaimed")).toBe(true);
		const queuedDelivery = manager.submitTaskChatInputWhenReady("task-reclaimed", "我选择只恢复");
		expect(queuedDelivery).not.toBeNull();
		await vi.advanceTimersByTimeAsync(65_000);

		expect(manager.isRestorationContinuationGuardArmed("task-reclaimed")).toBe(false);
	});

	it("答案排队后会话退出：完成回执为失败且不会迟到写入 PTY", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-exits-before-answer-write");
		const session = ptySessionSpawnMock.mock.results.at(-1)?.value as ReturnType<typeof createMockPtySession>;
		const deliveryOutcomes: TaskChatInputDeliveryOutcome[] = [];
		const queuedDelivery = manager.submitTaskChatInputWhenReady("task-exits-before-answer-write", "我的答案", {
			idempotencyKey: "task-exits-before-answer-write-answer",
			onDeliveryOutcome: (outcome) => deliveryOutcomes.push(outcome),
		});
		expect(queuedDelivery).not.toBeNull();

		manager.stopTaskSession("task-exits-before-answer-write");

		expect(deliveryOutcomes).toEqual([{ status: "delivery_failed", reason: "session_ended_before_delivery" }]);
		await vi.advanceTimersByTimeAsync(65_000);
		expect(session.write).not.toHaveBeenCalled();
	});

	it("答案排队被更新投递取代：旧回执失败，只有最新答案进入写后确认链", async () => {
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-answer-replaced",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp/reclaimed-answer-delivery",
			prompt: ORIGINAL_TASK_PROMPT,
		});
		const session = ptySessionSpawnMock.mock.results.at(-1)?.value as ReturnType<typeof createMockPtySession>;
		const supersededDeliveryOutcomes: TaskChatInputDeliveryOutcome[] = [];

		const supersededDelivery = manager.submitTaskChatInputWhenReady("task-answer-replaced", "旧答案", {
			idempotencyKey: "task-answer-replaced-old-answer",
			onDeliveryOutcome: (outcome) => supersededDeliveryOutcomes.push(outcome),
		});
		const latestDelivery = manager.submitTaskChatInputWhenReady("task-answer-replaced", "新答案");

		expect(supersededDelivery).not.toBeNull();
		expect(latestDelivery).not.toBeNull();
		expect(supersededDeliveryOutcomes).toEqual([
			{ status: "delivery_failed", reason: "superseded_by_later_delivery" },
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(session.write).toHaveBeenCalledTimes(1);
		expect(session.write).toHaveBeenCalledWith("SUBMIT[新答案]");

		manager.stopTaskSession("task-answer-replaced");
	});

	it("会话仍然活着时是 no-op，不会把正在干活的 PTY 掀掉重来", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-live");

		expect(await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-live")).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("账本里根本没有这个任务时如实返回 false，绝不假装就绪", async () => {
		const manager = new TerminalSessionManager();
		expect(await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-unknown")).toBe(false);
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
	});
});
