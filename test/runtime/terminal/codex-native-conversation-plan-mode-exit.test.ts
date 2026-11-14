import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRequestPort } from "../../../src/codex-native-session-protocol/codex-native-conversation-history";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { exitCodexNativeConversationPlanMode } from "../../../src/terminal/codex-native-conversation-plan-mode-exit";

const mocks = vi.hoisted(() => ({ request: vi.fn<CodexAppServerRequestPort["request"]>(), connect: vi.fn() }));
vi.mock("../../../src/codex-native-session-protocol/codex-app-server-control-socket-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: mocks.connect,
}));

const incarnationId = "281fd234-c6df-4563-ae2b-c9b2e33541f1";
function createSummary() {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "conversation-1",
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
		codexNativeSessionControlEndpoint: {
			socketPath: "/isolated/control.sock",
			workspaceId: "workspace-1",
			conversationSessionId: "conversation-1",
			runtimeSessionIncarnationId: incarnationId,
		},
	});
}

let nativeMode: string | null;
let nativeStatus: string;
let nativeModel: string;
let nativeEffort: string | null;
const nativeThread = () => ({ id: "native-1", cwd: "/workspace", status: { type: nativeStatus } });
beforeEach(() => {
	nativeMode = "plan";
	nativeStatus = "idle";
	nativeModel = "original-model";
	nativeEffort = "high";
	mocks.connect
		.mockReset()
		.mockImplementation(async (operation: (port: CodexAppServerRequestPort) => Promise<unknown>) =>
			operation({ request: mocks.request }),
		);
	mocks.request.mockReset().mockImplementation(async (method, params) => {
		if (method === "thread/loaded/list") return { data: ["native-1"], nextCursor: null };
		if (method === "thread/read") return { thread: nativeThread() };
		if (method === "thread/resume")
			return {
				thread: nativeThread(),
				model: nativeModel,
				reasoningEffort: nativeEffort,
				collaborationMode: nativeMode === null ? null : { mode: nativeMode },
			};
		if (method === "thread/settings/update") {
			nativeMode = "default";
			expect(params).toEqual({
				threadId: "native-1",
				collaborationMode: {
					mode: "default",
					settings: { model: "original-model", reasoning_effort: nativeEffort, developer_instructions: null },
				},
			});
			return {};
		}
		throw new Error(`不应调用 ${method}`);
	});
});

function exitPlanMode(
	summary = createSummary(),
	getCurrentLiveSummary: () => RuntimeTaskSessionSummary | null = () => summary,
) {
	return exitCodexNativeConversationPlanMode({ workspaceId: "workspace-1", summary, getCurrentLiveSummary });
}
const updates = () => mocks.request.mock.calls.filter(([method]) => method === "thread/settings/update");

function getNativeRequestFixtureImplementation() {
	const implementation = mocks.request.getMockImplementation();
	assert(implementation, "缺少原生请求夹具");
	return implementation;
}

