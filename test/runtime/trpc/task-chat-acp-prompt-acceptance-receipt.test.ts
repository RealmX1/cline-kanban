import { describe, expect, it, vi } from "vitest";
import type { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { RuntimeTrpcWorkspaceScope } from "../../../src/trpc/app-router";
import { sendTaskChatMessageAcrossSessionTransports } from "../../../src/trpc/task-chat-message-send-across-session-transports";

const pendingSummary: RuntimeTaskSessionSummary = {
	taskId: "task-1",
	state: "awaiting_review",
	agentId: "omp",
	sessionTransport: "acp_stdio_subprocess",
	workspacePath: "/repo",
	pid: 42,
	startedAt: 100,
	updatedAt: 200,
	lastOutputAt: null,
	reviewReason: "hook",
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
	turnOwner: "user",
	liveness: "live",
	userTurnKind: "review",
	agentConversationPromptSubmissionAcceptance: {
		status: "pending",
		attemptedAtMs: 200,
		runtimeSessionIncarnationId: "incarnation",
	},
};

describe("ACP 统一发送出口使用真实接受回执", () => {
	it("非 ACP 会话拒绝图片，避免静默丢弃附件", async () => {
		const submitTaskChatInput = vi.fn();
		const loadScopedRuntimeConfig = vi.fn();
		const response = await sendTaskChatMessageAcrossSessionTransports(
			{
				getScopedAcpTaskSessionService: async () => ({ getSummary: () => null }) as never,
				getScopedTerminalManager: async () =>
					({
						getSummary: () => ({ ...pendingSummary, agentId: "codex", sessionTransport: "pty_terminal" }),
						submitTaskChatInput,
					}) as never,
				loadScopedRuntimeConfig,
			},
			{ workspaceId: "workspace" } as RuntimeTrpcWorkspaceScope,
			{
				taskId: "task-1",
				text: "含附件的输入",
				images: [{ id: "image-1", name: "image.png", mimeType: "image/png", data: "AA==" }],
			},
		);
		expect(response.ok).toBe(false);
		expect(response.error).toContain("ACP");
		expect(submitTaskChatInput).not.toHaveBeenCalled();
		expect(loadScopedRuntimeConfig).not.toHaveBeenCalled();
	});
	it("提交前忙碌拒绝与回执超时分别提供证据，不用失败状态猜测未提交", async () => {
		const summary = {
			...pendingSummary,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "omp",
				nativeSessionId: "native-session",
				observedAt: 1,
			},
		} as RuntimeTaskSessionSummary;
		const service = {
			getSummary: () => summary,
			sendTaskSessionInput: vi.fn(async (...args: Parameters<AcpTaskSessionService["sendTaskSessionInput"]>) => {
				args[5]?.("request_busy");
				throw new Error("当前 ACP 请求正在处理");
			}),
		} as unknown as AcpTaskSessionService;
		const outcome = vi.fn();
		const response = await sendTaskChatMessageAcrossSessionTransports(
			{
				getScopedAcpTaskSessionService: async () => service,
				getScopedTerminalManager: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(),
				programmaticTerminalDeliveryReceiptPersistenceOwner: "queued_task_prompt_delivery_store",
				programmaticSubmissionAttemptId: "write-attempt",
				onProgrammaticTerminalDeliverySettled: outcome,
			},
			{ workspaceId: "workspace" } as RuntimeTrpcWorkspaceScope,
			{ taskId: "task-1", text: "结果", idempotencyKey: "stable-result-id" },
		);
		expect(response.terminalDelivery?.nativePromptSubmissionNotStartedEvidence).toEqual({
			source: "acp_input_rejected_before_prompt_registration",
			clientUserMessageId: "stable-result-id",
			submissionAttemptId: "write-attempt",
			nativeSessionId: "native-session",
			reason: "request_busy",
		});
		expect(outcome).toHaveBeenCalledTimes(1);
	});
	it.each([true, false])("返回 pending 后，仅由协议核验结算结果 accepted=%s", async (accepted) => {
		let settleAcceptance: ((accepted: boolean) => void) | undefined;
		const service = {
			getSummary: () => pendingSummary,
			listMessages: () => [],
			sendTaskSessionInput: vi.fn(
				async (_taskId: string, _text: string, _images: unknown, onSettled?: (accepted: boolean) => void) => {
					settleAcceptance = onSettled;
					return pendingSummary;
				},
			),
		} as unknown as AcpTaskSessionService;
		const outcome = vi.fn();
		const response = await sendTaskChatMessageAcrossSessionTransports(
			{
				getScopedAcpTaskSessionService: async () => service,
				getScopedTerminalManager: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(),
				onProgrammaticTerminalDeliverySettled: outcome,
			},
			{ workspaceId: "workspace" } as RuntimeTrpcWorkspaceScope,
			{ taskId: "task-1", text: "新输入" },
		);
		expect(response).toMatchObject({
			ok: true,
			terminalDelivery: { status: "accepted_pending_submit_confirmation" },
		});
		expect(outcome).not.toHaveBeenCalled();
		expect(settleAcceptance).toBeDefined();
		settleAcceptance?.(accepted);
		expect(outcome).toHaveBeenCalledExactlyOnceWith(
			accepted
				? { status: "delivered_and_submit_confirmed", reason: null }
				: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
		);
	});
});
