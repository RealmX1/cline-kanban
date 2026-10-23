// 恢复守卫「声明态」×排队出队门控 5 的跨层回归：hook 摄入 × 真实 TerminalSessionManager × 真实出队引擎。
//
// 2026-10-11 a768a：会话以 resumeFromTrash 恢复启动，首个真人提交晚于启动 48 分钟。解除漏斗
// disarmRestorationContinuationGuard 先判带 30 分钟兜底的武装谓词——超时后它恒为 false、直接返回，声明态
// 于是永久残留；而门控 5 只读声明态，排队条目在随后 2.5 小时的空闲里一次都没交出，直到截止过期。
// 每一层单独看都自洽（门控单测钉住「声明态 + 6 小时照样挡」，hooks-api 的单测把 disarm 桩掉），缺口长在
// 层与层之间，所以这里三层都用真的。
//
// 钉住的几条：
//   ① 启动 31 分钟后的真人 UserPromptSubmit 照样清掉声明态，随后的 Stop 把排队条目交出去；
//   ② 启动 31 分钟后到达的上一活体孤儿 <task-notification>（读侧拦截已过期，被放行进模型）不算「人继续了」：
//      声明态保留、门控 5 照旧挡——这是 24508 的设计意图，修解除侧时不得顺手放掉；
//   ③ 解除只走 disarmRestorationContinuationGuard 这一个漏斗：它不看兜底过期；transitionToRunning 不再解除。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RuntimeHookIngestRequest,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
} from "../../../src/core/api-contract";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import { confirmTestNativeUserInputAcceptance } from "../../utilities/confirm-test-native-user-input-acceptance";

const testRuntimeHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
		getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
	};
});

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

