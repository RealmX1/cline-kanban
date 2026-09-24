import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AcpClientConnectionRuntime,
	type AcpConnectionRuntimeHandlers,
} from "../../../src/acp-client-session/acp-client-connection-runtime";
import type { AcpClientHandlers, AcpSessionNotification } from "../../../src/acp-client-session/acp-protocol-boundary";

const connectionMocks = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: connectionMocks.spawn }));
vi.mock("../../../src/terminal/command-discovery", () => ({ isBinaryAvailableOnPath: () => true }));
vi.mock("../../../src/acp-client-session/acp-protocol-boundary", async (importOriginal) => ({
	...(await importOriginal()),
	connectKanbanAcpClient: connectionMocks.connect,
	createAcpNdJsonStreamOverChildProcessStdio: vi.fn(),
}));

function deferredResponse() {
	let resolve!: (value: object) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<object>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function prepareConnection() {
	const loadResponse = deferredResponse();
	const loadStarted = deferredResponse();
	const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
	const connection = {
		close: vi.fn(),
		agent: {
			request: vi.fn(async (method: string) => {
				if (method === "session/load") {
					loadStarted.resolve({});
					return loadResponse.promise;
				}
				if (method === "session/set_mode") throw new Error("plan mode rejected");
				return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			}),
		},
	};
	let handlers!: AcpClientHandlers;
	connectionMocks.spawn.mockReturnValueOnce(child);
	connectionMocks.connect.mockImplementationOnce((_stream: unknown, callbacks: AcpClientHandlers) => {
		handlers = callbacks;
		return connection;
	});
	return { loadResponse, loadStarted, child, connection, handlers: () => handlers };
}

function createRuntime() {
	const onSessionUpdate = vi.fn();
	const onPermissionRequest = vi.fn<AcpConnectionRuntimeHandlers["onPermissionRequest"]>(async () => ({
		outcome: { outcome: "cancelled" as const },
	}));
	const onElicitationRequest = vi.fn<AcpConnectionRuntimeHandlers["onElicitationRequest"]>(async () => ({
		action: "cancel" as const,
	}));
	const runtime = new AcpClientConnectionRuntime({
		onSessionUpdate,
		onPermissionRequest,
		onElicitationRequest,
		onConnectionClosed: vi.fn(),
	});
	return { runtime, onSessionUpdate, onPermissionRequest, onElicitationRequest };
}

const resumeInput = {
	agentId: "omp" as const,
	cwd: "/acp-test-workspace",
	permissionMode: "ask_for_every_tool_use" as const,
	resumePriorAgentConversationWithoutResendingPrompt: true,
	observedAgentNativeSessionId: "shared-native-session",
	isRuntimeSessionIncarnationCurrent: () => true,
};
const notification: AcpSessionNotification = {
	sessionId: resumeInput.observedAgentNativeSessionId,
	update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
};

beforeEach(() => vi.clearAllMocks());

describe("ACP 原生会话映射的连接所有权", () => {
	it("相同原生 ID 的重播各归本任务；旧 load 失败不移除新连接的映射", async () => {
		const { runtime, onSessionUpdate, onPermissionRequest, onElicitationRequest } = createRuntime();
		const older = prepareConnection();
		const olderStart = runtime.startTaskConnection({ ...resumeInput, taskId: "older-task" });
		const olderFailure = expect(olderStart).rejects.toThrow("load failed");
		await older.loadStarted.promise;
		const newer = prepareConnection();
		const newerStart = runtime.startTaskConnection({ ...resumeInput, taskId: "newer-task" });
		await newer.loadStarted.promise;
		newer.loadResponse.resolve({});
		await newerStart;
		older.handlers().handleSessionUpdate(notification);
		older.loadResponse.reject(new Error("load failed"));
		await olderFailure;
		expect(onSessionUpdate).toHaveBeenLastCalledWith("older-task", notification);
		newer.handlers().handleSessionUpdate(notification);
		expect(onSessionUpdate).toHaveBeenLastCalledWith("newer-task", notification);
		await newer.handlers().handlePermissionRequest({
			sessionId: notification.sessionId,
			options: [],
			toolCall: { toolCallId: "tool" },
		});
		expect(onPermissionRequest.mock.lastCall?.[0]).toBe("newer-task");
		await newer.handlers().handleElicitationRequest({
			sessionId: notification.sessionId,
			mode: "form",
			message: "批准计划",
			requestedSchema: { type: "object", properties: {} },
		});
		expect(onElicitationRequest.mock.lastCall?.[0]).toBe("newer-task");
	});

	it("load 成功后 plan mode 失败会撤销路由，迟到更新不会写回失败任务", async () => {
		const { runtime, onSessionUpdate } = createRuntime();
		const pending = prepareConnection();
		const startup = runtime.startTaskConnection({ ...resumeInput, taskId: "failed-task", startInPlanMode: true });
		const failure = expect(startup).rejects.toThrow("plan mode rejected");
		await pending.loadStarted.promise;
		pending.loadResponse.resolve({});
		await failure;
		pending.handlers().handleSessionUpdate(notification);
		expect(onSessionUpdate).not.toHaveBeenCalled();
		expect(runtime.getConnection("failed-task")).toBeNull();
		expect(pending.connection.close).toHaveBeenCalledOnce();
	});

	it("关闭共享原生 ID 的旧任务后，新任务仍能收到通知", async () => {
		const { runtime, onSessionUpdate } = createRuntime();
		const older = prepareConnection();
		const olderStart = runtime.startTaskConnection({ ...resumeInput, taskId: "older-task" });
		await older.loadStarted.promise;
		older.loadResponse.resolve({});
		const olderConnection = await olderStart;
		const newer = prepareConnection();
		const newerStart = runtime.startTaskConnection({ ...resumeInput, taskId: "newer-task" });
		await newer.loadStarted.promise;
		newer.loadResponse.resolve({});
		await newerStart;
		olderConnection.close();
		older.child.emit("exit", 0, null);
		newer.handlers().handleSessionUpdate(notification);
		expect(onSessionUpdate).toHaveBeenLastCalledWith("newer-task", notification);
	});

	it("启动取消与旧连接迟到关闭均不会移除同任务的新连接", async () => {
		const { runtime, onSessionUpdate } = createRuntime();
		let olderIncarnationCurrent = true;
		const older = prepareConnection();
		const olderStart = runtime.startTaskConnection({
			...resumeInput,
			taskId: "task",
			isRuntimeSessionIncarnationCurrent: () => olderIncarnationCurrent,
		});
		const olderFailure = expect(olderStart).rejects.toThrow("stopped or superseded");
		await older.loadStarted.promise;
		olderIncarnationCurrent = false;
		const newer = prepareConnection();
		const newerStart = runtime.startTaskConnection({ ...resumeInput, taskId: "task" });
		await newer.loadStarted.promise;
		newer.loadResponse.resolve({});
		const newerConnection = await newerStart;
		older.loadResponse.resolve({});
		await olderFailure;
		older.child.emit("exit", 0, null);
		older.handlers().handleSessionUpdate(notification);
		newer.handlers().handleSessionUpdate(notification);
		expect(onSessionUpdate).toHaveBeenCalledExactlyOnceWith("task", notification);
		expect(runtime.getConnection("task")).toBe(newerConnection);
	});
	it("旧连接的重复 close 和迟到 exit 不影响同任务重新登记的连接", async () => {
		const { runtime, onSessionUpdate } = createRuntime();
		const older = prepareConnection();
		const olderStart = runtime.startTaskConnection({ ...resumeInput, taskId: "task" });
		await older.loadStarted.promise;
		older.loadResponse.resolve({});
		const olderConnection = await olderStart;
		olderConnection.close();
		const newer = prepareConnection();
		const newerStart = runtime.startTaskConnection({ ...resumeInput, taskId: "task" });
		await newer.loadStarted.promise;
		newer.loadResponse.resolve({});
		const newerConnection = await newerStart;
		olderConnection.close();
		older.child.emit("exit", 0, null);
		newer.handlers().handleSessionUpdate(notification);
		expect(onSessionUpdate).toHaveBeenCalledExactlyOnceWith("task", notification);
		expect(runtime.getConnection("task")).toBe(newerConnection);
		expect(newer.connection.close).not.toHaveBeenCalled();
	});
});
