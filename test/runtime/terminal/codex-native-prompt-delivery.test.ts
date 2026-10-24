import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import {
	type CodexNativePromptDeliveryInput,
	deliverCodexNativePromptWithoutChangingComposer,
} from "../../../src/terminal/codex-native-prompt-delivery";

const mocks = vi.hoisted(() => ({ request: vi.fn(), connect: vi.fn() }));
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: mocks.connect,
}));

const CLIENT_MESSAGE_ID = "97fe98c3-7480-4689-884a-22c83a584f20";
const INCARNATION_ID = "e96aa879-02a4-480e-bbd6-97b7e5e83843";
const PROMPT = "程序化投递\n中文😀  \n";

function createInput(overrides: Partial<CodexNativePromptDeliveryInput> = {}): CodexNativePromptDeliveryInput {
	let clock = 0;
	return {
		summary: runtimeTaskSessionSummarySchema.parse({
			taskId: "conversation-1",
			agentId: "codex",
			workspacePath: "/workspace",
			pid: 123,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			state: "awaiting_review",
			reviewReason: "hook",
			exitCode: null,
			runtimeSessionIncarnationId: INCARNATION_ID,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "thread-1",
				transcriptPath: null,
				observedAt: 1,
			},
			codexNativeSessionControlEndpoint: {
				socketPath: "/isolated/control.sock",
				workspaceId: "workspace-1",
				conversationSessionId: "conversation-1",
				runtimeSessionIncarnationId: INCARNATION_ID,
			},
		}),
		workspaceId: "workspace-1",
		text: PROMPT,
		clientUserMessageId: CLIENT_MESSAGE_ID,
		isCurrent: () => true,
		beforeSubmit: vi.fn(async () => true),
		onRequestAttempted: vi.fn(),
		now: () => clock,
		waitMilliseconds: async (milliseconds) => {
			clock += milliseconds;
		},
		...overrides,
	};
}

function installNativeResponses(
	options: {
		submitThrowsAfterAcceptance?: boolean;
		neverAccepted?: boolean;
		echoClientMessageId?: boolean;
		nativeMessageContent?: { type: string; text?: string }[];
	} = {},
) {
	let attempted = false;
	mocks.request.mockImplementation(async (method: string) => {
		if (method === "thread/loaded/list") return { data: ["thread-1"], nextCursor: null };
		if (method === "thread/read") return { thread: { id: "thread-1", cwd: "/workspace" } };
		if (method === "thread/turns/list") {
			return {
				data:
					attempted && !options.neverAccepted
						? [
								{
									id: "native-turn-2",
									status: "inProgress",
									items: [
										{
											id: options.echoClientMessageId ? CLIENT_MESSAGE_ID : "native-user-2",
											type: "userMessage",
											content: options.nativeMessageContent ?? [{ type: "text", text: PROMPT }],
										},
									],
								},
							]
						: [{ id: "prior-turn", status: "completed", items: [] }],
				nextCursor: null,
			};
		}
		if (method === "turn/start") {
			attempted = true;
			if (options.submitThrowsAfterAcceptance) throw new Error("模拟写出请求后断线");
			return { turn: { id: "native-turn-2" } };
		}
		throw new Error(`不应调用 ${method}`);
	});
}