import { RESTORATION_CONTINUATION_GUARD_MAXIMUM_ARMED_DURATION_MS } from "../../../src/core/session-activity";
import { createQueuedTaskPromptDeliveryDispatcher } from "../../../src/server/queued-task-prompt-delivery-dispatcher";
import {
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../../../src/state/queued-task-prompt-delivery-store";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";

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

const WORKSPACE_ID = "workspace-restoration-guard-queued-delivery";
const WORKSPACE_PATH = "/tmp/restoration-guard-queued-delivery-regression";
const TASK_ID = "task-restored-and-first-continued-beyond-maximum-armed-duration";
// a768a 的真实启动时刻（16:28:16Z）；首个真人提交在它之后 48 分钟。
const RESTORED_SESSION_SPAWNED_AT_EPOCH_MS = Date.UTC(2026, 9, 11, 16, 28, 16);
const FIRST_HOOK_EVENT_AFTER_RESTORED_SESSION_SPAWN_AT_EPOCH_MS =
	RESTORED_SESSION_SPAWNED_AT_EPOCH_MS + RESTORATION_CONTINUATION_GUARD_MAXIMUM_ARMED_DURATION_MS + 60_000;

// 上一活体留下的孤儿后台任务通知（形状同 hooks-api.test.ts 的同名样本）：没有 <tool-use-id>、status=stopped。
const ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION = [
	"<task-notification>",
	"<task-id>background-1</task-id>",
	"<status>stopped</status>",
	"<summary>No completion record was found for 1 background agent from the previous session.</summary>",
	"</task-notification>",
].join("\n");

const deliveredAndSubmitConfirmed: RuntimeTaskChatSendResponse = {
	ok: true,
	summary: null,
	terminalDelivery: { status: "delivered_and_submit_confirmed", reason: null },
};

async function createRestoredClaudeSessionWithQueuedPromptDispatcher() {
	const manager = new TerminalSessionManager();
	await manager.startTaskSession({
		taskId: TASK_ID,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: WORKSPACE_PATH,
		prompt: "",
		resumeFromTrash: true,
	});
	const hooksApi = createHooksApi({
		getWorkspacePathById: vi.fn(() => WORKSPACE_PATH),
		ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview: vi.fn(),
		// checkpoint 捕获会对 cwd 跑真实 git；这里的 cwd 是个不存在的临时路径，必须桩掉。
		captureTaskTurnCheckpoint: vi.fn(async () => ({
			turn: 1,
			ref: `refs/kanban/checkpoints/${TASK_ID}/turn/1`,
			commit: "1111111",
			createdAt: 1,
		})),
		deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => undefined),
		consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
	});
	const sentRequests: RuntimeTaskChatSendRequest[] = [];
	const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
		getTaskSessionSummary: (_workspaceId, taskId) => manager.getSummary(taskId),
		hasPendingProgrammaticTaskChatInputDelivery: () => false,
		resolveWorkspaceScope: (workspaceId) => ({ workspaceId, workspacePath: WORKSPACE_PATH }),
		sendThroughTaskChatTransports: async (_scope, request) => {
			sentRequests.push(request);
			return deliveredAndSubmitConfirmed;
		},
		cancelProgrammaticTerminalDelivery: async () => "cancelled_before_delivery",
		readPromptLibraryEntryTextSha256ByEntryId: async () => new Map(),
		onProjectedQueueChanged: () => {},
		fallbackSweepIntervalMs: 60_000,
	});
	// 与 runtime-state-hub 同形：manager 每发出一份 summary 就喂给出队引擎（停止边沿触发源）。
	const unsubscribeFromSummaries = manager.onSummary((summary) => {
		dispatcher.observeTaskSessionSummary(WORKSPACE_ID, summary);
	});

	return {
		manager,
		dispatcher,
		sentRequests,
		dispose() {
			unsubscribeFromSummaries();
			dispatcher.stop();
			manager.dispose();
		},
		async enqueuePromptForDeliveryAfterCurrentTurn(queueEntryId: string, text: string) {
			const snapshot = await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: TASK_ID,
				queueEntryId,
				text,
			});
			await dispatcher.notifyQueueMutated(WORKSPACE_ID, TASK_ID, snapshot);
			await dispatcher.whenIdle();
		},
		async ingestClaudeHookEvent(
			request: Pick<RuntimeHookIngestRequest, "event" | "metadata" | "submittedPromptText">,
		) {
			const response = await hooksApi.ingest({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, ...request });
			await dispatcher.whenIdle();
			return response;
		},
		async readHeadQueueEntryDispatchBlockReason() {
			const projected = await dispatcher.buildProjectedEntriesByTaskId(WORKSPACE_ID);
			return projected[TASK_ID]?.[0]?.dispatchBlockReason ?? null;
		},
	};
}

async function readQueueEntryDeliveryStates(): Promise<string[]> {
	const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
	return (snapshot.entriesByTaskId[TASK_ID] ?? []).map((entry) => `${entry.queueEntryId}:${entry.deliveryState}`);
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(RESTORED_SESSION_SPAWNED_AT_EPOCH_MS);
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-restoration-guard-queued-delivery-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
	prepareAgentLaunchMock.mockReset();
	ptySessionSpawnMock.mockReset();
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
	}));
	ptySessionSpawnMock.mockImplementation((request: MockPtySpawnRequest) => createMockPtySession(4321, request));
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

