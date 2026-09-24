import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { getNotificationLifecycleArchive } from "../../../src/notifications/notification-lifecycle-archive";
import { captureNotificationSignal } from "../../../src/notifications/notification-signal-capture";
import { createHooksApi } from "../../../src/trpc/hooks-api";

// 文件末尾的跨层回归用例要驱动**真实** TerminalSessionManager——两档恢复守卫的状态机住在它里面，
// 用桩 manager 复述一遍就只是在测桩本身。真实 manager 会 spawn PTY 并做 agent 启动准备，故把这两条
// 外部边界桩掉。本文件其余用例仍用「按需实现方法的类型级 manager 桩」，完全不受这两个 mock 影响。
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

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

// 【该拦】上一个会话活体遗留的孤儿通知：无 tool-use-id、status 非 completed。判据与真实样本见
// test/runtime/core/harness-generated-restoration-prompt.test.ts。
const ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION = [
	"<task-notification>",
	"<task-id>background-1</task-id>",
	"<task-id>background-2</task-id>",
	"<status>stopped</status>",
	"<summary>No completion record was found for 2 background agents from the previous session.</summary>",
	"</task-notification>",
].join("\n");

// 【该放】本活体自己 dispatch 的后台工作完成通知：带 tool-use-id 且 status=completed。恢复守卫武装
// 期间也必须放行——它是 agent 明确在等的唤醒信号，拦下来就是把它自己派出去的活儿掐死在半路。
const LIVE_INCARNATION_BACKGROUND_WORK_COMPLETION_NOTIFICATION = [
	"<task-notification>",
	"<task-id>background-1</task-id>",
	"<tool-use-id>tool-use-1</tool-use-id>",
	"<output-file>/tmp/background-1.output</output-file>",
	"<status>completed</status>",
	'<summary>Background command "wait for attempts" completed (exit code 0)</summary>',
	"</task-notification>",
].join("\n");

