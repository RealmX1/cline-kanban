import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AcpConnectionRuntimeHandlers,
	AcpTaskConnection,
} from "../../../src/acp-client-session/acp-client-connection-runtime";
import type { AcpPromptResponse, AcpSessionNotification } from "../../../src/acp-client-session/acp-protocol-boundary";

const runtime = vi.hoisted(() => {
	const state = {
		handlers: null as AcpConnectionRuntimeHandlers | null,
		connection: null as AcpTaskConnection | null,
		connectionForStart: null as AcpTaskConnection | null,
		replaying: false,
	};
	class FakeRuntime {
		constructor(handlers: AcpConnectionRuntimeHandlers) {
			state.handlers = handlers;
		}
		getConnection() {
			return state.connection;
		}
		isReplayingPersistedConversationHistory() {
			return state.replaying;
		}
		async startTaskConnection() {
			state.connection = state.connectionForStart;
			return state.connection;
		}
		disposeTaskConnection() {
			state.connection = null;
		}
		disposeAllTaskConnections() {
			state.connection = null;
		}
	}
	return { state, FakeRuntime };
});
vi.mock("../../../src/acp-client-session/acp-client-connection-runtime", () => ({
	AcpClientConnectionRuntime: runtime.FakeRuntime,
}));

import { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";

const TASK_ID = "task-acceptance";
function deferredPrompt() {
	let resolve!: (value: AcpPromptResponse) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<AcpPromptResponse>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}
async function startAwaitingUserSession() {
	const turn = deferredPrompt();
	const connection: AcpTaskConnection = {
		taskId: TASK_ID,
		agentId: "omp",
		sessionId: "native-session",
		pid: 42,
		initializeResponse: { protocolVersion: 1, agentCapabilities: {} },
		prompt: vi.fn(() => turn.promise),
		cancel: vi.fn(async () => {}),
		setSessionMode: vi.fn(async () => {}),
		close: vi.fn(),
	};
	// 启动前 getConnection 必须为空；startTaskConnection 才正式注册连接。
	runtime.state.connection = null;
	runtime.state.connectionForStart = connection;
	const service = new AcpTaskSessionService();
	const start = service.startTaskSession({
		taskId: TASK_ID,
		agentId: "omp",
		cwd: "/workspace/task",
		prompt: "",
		permissionMode: "ask_for_every_tool_use",
		resumePriorAgentConversationWithoutResendingPrompt: true,
	});
	await start;
	const listener = vi.fn();
	service.setUserPromptSubmittedListener(listener);
	return { service, connection, listener, turn };
}
function notify(update: AcpSessionNotification["update"]) {
	runtime.state.handlers?.onSessionUpdate(TASK_ID, { sessionId: "native-session", update });
}

afterEach(() => {
	runtime.state.connection = null;
	runtime.state.replaying = false;
	vi.useRealTimers();
});

describe("ACP 提交只在可靠协议活动后确认接受", () => {
	it("持久交接 hold 解除后，活会话重发同一接受事实而不刷新活动时间", async () => {
		const { service } = await startAwaitingUserSession();
		const metadata = {
			workspaceTaskId: TASK_ID,
			taskConversationSessionRole: "main" as const,
			taskConversationSessionContextSource: "main" as const,
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
			taskAutomationSuspendedForMainSessionHandover: true,
		};
		service.applyTaskConversationSessionMetadata(TASK_ID, metadata);
		await service.sendTaskSessionInput(TASK_ID, "真正继续新主会话");
		notify({ sessionUpdate: "tool_call", toolCallId: "first-active-tool", title: "真实处理" });
		const accepted = service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance;
		const activity = service.getSummary(TASK_ID)?.lastEffectiveAgentConversationActivityObservation;
		const emitted = vi.fn();
		service.onSummary(emitted);
		service.applyTaskConversationSessionMetadata(TASK_ID, {
			...metadata,
			taskAutomationSuspendedForMainSessionHandover: false,
		});
		expect(emitted).toHaveBeenCalledOnce();
		expect(emitted.mock.calls[0][0]).toMatchObject({
			agentConversationPromptSubmissionAcceptance: accepted,
			taskConversationSessionMetadata: { taskAutomationSuspendedForMainSessionHandover: false },
		});
		expect(service.getSummary(TASK_ID)?.lastEffectiveAgentConversationActivityObservation).toEqual(activity);
	});
	it("取消旧请求的 await 空档继续拒绝新提交，防旧取消结果覆盖新回合", async () => {
		const { service, connection } = await startAwaitingUserSession();
		await service.sendTaskSessionInput(TASK_ID, "旧请求");
		let completeCancellation!: () => void;
		vi.mocked(connection.cancel).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				completeCancellation = resolve;
			}),
		);
		const cancellation = service.cancelTaskTurn(TASK_ID);
		try {
			await expect(service.sendTaskSessionInput(TASK_ID, "取消中的新请求")).rejects.toThrow("正在处理");
		} finally {
			completeCancellation();
			await cancellation;
		}
	});
	it.each(["cancelTaskTurn", "abortTaskSession"] as const)(
		"%s 的通知返回后仍等旧 prompt 真正结算，并保留同 key 的取消结果",
		async (cancelMethod) => {
			vi.useFakeTimers();
			const { service, connection, listener, turn } = await startAwaitingUserSession();
			const oldAcceptanceOutcome = vi.fn();
			await service.sendTaskSessionInput(TASK_ID, "旧请求", undefined, oldAcceptanceOutcome, "old-request-key");
			await service[cancelMethod](TASK_ID);
			const repeatedCancelledOutcome = vi.fn();
			await service.sendTaskSessionInput(TASK_ID, "旧请求", undefined, repeatedCancelledOutcome, "old-request-key");
			notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧请求迟到的输出" } });
			expect(oldAcceptanceOutcome).toHaveBeenCalledExactlyOnceWith(false);
			expect(repeatedCancelledOutcome).toHaveBeenCalledExactlyOnceWith(false);
			expect(listener).not.toHaveBeenCalled();
			expect(service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance).toMatchObject({
				status: "unconfirmed",
				eventId: "old-request-key",
			});
			await expect(service.sendTaskSessionInput(TASK_ID, "新请求")).rejects.toThrow("正在处理");
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(service.sendTaskSessionInput(TASK_ID, "静默后仍不能重发")).rejects.toThrow("正在处理");
			expect(connection.prompt).toHaveBeenCalledTimes(1);

			turn.resolve({ stopReason: "end_turn" });
			await Promise.resolve();
			await Promise.resolve();
			expect(listener).not.toHaveBeenCalled();
			expect(service.getSummary(TASK_ID)?.lastAgentConversationUserHandoffObservation).toBeUndefined();
			await service.sendTaskSessionInput(TASK_ID, "旧请求", undefined, undefined, "old-request-key");
			expect(connection.prompt).toHaveBeenCalledTimes(1);

			const nextTurn = deferredPrompt();
			vi.mocked(connection.prompt).mockReturnValueOnce(nextTurn.promise);
			const newAcceptanceOutcome = vi.fn();
			await service.sendTaskSessionInput(TASK_ID, "新请求", undefined, newAcceptanceOutcome, "new-request-key");
			expect(connection.prompt).toHaveBeenCalledTimes(2);
			expect(newAcceptanceOutcome).not.toHaveBeenCalled();
			notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "新请求的输出" } });
			expect(newAcceptanceOutcome).toHaveBeenCalledExactlyOnceWith(true);
			expect(listener).toHaveBeenCalledExactlyOnceWith(TASK_ID, "新请求");
			service.disposeAllTaskSessions();
		},
	);
	it.each(["stop", "connection_closed"] as const)(
		"取消通知不返回时，%s 可释放旧连接归属且不阻塞新连接",
		async (closeMethod) => {
			const { service, connection, listener, turn } = await startAwaitingUserSession();
			await service.sendTaskSessionInput(TASK_ID, "旧请求");
			let completeCancellation!: () => void;
			vi.mocked(connection.cancel).mockReturnValueOnce(
				new Promise<void>((resolve) => {
					completeCancellation = resolve;
				}),
			);
			const cancellation = service.cancelTaskTurn(TASK_ID);
			try {
				turn.resolve({ stopReason: "cancelled" });
				await Promise.resolve();
				await Promise.resolve();
				await expect(service.sendTaskSessionInput(TASK_ID, "取消通知仍在途")).rejects.toThrow("正在处理");
				if (closeMethod === "stop") await service.stopTaskSession(TASK_ID);
				else {
					runtime.state.connection = null;
					runtime.state.handlers?.onConnectionClosed(TASK_ID, {
						exitCode: 1,
						terminationSignal: null,
						closeIntent: "exited_on_its_own",
						stderrDiagnostics: "",
					});
				}
				const nextTurn = deferredPrompt();
				const nextConnection: AcpTaskConnection = {
					...connection,
					prompt: vi.fn(() => nextTurn.promise),
					cancel: vi.fn(async () => {}),
				};
				runtime.state.connectionForStart = nextConnection;
				await service.startTaskSession({
					taskId: TASK_ID,
					agentId: "omp",
					cwd: "/workspace/task",
					prompt: "",
					permissionMode: "ask_for_every_tool_use",
					resumePriorAgentConversationWithoutResendingPrompt: true,
				});
				await service.sendTaskSessionInput(TASK_ID, "新连接的输入");
				expect(nextConnection.prompt).toHaveBeenCalledOnce();
				expect(listener).not.toHaveBeenCalled();
				completeCancellation();
				await cancellation;
				notify({ sessionUpdate: "tool_call", toolCallId: "new-connection-tool", title: "新连接处理输入" });
				expect(listener).toHaveBeenCalledExactlyOnceWith(TASK_ID, "新连接的输入");
			} finally {
				completeCancellation();
				await cancellation;
				service.disposeAllTaskSessions();
			}
		},
	);
	it("仅发出 prompt 和元数据更新保持待确认及用户回合", async () => {
		const { service, listener } = await startAwaitingUserSession();
		await service.sendTaskSessionInput(TASK_ID, "真正的新输入");
		notify({ sessionUpdate: "current_mode_update", currentModeId: "code" });
		expect(listener).not.toHaveBeenCalled();
		expect(service.getSummary(TASK_ID)).toMatchObject({
			turnOwner: "user",
			agentConversationPromptSubmissionAcceptance: { status: "pending" },
		});
		expect(service.getSummary(TASK_ID)?.lastEffectiveAgentConversationActivityObservation).toBeUndefined();
	});

	it("首个真实工具更新确认一次接受，session/load 重播不能确认", async () => {
		const { service, listener } = await startAwaitingUserSession();
		const acceptanceOutcome = vi.fn();
		await service.sendTaskSessionInput(TASK_ID, "执行工具", undefined, acceptanceOutcome);
		runtime.state.replaying = true;
		notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "历史输出" } });
		expect(listener).not.toHaveBeenCalled();
		expect(acceptanceOutcome).not.toHaveBeenCalled();
		runtime.state.replaying = false;
		notify({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "读取文件" });
		notify({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
		expect(listener).toHaveBeenCalledExactlyOnceWith(TASK_ID, "执行工具");
		expect(acceptanceOutcome).toHaveBeenCalledExactlyOnceWith(true);
		expect(service.getSummary(TASK_ID)).toMatchObject({
			turnOwner: "agent",
			agentConversationPromptSubmissionAcceptance: { status: "accepted", nativeSessionId: "native-session" },
		});
	});

	it("没有流式输出的成功最终响应也可证明接受", async () => {
		const { service, listener, turn } = await startAwaitingUserSession();
		await service.sendTaskSessionInput(TASK_ID, "无输出回合");
		const attemptedAtMs = service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance?.attemptedAtMs;
		expect(service.getSummary(TASK_ID)?.lastAgentConversationPromptCacheReferenceObservation).toBeUndefined();
		turn.resolve({ stopReason: "end_turn" });
		await Promise.resolve();
		await Promise.resolve();
		expect(listener).toHaveBeenCalledExactlyOnceWith(TASK_ID, "无输出回合");
		expect(service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted");
		expect(service.getSummary(TASK_ID)?.lastAgentConversationUserHandoffObservation).toBeDefined();
		expect(service.getSummary(TASK_ID)?.lastAgentConversationPromptCacheReferenceObservation).toEqual({
			observedAtMs: attemptedAtMs,
			evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate",
		});
	});

	it("prompt 被拒绝不能宣称已接受，也不能制造 Agent 回合", async () => {
		const { service, listener, turn } = await startAwaitingUserSession();
		await service.sendTaskSessionInput(TASK_ID, "会被拒绝的输入");
		turn.reject(new Error("provider rejected prompt"));
		await Promise.resolve();
		await Promise.resolve();
		expect(listener).not.toHaveBeenCalled();
		expect(service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance?.status).toBe("unconfirmed");
		expect(service.getSummary(TASK_ID)?.agentResponseGenerationTurnSequence ?? 0).toBe(0);
	});

	it("有一个未完成请求时拒绝第二条，避免更新归因不明", async () => {
		const { service, connection } = await startAwaitingUserSession();
		await service.sendTaskSessionInput(TASK_ID, "第一条");
		await expect(service.sendTaskSessionInput(TASK_ID, "第二条")).rejects.toThrow("正在处理");
		expect(connection.prompt).toHaveBeenCalledTimes(1);
	});

	it("15 秒未确认只显示未知，不重发 prompt", async () => {
		vi.useFakeTimers();
		const { service, connection } = await startAwaitingUserSession();
		const acceptanceOutcome = vi.fn();
		await service.sendTaskSessionInput(TASK_ID, "慢接受", undefined, acceptanceOutcome, "stable-delivery-key");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance?.status).toBe("unconfirmed");
		expect(connection.prompt).toHaveBeenCalledTimes(1);
		expect(acceptanceOutcome).toHaveBeenCalledExactlyOnceWith(false);
		const repeatedUnknownOutcome = vi.fn();
		await service.sendTaskSessionInput(TASK_ID, "慢接受", undefined, repeatedUnknownOutcome, "stable-delivery-key");
		expect(repeatedUnknownOutcome).toHaveBeenCalledExactlyOnceWith(false);
		expect(connection.prompt).toHaveBeenCalledTimes(1);
		notify({ sessionUpdate: "tool_call", toolCallId: "late-tool", title: "迟到的可靠接受证明" });
		expect(service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted");
		expect(acceptanceOutcome).toHaveBeenCalledTimes(1);
		const repeatedAcceptedOutcome = vi.fn();
		await service.sendTaskSessionInput(TASK_ID, "慢接受", undefined, repeatedAcceptedOutcome, "stable-delivery-key");
		expect(repeatedAcceptedOutcome).toHaveBeenCalledExactlyOnceWith(true);
		expect(connection.prompt).toHaveBeenCalledTimes(1);
		service.disposeAllTaskSessions();
	});

	it("停止之后才返回的旧成功响应不得确认新 incarnation", async () => {
		const { service, listener, turn } = await startAwaitingUserSession();
		await service.sendTaskSessionInput(TASK_ID, "旧请求");
		await service.stopTaskSession(TASK_ID);
		turn.resolve({ stopReason: "end_turn" });
		await Promise.resolve();
		await Promise.resolve();
		expect(listener).not.toHaveBeenCalled();
		expect(service.getSummary(TASK_ID)?.turnOwner).toBe("user");
		expect(service.getSummary(TASK_ID)?.agentConversationPromptSubmissionAcceptance?.status).not.toBe("accepted");
	});
});
