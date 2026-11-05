import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../../../src/core/codex-native-agent-turn-execution-observation";
import type { CreateNativeAgentConversationActivityObserverOptions } from "../../../src/server/native-agent-conversation-activity-observer";
import {
	type CreateRuntimeStateHubDependencies,
	createRuntimeStateHub,
	type RuntimeStateHub,
} from "../../../src/server/runtime-state-hub";
import type * as WorkspaceState from "../../../src/state/workspace-state";
import type {
	CodexReviewMisclassificationPersistenceHandler,
	TerminalSessionManager,
} from "../../../src/terminal/session-manager";
import type { moveTaskCardIntoInProgressAfterAcceptedMainConversationInput } from "../../../src/trpc/task-card-action-api";
import { createTempDir } from "../../utilities/temp-dir";

const mockedDependencies = vi.hoisted(() => ({
	moveAcceptedInput: vi.fn<typeof moveTaskCardIntoInProgressAfterAcceptedMainConversationInput>(),
	moveCorrectedReview: vi.fn(),
	persistNativeReadiness: vi.fn().mockResolvedValue(true),
	observeNativeSummary: vi.fn().mockResolvedValue(undefined),
	wakeNativeSubmission: vi.fn(),
	forgetNativeWorkspace: vi.fn(),
	disposeNativeObserver: vi.fn(),
	retentionWarning: vi.fn(),
	completeMainSessionHandover: vi.fn(),
	observerOptions: null as CreateNativeAgentConversationActivityObserverOptions | null,
}));

vi.mock("../../../src/state/persist-codex-native-direct-input-readiness-reconciliation", () => ({
	persistCodexNativeDirectInputReadinessReconciliation: mockedDependencies.persistNativeReadiness,
}));

vi.mock("../../../src/state/workspace-state", async (importOriginal) => ({
	...(await importOriginal<typeof WorkspaceState>()),
	loadWorkspaceContextById: async () => ({ repoPath: "/isolated/accepted-input-worktree" }),
}));
vi.mock("../../../src/state/complete-task-main-session-handover-after-user-message", () => ({
	completeTaskMainSessionHandoverAfterUserMessage: mockedDependencies.completeMainSessionHandover,
}));

vi.mock("../../../src/trpc/task-card-action-api", () => ({
	moveTaskCardIntoInProgressAfterAcceptedMainConversationInput: mockedDependencies.moveAcceptedInput,
	moveTaskCardIntoInProgressAfterCodexNativeReviewMisclassification: mockedDependencies.moveCorrectedReview,
}));
vi.mock("../../../src/server/native-agent-conversation-activity-observer", () => ({
	createNativeAgentConversationActivityObserver: (options: CreateNativeAgentConversationActivityObserverOptions) => {
		mockedDependencies.observerOptions = options;
		return {
			observeTaskSessionSummary: mockedDependencies.observeNativeSummary,
			wakeForPotentialUserPromptSubmission: mockedDependencies.wakeNativeSubmission,
			forgetWorkspace: mockedDependencies.forgetNativeWorkspace,
			dispose: mockedDependencies.disposeNativeObserver,
		};
	},
}));
vi.mock("../../../src/server/agent-session-response-generation-stop-observer", () => ({
	createAgentSessionResponseGenerationStopObserver: () => ({
		observeTaskSessionSummary: () => {},
		forgetWorkspace: () => {},
	}),
}));
vi.mock("../../../src/server/persisted-agent-transcript-conversation-progress-observer", () => ({
	createPersistedAgentTranscriptConversationProgressObserver: () => ({
		observeTaskSessionSummary: () => {},
		forgetWorkspace: () => {},
		dispose: () => {},
	}),
}));
vi.mock("../../../src/diagnostics/agent-session-retention-logger", () => ({
	logAgentSessionRetentionWarning: mockedDependencies.retentionWarning,
}));

const WORKSPACE_ID = "accepted-input-workspace";
const TASK_ID = "current-main-session";
const NOW_MS = 1_790_000_000_000;

