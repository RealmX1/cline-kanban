// 「连接还没建立时，卡片该归谁的回合」——startTaskSession 在 await startTaskConnection **之前**发出的
// 那一次开局 summary。钉死的是一次实测过的假象：续跑重开（通道切换后重开会话、不重投 prompt）也走乐观
// running，于是 session/load 重播的整段时间里卡片被推进 In Progress，重播结束才翻回 Review——一次没有
// 任何 agent 产出的假 running。
// 用 test double 顶掉连接运行时：本用例要的是「连接迟迟不返回」这个时间窗，与真实 agent 子进程无关。
import { describe, expect, it, vi } from "vitest";

const acpClientConnectionRuntimeTestDouble = vi.hoisted(() => ({
	startTaskConnection: vi.fn(),
	getConnection: vi.fn(() => null),
}));

vi.mock("../../../src/acp-client-session/acp-client-connection-runtime", () => ({
	AcpClientConnectionRuntime: class {
		startTaskConnection = acpClientConnectionRuntimeTestDouble.startTaskConnection;
		getConnection = acpClientConnectionRuntimeTestDouble.getConnection;
		disposeTaskConnection = () => {};
		disposeAllTaskConnections = () => {};
	},
}));

import {
	AcpTaskSessionService,
	type StartAcpTaskSessionRequest,
} from "../../../src/acp-client-session/acp-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const TASK_ID = "task-1";

function buildStartRequest(overrides: Partial<StartAcpTaskSessionRequest> = {}): StartAcpTaskSessionRequest {
	return {
		taskId: TASK_ID,
		agentId: "omp",
		cwd: "/workspace/task-1",
		prompt: "原始 prompt",
		permissionMode: "ask_for_every_tool_use",
		...overrides,
	};
}

// 连接建立故意悬着：开局那一次 emit 是同步发生在 await 之前的，于是「连接期间卡片长什么样」
// 就等于「startTaskSession 还没 await 出来时收到了哪些 summary」。
function createPendingTaskConnection() {
	let settleAsEstablished!: (connection: { pid: number | null; agentId: "omp" }) => void;
	let settleAsFailed!: (error: unknown) => void;
	const pendingConnection = new Promise<{ pid: number | null; agentId: "omp" }>((resolve, reject) => {
		settleAsEstablished = resolve;
		settleAsFailed = reject;
	});
	acpClientConnectionRuntimeTestDouble.startTaskConnection.mockReturnValue(pendingConnection);
	return { settleAsEstablished, settleAsFailed };
}

function startServiceWithSummaryRecorder(
	workspaceIdentity: { workspaceId: string; workspaceRepositoryPath: string } | null = null,
): {
	service: AcpTaskSessionService;
	emittedSummaries: RuntimeTaskSessionSummary[];
} {
	acpClientConnectionRuntimeTestDouble.startTaskConnection.mockReset();
	acpClientConnectionRuntimeTestDouble.getConnection.mockReset();
	acpClientConnectionRuntimeTestDouble.getConnection.mockReturnValue(null);
	const service = new AcpTaskSessionService(workspaceIdentity);
	const emittedSummaries: RuntimeTaskSessionSummary[] = [];
	service.onSummary((summary) => emittedSummaries.push(summary));
	return { service, emittedSummaries };
}