describe("createHooksApi", () => {
	it("恢复旧 Claude 会话时阻止并持久暂存 harness 自动 task-notification", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationContinuationGuardArmed: vi.fn(() => true),
			transitionToRunning: vi.fn(),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
		} as unknown as TerminalSessionManager;
		const deferHarnessGeneratedPrompt = vi.fn(async () => undefined);
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: deferHarnessGeneratedPrompt,
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
		});
		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
		});

		expect(response).toEqual({
			ok: true,
			harnessUserPromptProcessingDirective: {
				processingDecision: "block_and_defer_until_explicit_user_input",
				userVisibleReason: "Kanban 正在恢复旧会话；这条系统任务通知已暂存，不会自动启动新的 agent 回合。",
			},
		});
		expect(deferHarnessGeneratedPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				promptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
			}),
		);
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
	});

	it("恢复期通知暂存失败时仍 fail-safe 返回 Claude block，而不是 ok:false 触发 CLI fail-open", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => true),
			transitionToRunning: vi.fn(),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
		} as unknown as TerminalSessionManager;
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => {
				throw new Error("disk unavailable");
			}),
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
		});

		expect(response).toEqual({
			ok: true,
			harnessUserPromptProcessingDirective: {
				processingDecision: "block_and_defer_until_explicit_user_input",
				userVisibleReason: "Kanban 正在恢复旧会话；系统任务通知暂存失败，已安全拦截，未启动新的 agent 回合。",
			},
		});
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
	});

	it("真人恢复提交已解除主守卫后，首轮 Stop 前迟到的 task-notification 仍被暂存并拦截", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running", restorationContinuationGuardState: "inactive" })),
			isRestorationContinuationGuardArmed: vi.fn(() => false),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => true),
			transitionToRunning: vi.fn(),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
		} as unknown as TerminalSessionManager;
		const deferHarnessGeneratedPrompt = vi.fn(async () => undefined);
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: deferHarnessGeneratedPrompt,
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
		});

		expect(response.harnessUserPromptProcessingDirective?.processingDecision).toBe(
			"block_and_defer_until_explicit_user_input",
		);
		expect(deferHarnessGeneratedPrompt).toHaveBeenCalledOnce();
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
	});

	it("恢复拦截期缺失 prompt 字段的畸形 UserPromptSubmit 被拦截并保留守卫", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => true),
			transitionToRunning: vi.fn(),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
		} as unknown as TerminalSessionManager;
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => undefined),
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});

		expect(response.harnessUserPromptProcessingDirective?.processingDecision).toBe(
			"block_and_defer_until_explicit_user_input",
		);
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
	});

	it("恢复守卫下的真人 UserPromptSubmit 被允许，并携带此前暂存的系统通知上下文", async () => {
		const transitionedSummary = createSummary({ state: "running" });
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationContinuationGuardArmed: vi.fn(() => true),
			disarmRestorationContinuationGuard: vi.fn(),
			transitionToRunning: vi.fn(() => transitionedSummary),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => undefined),
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => [
				{
					taskId: "task-1",
					sourceHarness: "claude:UserPromptSubmit:task-notification",
					promptText: "<task-notification>历史通知</task-notification>",
					receivedAt: 100,
				},
			]),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: "我选择方案 A",
		});

		expect(response.ok).toBe(true);
		expect(response.harnessUserPromptProcessingDirective).toMatchObject({
			processingDecision: "allow",
			additionalContextMarkdown: expect.stringContaining("历史通知"),
		});
		expect(manager.transitionToRunning).toHaveBeenCalledWith("task-1", { userInitiatedResume: true });
	});

	it("读取暂存通知失败时仍放行非空真人 UserPromptSubmit，并保留账本供下次重试", async () => {
		const transitionedSummary = createSummary({ state: "running" });
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => true),
			transitionToRunning: vi.fn(() => transitionedSummary),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => undefined),
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => {
				throw new Error("disk unavailable");
			}),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: "我选择方案 A",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledWith("task-1", { userInitiatedResume: true });
	});

	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			activityText: "Using Read",
		});
	});

	it("B3: classifies Claude PermissionRequest into userTurnKind=permission and broadcasts it", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "permission",
		});
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PermissionRequest" },
		});

		expect(response).toEqual({ ok: true });
		// override 经 hook.to_review 下发给 reducer（第三形参）。
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook", "permission");
		// ready 事件 payload 内联 permission 人轴（前端通知标题据此措辞）。
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			"permission",
			expect.objectContaining({ candidateId: expect.any(String), summary: expect.any(Object) }),
		);
	});

	it("B3: leaves non-Claude / non-permission to_review without an override", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
		});
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		// Stop（自然完成）不是 permission → 不覆写人轴（第三形参 undefined）。
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook", undefined);
		expect(
			manager.completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn,
		).toHaveBeenCalledWith("task-1");
	});

	it("S5: classifies Claude ExitPlanMode PreToolUse into userTurnKind=plan_review and broadcasts it", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "plan_review",
		});
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PreToolUse", toolName: "ExitPlanMode" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook", "plan_review");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			"plan_review",
			expect.objectContaining({ candidateId: expect.any(String), summary: expect.any(Object) }),
		);
	});

	it("S5: classifies Claude AskUserQuestion PreToolUse into userTurnKind=question and broadcasts it", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "question",
		});
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PreToolUse", toolName: "AskUserQuestion" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook", "question");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			"question",
			expect.objectContaining({ candidateId: expect.any(String), summary: expect.any(Object) }),
		);
	});

	it("S5: ExitPlanMode arriving via PermissionRequest is labeled plan_review (race-proof, not permission)", async () => {
		// ExitPlanMode 同时 fire PreToolUse 与 PermissionRequest；本仓库 adapter 的 PermissionRequest "*"→to_review
		// 可能先到。classifier 按 toolName 优先于通用 permission，故无论哪条 hook 先赢 to_review 闸，都落 plan_review。
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "plan_review",
		});
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PermissionRequest", toolName: "ExitPlanMode" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook", "plan_review");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			"plan_review",
			expect.objectContaining({ candidateId: expect.any(String), summary: expect.any(Object) }),
		);
	});

	it("S5: double-fire — the matcher `*`→activity for the same tool is a benign no-op (no transition)", async () => {
		// 同一个 ExitPlanMode/AskUserQuestion 工具同时命中专用 matcher（to_review）与 *（activity）。后者
		// 经 activity 路径：canTransitionTaskForHookEvent → false → 仅 applyHookActivity（metadata-only 漏斗
		// 分支 preserve 已采集的 userTurnKind），不触发任何 state 转换。此处在 hooks-api 层钉住「activity 不
		// 转换」的不变量（已采集人轴的 preserve 由 mergeSummaryWithFacets 单测覆盖）。
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({ state: "awaiting_review", turnOwner: "user", userTurnKind: "plan_review" }),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { source: "claude", hookEventName: "PreToolUse", toolName: "ExitPlanMode" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			hookEventName: "PreToolUse",
			toolName: "ExitPlanMode",
		});
	});

	it("parked（已派发后台工作）的裸 Stop：to_review 被闸抑制，绝不广播 ready-for-review", async () => {
		// 主 agent 非 native dispatch 后 park、结束本轮发裸 Stop。真实 gate 读 getSummary 返回的 parked summary →
		// to_review 返回 false → 走 no-transition 路径（仅 applyHookActivity）→ broadcastTaskReadyForReview 不可达。
		const broadcastTaskReadyForReview = vi.fn();
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({ state: "running", awaitingDispatchedBackgroundWork: { sinceMs: 1_000, label: "child-x" } }),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			unparkTaskSession: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(broadcastTaskReadyForReview).not.toHaveBeenCalled();
		// 活动元数据仍被记录（no-transition 路径）。
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", { source: "claude", hookEventName: "Stop" });
	});

	it("parked + AskUserQuestion：先持久化决策、解除 park，再进入 question 人轴", async () => {
		const parkedSummary = createSummary({
			state: "running",
			awaitingDispatchedBackgroundWork: { sinceMs: 1_000, label: "child-x" },
		});
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "question",
			awaitingDispatchedBackgroundWork: null,
		});
		const manager = {
			getSummary: vi.fn(() => parkedSummary),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			unparkTaskSession: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;
		const recordPendingUserDecision = vi.fn(async () => ({}) as never);
		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			recordAgentRaisedPendingUserDecision: recordPendingUserDecision,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PreToolUse", toolName: "AskUserQuestion" },
			agentRaisedUserQuestion: {
				decisionSourceId: "toolu_question",
				questionMarkdown: "请你拍板",
				options: [{ optionId: "option-0", label: "同意" }],
				allowsFreeformAnswer: true,
				multiSelect: false,
				orderedQuestions: [
					{
						decisionQuestionId: "question-0",
						headerMarkdown: null,
						questionMarkdown: "请你拍板",
						selectionMode: "single",
						options: [{ optionId: "question-0-option-0", label: "同意" }],
						allowsFreeformAnswer: true,
					},
				],
			},
		});

		expect(response).toEqual({ ok: true });
		expect(recordPendingUserDecision).toHaveBeenCalledTimes(1);
		expect(manager.unparkTaskSession).toHaveBeenCalledWith("task-1");
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook", "question");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			"question",
			expect.objectContaining({ candidateId: expect.any(String), summary: expect.any(Object) }),
		);
		expect(recordPendingUserDecision.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(manager.unparkTaskSession).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("parked + UserPromptSubmit（to_in_progress）：清 park（unparkTaskSession 被调用）", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({ state: "running", awaitingDispatchedBackgroundWork: { sinceMs: 1_000 } }),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			unparkTaskSession: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.unparkTaskSession).toHaveBeenCalledWith("task-1");
	});

	it("parked + PostToolUse（to_in_progress 的中途活动）：**不**清 park（避免结束本轮前误清）", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({ state: "running", awaitingDispatchedBackgroundWork: { sinceMs: 1_000 } }),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			unparkTaskSession: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "PostToolUse", toolName: "Read" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.unparkTaskSession).not.toHaveBeenCalled();
	});

	it("to_in_progress + Gemini BeforeAgent：userInitiatedResume=true（Gemini 的用户提交等价信号，解除 resume guard）", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({ agentId: "gemini", state: "awaiting_review", reviewReason: "attention" }),
			),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ agentId: "gemini", state: "running" })),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "gemini", hookEventName: "BeforeAgent" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledWith("task-1", { userInitiatedResume: true });
	});

	it("to_in_progress + UserPromptSubmit：userInitiatedResume=true（Claude/Codex/Droid 用户提交）", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "attention" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running" })),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledWith("task-1", { userInitiatedResume: true });
	});

	it("to_in_progress + PostToolUse：userInitiatedResume=false（自动续跑中途活动，不解除 guard）", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "attention" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running" })),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "PostToolUse", toolName: "Read" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledWith("task-1", { userInitiatedResume: false });
	});

	it("captures a turn checkpoint when transitioning to review", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			latestTurnCheckpoint: {
				turn: 2,
				ref: "refs/kanban/checkpoints/task-1/turn/2",
				commit: "2222222",
				createdAt: 1,
			},
			previousTurnCheckpoint: {
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			},
		});

		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 3,
			ref: "refs/kanban/checkpoints/task-1/turn/3",
			commit: "3333333",
			createdAt: Date.now(),
		}));

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		// F1：checkpoint 已移出响应关键路径，作为不 await 的后台任务在 ingest 返回后才落定。
		// 故 capture/applyTurnCheckpoint 这些副作用要 waitFor，而非在 ingest 返回那刻断言。
		await vi.waitFor(() => {
			expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
				cwd: "/tmp/worktree",
				taskId: "task-1",
				turn: 3,
			});
		});
		// 保留策略翻转（姊妹蓝图 §1.4）：hook 路径只捕获新 checkpoint，不再轮换删除 previous ref——
		// 批删挂在任务删除 / trash 清空路径（deleteAllTaskTurnCheckpointRefs）。
		expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
	});

	it("B.2：Claude 自然 Stop 才把 Stop 边沿交给 exploration thread graph 维护", async () => {
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const notifyExplorationThreadGraphAgentTurnStopped = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			notifyExplorationThreadGraphAgentTurnStopped,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(notifyExplorationThreadGraphAgentTurnStopped).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			explorationId: "task-1",
		});
	});

	it("B.2：中途人轴的 to_review（PermissionRequest / AskUserQuestion）绝不触发维护——那一轮还没结束", async () => {
		// 这两类事件与自然 Stop 共用 to_review。只判 event 的话，用户在权限框/提问框上想得比防抖窗口
		// （45s）久，就会用 treatFinalTurnAsCompleted:true 的 turn 源 fork 一次分身：白烧钱，还把半截
		// turn 当已完成轮次归位进图。
		const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const notifyExplorationThreadGraphAgentTurnStopped = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			notifyExplorationThreadGraphAgentTurnStopped,
			captureTaskTurnCheckpoint: vi.fn(async () => ({
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			})),
		});

		const permissionResponse = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PermissionRequest" },
		});
		const questionResponse = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "PreToolUse", toolName: "AskUserQuestion" },
		});

		expect(permissionResponse).toEqual({ ok: true });
		expect(questionResponse).toEqual({ ok: true });
		expect(notifyExplorationThreadGraphAgentTurnStopped).not.toHaveBeenCalled();
	});

	it("B.2：by-the-way 会话的自然 Stop 照样触发维护，explorationId 解析回主任务卡片", async () => {
		// 图挂在卡片上、不挂在单条会话上；这一块必须留在 by_the_way 守卫**之外**（那道守卫管的是
		// 转审通知 + checkpoint，与图无关）。
		const transitionedSummary = createSummary({
			taskId: "task-1-btw",
			state: "awaiting_review",
			reviewReason: "hook",
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: null,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: null,
			},
		});
		const manager = {
			getSummary: vi.fn(() => createSummary({ taskId: "task-1-btw", state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const notifyExplorationThreadGraphAgentTurnStopped = vi.fn();
		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			notifyExplorationThreadGraphAgentTurnStopped,
		});

		const response = await api.ingest({
			taskId: "task-1-btw",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(notifyExplorationThreadGraphAgentTurnStopped).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			explorationId: "task-1",
		});
		// by_the_way 守卫仍然照常抑制转审通知——两件事互不牵连。
		expect(broadcastTaskReadyForReview).not.toHaveBeenCalled();
	});
	it("恢复守卫武装期间放行本活体自己 dispatch 的后台工作完成通知——那是 agent 在等的唤醒信号", async () => {
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationContinuationGuardArmed: vi.fn(() => true),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => true),
			transitionToRunning: vi.fn(() => createSummary()),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			disarmRestorationContinuationGuard: vi.fn(),
		} as unknown as TerminalSessionManager;
		const deferHarnessGeneratedPrompt = vi.fn(async () => undefined);
		const consumeDeferredHarnessGeneratedPrompts = vi.fn(async () => []);
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: deferHarnessGeneratedPrompt,
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: consumeDeferredHarnessGeneratedPrompts,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: LIVE_INCARNATION_BACKGROUND_WORK_COMPLETION_NOTIFICATION,
		});

		expect(response.ok).toBe(true);
		expect(response.harnessUserPromptProcessingDirective?.processingDecision).not.toBe(
			"block_and_defer_until_explicit_user_input",
		);
		expect(deferHarnessGeneratedPrompt).not.toHaveBeenCalled();
		// 放行不等于「当成真人提交」：harness 通知既不得解除恢复守卫，也不得消费暂存账本。
		expect(manager.disarmRestorationContinuationGuard).not.toHaveBeenCalled();
		expect(consumeDeferredHarnessGeneratedPrompts).not.toHaveBeenCalled();
	});

	it("会话已 running 时真人 prompt 仍解除恢复守卫——解除必须先于转移闸，否则守卫永久武装", async () => {
		// 回归 2026-08 的死锁：守卫解除原先只挂在闸后的 transitionToRunning 上，而 running 态的
		// to_in_progress 过不了 canTransitionTaskForHookEvent（它要 awaiting_review），于是守卫再也解除不掉。
		const manager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					reviewReason: null,
					restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				}),
			),
			isRestorationContinuationGuardArmed: vi.fn(() => true),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => true),
			transitionToRunning: vi.fn(() => createSummary()),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			disarmRestorationContinuationGuard: vi.fn(),
		} as unknown as TerminalSessionManager;
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => undefined),
			consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
		});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: "接着把 handoff 补完",
		});

		expect(manager.disarmRestorationContinuationGuard).toHaveBeenCalledWith("task-1");
	});
});