function makeSummary(
	status: "pending" | "accepted",
	incarnation = "first-process",
	eventId = "native-message-1",
): RuntimeTaskSessionSummary {
	return {
		taskId: TASK_ID,
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		agentId: "codex",
		workspacePath: "/isolated/accepted-input-worktree",
		pid: 1234,
		startedAt: NOW_MS - 10_000,
		updatedAt: NOW_MS,
		runtimeSessionIncarnationId: incarnation,
		lastOutputAt: null,
		lastHookAt: null,
		latestHookActivity: null,
		reviewReason: null,
		exitCode: null,
		agentConversationPromptSubmissionAcceptance: {
			status,
			attemptedAtMs: NOW_MS - 100,
			runtimeSessionIncarnationId: incarnation,
			...(status === "accepted" ? { confirmedAtMs: NOW_MS, eventId } : {}),
		},
	};
}

function createTrackedManagerHub(initialSummaries: RuntimeTaskSessionSummary[] = []) {
	const workspaceRegistry: CreateRuntimeStateHubDependencies["workspaceRegistry"] = {
		resolveWorkspaceForStream: vi.fn(async () => ({
			status: "no_registered_project" as const,
			projectId: null,
			workspacePath: null,
		})),
		buildProjectsPayloadUsingCachedRuntimeProjectAvailability: vi.fn(async () => ({
			currentProjectId: null,
			projects: [],
		})),
		buildWorkspaceStateSnapshot: vi.fn(async () => {
			throw new Error("测试没有任何浏览器客户端，不应请求工作区快照");
		}),
	};
	const currentByTaskId = new Map(initialSummaries.map((summary) => [summary.taskId, summary]));
	let listener: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
	const hub = createRuntimeStateHub({ workspaceRegistry });
	const recordEffectiveActivity = vi.fn();
	const reconcileNativeDirectInputReadiness = vi.fn();
	const confirmAcceptedInput = vi.fn<TerminalSessionManager["confirmAcceptedAgentConversationInput"]>();
	let correctionPersistenceHandler: CodexReviewMisclassificationPersistenceHandler | null = null;
	const reconcileNativeExecution =
		vi.fn<TerminalSessionManager["reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution"]>();
	const manager = {
		listSummaries: () => [...currentByTaskId.values()],
		getSummary: (taskId: string) => currentByTaskId.get(taskId) ?? null,
		recordEffectiveAgentConversationActivity: recordEffectiveActivity,
		reconcileCodexNeedsInputWithNativeDirectInputReadiness: reconcileNativeDirectInputReadiness,
		confirmAcceptedAgentConversationInput: confirmAcceptedInput,
		setCodexReviewMisclassificationPersistenceHandler: (
			handler: CodexReviewMisclassificationPersistenceHandler | null,
		) => {
			correctionPersistenceHandler = handler;
		},
		reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution: reconcileNativeExecution,
		onSummary: (onSummary: (summary: RuntimeTaskSessionSummary) => void) => {
			listener = onSummary;
			return () => {
				listener = null;
			};
		},
	};
	hub.trackTerminalManager(WORKSPACE_ID, manager as unknown as TerminalSessionManager);
	return {
		hub,
		workspaceRegistry,
		recordEffectiveActivity,
		reconcileNativeDirectInputReadiness,
		confirmAcceptedInput,
		reconcileNativeExecution,
		getCorrectionPersistenceHandler: () => correctionPersistenceHandler,
		emit(summary: RuntimeTaskSessionSummary) {
			currentByTaskId.set(summary.taskId, summary);
			if (!listener) throw new Error("没有存活的 summary 订阅");
			listener(summary);
		},
	};
}