describe("AcpTaskSessionService.startTaskSession 开局回合归属", () => {
	it("协作 ACP 会话在连接前后均保留宿主归属", async () => {
		const { service, emittedSummaries } = startServiceWithSummaryRecorder({
			workspaceId: "workspace-1",
			workspaceRepositoryPath: "/workspace",
		});
		const { settleAsEstablished } = createPendingTaskConnection();
		const metadata = {
			workspaceTaskId: "owner-task",
			taskConversationSessionRole: "task_collaborator" as const,
			taskConversationSessionContextSource: "started_from_scratch" as const,
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: 1,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: "协作工作",
		};
		const started = service.startTaskSession(
			buildStartRequest({ workspaceTaskId: "owner-task", taskConversationSessionMetadata: metadata }),
		);
		expect(emittedSummaries[0]?.taskConversationSessionMetadata).toEqual(metadata);
		expect(acpClientConnectionRuntimeTestDouble.startTaskConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					KANBAN_TASK_ID: "owner-task",
					KANBAN_TASK_CONVERSATION_SESSION_ID: TASK_ID,
				}),
			}),
		);
		const connection = createIdentityTestConnection("collaboration-native-id");
		settleAsEstablished(connection);
		await started;
		expect(service.getSummary(TASK_ID)?.taskConversationSessionMetadata).toEqual(metadata);
		expect(connection.prompt).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("协作会话的责任边界"),
				}),
			]),
		);
	});

	it("续跑重开在连接建立前把回合留给用户，而不是假装 agent 在跑", async () => {
		const { service, emittedSummaries } = startServiceWithSummaryRecorder();
		const { settleAsEstablished } = createPendingTaskConnection();

		const startedSession = service.startTaskSession(
			buildStartRequest({ resumePriorAgentConversationWithoutResendingPrompt: true }),
		);

		// 连接还悬着的这一刻：卡片必须已经归用户，且成因是 "hook"（agent 只是把回合交回来了）。
		// 用 "attention" 会派生出 userTurnKind=needs_input，让后台程序化投递一直让位到超时。
		expect(emittedSummaries).toHaveLength(1);
		expect(emittedSummaries[0]).toMatchObject({
			state: "awaiting_review",
			turnOwner: "user",
			userTurnKind: "review",
			reviewReason: "hook",
			workspacePath: "/workspace/task-1",
		});
		// 没有新 prompt 被发出去 ⇒ 也不该凭空多一条用户消息。
		expect(service.listMessages(TASK_ID)).toHaveLength(0);

		settleAsEstablished({ pid: 4242, agentId: "omp" });
		await startedSession;

		expect(service.getSummary(TASK_ID)).toMatchObject({
			state: "awaiting_review",
			turnOwner: "user",
			userTurnKind: "review",
			reviewReason: "hook",
			pid: 4242,
		});
	});

	it("正常新会话仍保留开局的乐观 running（进程冷启动那几秒卡片要有反应）", async () => {
		const { service, emittedSummaries } = startServiceWithSummaryRecorder();
		const { settleAsEstablished } = createPendingTaskConnection();

		const startedSession = service.startTaskSession(buildStartRequest());

		expect(emittedSummaries).toHaveLength(1);
		expect(emittedSummaries[0]).toMatchObject({
			state: "running",
			turnOwner: "agent",
			reviewReason: null,
		});
		expect(service.listMessages(TASK_ID)).toHaveLength(1);

		settleAsEstablished({ pid: 4242, agentId: "omp" });
		await startedSession;
	});

	it("续跑重开连接起不来时落到 failed/error，而不是停在假的 awaiting_review", async () => {
		const { service } = startServiceWithSummaryRecorder();
		const { settleAsFailed } = createPendingTaskConnection();

		const startedSession = service.startTaskSession(
			buildStartRequest({ resumePriorAgentConversationWithoutResendingPrompt: true }),
		);
		settleAsFailed(new Error("omp was not found on PATH"));
		await startedSession;

		expect(service.getSummary(TASK_ID)).toMatchObject({
			state: "failed",
			turnOwner: "user",
			userTurnKind: "error",
			reviewReason: "error",
			warningMessage: "omp was not found on PATH",
		});
	});
});

describe("AcpTaskSessionService.startTaskSession taskConversationMode 盖章", () => {
	it("启动请求带 taskConversationMode ⇒ 开局那次 summary 就盖上章", async () => {
		const { service, emittedSummaries } = startServiceWithSummaryRecorder();
		const { settleAsEstablished } = createPendingTaskConnection();

		const startedSession = service.startTaskSession(buildStartRequest({ taskConversationMode: "exploratory" }));

		expect(emittedSummaries).toHaveLength(1);
		expect(emittedSummaries[0]?.taskConversationMode).toBe("exploratory");

		settleAsEstablished({ pid: 4242, agentId: "omp" });
		const summary = await startedSession;
		expect(summary.taskConversationMode).toBe("exploratory");
	});

	it("缺省不物化：不带 taskConversationMode 的启动不在 summary 上落这个字段", async () => {
		const { service, emittedSummaries } = startServiceWithSummaryRecorder();
		const { settleAsEstablished } = createPendingTaskConnection();

		const startedSession = service.startTaskSession(buildStartRequest());

		expect(emittedSummaries).toHaveLength(1);
		expect("taskConversationMode" in (emittedSummaries[0] ?? {})).toBe(false);

		settleAsEstablished({ pid: 4242, agentId: "omp" });
		const summary = await startedSession;
		expect("taskConversationMode" in summary).toBe(false);
	});
});