// 回收路径与 spawn 路径都要求 PTY 桩把 pid / write / stop / hasExited 做全，否则 manager 装载
// entry.active 时就会因缺方法炸掉——这里只需要「能起得来、能停得掉」。
interface MockPtySpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySessionForRestorationGuardRegression(pid: number, request: MockPtySpawnRequest) {
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

const RESTORATION_GUARD_REGRESSION_WORKSPACE_PATH = "/tmp/restoration-continuation-guard-regression";

// 两档恢复守卫（A=持久化的 restorationContinuationGuardState，B=挂在 entry.active 上的窄通知拦截）
// 的解除时序只有把 hook 摄入与真实 session manager 串起来才验得出来：任何一侧单独看都是自洽的，
// 缺口恰恰长在两者之间。
describe("恢复守卫两档解除时序（hook 摄入 × 真实 TerminalSessionManager）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation((request: MockPtySpawnRequest) =>
			createMockPtySessionForRestorationGuardRegression(300 + ptySessionSpawnMock.mock.calls.length, request),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("恢复过程自身的 Stop 不解除窄通知拦截：A 已由真人 prompt 解除、真人首轮尚未 Stop 时的迟到孤儿仍被暂存", async () => {
		const taskId = "task-restored-claude";
		const manager = new TerminalSessionManager();
		try {
			await manager.startTaskSession({
				taskId,
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: RESTORATION_GUARD_REGRESSION_WORKSPACE_PATH,
				prompt: "",
				resumeFromTrash: true,
			});

			const deferHarnessGeneratedPrompt = vi.fn(async () => undefined);
			const api = createHooksApi({
				getWorkspacePathById: vi.fn(() => RESTORATION_GUARD_REGRESSION_WORKSPACE_PATH),
				ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastTaskReadyForReview: vi.fn(),
				// checkpoint 捕获会对 cwd 跑真实 git；这里的 cwd 是个不存在的临时路径，必须桩掉。
				captureTaskTurnCheckpoint: vi.fn(async () => ({
					turn: 1,
					ref: `refs/kanban/checkpoints/${taskId}/turn/1`,
					commit: "1111111",
					createdAt: 1,
				})),
				deferHarnessGeneratedPromptDuringAgentSessionRestoration: deferHarnessGeneratedPrompt,
				consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration: vi.fn(async () => []),
			});

			// resumeFromTrash 的 Claude 会话：A、B 两档同时武装。
			expect(manager.isRestorationContinuationGuardArmed(taskId)).toBe(true);
			expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive(taskId)).toBe(true);

			// ① 恢复后 Claude 以 --continue 自己跑完一轮就 Stop——真人尚未发言。这条 Stop 不是「首个显式
			//    用户回合结束」，不得解除 B。
			await api.ingest({
				taskId,
				workspaceId: "workspace-1",
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop" },
			});
			expect(manager.isRestorationContinuationGuardArmed(taskId)).toBe(true);
			expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive(taskId)).toBe(true);

			// ② 真人 prompt：A 档在转移闸之前解除（死锁修复），此后只剩 B 兜着迟到窗口。
			await api.ingest({
				taskId,
				workspaceId: "workspace-1",
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
				submittedPromptText: "接着把 handoff 补完",
			});
			expect(manager.isRestorationContinuationGuardArmed(taskId)).toBe(false);
			expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive(taskId)).toBe(true);

			// ③ 真人首轮进行中、尚未 Stop 时到达的迟到孤儿通知：必须仍被拦截并暂存，绝不能穿透给 agent。
			const lateOrphanResponse = await api.ingest({
				taskId,
				workspaceId: "workspace-1",
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
				submittedPromptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
			});
			expect(lateOrphanResponse.harnessUserPromptProcessingDirective?.processingDecision).toBe(
				"block_and_defer_until_explicit_user_input",
			);
			expect(deferHarnessGeneratedPrompt).toHaveBeenCalledOnce();

			// ④ 契约的另一半：真人首轮的自然 Stop 到达时 B 必须真的放开，不能变成「永不解除」。
			await api.ingest({
				taskId,
				workspaceId: "workspace-1",
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop" },
			});
			expect(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive(taskId)).toBe(false);
		} finally {
			manager.dispose();
		}
	});

	it("N0a：hook 带原生会话身份时先于一切早退写 sidecar；不带时不调用", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToRunning: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			applyHookActivity: vi.fn(),
			applyAgentNativeConversationSessionIdentity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
		} as unknown as TerminalSessionManager;
		const persistIdentity = vi.fn(async () => true);
		const api = createHooksApi({
			persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: persistIdentity,
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});
		const identity = {
			sourceAgentId: "claude",
			nativeSessionId: "sess-1",
			transcriptPath: "/tmp/sess-1.jsonl",
			observedAt: 1,
		};
		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { source: "claude", hookEventName: "PostToolUse" },
			agentNativeConversationSessionIdentity: identity,
		});
		expect(response).toEqual({ ok: true });
		expect(manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledWith("task-1", identity);

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { source: "claude", hookEventName: "PostToolUse" },
		});
		expect(manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledTimes(1);
		expect(persistIdentity).toHaveBeenCalledTimes(1);
		expect(persistIdentity).toHaveBeenCalledWith("workspace-1", "task-1", expect.any(Function));
	});
});

