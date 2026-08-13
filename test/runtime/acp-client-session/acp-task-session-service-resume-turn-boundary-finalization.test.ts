// 续跑重开（resumePriorAgentConversationWithoutResendingPrompt）这条分支刻意不发 session/prompt，
// 所以它永远走不到 applyAcpPromptTurnCompletion 那个回合边界收尾点。这里钉住「重播结束即收尾」：
// 历史 reasoning 必须被改写成已收束并发出去，流式分组必须被清空。
import { describe, expect, it, vi } from "vitest";
import type { AcpSessionNotification } from "../../../src/acp-client-session/acp-protocol-boundary";
import type { AcpTaskMessage } from "../../../src/acp-client-session/acp-session-state";

const RESUMED_SESSION_ID = "session-resumed";
const TASK_ID = "task-resume-turn-boundary";
// 重播回来的历史思考与续跑后新产出的思考刻意共用同一个 ACP messageId：分组表没清干净时，
// 后者会被追加到前者身上，于是「两条独立消息」这个断言正是清分组的判据。
const REPLAYED_AND_NEXT_TURN_SHARED_ACP_MESSAGE_ID = "thought-1";

// 测试替身：换掉真实的 AcpClientConnectionRuntime，好在不 spawn omp 子进程的前提下复现
// 「session/load 在 startTaskConnection 返回之前就把历史推完」这段承重时序。
const acpClientConnectionRuntimeTestDouble = vi.hoisted(() => {
	interface FakeConnectionRuntimeHandlers {
		onSessionUpdate(taskId: string, notification: unknown): void;
	}

	const state = {
		handlers: null as FakeConnectionRuntimeHandlers | null,
		notificationsReplayedDuringSessionLoad: [] as unknown[],
	};

	class FakeAcpClientConnectionRuntime {
		private readonly connectionsByTaskId = new Map<string, unknown>();
		private readonly taskIdsReplayingPersistedConversationHistory = new Set<string>();

		constructor(handlers: FakeConnectionRuntimeHandlers) {
			state.handlers = handlers;
		}

		getConnection(taskId: string): unknown {
			return this.connectionsByTaskId.get(taskId) ?? null;
		}

		isReplayingPersistedConversationHistory(taskId: string): boolean {
			return this.taskIdsReplayingPersistedConversationHistory.has(taskId);
		}

		async startTaskConnection(input: { taskId: string; agentId: string }): Promise<unknown> {
			const connection = {
				taskId: input.taskId,
				agentId: input.agentId,
				sessionId: RESUMED_SESSION_ID,
				pid: 4242,
				initializeResponse: {},
				prompt: async () => ({ stopReason: "end_turn" }),
				cancel: async () => undefined,
				setSessionMode: async () => undefined,
				close: () => undefined,
			};
			// 连接先入账再重播：重播期间的 SessionUpdate 要能查到 pid，与真实实现一致。
			this.connectionsByTaskId.set(input.taskId, connection);
			this.taskIdsReplayingPersistedConversationHistory.add(input.taskId);
			for (const notification of state.notificationsReplayedDuringSessionLoad) {
				state.handlers?.onSessionUpdate(input.taskId, notification);
			}
			this.taskIdsReplayingPersistedConversationHistory.delete(input.taskId);
			return connection;
		}
	}

	return { state, FakeAcpClientConnectionRuntime };
});

vi.mock("../../../src/acp-client-session/acp-client-connection-runtime", () => ({
	AcpClientConnectionRuntime: acpClientConnectionRuntimeTestDouble.FakeAcpClientConnectionRuntime,
}));

import { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";

function notifyAgentThoughtChunk(text: string): AcpSessionNotification {
	return {
		sessionId: RESUMED_SESSION_ID,
		update: {
			sessionUpdate: "agent_thought_chunk",
			messageId: REPLAYED_AND_NEXT_TURN_SHARED_ACP_MESSAGE_ID,
			content: { type: "text", text },
		},
	};
}

async function startResumedTaskSession(): Promise<{
	service: AcpTaskSessionService;
	emittedMessages: AcpTaskMessage[];
}> {
	acpClientConnectionRuntimeTestDouble.state.notificationsReplayedDuringSessionLoad = [
		notifyAgentThoughtChunk("重播回来的历史思考"),
	];
	const service = new AcpTaskSessionService();
	const emittedMessages: AcpTaskMessage[] = [];
	service.onMessage((_taskId, message) => {
		emittedMessages.push(message);
	});
	await service.startTaskSession({
		taskId: TASK_ID,
		agentId: "omp",
		cwd: "/tmp/kanban-acp-resume-turn-boundary",
		prompt: "",
		permissionMode: "ask_for_every_tool_use",
		resumePriorAgentConversationWithoutResendingPrompt: true,
	});
	return { service, emittedMessages };
}

describe("AcpTaskSessionService 续跑重开的回合边界收尾", () => {
	it("把重播回来的 reasoning 改写成已收束，并把改写后的消息发出去", async () => {
		const { service, emittedMessages } = await startResumedTaskSession();

		const replayedReasoningMessage = service.listMessages(TASK_ID).find((message) => message.role === "reasoning");
		expect(replayedReasoningMessage?.content).toBe("重播回来的历史思考");
		// 仍是 reasoning_streaming 就意味着面板会把一段早已写完的思考一直当作「在流」而保持展开。
		expect(replayedReasoningMessage?.meta?.streamType).toBe("reasoning");
		// 只改账本不发消息前端拿不到更新，所以改写后的那一版必须经 emitMessage 出去过。
		expect(
			emittedMessages.some(
				(message) => message.id === replayedReasoningMessage?.id && message.meta?.streamType === "reasoning",
			),
		).toBe(true);
	});

	it("清掉流式分组，使续跑后同一 ACP messageId 的 chunk 新建消息而不是追加到历史消息上", async () => {
		const { service } = await startResumedTaskSession();

		acpClientConnectionRuntimeTestDouble.state.handlers?.onSessionUpdate(
			TASK_ID,
			notifyAgentThoughtChunk("续跑后新产出的思考"),
		);

		const reasoningMessages = service.listMessages(TASK_ID).filter((message) => message.role === "reasoning");
		expect(reasoningMessages.map((message) => message.content)).toEqual(["重播回来的历史思考", "续跑后新产出的思考"]);
	});
});