async function flushPromiseCallbacks(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

function deferredCompletion() {
	let resolveCompletion: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	return { promise, resolve: resolveCompletion };
}

describe("runtime-state-hub 服务端输入接受边沿", () => {
	let temporaryHome: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	const hubs: RuntimeStateHub[] = [];
	function trackedHub(initial: RuntimeTaskSessionSummary[] = []) {
		const tracked = createTrackedManagerHub(initial);
		hubs.push(tracked.hub);
		return tracked;
	}
	beforeEach(() => {
		temporaryHome = createTempDir("kanban-hub-accepted-input-transition-");
		previousHome = process.env.HOME;
		process.env.HOME = temporaryHome.path;
		vi.useFakeTimers();
		vi.setSystemTime(NOW_MS);
		vi.clearAllMocks();
		mockedDependencies.moveAcceptedInput.mockReset();
		mockedDependencies.moveAcceptedInput.mockResolvedValue({ saved: false, workspacePath: null });
		mockedDependencies.moveCorrectedReview.mockReset();
		mockedDependencies.moveCorrectedReview.mockResolvedValue({
			saved: false,
			workspacePath: "/isolated/accepted-input-worktree",
		});
		mockedDependencies.observerOptions = null;
	});
	afterEach(async () => {
		for (const hub of hubs.splice(0)) await hub.close();
		vi.clearAllTimers();
		vi.useRealTimers();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		temporaryHome.cleanup();
	});

	it("历史补证标记不会触发卡片移列", async () => {
		const { emit } = trackedHub([makeSummary("pending")]);
		const accepted = makeSummary("accepted");
		if (accepted.agentConversationPromptSubmissionAcceptance)
			accepted.agentConversationPromptSubmissionAcceptance.acceptedByHistoricalReconciliation = true;
		emit(accepted);
		await vi.advanceTimersByTimeAsync(100);
		expect(mockedDependencies.moveAcceptedInput).not.toHaveBeenCalled();
	});
	it("原生接受出口明确报告旧候选拒绝及 manager 的实际应用结果", async () => {
		const pending = {
			...makeSummary("pending"),
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex" as const,
				nativeSessionId: "native",
				transcriptPath: "/isolated/native.jsonl",
				observedAt: NOW_MS,
			},
		};
		const tracked = trackedHub([pending]);
		const acceptedInputListener = vi.fn();
		tracked.hub.registerAgentConversationInputAcceptedListener?.(acceptedInputListener);
		const observation = {
			workspaceId: WORKSPACE_ID,
			conversationSessionId: TASK_ID,
			runtimeSessionIncarnationId: "first-process",
			nativeSessionId: "native",
			eventId: "native-message-1",
			observedAtMs: NOW_MS,
			activityKind: "accepted_user_input" as const,
			evidenceKind: "native_user_prompt_acceptance" as const,
			observedSubmissionAttemptedAtMs: NOW_MS - 200,
		};
		expect(await mockedDependencies.observerOptions?.onAccepted(observation)).toBe(false);
		expect(tracked.confirmAcceptedInput).not.toHaveBeenCalled();
		tracked.confirmAcceptedInput.mockReturnValueOnce(null);
		const currentObservation = { ...observation, observedSubmissionAttemptedAtMs: NOW_MS - 100 };
		expect(await mockedDependencies.observerOptions?.onAccepted(currentObservation)).toBe(false);
		expect(acceptedInputListener).not.toHaveBeenCalled();
		const held = {
			...pending,
			taskConversationSessionMetadata: {
				workspaceTaskId: "owner-card",
				taskConversationSessionRole: "main" as const,
				taskConversationSessionContextSource: "started_from_scratch" as const,
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: null,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: null,
				taskAutomationSuspendedForMainSessionHandover: true,
			},
		};
		tracked.emit(held);
		const accepted = { ...held, ...makeSummary("accepted") };
		tracked.confirmAcceptedInput.mockReturnValueOnce(accepted);
		expect(await mockedDependencies.observerOptions?.onAccepted(currentObservation)).toBe(true);
		expect(mockedDependencies.completeMainSessionHandover).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				workspaceId: WORKSPACE_ID,
				workspacePath: "/isolated/accepted-input-worktree",
				taskConversationSessionId: TASK_ID,
			}),
		);
		expect(acceptedInputListener).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, summary: accepted });
	});

	it("原生输入就绪只路由给本工作区的状态校正出口，不冒充接受或活动", async () => {
		const snapshot = makeSummary("pending");
		const tracked = trackedHub([snapshot]);
		const observation = {
			workspaceId: WORKSPACE_ID,
			conversationSessionId: TASK_ID,
			nativeSessionId: "native",
			runtimeSessionIncarnationId: "first-process",
			observedAtMs: NOW_MS,
		};
		await mockedDependencies.observerOptions?.onCodexNativeDirectInputReadiness?.(observation, snapshot);
		expect(tracked.reconcileNativeDirectInputReadiness).toHaveBeenCalledWith(TASK_ID, snapshot, observation);
		expect(tracked.recordEffectiveActivity).not.toHaveBeenCalled();
		expect(mockedDependencies.moveAcceptedInput).not.toHaveBeenCalled();
	});
	it("原生执行纠偏从观察器路由至 manager，无浏览器也先持久化再撤销派生状态", async () => {
		const before = makeSummary("accepted");
		const tracked = trackedHub([before]);
		const observation: CodexNativeAgentTurnExecutionObservation = {
			workspaceId: WORKSPACE_ID,
			conversationSessionId: TASK_ID,
			runtimeSessionIncarnationId: "first-process",
			nativeSessionId: "native",
			nativeTurnId: "turn",
			nativeTurnStartedAtMs: NOW_MS - 100,
			observedAtMs: NOW_MS,
			threadStatus: "active",
			nativeTurnStatus: "inProgress",
			activeFlags: [],
			canAcceptDirectInput: true,
			executionStatus: "running",
		};
		const corrected = { ...before, updatedAt: NOW_MS + 1 };
		const applyCorrection = vi.fn(() => {
			expect(mockedDependencies.moveCorrectedReview).toHaveBeenCalledOnce();
			tracked.emit(corrected);
			return corrected;
		});
		tracked.reconcileNativeExecution.mockImplementation(async () => {
			const handler = tracked.getCorrectionPersistenceHandler();
			if (!handler) throw new Error("未绑定看板持久化处理器");
			return handler(before, observation, applyCorrection);
		});
		mockedDependencies.moveCorrectedReview.mockResolvedValue({
			saved: true,
			sessionCorrectionAllowed: true,
			workspacePath: "/isolated/accepted-input-worktree",
		});
		await mockedDependencies.observerOptions?.onCodexNativeAgentTurnExecution?.(observation, before);
		expect(tracked.reconcileNativeExecution).toHaveBeenCalledWith(TASK_ID, before, observation);
		expect(applyCorrection).toHaveBeenCalledOnce();
		expect(mockedDependencies.moveCorrectedReview.mock.calls[0]?.[0].getCurrentSummary()).toBe(corrected);
		expect(mockedDependencies.moveAcceptedInput).not.toHaveBeenCalled();
	});
	it("纠偏持久化失败时不撤销原状态，观察器收到失败以便重试", async () => {
		const before = makeSummary("accepted");
		const tracked = trackedHub([before]);
		const applyCorrection = vi.fn();
		mockedDependencies.moveCorrectedReview.mockRejectedValueOnce(new Error("暂时无法写盘"));
		const handler = tracked.getCorrectionPersistenceHandler();
		if (!handler) throw new Error("未绑定看板持久化处理器");
		await expect(handler(before, {} as CodexNativeAgentTurnExecutionObservation, applyCorrection)).rejects.toThrow(
			"暂时无法写盘",
		);
		expect(applyCorrection).not.toHaveBeenCalled();
	});
	it("持久恢复尚未完成时不消费会话锚点，下一次核验可以继续", async () => {
		const before = makeSummary("accepted");
		const tracked = trackedHub([before]);
		const applyCorrection = vi.fn(() => before);
		const handler = tracked.getCorrectionPersistenceHandler();
		if (!handler) throw new Error("未绑定看板持久化处理器");
		const observation = { conversationSessionId: TASK_ID } as CodexNativeAgentTurnExecutionObservation;
		mockedDependencies.moveCorrectedReview.mockResolvedValueOnce({
			saved: false,
			sessionCorrectionAllowed: false,
			workspacePath: "/isolated/accepted-input-worktree",
		});
		expect(await handler(before, observation, applyCorrection)).toBeNull();
		expect(applyCorrection).not.toHaveBeenCalled();
		mockedDependencies.moveCorrectedReview.mockResolvedValueOnce({
			saved: true,
			sessionCorrectionAllowed: true,
			workspacePath: "/isolated/accepted-input-worktree",
		});
		await handler(before, observation, applyCorrection);
		expect(applyCorrection).toHaveBeenCalledOnce();
	});

	it("只将本代原生响应携带的专用缓存证据传给活动写点，换代及普通接受不能冒领", () => {
		const { emit, recordEffectiveActivity } = trackedHub([makeSummary("pending")]);
		const reference = {
			observedAtMs: NOW_MS - 100,
			evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate" as const,
		};
		const observation = {
			workspaceId: WORKSPACE_ID,
			conversationSessionId: TASK_ID,
			runtimeSessionIncarnationId: "first-process",
			nativeSessionId: "native",
			observedAtMs: NOW_MS,
			eventId: "native-response",
			activityKind: "agent_output" as const,
			evidenceKind: "structured_agent_session_event" as const,
			nativeAgentResponsePromptCacheReferenceObservation: reference,
			nativeAgentResponseAcceptedUserInputEventId: "new-native-input",
		};
		mockedDependencies.observerOptions?.onActivity?.(observation);
		expect(recordEffectiveActivity).toHaveBeenCalledExactlyOnceWith(TASK_ID, observation, {
			nativeAgentResponsePromptCacheReferenceObservation: reference,
			nativeAgentResponseAcceptedUserInputEventId: "new-native-input",
		});
		mockedDependencies.observerOptions?.onActivity?.({
			...observation,
			activityKind: "accepted_user_input",
			evidenceKind: "native_user_prompt_acceptance",
		});
		emit(makeSummary("pending", "replacement-process"));
		mockedDependencies.observerOptions?.onActivity?.(observation);
		expect(recordEffectiveActivity).toHaveBeenCalledOnce();
	});

	it("水合时已有 accepted 只建立基线，同一历史接受后续广播不移卡", async () => {
		const accepted = makeSummary("accepted");
		const { emit } = trackedHub([accepted]);
		expect(mockedDependencies.observeNativeSummary).toHaveBeenCalledWith(
			WORKSPACE_ID,
			accepted,
			expect.any(Function),
		);
		emit({ ...accepted, updatedAt: NOW_MS + 1 });
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).not.toHaveBeenCalled();
	});

	it("pending 到 accepted 时即使没有浏览器客户端也调用服务端移列", async () => {
		const pending = makeSummary("pending");
		const { emit, workspaceRegistry } = trackedHub([pending]);
		emit(pending);
		expect(mockedDependencies.wakeNativeSubmission).toHaveBeenCalledTimes(1);
		expect(mockedDependencies.moveAcceptedInput).not.toHaveBeenCalled();
		const accepted = makeSummary("accepted");
		emit(accepted);
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			summary: accepted,
			getCurrentSummary: expect.any(Function),
		});
		expect(mockedDependencies.moveAcceptedInput.mock.calls[0]?.[0].getCurrentSummary()).toBe(accepted);
		expect(workspaceRegistry.resolveWorkspaceForStream).not.toHaveBeenCalled();
		expect(workspaceRegistry.buildWorkspaceStateSnapshot).not.toHaveBeenCalled();
	});

	it("交接 hold 中接受输入时保留边沿，解除 hold 后消费一次", async () => {
		const { emit } = trackedHub([makeSummary("pending")]);
		const held = {
			...makeSummary("accepted"),
			taskConversationSessionMetadata: {
				workspaceTaskId: "owner-card",
				taskConversationSessionRole: "main" as const,
				taskConversationSessionContextSource: "started_from_scratch" as const,
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: null,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: null,
				taskAutomationSuspendedForMainSessionHandover: true,
			},
		};
		emit(held);
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).not.toHaveBeenCalled();
		const released = {
			...held,
			taskConversationSessionMetadata: {
				...held.taskConversationSessionMetadata,
				taskAutomationSuspendedForMainSessionHandover: false,
			},
		};
		emit(released);
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
		emit({ ...released, updatedAt: NOW_MS + 100 });
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
	});

	it("同一接受事件后续活动 summary 不重复消费", async () => {
		const { emit } = trackedHub([makeSummary("pending")]);
		const accepted = makeSummary("accepted");
		emit(accepted);
		await flushPromiseCallbacks();
		emit({ ...accepted, updatedAt: NOW_MS + 100, lastOutputAt: NOW_MS + 100 });
		emit({ ...accepted, updatedAt: NOW_MS + 200 });
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
	});

	it("暂时移列失败不提前记为已处理，一秒后重试成功再去重", async () => {
		mockedDependencies.moveAcceptedInput.mockRejectedValueOnce(new Error("暂时无法持久化看板"));
		const { emit } = trackedHub([makeSummary("pending")]);
		const accepted = makeSummary("accepted");
		emit(accepted);
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
		expect(mockedDependencies.retentionWarning).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(2);
		emit({ ...accepted, updatedAt: NOW_MS + 2_000 });
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(2);
	});

	it("在途旧代际的移列入口读取最新 summary 后放弃，随后新代际可以独立消费", async () => {
		const completion = deferredCompletion();
		const appliedIncarnations: Array<string | null | undefined> = [];
		const checkedCurrentIncarnations: Array<string | null | undefined> = [];
		mockedDependencies.moveAcceptedInput.mockImplementation(async (input) => {
			await completion.promise;
			const current = input.getCurrentSummary();
			checkedCurrentIncarnations.push(current?.runtimeSessionIncarnationId);
			const currentIdentityMatches =
				current?.runtimeSessionIncarnationId === input.summary.runtimeSessionIncarnationId &&
				current?.agentConversationPromptSubmissionAcceptance?.eventId ===
					input.summary.agentConversationPromptSubmissionAcceptance?.eventId;
			if (currentIdentityMatches) appliedIncarnations.push(current?.runtimeSessionIncarnationId);
			return { saved: currentIdentityMatches, workspacePath: null };
		});
		const { emit } = trackedHub([makeSummary("pending")]);
		emit(makeSummary("accepted"));
		emit(makeSummary("pending", "replacement-process"));
		completion.resolve();
		await flushPromiseCallbacks();
		expect(checkedCurrentIncarnations).toEqual(["replacement-process"]);
		expect(appliedIncarnations).toEqual([]);
		emit(makeSummary("accepted", "replacement-process", "native-message-2"));
		await flushPromiseCallbacks();
		expect(appliedIncarnations).toEqual(["replacement-process"]);
	});

	it("close 清理尚未触发的一秒重试与原生观察器，不再写看板", async () => {
		mockedDependencies.moveAcceptedInput.mockRejectedValue(new Error("等待恢复存储"));
		const { hub, emit } = trackedHub([makeSummary("pending")]);
		emit(makeSummary("accepted"));
		await flushPromiseCallbacks();
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
		await hub.close();
		hubs.splice(hubs.indexOf(hub), 1);
		expect(mockedDependencies.disposeNativeObserver).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(mockedDependencies.moveAcceptedInput).toHaveBeenCalledTimes(1);
	});
});