describe("原生身份落盘与 hook 确认", () => {
	it.each([false, true])("保存失败可重试，恢复拦截=%s 时仍保留 block", async (restorationBlocked) => {
		const manager = {
			getSummary: vi.fn(() => createSummary()),
			applyAgentNativeConversationSessionIdentity: vi.fn(),
			applyHookActivity: vi.fn(),
			recordAgentLifecycleHookConversationProgress: vi.fn(),
			isRestorationHarnessGeneratedTaskNotificationInterceptionActive: vi.fn(() => restorationBlocked),
		} as unknown as TerminalSessionManager;
		let releasePersistence: () => void = () => {};
		const pendingPersistence = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		const persistIdentity = vi
			.fn()
			.mockImplementationOnce(async () => {
				await pendingPersistence;
				throw new Error("disk unavailable");
			})
			.mockResolvedValueOnce(true);
		const broadcast = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: () => "/tmp/repo",
			ensureTerminalManagerForWorkspace: async () => manager,
			broadcastRuntimeWorkspaceStateUpdated: broadcast,
			broadcastTaskReadyForReview: vi.fn(),
			persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: persistIdentity,
			deferHarnessGeneratedPromptDuringAgentSessionRestoration: vi.fn(async () => undefined),
		});
		const input = {
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: restorationBlocked ? ("to_in_progress" as const) : ("activity" as const),
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
			submittedPromptText: ORPHAN_TASK_NOTIFICATION_FROM_PREVIOUS_AGENT_SESSION_INCARNATION,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "session-1",
				transcriptPath: null,
				observedAt: 1,
			},
		};
		let completed = false;
		const responsePromise = api.ingest(input).then((result) => {
			completed = true;
			return result;
		});
		await vi.waitFor(() => expect(persistIdentity).toHaveBeenCalledOnce());
		expect(completed).toBe(false);
		releasePersistence();
		const failed = await responsePromise;
		expect(failed).toMatchObject({ ok: false, error: "disk unavailable" });
		expect(broadcast).not.toHaveBeenCalled();
		if (restorationBlocked) {
			expect(failed.harnessUserPromptProcessingDirective?.processingDecision).toBe(
				"block_and_defer_until_explicit_user_input",
			);
		}
		expect((await api.ingest(input)).ok).toBe(true);
		expect(persistIdentity).toHaveBeenCalledTimes(2);
		expect(broadcast).toHaveBeenCalledOnce();
	});
});

