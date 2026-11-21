import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RuntimeAutomaticAgentFailureContinuation,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import { createAutomaticAgentFailureContinuationCoordinator } from "../../../src/terminal/automatic-agent-failure-continuation-coordinator";
import { deliverAutomaticAgentFailureContinuationNativePrompt } from "../../../src/terminal/automatic-agent-failure-continuation-native-delivery";
import type { deliverCodexNativePromptWithoutChangingComposer } from "../../../src/terminal/codex-native-prompt-delivery";

const isolatedState = vi.hoisted(() => ({ directory: "", readExecution: vi.fn(), readiness: vi.fn() }));
vi.mock("../../../src/state/runtime-home-path", () => ({ getRuntimeHomePath: () => isolatedState.directory }));
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => isolatedState.directory,
	getWorkspacesRootPath: () => join(isolatedState.directory, "workspaces"),
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedState.directory, "workspaces", workspaceId),
}));
vi.mock("../../../src/agent-session-history/codex-native-agent-turn-execution-reader", () => ({
	readCodexNativeAgentTurnExecution: isolatedState.readExecution,
}));
vi.mock("../../../src/terminal/codex-native-connection-retry-continuation-readiness", () => ({
	inspectCodexNativeConnectionRetryContinuationReadiness: isolatedState.readiness,
}));
const summary = runtimeTaskSessionSummarySchema.parse({
	taskId: "conversation",
	agentId: "codex",
	workspacePath: "/isolated",
	pid: 123,
	startedAt: 1,
	updatedAt: 1,
	lastOutputAt: null,
	exitCode: null,
	reviewReason: null,
	turnOwner: "agent",
	liveness: "live",
	userTurnKind: null,
	runtimeSessionIncarnationId: "e96aa879-02a4-480e-bbd6-97b7e5e83843",
	agentNativeConversationSessionIdentity: {
		sourceAgentId: "codex",
		nativeSessionId: "native",
		transcriptPath: null,
		observedAt: 1,
	},
	codexNativeSessionControlEndpoint: {
		socketPath: "/isolated/control.sock",
		workspaceId: "isolated",
		conversationSessionId: "conversation",
		runtimeSessionIncarnationId: "e96aa879-02a4-480e-bbd6-97b7e5e83843",
	},
});
async function episode(reason: "connection" | "model_capacity" = "model_capacity") {
	const coordinator = createAutomaticAgentFailureContinuationCoordinator({
		now: Date.now,
		publish: () => {},
		schedule: () => {},
		clearScheduled: () => {},
		canAttempt: () => true,
		submit: async () => ({ outcome: "deferred" }),
		target: () => ({
			workspaceId: "isolated",
			taskId: "card",
			conversationSessionId: "conversation",
			taskIncarnationCreatedAtEpochMs: 1,
			runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
			nativeSessionId: "native",
			nativeTranscriptPath: null,
			executionWorkingDirectoryPath: "/isolated",
			ownerProcessId: 123,
			agentId: "codex",
			faultTurnIdentity: "fault",
		}),
	});
	coordinator.observeFailure(reason, "failed-original");
	await coordinator.attempt(true);
	const record = coordinator.snapshot();
	if (!record) throw new Error("缺少故障记录");
	return record;
}
const evidence = {
	clientUserMessageId: "delivery",
	nativeSessionId: "native",
	nativeTurnId: "accepted-turn",
	nativeUserMessageId: "accepted-message",
};
async function deliver(
	record: RuntimeAutomaticAgentFailureContinuation,
	sender?: typeof deliverCodexNativePromptWithoutChangingComposer,
	currentSummary = summary,
) {
	return deliverAutomaticAgentFailureContinuationNativePrompt({
		record,
		summary: currentSummary,
		getCurrentSummary: () => currentSummary,
		beforeSubmit: async () => true,
		sender: sender ?? (async () => ({ status: "confirmed", evidence })),
	});
}
beforeEach(async () => {
	isolatedState.directory = await mkdtemp(join(tmpdir(), "automatic-failure-native-delivery-"));
	isolatedState.readExecution.mockReset();
	isolatedState.readiness.mockReset().mockResolvedValue({ outcome: "ready_for_terminal_write" });
});
afterEach(async () => {
	await rm(isolatedState.directory, { recursive: true, force: true });
});

