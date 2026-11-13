import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { exitCodexNativeConversationPlanMode } from "../../../src/terminal/codex-native-conversation-plan-mode-exit";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

const mocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	exitCodexNativeConversationPlanMode: vi.fn<typeof exitCodexNativeConversationPlanMode>(),
	withTaskClosureLifecycleLocks: vi.fn(
		async (_workspaceId: string, _taskIds: readonly string[], action: () => Promise<unknown>) => action(),
	),
}));
vi.mock("../../../src/state/workspace-state", () => ({ loadWorkspaceBoardById: mocks.loadWorkspaceBoardById }));
vi.mock("../../../src/terminal/codex-native-conversation-plan-mode-exit", () => ({
	exitCodexNativeConversationPlanMode: mocks.exitCodexNativeConversationPlanMode,
}));
vi.mock("../../../src/task-closure/task-closure-operation-store", () => ({
	withTaskClosureLifecycleLocks: mocks.withTaskClosureLifecycleLocks,
}));

const incarnationId = "281fd234-c6df-4563-ae2b-c9b2e33541f1";
const workspaceScope = { workspaceId: "workspace-1", workspacePath: "/workspace" };
const request = {
	taskConversationSessionId: "task-1",
	expectedRuntimeSessionIncarnationId: incarnationId,
	expectedNativeConversationSessionId: "native-1",
};
function setup(sessionId = "task-1") {
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: sessionId,
		agentId: "codex",
		workspacePath: "/workspace",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: incarnationId,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native-1",
			transcriptPath: null,
			observedAt: 1,
		},
		...(sessionId !== "task-1"
			? {
					taskConversationSessionMetadata: {
						workspaceTaskId: "task-1",
						taskConversationSessionRole: "task_collaborator",
						taskConversationSessionContextSource: "started_from_scratch",
						parentTaskConversationSessionId: "task-1",
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
				}
			: {}),
	});
	const terminalManager = {
		getSummary: vi.fn(() => summary),
		hasLiveTaskSession: vi.fn(() => true),
	};
	const api = createRuntimeApi({
		getScopedTerminalManager: vi.fn(async () => terminalManager as unknown as TerminalSessionManager),
	} as unknown as CreateRuntimeApiDependencies);
	return { api, summary, terminalManager };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadWorkspaceBoardById.mockResolvedValue({ columns: [{ id: "in_progress", cards: [{ id: "task-1" }] }] });
	mocks.exitCodexNativeConversationPlanMode.mockResolvedValue({ status: "exited" });
});

describe("退出计划模式的任务与会话归属", () => {
	it.each([true, false])("异常发生时，已进入原生控制=%s 决定是否仍需补证", async (nativeControlStarted) => {
		const { api } = setup();
		if (nativeControlStarted)
			mocks.exitCodexNativeConversationPlanMode.mockRejectedValueOnce(new Error("控制或释放锁时连接中断"));
		else mocks.loadWorkspaceBoardById.mockRejectedValueOnce(new Error("读取归属失败"));
		expect((await api.exitCodexTaskConversationSessionPlanMode(workspaceScope, request)).status).toBe(
			nativeControlStarted ? "unconfirmed" : "rejected",
		);
	});
	it.each(["task-1", "collaborator-1"])("%s 使用自己的原生身份，并锁住宿主卡防止并发结案", async (sessionId) => {
		const { api, summary, terminalManager } = setup(sessionId);
		expect(
			await api.exitCodexTaskConversationSessionPlanMode(workspaceScope, {
				...request,
				taskConversationSessionId: sessionId,
			}),
		).toEqual({ status: "exited" });
		expect(mocks.loadWorkspaceBoardById).toHaveBeenCalledWith("workspace-1");
		expect(mocks.withTaskClosureLifecycleLocks).toHaveBeenCalledWith("workspace-1", ["task-1"], expect.any(Function));
		const input = mocks.exitCodexNativeConversationPlanMode.mock.calls[0]?.[0];
		assert(input);
		expect(input.summary).toBe(summary);
		expect(input.getCurrentLiveSummary()).toBe(summary);
		terminalManager.hasLiveTaskSession.mockReturnValue(false);
		expect(input.getCurrentLiveSummary()).toBeNull();
	});

	it.each([
		"expectedRuntimeSessionIncarnationId",
		"expectedNativeConversationSessionId",
		"taskConversationSessionId",
	] as const)("旧的 %s 不能切换新会话", async (field) => {
		const { api } = setup();
		expect(
			(await api.exitCodexTaskConversationSessionPlanMode(workspaceScope, { ...request, [field]: "stale" })).status,
		).toBe("rejected");
		expect(mocks.exitCodexNativeConversationPlanMode).not.toHaveBeenCalled();
	});

	it.each(["trash", "missing"])("%s 宿主任务不能执行模式切换", async (state) => {
		const { api } = setup("collaborator-1");
		mocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{ id: state === "trash" ? "trash" : "in_progress", cards: state === "missing" ? [] : [{ id: "task-1" }] },
			],
		});
		expect(
			(
				await api.exitCodexTaskConversationSessionPlanMode(workspaceScope, {
					...request,
					taskConversationSessionId: "collaborator-1",
				})
			).status,
		).toBe("rejected");
		expect(mocks.exitCodexNativeConversationPlanMode).not.toHaveBeenCalled();
	});
});

import assert from "node:assert/strict";