it("通知已处理的重复 hook 仍补存身份，但不再次转换状态", async () => {
	const candidateId = await captureNotificationSignal({
		workspaceId: "workspace-dedup",
		taskId: "task-1",
		sourceKind: "hook_runtime_received",
		rawPayload: {},
	});
	if (!candidateId) throw new Error("Expected notification candidate");
	await getNotificationLifecycleArchive().update(
		candidateId,
		{ notificationProcessingStatus: "published" },
		"test-published",
		{},
	);
	const manager = {
		getSummary: vi.fn(() => createSummary()),
		applyAgentNativeConversationSessionIdentity: vi.fn(),
		transitionToReview: vi.fn(),
	} as unknown as TerminalSessionManager;
	const persistIdentity = vi.fn(async () => true);
	const api = createHooksApi({
		getWorkspacePathById: () => "/tmp/repo",
		ensureTerminalManagerForWorkspace: async () => manager,
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview: vi.fn(),
		persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: persistIdentity,
	});
	expect(
		await api.ingest({
			workspaceId: "workspace-dedup",
			taskId: "task-1",
			notificationCandidateId: candidateId,
			event: "to_review",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "session-1",
				transcriptPath: null,
				observedAt: 1,
			},
		}),
	).toEqual({ ok: true });
	expect(persistIdentity).toHaveBeenCalledOnce();
	expect(manager.transitionToReview).not.toHaveBeenCalled();
});

