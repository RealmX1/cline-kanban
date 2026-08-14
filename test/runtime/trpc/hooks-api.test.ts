import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";

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

const CLAUDE_HARNESS_GENERATED_TASK_NOTIFICATION = [
	"<task-notification>",
	"<task-id>background-1</task-id>",
	"<tool-use-id>tool-use-1</tool-use-id>",
	"<output-file>/tmp/background-1.output</output-file>",
	"<status>failed</status>",
	"<summary>No completion record was found.</summary>",
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
			submittedPromptText: CLAUDE_HARNESS_GENERATED_TASK_NOTIFICATION,
		});

		expect(response).toEqual({
			ok: true,
			harnessUserPromptProcessingDirective: {
				processingDecision: "block_and_defer_until_explicit_user_input",
				userVisibleReason: "Kanban 正在恢复旧会话；这条系统任务通知已暂存，不会自动启动新的 agent 回合。",
			},
		});
		expect(deferHarnessGeneratedPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "task-1", promptText: CLAUDE_HARNESS_GENERATED_TASK_NOTIFICATION }),
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
			submittedPromptText: CLAUDE_HARNESS_GENERATED_TASK_NOTIFICATION,
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
			submittedPromptText: CLAUDE_HARNESS_GENERATED_TASK_NOTIFICATION,
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
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1", "permission");
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
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1", "plan_review");
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
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1", "question");
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
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1", "plan_review");
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
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1", "question");
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
		const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		// F1：checkpoint 已移出响应关键路径，作为不 await 的后台任务在 ingest 返回后才落定。
		// 故 capture/applyTurnCheckpoint/deleteRef 这些副作用要 waitFor，而非在 ingest 返回那刻断言。
		await vi.waitFor(() => {
			expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
				cwd: "/tmp/worktree",
				ref: "refs/kanban/checkpoints/task-1/turn/1",
			});
		});
		expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
		expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
	});
});
