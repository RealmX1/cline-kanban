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
				getScopedClineTaskSessionService: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(),
				resolveClineTaskSessionLaunchConfig: vi.fn(),
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