it("SessionStart 身份事件不解除恢复守卫、不推进时间戳或通知", async () => {
	const manager = {
		getSummary: vi.fn(() => createSummary()),
		applyAgentNativeConversationSessionIdentity: vi.fn(),
		applyHookActivity: vi.fn(),
		transitionToRunning: vi.fn(),
		recordAgentLifecycleHookConversationProgress: vi.fn(),
		markRestoredAgentConversationContinued: vi.fn(),
	} as unknown as TerminalSessionManager;
	const notify = vi.fn();
	const api = createHooksApi({
		persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: vi.fn(async () => false),
		getWorkspacePathById: () => "/tmp/repo",
		ensureTerminalManagerForWorkspace: async () => manager,
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview: notify,
	});
	expect(
		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "agent_conversation_session_identity_observed",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "session-new",
				transcriptPath: null,
				observedAt: 1,
			},
		}),
	).toEqual({ ok: true });
	expect(manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
	expect(manager.applyHookActivity).not.toHaveBeenCalled();
	expect(manager.transitionToRunning).not.toHaveBeenCalled();
	expect(manager.recordAgentLifecycleHookConversationProgress).not.toHaveBeenCalled();
	expect(notify).not.toHaveBeenCalled();
});

it("身份落盘失败如实返回错误且保留恢复拦截指令", async () => {
	const manager = {
		getSummary: vi.fn(() => createSummary()),
		applyAgentNativeConversationSessionIdentity: vi.fn(),
		isRestorationHarnessGeneratedTaskNotificationInterceptionActive: () => true,
		applyHookActivity: vi.fn(),
		disarmRestorationContinuationGuard: vi.fn(),
	} as unknown as TerminalSessionManager;
	const api = createHooksApi({
		persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: async () => {
			throw new Error("identity storage unavailable");
		},
		getWorkspacePathById: () => "/tmp/repo",
		ensureTerminalManagerForWorkspace: async () => manager,
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview: vi.fn(),
	});
	const response = await api.ingest({
		taskId: "task-1",
		workspaceId: "workspace-1",
		event: "to_in_progress",
		metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId: "new-session",
			transcriptPath: null,
			observedAt: 1,
		},
	});
	expect(response).toMatchObject({
		ok: false,
		error: "identity storage unavailable",
		harnessUserPromptProcessingDirective: { processingDecision: "block_and_defer_until_explicit_user_input" },
	});
	expect(manager.applyHookActivity).not.toHaveBeenCalled();
	expect(manager.disarmRestorationContinuationGuard).not.toHaveBeenCalled();
});