describe("通过原生端点退出 Codex 计划模式", () => {
	it.each(["high", null])("不依赖模式列表，保留模型与推理档 %s，只写模式并读回确认", async (effort) => {
		nativeEffort = effort;
		expect(await exitPlanMode()).toEqual({ status: "exited" });
		expect(updates()).toHaveLength(1);
		expect(mocks.connect).toHaveBeenCalledWith(expect.any(Function), {
			socketPath: "/isolated/control.sock",
			writerBinding: undefined,
		});
		expect(mocks.request.mock.calls.map(([method]) => method)).toEqual([
			"thread/loaded/list",
			"thread/read",
			"thread/resume",
			"thread/settings/update",
			"thread/resume",
		]);
		for (const [method, params] of mocks.request.mock.calls)
			if (method === "thread/resume") expect(params).toEqual({ threadId: "native-1", excludeTurns: true });
	});

	it("已是 Default 时幂等返回，不发送用户消息或写入", async () => {
		nativeMode = "default";
		expect(await exitPlanMode()).toEqual({ status: "already_default" });
		expect(updates()).toHaveLength(0);
	});

	it.each(["workspace", "conversation", "incarnation", "missing_endpoint", "native_agent", "stopped"])(
		"拒绝不匹配的 %s，不连接其他宿主",
		async (mismatch) => {
			const summary = createSummary();
			const endpoint = summary.codexNativeSessionControlEndpoint;
			const identity = summary.agentNativeConversationSessionIdentity;
			assert(endpoint && identity);
			if (mismatch === "workspace") endpoint.workspaceId = "other-workspace";
			if (mismatch === "conversation") endpoint.conversationSessionId = "other-session";
			if (mismatch === "incarnation") endpoint.runtimeSessionIncarnationId = "1146714b-d217-4252-a084-d63a980a0743";
			if (mismatch === "missing_endpoint") summary.codexNativeSessionControlEndpoint = null;
			if (mismatch === "native_agent") identity.sourceAgentId = "claude";
			expect((await exitPlanMode(summary, () => (mismatch === "stopped" ? null : summary))).status).toBe("rejected");
			expect(mocks.connect).not.toHaveBeenCalled();
		},
	);

	it("未加载的 thread 不通过 resume 意外启动", async () => {
		mocks.request.mockResolvedValue({ data: [], nextCursor: null });
		expect((await exitPlanMode()).status).toBe("rejected");
		expect(mocks.request).toHaveBeenCalledTimes(1);
	});

	it("分页查找已加载 thread，重复 cursor 有界终止", async () => {
		const original = getNativeRequestFixtureImplementation();
		mocks.request.mockImplementation(async (method, params) =>
			method === "thread/loaded/list" && params.cursor === null
				? { data: [], nextCursor: "next" }
				: original(method, params),
		);
		expect((await exitPlanMode()).status).toBe("exited");
		mocks.request.mockReset().mockResolvedValue({ data: [], nextCursor: "cycle" });
		expect((await exitPlanMode()).status).toBe("rejected");
		expect(mocks.request).toHaveBeenCalledTimes(2);
	});

	it.each(["id", "cwd"])("原生 %s 不匹配时不写入", async (field) => {
		const original = getNativeRequestFixtureImplementation();
		mocks.request.mockImplementation(async (method, params) =>
			method === "thread/read" ? { thread: { ...nativeThread(), [field]: "wrong" } } : original(method, params),
		);
		expect((await exitPlanMode()).status).toBe("rejected");
		expect(updates()).toHaveLength(0);
	});

	it.each(["agent", "question", "permission", "needs_input", "plan_review", "native_active"] as const)(
		"%s 仍在运行或待答时不隐式中断和作答",
		async (busy) => {
			const summary = createSummary();
			if (busy === "agent") {
				summary.turnOwner = "agent";
				summary.userTurnKind = null;
			} else if (busy === "native_active") nativeStatus = "active";
			else summary.userTurnKind = busy;
			expect((await exitPlanMode(summary)).status).toBe("rejected");
			expect(updates()).toHaveLength(0);
		},
	);

	it.each(["thread/loaded/list", "thread/read", "first_resume", "thread/settings/update", "confirmation_resume"])(
		"%s 返回后原生身份变化，不更新新会话或误报成功",
		async (phase) => {
			const summary = createSummary();
			let current = summary;
			let resumes = 0;
			const identity = summary.agentNativeConversationSessionIdentity;
			assert(identity);
			const original = getNativeRequestFixtureImplementation();
			mocks.request.mockImplementation(async (method, params) => {
				const response = await original(method, params);
				if (method === "thread/resume") resumes += 1;
				if (
					method === phase ||
					(phase === "first_resume" && method === "thread/resume" && resumes === 1) ||
					(phase === "confirmation_resume" && method === "thread/resume" && resumes === 2)
				)
					current = {
						...summary,
						agentNativeConversationSessionIdentity: {
							...identity,
							nativeSessionId: "rewound-native",
						},
					};
				return response;
			});
			const result = await exitPlanMode(summary, () => current);
			expect(result.status).toBe(
				phase === "thread/settings/update" || phase === "confirmation_resume" ? "unconfirmed" : "rejected",
			);
			expect(updates()).toHaveLength(phase === "thread/settings/update" || phase === "confirmation_resume" ? 1 : 0);
		},
	);

	it("连接失败时自动重连一次", async () => {
		mocks.connect.mockRejectedValueOnce(new Error("连接超时"));
		expect(await exitPlanMode()).toEqual({ status: "exited" });
		expect(mocks.connect).toHaveBeenCalledTimes(2);
		expect(updates()).toHaveLength(1);
	});

	it.each(["update_receipt", "readback"])("%s 丢失后只读补证，不重复写入", async (failure) => {
		const original = getNativeRequestFixtureImplementation();
		let failed = false;
		mocks.request.mockImplementation(async (method, params) => {
			const response = await original(method, params);
			if (
				!failed &&
				((failure === "update_receipt" && method === "thread/settings/update") ||
					(failure === "readback" && method === "thread/resume" && nativeMode === "default"))
			) {
				failed = true;
				throw new Error("已写入但回执丢失");
			}
			return response;
		});
		expect(await exitPlanMode()).toEqual({ status: "exited" });
		expect(mocks.connect).toHaveBeenCalledTimes(2);
		expect(updates()).toHaveLength(1);
	});

	it("写入结果无法证实仍报告未知，用户重试后幂等读回", async () => {
		const original = getNativeRequestFixtureImplementation();
		mocks.request.mockImplementation(async (method, params) => {
			if (method === "thread/settings/update") throw new Error("请求超时，是否生效未知");
			return original(method, params);
		});
		expect((await exitPlanMode()).status).toBe("unconfirmed");
		expect(updates()).toHaveLength(1);
		nativeMode = "default";
		expect(await exitPlanMode()).toEqual({ status: "already_default" });
		expect(updates()).toHaveLength(1);
	});

	it("旧原生服务缺少可确认的模式时明确拒绝，不猜测", async () => {
		nativeMode = null;
		expect((await exitPlanMode()).status).toBe("rejected");
		expect(updates()).toHaveLength(0);
	});

	it("确认期间模型发生变化不报告完整成功", async () => {
		const original = getNativeRequestFixtureImplementation();
		mocks.request.mockImplementation(async (method, params) => {
			const result = await original(method, params);
			if (method === "thread/settings/update") nativeModel = "externally-changed-model";
			return result;
		});
		expect((await exitPlanMode()).status).toBe("unconfirmed");
	});
});

import assert from "node:assert/strict";
