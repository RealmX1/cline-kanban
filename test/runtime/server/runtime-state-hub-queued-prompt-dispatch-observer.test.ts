// runtime-state-hub 上排队 prompt 出队观察器的挂载点。
//
// 这条是**正确性**要求而不是风格：观察器必须挂在「0 客户端提前返回」之前。挂到后面去，用户一关浏览器
// 标签页，队列就再也不会在 agent 停下时排空——而「我去睡了，让它跑完这一轮再接着做下一件事」恰恰是
// 这个特性最典型的用法。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	type CreateRuntimeStateHubDependencies,
	createRuntimeStateHub,
	type QueuedTaskPromptDeliveryDispatchObserver,
} from "../../../src/server/runtime-state-hub";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTempDir } from "../../utilities/temp-dir";

const WORKSPACE_ID = "workspace-1";

function makeRunningSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		// codex：转录推进探测只支持 claude，其它 agentId 让该观察器对 fake manager 保持惰性。
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function createHubWithFakeTerminalManager() {
	const workspaceRegistry: CreateRuntimeStateHubDependencies["workspaceRegistry"] = {
		resolveWorkspaceForStream: async () => ({
			status: "no_registered_project",
			projectId: null,
			workspacePath: null,
		}),
		buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async () => ({ currentProjectId: null, projects: [] }),
		buildWorkspaceStateSnapshot: async () => {
			throw new Error("not used in this test");
		},
	};
	const hub = createRuntimeStateHub({ workspaceRegistry });
	let emitSummary: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
	hub.trackTerminalManager(WORKSPACE_ID, {
		onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
			emitSummary = listener;
			return () => {
				emitSummary = null;
			};
		},
		listSummaries: () => [] as RuntimeTaskSessionSummary[],
	} as unknown as TerminalSessionManager);
	return {
		hub,
		emit(summary: RuntimeTaskSessionSummary) {
			if (!emitSummary) {
				throw new Error("terminal summary listener was not registered");
			}
			emitSummary(summary);
		},
	};
}

function createRecordingObserver() {
	const observed: string[] = [];
	const forgotten: string[] = [];
	const observer: QueuedTaskPromptDeliveryDispatchObserver = {
		observeTaskSessionSummary: (workspaceId, summary) => observed.push(`${workspaceId}/${summary.taskId}`),
		forgetWorkspace: (workspaceId) => forgotten.push(workspaceId),
	};
	return { observer, observed, forgotten };
}

describe("runtime-state-hub — 排队 prompt 出队观察器", () => {
	let tempHome: { path: string; cleanup: () => void };
	let previousHome: string | undefined;

	beforeEach(() => {
		tempHome = createTempDir("kanban-hub-queued-prompt-observer-test-");
		previousHome = process.env.HOME;
		process.env.HOME = tempHome.path;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		tempHome.cleanup();
	});

	it("**没有任何客户端连着**时也照样把每条 summary 交给观察器", async () => {
		const { hub, emit } = createHubWithFakeTerminalManager();
		const recording = createRecordingObserver();
		hub.registerQueuedTaskPromptDeliveryDispatchObserver(recording.observer);
		emit(makeRunningSummary("task-a"));
		expect(recording.observed).toEqual([`${WORKSPACE_ID}/task-a`]);
		await hub.close();
	});

	it("解绑之后不再收到", async () => {
		const { hub, emit } = createHubWithFakeTerminalManager();
		const recording = createRecordingObserver();
		const unregister = hub.registerQueuedTaskPromptDeliveryDispatchObserver(recording.observer);
		unregister();
		emit(makeRunningSummary("task-a"));
		expect(recording.observed).toEqual([]);
		await hub.close();
	});

	it("workspace 被销毁时让观察器忘掉它", async () => {
		const { hub } = createHubWithFakeTerminalManager();
		const recording = createRecordingObserver();
		hub.registerQueuedTaskPromptDeliveryDispatchObserver(recording.observer);
		hub.disposeWorkspace(WORKSPACE_ID);
		expect(recording.forgotten).toEqual([WORKSPACE_ID]);
		await hub.close();
	});

	// 出队是附加动作：它的任何异常都不能掀翻 summary 广播链路（回收计时、通知、推流都挂在同一条链上）。
	it("观察器抛异常不影响 summary 链路", async () => {
		const { hub, emit } = createHubWithFakeTerminalManager();
		hub.registerQueuedTaskPromptDeliveryDispatchObserver({
			observeTaskSessionSummary: () => {
				throw new Error("出队引擎炸了");
			},
			forgetWorkspace: () => {},
		});
		expect(() => emit(makeRunningSummary("task-a"))).not.toThrow();
		await hub.close();
	});
});