describe("恢复启动后首个真人提交晚于守卫兜底时长：排队投递（hook 摄入 × 真实 manager × 真实出队引擎）", () => {
	it("启动 31 分钟后的真人 UserPromptSubmit 清掉声明态，随后的 Stop 把排队条目交出去", async () => {
		const harness = await createRestoredClaudeSessionWithQueuedPromptDispatcher();
		try {
			expect(harness.manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe(
				"restored_agent_conversation_waiting_for_explicit_user_input",
			);
			await harness.enqueuePromptForDeliveryAfterCurrentTurn("queued-before-first-user-prompt", "等 agent 停下再发");
			expect(harness.sentRequests).toHaveLength(0);

			vi.setSystemTime(FIRST_HOOK_EVENT_AFTER_RESTORED_SESSION_SPAWN_AT_EPOCH_MS);
			await harness.ingestClaudeHookEvent({
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
				submittedPromptText: "接着把 handoff 补完",
			});
			confirmTestNativeUserInputAcceptance({
				manager: harness.manager,
				taskId: TASK_ID,
				promptText: "接着把 handoff 补完",
			});
			expect(harness.manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe("inactive");

			await harness.ingestClaudeHookEvent({
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop" },
			});
			expect(harness.sentRequests.map((request) => request.text)).toEqual(["等 agent 停下再发"]);
			expect(await readQueueEntryDeliveryStates()).toEqual(["queued-before-first-user-prompt:settled_delivered"]);
		} finally {
			harness.dispose();
		}
	});

	it("启动 31 分钟后放行进模型的上一活体孤儿 task-notification 不算人继续了：声明态保留，门控 5 照旧挡", async () => {
		const harness = await createRestoredClaudeSessionWithQueuedPromptDispatcher();
		try {
			await harness.enqueuePromptForDeliveryAfterCurrentTurn("queued-before-first-user-prompt", "人没继续就别发");

			vi.setSystemTime(FIRST_HOOK_EVENT_AFTER_RESTORED_SESSION_SPAWN_AT_EPOCH_MS);
			// 兜底过期后读侧拦截已失效：这条通知不再被暂存，而是作为一轮输入进了模型。
			expect(harness.manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive(TASK_ID)).toBe(false);
			const response = await harness.ingestClaudeHookEvent({
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
				submittedPromptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
			});
			expect(response.harnessUserPromptProcessingDirective?.processingDecision).not.toBe(
				"block_and_defer_until_explicit_user_input",
			);
			await harness.ingestClaudeHookEvent({
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop" },
			});

			expect(harness.manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe(
				"restored_agent_conversation_waiting_for_explicit_user_input",
			);
			expect(await harness.readHeadQueueEntryDispatchBlockReason()).toBe("session_restoring_conversation");
			expect(harness.sentRequests).toHaveLength(0);
			expect(await readQueueEntryDeliveryStates()).toEqual(["queued-before-first-user-prompt:queued"]);
		} finally {
			harness.dispose();
		}
	});
});

describe("恢复守卫的解除只走 disarmRestorationContinuationGuard 这一个漏斗", () => {
	// 一键放行、Codex / Cursor 的提交边沿、hooks-api 的真人 UserPromptSubmit 都只调这个漏斗。
	it("启动超过兜底时长后，解除漏斗仍清掉声明态", async () => {
		const harness = await createRestoredClaudeSessionWithQueuedPromptDispatcher();
		try {
			vi.setSystemTime(FIRST_HOOK_EVENT_AFTER_RESTORED_SESSION_SPAWN_AT_EPOCH_MS);
			// 带兜底的谓词此刻已判「未武装」，但声明态还在——门控 5 读的正是声明态。
			expect(harness.manager.isRestorationContinuationGuardArmed(TASK_ID)).toBe(false);

			harness.manager.disarmRestorationContinuationGuard(TASK_ID);

			expect(harness.manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe("inactive");
		} finally {
			harness.dispose();
		}
	});

	// harness 的 task-notification 也以 userInitiatedResume=true 走到 transitionToRunning；在那里解除，30 分钟后
	// 放行进来的孤儿通知就会替用户打开门控 5。真人提交由 hooks-api 在转移闸之前调漏斗解除。
	it("transitionToRunning(userInitiatedResume) 不解除恢复守卫", async () => {
		const harness = await createRestoredClaudeSessionWithQueuedPromptDispatcher();
		try {
			harness.manager.transitionToRunning(TASK_ID, { userInitiatedResume: true });

			expect(harness.manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe(
				"restored_agent_conversation_waiting_for_explicit_user_input",
			);
		} finally {
			harness.dispose();
		}
	});
});
