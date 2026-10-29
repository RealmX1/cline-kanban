import { describe, expect, it, vi } from "vitest";
import type { RuntimeAutomaticAgentFailureContinuation } from "../../../src/core/api-contract";
import { describeAutomaticAgentFailureContinuation } from "../../../src/core/session-activity";
import {
	ACCEPTED_EXECUTION_INTERRUPTED_BY_NEW_FAILURE,
	type AutomaticFailureContinuationAttemptResult,
	claudeAutomaticFailureContinuationMayStartWrite,
	createAutomaticAgentFailureContinuationCoordinator,
	hasCompletionReviewForSubmittedAutomaticFailureContinuation,
} from "../../../src/terminal/automatic-agent-failure-continuation-coordinator";

function setup(options?: { canAttempt?: () => boolean; softDeferralReason?: () => string | null }) {
	let now = 1_000;
	const publish = vi.fn();
	const submit = vi.fn(
		async (
			_record: RuntimeAutomaticAgentFailureContinuation,
		): Promise<AutomaticFailureContinuationAttemptResult> => ({ outcome: "unconfirmed" }),
	);
	const coordinator = createAutomaticAgentFailureContinuationCoordinator({
		now: () => now,
		publish,
		schedule: vi.fn(),
		clearScheduled: vi.fn(),
		target: () => ({
			agentId: "codex",
			nativeTranscriptPath: "/isolated/native.jsonl",
			executionWorkingDirectoryPath: "/isolated",
			ownerProcessId: 123,
			workspaceId: "workspace",
			taskId: "task",
			taskIncarnationCreatedAtEpochMs: 10,
			conversationSessionId: "task",
			nativeSessionId: "native",
			runtimeSessionIncarnationId: "process",
			faultTurnIdentity: "turn",
		}),
		canAttempt: options?.canAttempt ?? (() => true),
		softDeferralReason: options?.softDeferralReason,
		submit,
	});
	return {
		coordinator,
		publish,
		submit,
		setNow: (value: number) => {
			now = value;
		},
	};
}
describe("共用故障恢复协调器", () => {
	it("旧 Codex 记录缺提交边沿时，实际调用证据仍能绑定接受补证前的当前 Stop", async () => {
		const h = setup();
		h.coordinator.observeFailure("connection");
		h.submit.mockResolvedValue({ outcome: "deferred" });
		await h.coordinator.attempt(true);
		const deliveryId = h.coordinator.snapshot()?.activeDeliveryId;
		if (!deliveryId) throw new Error("缺少投递引用");
		h.setNow(2_000);
		h.coordinator.recordNativeRequestInvoked(deliveryId, "connection");
		h.coordinator.requestCompletionReview("hook", 2_001);
		const saved = h.coordinator.snapshot();
		if (!saved) throw new Error("缺少旧格式恢复记录");
		expect(saved.activeDeliverySubmissionStartedAtMs).toBeUndefined();
		expect(hasCompletionReviewForSubmittedAutomaticFailureContinuation(saved)).toBe(true);
		const restarted = setup();
		restarted.coordinator.restore(saved);
		restarted.coordinator.observeProgress(2_002);
		expect(restarted.coordinator.snapshot()?.phase).not.toBe("recovered");
		restarted.submit.mockResolvedValue({ outcome: "accepted_finished", nativeTurnId: "retry-turn" });
		await restarted.coordinator.attempt(true);
		expect(restarted.coordinator.snapshot()).toMatchObject({
			phase: "recovered",
			pendingCompletionReview: saved.pendingCompletionReview,
		});
	});
	it("发送边沿清除旧回合 Stop，当前 Stop 保留到原生 completed 且不被工具活动冒充完工", async () => {
		const h = setup();
		h.coordinator.observeFailure("connection");
		h.coordinator.requestCompletionReview("hook", 1_000);
		h.submit.mockResolvedValue({ outcome: "deferred" });
		await h.coordinator.attempt(true);
		const deliveryId = h.coordinator.snapshot()?.activeDeliveryId;
		if (!deliveryId) throw new Error("未登记投递");
		h.setNow(2_000);
		h.coordinator.requestCompletionReview("hook", 2_000);
		expect(h.coordinator.snapshot()?.pendingCompletionReview?.activeDeliveryId).toBeNull();
		h.setNow(3_000);
		h.coordinator.markActiveDeliverySubmissionStarted(deliveryId);
		expect(h.coordinator.snapshot()?.pendingCompletionReview).toBeUndefined();
		h.coordinator.recordNativeRequestInvoked(deliveryId, "connection");
		h.coordinator.recordNativeAcceptanceConfirmed(deliveryId);
		h.coordinator.requestCompletionReview("hook", 3_001);
		const pendingReview = h.coordinator.snapshot()?.pendingCompletionReview;
		h.coordinator.markActiveDeliverySubmissionStarted(deliveryId);
		h.coordinator.requestCompletionReview("hook", 2_000);
		expect(h.coordinator.snapshot()?.pendingCompletionReview).toEqual(pendingReview);
		h.coordinator.observeProgress(3_002);
		expect(h.coordinator.snapshot()?.phase).not.toBe("recovered");
		h.submit.mockResolvedValue({ outcome: "accepted_finished", nativeTurnId: "retry-turn" });
		await h.coordinator.attempt(true);
		const completed = h.coordinator.snapshot();
		if (!completed) throw new Error("缺少恢复记录");
		expect(completed).toMatchObject({
			phase: "recovered",
			blockingReason: "native_turn_completed",
			pendingCompletionReview: pendingReview,
		});
		expect(hasCompletionReviewForSubmittedAutomaticFailureContinuation(completed)).toBe(true);
	});
	it.each(["connection", "model_capacity"] as const)("%s 的机器等待文案说明当前缺口及已有接受事实", (reason) => {
		const h = setup();
		h.coordinator.observeFailure(reason);
		const saved = h.coordinator.snapshot();
		if (!saved) throw new Error("缺少恢复记录");
		expect(
			describeAutomaticAgentFailureContinuation({
				...saved,
				phase: "waiting_machine_evidence",
				blockingReason: "waiting_for_user_decision",
			}),
		).toContain("等待用户回答问题、确认计划或权限");
		expect(
			describeAutomaticAgentFailureContinuation({
				...saved,
				phase: "reconciling_acceptance",
				activeDeliveryWasAccepted: true,
				blockingReason: "waiting_for_failed_native_turn_reason",
			}),
		).toContain("已确认接受，等待本次失败原因补证");
	});
	it("已确证执行但尚无有效产出时再失败，立即回等待并核对原投递", async () => {
		const h = setup();
		h.submit.mockResolvedValue({ outcome: "accepted_running", nativeTurnId: "retry-turn" });
		h.coordinator.observeFailure("model_capacity");
		await h.coordinator.attempt(true);
		const before = h.coordinator.snapshot();
		h.setNow(2_000);
		h.coordinator.observeFailure("model_capacity", "retry-turn");
		expect(h.coordinator.snapshot()).toMatchObject({
			phase: "reconciling_acceptance",
			blockingReason: ACCEPTED_EXECUTION_INTERRUPTED_BY_NEW_FAILURE,
			nextCheckAtMs: 2_000,
			deadlineAtMs: before?.deadlineAtMs,
			episodeId: before?.episodeId,
			activeDeliveryId: before?.activeDeliveryId,
		});
		h.submit.mockResolvedValue({ outcome: "accepted_failed", nativeTurnId: "retry-turn" });
		await h.coordinator.attempt();
		expect(h.coordinator.snapshot()).toMatchObject({
			phase: "waiting_backoff",
			nextCheckAtMs: 62_000,
			deadlineAtMs: before?.deadlineAtMs,
			attemptCount: 1,
			acceptedCount: 1,
		});
	});
	it("持久账本回调独立记录发送与接受，迟到接受不能复活已取消的资格", async () => {
		const h = setup();
		h.submit.mockResolvedValue({ outcome: "deferred" });
		h.coordinator.observeFailure("model_capacity");
		await h.coordinator.attempt(true);
		const id = h.coordinator.snapshot()?.activeDeliveryId;
		if (!id) throw new Error("未登记投递");
		h.coordinator.recordNativeRequestInvoked(id, "model_capacity");
		expect(h.coordinator.snapshot()).toMatchObject({ attemptCount: 1, acceptedCount: 0 });
		h.coordinator.cancel("user_stopped");
		h.coordinator.recordNativeAcceptanceConfirmed(id);
		h.coordinator.recordNativeAcceptanceConfirmed(id);
		expect(h.coordinator.snapshot()).toMatchObject({ phase: "cancelled", acceptedCount: 1, nextCheckAtMs: null });
	});
	it("运行时关停冻结在途核验，保留持久资格供新运行时接续", async () => {
		const h = setup();
		let finish: (result: AutomaticFailureContinuationAttemptResult) => void = () => {};
		h.submit.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.coordinator.observeFailure("connection");
		const pending = h.coordinator.attempt(true);
		const saved = h.coordinator.snapshot();
		h.coordinator.suspendForRuntimeShutdown();
		finish({ outcome: "invalidated" });
		await pending;
		expect(h.coordinator.snapshot()).toEqual(saved);
		await h.coordinator.attempt(true);
		expect(h.submit).toHaveBeenCalledOnce();
	});
	it("网络等待中首次发生容量故障，从这次容量故障起算 30 分钟", () => {
		const h = setup();
		h.coordinator.observeFailure("connection");
		h.setNow(100_000);
		h.coordinator.observeFailure("model_capacity");
		expect(h.coordinator.snapshot()).toMatchObject({ firstCapacityErrorAtMs: 100_000, deadlineAtMs: 1_900_000 });
		h.setNow(200_000);
		h.coordinator.observeFailure("model_capacity");
		expect(h.coordinator.snapshot()?.deadlineAtMs).toBe(1_900_000);
	});
	it.each([
		["model_capacity", [30_000, 60_000, 120_000, 240_000, 480_000, 480_000]],
		["connection", [4_000, 15_000, 60_000, 240_000, 480_000, 480_000]],
	] as const)("%s 使用独立退避，立即再失败不续期", async (reason, intervals) => {
		const h = setup();
		h.submit.mockResolvedValue({ outcome: "accepted_failed" });
		h.coordinator.observeFailure(reason);
		const episode = h.coordinator.snapshot();
		let previous = 1_000;
		for (const interval of intervals) {
			const next = h.coordinator.snapshot()?.nextCheckAtMs;
			expect(next).toBe(previous + interval);
			if (next == null) throw new Error("缺少下次检查时间");
			h.setNow(next);
			await h.coordinator.attempt();
			expect(h.coordinator.snapshot()?.episodeId).toBe(episode?.episodeId);
			expect(h.coordinator.snapshot()?.deadlineAtMs).toBe(episode?.deadlineAtMs);
			previous = next;
		}
	});
	it("接受但未证明执行仍在核对，不能因原生受理进入执行态", async () => {
		const h = setup();
		h.submit.mockResolvedValue({ outcome: "unconfirmed", nativeAcceptanceConfirmed: true });
		h.coordinator.observeFailure("model_capacity");
		await h.coordinator.attempt(true);
		expect(h.coordinator.snapshot()).toMatchObject({ phase: "reconciling_acceptance", acceptedCount: 1 });
	});
	it("未知请求在截止时到期，重启或立即核对不清掉原投递引用", async () => {
		const h = setup();
		h.coordinator.observeFailure("model_capacity");
		await h.coordinator.attempt(true);
		const deliveryId = h.coordinator.snapshot()?.activeDeliveryId;
		h.setNow(1_800_999);
		await h.coordinator.attempt(true);
		expect(h.coordinator.snapshot()?.nextCheckAtMs).toBe(1_801_000);
		h.setNow(1_801_000);
		await h.coordinator.attempt();
		expect(h.coordinator.snapshot()).toMatchObject({ phase: "expired", activeDeliveryId: deliveryId });
		expect(h.submit).toHaveBeenCalledTimes(2);
		await h.coordinator.attempt(true);
		expect(h.submit.mock.calls.at(-1)?.[0].activeDeliveryId).toBe(deliveryId);
	});
	it("发送前意图在重建后仍是核对状态，不能当成未发送", async () => {
		const h = setup();
		h.submit.mockResolvedValue({ outcome: "deferred" });
		h.coordinator.observeFailure("connection");
		await h.coordinator.attempt(true);
		const deliveryId = h.coordinator.snapshot()?.activeDeliveryId;
		if (!deliveryId) throw new Error("缺少投递标识");
		h.coordinator.markTerminalRequestMayHaveBeenSent(deliveryId);
		const restored = setup();
		const saved = h.coordinator.snapshot();
		if (!saved) throw new Error("缺少测试记录");
		restored.coordinator.restore(saved);
		await restored.coordinator.attempt(true);
		expect(restored.submit.mock.calls[0]?.[0]).toMatchObject({
			phase: "reconciling_acceptance",
			activeDeliveryId: deliveryId,
			activeDeliveryRequestMayHaveBeenSent: true,
			attemptCount: 0,
		});
	});
	it("查询或存储失败会发布有界退避，不复用已经过期的检查时间", async () => {
		const h = setup();
		h.submit.mockRejectedValue(new Error("临时读取失败"));
		h.coordinator.observeFailure("connection");
		h.setNow(5_000);
		await h.coordinator.attempt();
		expect(h.coordinator.snapshot()).toMatchObject({
			phase: "waiting_machine_evidence",
			lastCheckAtMs: 5_000,
			nextCheckAtMs: 10_000,
		});
		h.setNow(10_000);
		await h.coordinator.attempt();
		expect(h.coordinator.snapshot()?.nextCheckAtMs).toBe(25_000);
	});
	it("容量退避从首次错误起算，到期停止新发送", async () => {
		const h = setup();
		h.coordinator.observeFailure("model_capacity");
		expect(h.coordinator.snapshot()).toMatchObject({
			nextCheckAtMs: 31_000,
			deadlineAtMs: 1_801_000,
			attemptCount: 0,
		});
		h.setNow(1_801_000);
		await h.coordinator.attempt();
		expect(h.submit).not.toHaveBeenCalled();
		expect(h.coordinator.snapshot()?.phase).toBe("expired");
	});
	it("未知发送结果只核对同一投递，不因没有新错误宣告恢复", async () => {
		const h = setup();
		h.coordinator.observeFailure("model_capacity");
		h.setNow(31_000);
		await h.coordinator.attempt();
		const deliveryId = h.coordinator.snapshot()?.activeDeliveryId;
		h.setNow(100_000);
		await h.coordinator.attempt(true);
		expect(h.submit).toHaveBeenCalledTimes(2);
		expect(h.coordinator.snapshot()).toMatchObject({
			phase: "reconciling_acceptance",
			activeDeliveryId: deliveryId,
			attemptCount: 1,
		});
	});
	it("取消后旧错误重绘不能复活；明确重试才重新开启", async () => {
		const h = setup();
		h.coordinator.observeFailure("model_capacity");
		h.coordinator.cancel("user_stopped");
		h.coordinator.observeFailure("model_capacity");
		expect(h.coordinator.snapshot()?.phase).toBe("cancelled");
		await h.coordinator.attempt(true);
		expect(h.coordinator.snapshot()?.phase).not.toBe("cancelled");
	});
	it("接受后立即失败保留原 episode 与截止", async () => {
		const h = setup();
		h.submit.mockResolvedValue({ outcome: "accepted_failed" });
		h.coordinator.observeFailure("model_capacity");
		h.setNow(31_000);
		await h.coordinator.attempt();
		expect(h.coordinator.snapshot()).toMatchObject({
			deadlineAtMs: 1_801_000,
			acceptedCount: 1,
			attemptCount: 1,
			nextCheckAtMs: 91_000,
			phase: "waiting_backoff",
		});
	});
	it("等待延期发布真实下次检查时间，单飞且迟到结果不能复活取消", async () => {
		const h = setup();
		let finish: (value: { outcome: "accepted_running" }) => void = () => {};
		h.submit.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.coordinator.observeFailure("connection");
		h.setNow(5_000);
		const pending = h.coordinator.attempt();
		await h.coordinator.attempt(true);
		expect(h.submit).toHaveBeenCalledOnce();
		h.coordinator.cancel("user_stopped");
		finish({ outcome: "accepted_running" });
		await pending;
		expect(h.coordinator.snapshot()?.phase).toBe("cancelled");
	});
	it("重建后保留原发送引用与截止，先核对再调度", async () => {
		const h = setup();
		h.coordinator.observeFailure("model_capacity");
		h.setNow(31_000);
		await h.coordinator.attempt();
		const saved = h.coordinator.snapshot();
		const restored = setup();
		if (!saved) throw new Error("缺少恢复快照");
		restored.coordinator.restore(saved);
		await restored.coordinator.attempt(true);
		expect(restored.submit.mock.calls[0]?.[0]).toMatchObject({
			activeDeliveryId: saved?.activeDeliveryId,
			deadlineAtMs: saved?.deadlineAtMs,
		});
	});
	it("模态只推迟这一次发送，不取消 episode，也不重置截止", async () => {
		const h = setup({
			canAttempt: () => true,
			softDeferralReason: () => "waiting_for_user_decision",
		});
		h.coordinator.observeFailure("model_capacity");
		const before = h.coordinator.snapshot();
		h.setNow(31_000);
		await h.coordinator.attempt();
		expect(h.submit).not.toHaveBeenCalled();
		expect(h.coordinator.snapshot()).toMatchObject({
			phase: "waiting_machine_evidence",
			blockingReason: "waiting_for_user_decision",
			episodeId: before?.episodeId,
			deadlineAtMs: before?.deadlineAtMs,
		});
	});
	it("搁置或停止仍然取消，旧故障不能靠重绘复活", async () => {
		const h = setup({ canAttempt: () => false, softDeferralReason: () => null });
		h.coordinator.observeFailure("connection");
		h.setNow(5_000);
		await h.coordinator.attempt();
		expect(h.coordinator.snapshot()?.phase).toBe("cancelled");
		h.coordinator.observeFailure("connection");
		expect(h.coordinator.snapshot()?.phase).toBe("cancelled");
	});

	it("待交棒与本投递的故障证据跨恢复保留，下一条发送不会沿用旧交棒", async () => {
		const h = setup();
		h.coordinator.observeFailure("connection");
		h.submit.mockResolvedValue({ outcome: "accepted_running", nativeTurnId: "retry-turn" });
		await h.coordinator.attempt(true);
		h.setNow(2_000);
		h.coordinator.observeFailure("connection", "retry-turn");
		h.coordinator.requestCompletionReview("hook", 2_001);
		const saved = h.coordinator.snapshot();
		if (!saved) throw new Error("缺少记录");
		const restarted = setup();
		restarted.coordinator.restore(saved);
		expect(restarted.coordinator.snapshot()).toMatchObject({
			activeDeliveryObservedFailure: { reason: "connection", nativeTurnId: "retry-turn" },
			pendingCompletionReview: { reason: "hook", observedAtMs: 2_001 },
		});
		restarted.submit.mockResolvedValue({ outcome: "accepted_failed" });
		await restarted.coordinator.attempt(true);
		expect(restarted.coordinator.snapshot()?.pendingCompletionReview).toBeUndefined();
		expect(restarted.coordinator.snapshot()?.activeDeliveryObservedFailure).toBeUndefined();
	});

	it("仅登记且未到写前标记时可以重发，结果未知时保持只读核对", () => {
		expect(
			claudeAutomaticFailureContinuationMayStartWrite({
				activeDeliveryAttemptCounted: false,
				activeDeliveryRequestMayHaveBeenSent: false,
				hasManagedEntry: true,
				managedReceiptStatus: null,
			}),
		).toBe(true);
		expect(
			claudeAutomaticFailureContinuationMayStartWrite({
				activeDeliveryAttemptCounted: false,
				activeDeliveryRequestMayHaveBeenSent: false,
				hasManagedEntry: true,
				managedReceiptStatus: "delivery_failed",
				managedReceiptReason: "cancelled_before_delivery",
			}),
		).toBe(true);
		expect(
			claudeAutomaticFailureContinuationMayStartWrite({
				activeDeliveryAttemptCounted: false,
				activeDeliveryRequestMayHaveBeenSent: true,
				hasManagedEntry: true,
				managedReceiptStatus: null,
			}),
		).toBe(false);
		expect(
			claudeAutomaticFailureContinuationMayStartWrite({
				activeDeliveryAttemptCounted: true,
				hasManagedEntry: false,
			}),
		).toBe(false);
	});
});