describe("原生自动续跑入口", () => {
	it.each([null, "unexpected status 503 Service Unavailable"])(
		"已接受续跑的控制查询超时时按同回合转录结算：%s",
		async (message) => {
			const path = join(isolatedState.directory, "native.jsonl");
			const timestamp = new Date(Date.now() - 1_000).toISOString();
			const records = [
				{ type: "session_meta", payload: { id: "native", cwd: "/isolated", source: "vscode" } },
				{ type: "event_msg", timestamp, payload: { type: "task_started", turn_id: evidence.nativeTurnId } },
				{
					type: "event_msg",
					timestamp,
					payload: {
						type: "task_complete",
						turn_id: evidence.nativeTurnId,
						error: message ? { message } : null,
					},
				},
			];
			await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			isolatedState.readExecution.mockRejectedValue(new Error("控制查询超时"));
			const currentSummary = {
				...summary,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex" as const,
					nativeSessionId: "native",
					observedAt: 1,
					transcriptPath: path,
				},
			};
			const result = await deliver(await episode(), undefined, currentSummary);
			expect(result).toMatchObject({
				outcome: message ? "accepted_failed" : "accepted_finished",
				nativeTurnId: evidence.nativeTurnId,
			});
		},
	);

	it("实际调用前才记录新提示的发送边沿，readiness 和模态延期不能提前清除旧交棒", async () => {
		const record = await episode();
		const onSubmissionStarted = vi.fn();
		let modal = true;
		await deliverAutomaticAgentFailureContinuationNativePrompt({
			record,
			summary,
			getCurrentSummary: () => summary,
			beforeSubmit: async () => true,
			readSoftDeferral: () => (modal ? "waiting_for_user_decision" : null),
			onSubmissionStarted,
			sender: async (input) => {
				expect(await input.beforeSubmit()).toBe(false);
				expect(input.mayInvokeNativeTurnStartRequest?.()).toBe(false);
				expect(onSubmissionStarted).not.toHaveBeenCalled();
				modal = false;
				expect(await input.beforeSubmit()).toBe(true);
				expect(onSubmissionStarted).not.toHaveBeenCalled();
				expect(input.mayInvokeNativeTurnStartRequest?.()).toBe(true);
				expect(onSubmissionStarted).toHaveBeenCalledOnce();
				return { status: "unconfirmed" };
			},
		});
	});
	it.each(["idle", "systemError"])("%s 的未知 failed 只核对原因，不能沿用旧容量原因重发", async (threadStatus) => {
		isolatedState.readExecution.mockResolvedValue({
			nativeTurnId: "accepted-turn",
			nativeTurnStatus: "failed",
			executionStatus: "finished",
			threadStatus,
		});
		expect(await deliver(await episode())).toMatchObject({
			outcome: "unconfirmed",
			blockingReason: "waiting_for_failed_native_turn_reason",
		});
	});
	it.each(["idle", "systemError"])("%s 的鉴权、配额和上下文失败都撤销发送资格", async (threadStatus) => {
		for (const message of [
			"authentication failed",
			"insufficient_quota",
			"context window exceeded",
			"HTTP 503: Selected model is at capacity. Please try a different model. authentication failed",
			"overloaded_error: Selected model is at capacity. Please try a different model. insufficient_quota",
			"HTTP 503: Selected model is at capacity. Please try a different model. context window exceeded",
		]) {
			isolatedState.readExecution.mockResolvedValue({
				nativeTurnId: "accepted-turn",
				nativeTurnStatus: "failed",
				executionStatus: "finished",
				threadStatus,
				nativeTurnErrorMessage: message,
			});
			expect(await deliver(await episode())).toMatchObject({
				outcome: "accepted_terminal_failure",
				blockingReason: "non_retryable_native_turn_failure",
			});
		}
	});
	it.each(["idle", "systemError"])("%s 的可信容量与连接原因允许按对应策略重试", async (threadStatus) => {
		for (const [message, retryableFailureReason] of [
			["Selected model is at capacity. Please try a different model.", "model_capacity"],
			["stream disconnected: connection reset", "connection"],
			["HTTP 503: service unavailable", "connection"],
			["overloaded_error", "connection"],
		]) {
			isolatedState.readExecution.mockResolvedValue({
				nativeTurnId: "accepted-turn",
				nativeTurnStatus: "failed",
				executionStatus: "finished",
				threadStatus,
				nativeTurnErrorMessage: message,
			});
			expect(await deliver(await episode())).toMatchObject({ outcome: "accepted_failed", retryableFailureReason });
		}
	});
	it.each(["idle", "systemError"])("%s 的明确容量原因优先于 HTTP 503 或过载包装", async (threadStatus) => {
		for (const errorPrefix of ["HTTP 503", "overloaded_error"]) {
			const record = await episode();
			record.activeDeliveryObservedFailure = { reason: "model_capacity", nativeTurnId: "accepted-turn" };
			isolatedState.readExecution.mockResolvedValue({
				nativeTurnId: "accepted-turn",
				nativeTurnStatus: "failed",
				executionStatus: "finished",
				threadStatus,
				nativeTurnErrorMessage: `${errorPrefix}: Selected model is at capacity. Please try a different model.`,
			});
			expect(await deliver(record)).toMatchObject({
				outcome: "accepted_failed",
				retryableFailureReason: "model_capacity",
			});
		}
	});
	it("只接受绑定于已接受回合的新故障证据，旧回合或未知显式错误不能借用检测证据", async () => {
		const record = await episode("connection");
		record.activeDeliveryObservedFailure = { reason: "connection", nativeTurnId: "accepted-turn" };
		isolatedState.readExecution.mockResolvedValue({
			nativeTurnId: "accepted-turn",
			nativeTurnStatus: "failed",
			executionStatus: "finished",
			threadStatus: "systemError",
		});
		expect(await deliver(record)).toMatchObject({ outcome: "accepted_failed", retryableFailureReason: "connection" });
		record.activeDeliveryObservedFailure.nativeTurnId = "older-turn";
		expect((await deliver(record)).outcome).toBe("unconfirmed");
		record.activeDeliveryObservedFailure.nativeTurnId = "accepted-turn";
		isolatedState.readExecution.mockResolvedValue({
			nativeTurnId: "accepted-turn",
			nativeTurnStatus: "failed",
			executionStatus: "finished",
			threadStatus: "systemError",
			nativeTurnErrorMessage: "unknown fatal error",
		});
		expect((await deliver(record)).outcome).toBe("accepted_terminal_failure");
	});
	it("执行期 Stop 遇到原生 failed 不会冒充成功，completed 才允许补交棒", async () => {
		const record = await episode();
		record.pendingCompletionReview = {
			reason: "hook",
			observedAtMs: Date.now(),
			activeDeliveryId: record.activeDeliveryId,
		};
		isolatedState.readExecution.mockResolvedValue({
			nativeTurnId: "accepted-turn",
			nativeTurnStatus: "failed",
			executionStatus: "finished",
			threadStatus: "systemError",
		});
		expect((await deliver(record)).outcome).toBe("unconfirmed");
		isolatedState.readExecution.mockResolvedValue({
			nativeTurnId: "accepted-turn",
			nativeTurnStatus: "completed",
			executionStatus: "finished",
			threadStatus: "idle",
		});
		expect((await deliver(record)).outcome).toBe("accepted_finished");
	});

	it("二次 readiness 缺口只延期，同一投递随后自动重验", async () => {
		const record = await episode();
		isolatedState.readiness
			.mockResolvedValueOnce({ outcome: "ready_for_terminal_write" })
			.mockResolvedValue({ outcome: "deferred_before_terminal_write" });
		const sender = vi.fn<typeof deliverCodexNativePromptWithoutChangingComposer>(async (input) =>
			(await input.beforeSubmit()) ? { status: "unconfirmed" } : { status: "cancelled" },
		);
		expect(await deliver(record, sender)).toMatchObject({ outcome: "deferred", requestWasInvoked: false });
		isolatedState.readiness.mockResolvedValue({ outcome: "ready_for_terminal_write" });
		expect((await deliver(record, sender)).outcome).toBe("unconfirmed");
		expect(sender).toHaveBeenCalledTimes(2);
	});
	it("二次 readiness 期间跨过截止显示到期，模态到达只延期", async () => {
		const record = await episode();
		let modal = false;
		const result = await deliverAutomaticAgentFailureContinuationNativePrompt({
			record,
			summary,
			getCurrentSummary: () => summary,
			beforeSubmit: async () => true,
			readSoftDeferral: () => (modal ? "waiting_for_user_decision" : null),
			sender: async (input) => {
				modal = true;
				expect(await input.beforeSubmit()).toBe(false);
				return { status: "cancelled" };
			},
		});
		expect(result).toMatchObject({ outcome: "deferred", blockingReason: "waiting_for_user_decision" });
		record.deadlineAtMs = Date.now() - 1;
		expect(await deliver(record)).toMatchObject({
			outcome: "deferred",
			blockingReason: "capacity_recovery_deadline_reached",
		});
	});
});