describe("Codex 原生投递保留 composer", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.connect.mockImplementation(async (operation) => operation({ request: mocks.request }));
		installNativeResponses();
	});

	it.each(["text", "input_text"])("提交独立原生消息并以实际 %s userMessage 确认", async (type) => {
		installNativeResponses({ nativeMessageContent: [{ type, text: PROMPT }] });
		const input = createInput();
		expect(await deliverCodexNativePromptWithoutChangingComposer(input)).toEqual({
			status: "confirmed",
			evidence: {
				clientUserMessageId: CLIENT_MESSAGE_ID,
				nativeSessionId: "thread-1",
				nativeTurnId: "native-turn-2",
				nativeUserMessageId: "native-user-2",
			},
		});
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toEqual([
			[
				"turn/start",
				{
					threadId: "thread-1",
					clientUserMessageId: CLIENT_MESSAGE_ID,
					input: [{ type: "text", text: PROMPT, text_elements: [] }],
				},
			],
		]);
		expect(input.onRequestAttempted).toHaveBeenCalledOnce();
	});

	it("text 与 input_text 分片拼接后精确匹配时确认且只提交一次", async () => {
		installNativeResponses({
			nativeMessageContent: [
				{ type: "text", text: "程序化投递\n" },
				{ type: "input_text", text: "中文😀  \n" },
			],
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("confirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it.each([
		{ name: "text 正文不匹配", content: [{ type: "text", text: `${PROMPT}其他内容` }] },
		{ name: "input_text 正文不匹配", content: [{ type: "input_text", text: `${PROMPT}其他内容` }] },
		{
			name: "混合文本包含额外正文",
			content: [
				{ type: "text", text: PROMPT },
				{ type: "input_text", text: "其他内容" },
			],
		},
		{
			name: "混合内容包含非文本部分",
			content: [{ type: "text", text: PROMPT }, { type: "image" }],
		},
		{
			name: "混合内容缺少文本正文",
			content: [{ type: "text", text: PROMPT }, { type: "input_text" }],
		},
	])("$name 时不误认成功，也不重发", async ({ content }) => {
		installNativeResponses({ nativeMessageContent: content });
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("unconfirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it.each(["text", "input_text"])("请求已写出后报错，但 %s 原生消息 ID 可精确关联时读回确认且不重发", async (type) => {
		installNativeResponses({
			submitThrowsAfterAcceptance: true,
			echoClientMessageId: true,
			nativeMessageContent: [{ type, text: PROMPT }],
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("confirmed");
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it.each(["text", "input_text"])(
		"响应丢失且 %s 原生消息没有回显客户端 ID 时，不能只凭同文冒领确认或重发",
		async (type) => {
			installNativeResponses({
				submitThrowsAfterAcceptance: true,
				nativeMessageContent: [{ type, text: PROMPT }],
			});
			expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("unconfirmed");
			expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
		},
	);

	it("只有 API 返回、没有原生用户消息时不报送达，也不重发", async () => {
		installNativeResponses({ neverAccepted: true });
		expect(await deliverCodexNativePromptWithoutChangingComposer(createInput())).toEqual({ status: "unconfirmed" });
		expect(mocks.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
	});

	it("先前相同正文的 userMessage 不能确认新投递", async () => {
		installNativeResponses({ neverAccepted: true });
		const original = mocks.request.getMockImplementation();
		mocks.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/turns/list")
				return {
					data: [
						{
							id: "prior-turn",
							status: "completed",
							items: [{ id: "old-message", type: "userMessage", content: [{ type: "text", text: PROMPT }] }],
						},
					],
					nextCursor: null,
				};
			return original?.(method, parameters);
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("unconfirmed");
	});

	it.each(["workspaceId", "conversationSessionId", "runtimeSessionIncarnationId"])(
		"端点 %s 不匹配时不连接",
		async (field) => {
			const input = createInput();
			Object.assign(input.summary.codexNativeSessionControlEndpoint ?? {}, { [field]: "another-session" });
			expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("unavailable");
			expect(mocks.connect).not.toHaveBeenCalled();
		},
	);

	it("原生回合仍在运行时让路，不将独立消息合并进旧回合", async () => {
		mocks.request.mockImplementation(async (method: string) => {
			if (method === "thread/loaded/list") return { data: ["thread-1"], nextCursor: null };
			if (method === "thread/read") return { thread: { id: "thread-1", cwd: "/workspace" } };
			return { data: [{ id: "prior-turn", status: "inProgress", items: [] }], nextCursor: null };
		});
		expect((await deliverCodexNativePromptWithoutChangingComposer(createInput())).status).toBe("not_ready");
		expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
	});

	it("读取期间换代或领域核验拒绝时不提交", async () => {
		const input = createInput({ beforeSubmit: vi.fn(async () => false) });
		expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("cancelled");
		expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
	});

	it("已加载会话分页受整体预检预算限制，不累加成无界等待", async () => {
		let clock = 0;
		let pageCount = 0;
		mocks.request.mockImplementation(async (method: string) => {
			expect(method).toBe("thread/loaded/list");
			clock += 4000;
			return { data: [], nextCursor: `page-${++pageCount}` };
		});
		const input = createInput({ now: () => clock });
		expect((await deliverCodexNativePromptWithoutChangingComposer(input)).status).toBe("unavailable");
		expect(pageCount).toBeLessThanOrEqual(4);
		expect(input.onRequestAttempted).not.toHaveBeenCalled();
	});
});
