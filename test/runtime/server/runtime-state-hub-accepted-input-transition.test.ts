import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { CreateNativeAgentConversationActivityObserverOptions } from "../../../src/server/native-agent-conversation-activity-observer";
import {
	type CreateRuntimeStateHubDependencies,
	createRuntimeStateHub,
	type RuntimeStateHub,
} from "../../../src/server/runtime-state-hub";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { moveTaskCardIntoInProgressAfterAcceptedMainConversationInput } from "../../../src/trpc/task-card-action-api";
import { createTempDir } from "../../utilities/temp-dir";

const mockedDependencies = vi.hoisted(() => ({
	moveAcceptedInput: vi.fn<typeof moveTaskCardIntoInProgressAfterAcceptedMainConversationInput>(),
	observeNativeSummary: vi.fn().mockResolvedValue(undefined),
	wakeNativeSubmission: vi.fn(),
	forgetNativeWorkspace: vi.fn(),
	disposeNativeObserver: vi.fn(),
	retentionWarning: vi.fn(),
	observerOptions: null as CreateNativeAgentConversationActivityObserverOptions | null,
}));

vi.mock("../../../src/trpc/task-card-action-api", () => ({
	moveTaskCardIntoInProgressAfterAcceptedMainConversationInput: mockedDependencies.moveAcceptedInput,
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
	const manager = {
		listSummaries: () => [...currentByTaskId.values()],
		getSummary: (taskId: string) => currentByTaskId.get(taskId) ?? null,
		recordEffectiveAgentConversationActivity: recordEffectiveActivity,
		reconcileCodexNeedsInputWithNativeDirectInputReadiness: reconcileNativeDirectInputReadiness,
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