function createIdentityTestConnection(sessionId: string) {
	return {
		sessionId,
		pid: 4242,
		agentId: "omp" as const,
		prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
		close: vi.fn(),
	};
}
describe("ACP 原生身份恢复", () => {
	it("新提交报告原始用户正文，续跑重播不会触发提交监听", async () => {
		const { service } = startServiceWithSummaryRecorder();
		const listener = vi.fn();
		service.setUserPromptSubmittedListener(listener);
		const connection = createIdentityTestConnection("native-prompt-usage");
		acpClientConnectionRuntimeTestDouble.startTaskConnection.mockResolvedValue(connection);
		await service.startTaskSession(buildStartRequest({ prompt: "首次用户正文" }));
		expect(listener.mock.calls).toEqual([[TASK_ID, "首次用户正文"]]);
		acpClientConnectionRuntimeTestDouble.getConnection.mockReturnValueOnce(connection as never);
		await service.sendTaskSessionInput(TASK_ID, "后续用户正文");
		expect(listener.mock.calls).toEqual([
			[TASK_ID, "首次用户正文"],
			[TASK_ID, "后续用户正文"],
		]);
		await service.stopTaskSession(TASK_ID);
		await service.startTaskSession(buildStartRequest({ resumePriorAgentConversationWithoutResendingPrompt: true }));
		expect(listener).toHaveBeenCalledTimes(2);
	});
	it("保存协议 ID，下一次恢复按此 ID 且不重发 prompt", async () => {
		const { service } = startServiceWithSummaryRecorder();
		const first = createIdentityTestConnection("native-A");
		acpClientConnectionRuntimeTestDouble.startTaskConnection.mockResolvedValue(first);
		await service.startTaskSession(buildStartRequest({ prompt: "" }));
		expect(service.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe("native-A");
		await service.stopTaskSession(TASK_ID);
		await service.startTaskSession(
			buildStartRequest({ resumePriorAgentConversationWithoutResendingPrompt: true, startInPlanMode: true }),
		);
		expect(acpClientConnectionRuntimeTestDouble.startTaskConnection).toHaveBeenLastCalledWith(
			expect.objectContaining({ observedAgentNativeSessionId: "native-A", startInPlanMode: false }),
		);
		expect(first.prompt).not.toHaveBeenCalled();
	});

	it("已连接会话重复启动保持原 incarnation，不使原连接事件失效", async () => {
		const { service } = startServiceWithSummaryRecorder();
		const first = createIdentityTestConnection("native-active");
		acpClientConnectionRuntimeTestDouble.startTaskConnection.mockResolvedValue(first);
		const before = await service.startTaskSession(buildStartRequest({ prompt: "" }));
		const isCurrent =
			acpClientConnectionRuntimeTestDouble.startTaskConnection.mock.lastCall?.[0].isRuntimeSessionIncarnationCurrent;
		acpClientConnectionRuntimeTestDouble.getConnection.mockReturnValueOnce(first as never);
		const after = await service.startTaskSession(buildStartRequest({ prompt: "" }));
		expect(after.runtimeSessionIncarnationId).toBe(before.runtimeSessionIncarnationId);
		expect(isCurrent()).toBe(true);
	});
	it("停止后才完成的旧连接不能覆盖会话身份", async () => {
		const { service } = startServiceWithSummaryRecorder();
		const pending = createPendingTaskConnection();
		const start = service.startTaskSession(buildStartRequest({ prompt: "" }));
		const isCurrent =
			acpClientConnectionRuntimeTestDouble.startTaskConnection.mock.lastCall?.[0].isRuntimeSessionIncarnationCurrent;
		expect(isCurrent()).toBe(true);
		await service.stopTaskSession(TASK_ID);
		expect(isCurrent()).toBe(false);
		const late = createIdentityTestConnection("late-native");
		pending.settleAsEstablished(late);
		await start;
		expect(late.close).toHaveBeenCalledOnce();
		expect(service.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity).toBeUndefined();
	});
});
