import { describe, expect, it, vi } from "vitest";
import {
	NativeIndependentUserTurnDeliveryError,
	NativeIndependentUserTurnMessageAlreadyAccepted,
} from "../../../src/rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import {
	type SendTaskChatMessageAcrossSessionTransportsDependencies,
	sendTaskChatMessageAcrossSessionTransports,
} from "../../../src/trpc/task-chat-message-send-across-session-transports";

function createValidationOnlyTransportDependencies(validationError: Error) {
	const submitTaskChatInputWhenReady = vi.fn();
	const dependencies = {
		getScopedTerminalManager: async () => ({ submitTaskChatInputWhenReady, getSummary: () => null }),
		getScopedAcpTaskSessionService: async () => ({ getSummary: () => null }),
		getScopedClineTaskSessionService: async () => ({
			sendTaskSessionInput: async () => null,
			rebindPersistedTaskSession: async () => null,
		}),
		loadScopedRuntimeConfig: async () => ({}),
		resolveClineTaskSessionLaunchConfig: vi.fn(),
		validateBeforeTerminalWrite: async () => {
			throw validationError;
		},
	} as unknown as SendTaskChatMessageAcrossSessionTransportsDependencies;
	return { dependencies, submitTaskChatInputWhenReady };
}

describe("独立原生回合二次校验的真实回执", () => {
	it.each([
		"native_independent_user_turn_capability_unavailable",
		"native_independent_user_turn_session_replaced",
	] as const)("%s 不得被改写为取消，诊断正文随回执保留", async (reason) => {
		const failureNote = "二次原生查询未完成：thread/turns/list";
		const subject = createValidationOnlyTransportDependencies(
			new NativeIndependentUserTurnDeliveryError(reason, failureNote),
		);
		const response = await sendTaskChatMessageAcrossSessionTransports(
			subject.dependencies,
			{ workspaceId: "isolated-validation", workspacePath: "/isolated" },
			{ taskId: "isolated-task", text: "独立回合边界", source: "review-validate-fix" },
		);
		expect(response).toMatchObject({
			ok: false,
			error: failureNote,
			terminalDelivery: { status: "delivery_failed", reason, failureNote },
		});
		expect(subject.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
	});

	it("本条唯一后继消息已存在时确认原投递，不再进入 transport", async () => {
		const subject = createValidationOnlyTransportDependencies(
			new NativeIndependentUserTurnMessageAlreadyAccepted("精确正文已在唯一后继用户回合"),
		);
		const response = await sendTaskChatMessageAcrossSessionTransports(
			subject.dependencies,
			{ workspaceId: "isolated-validation", workspacePath: "/isolated" },
			{ taskId: "isolated-task", text: "独立回合边界", source: "review-validate-fix" },
		);
		expect(response).toMatchObject({
			ok: true,
			terminalDelivery: { status: "delivered_and_submit_confirmed", reason: null },
		});
		expect(subject.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
	});
});
