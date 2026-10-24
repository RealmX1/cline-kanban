import { describe, expect, it } from "vitest";
import {
	applyCodexAutomaticCompactionPhaseObservation,
	createCodexRvfCloseoutCompactionAwareConfirmation,
	resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs,
} from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";

const binding = {
	workspaceId: "workspace-1",
	taskId: "task-1",
	conversationSessionId: "session-1",
	decisionToken: "a".repeat(16),
	runId: "run-1",
	handoffSha256: "b".repeat(64),
	idempotencyKey: "closeout-1",
	promptSha256: "c".repeat(64),
	nativeSessionId: "native-1",
	runtimeSessionIncarnationId: "generation-1",
	controlHostSocketPath: "/isolated/control.sock",
	terminalSessionSpawnedAtEpochMs: 1,
};

function initial() {
	return createCodexRvfCloseoutCompactionAwareConfirmation({
		binding,
		firstSubmissionAtEpochMs: 1_000,
		submissionTransport: "codex_native_request",
		clientUserMessageId: "client-message-1",
		predecessorNativeTurnId: "old-turn",
		lastHumanInputAtSubmission: null,
	});
}

function observe(
	state: ReturnType<typeof initial>,
	phase: "started" | "completed",
	at: number,
	key = `${phase}-${at}`,
) {
	return applyCodexAutomaticCompactionPhaseObservation(state, {
		phase,
		nativeTurnId: "new-turn",
		capturedAtEpochMs: at,
		receivedAtEpochMs: at,
		hookDeliveryId: key,
	});
}

describe("Codex RVF 收尾的有界压缩计时", () => {
	it("正常 38fd3 路径仍只有 15 秒，不需要压缩恢复", () => {
		expect(resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(initial())).toBe(16_000);
	});
	it.each([117_160, 129_828, 120_347])("同一正文遇 %i ms 压缩，结束后只恢复原剩余普通预算", (duration) => {
		const started = observe(initial(), "started", 3_000);
		expect(started.phase).toBe("waiting_for_automatic_context_compaction");
		expect(started.ordinaryConfirmationBudgetRemainingMs).toBe(13_000);
		const ended = observe(started, "completed", 3_000 + duration);
		expect(resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(ended)).toBe(16_000 + duration);
	});
	it("多次压缩共用 300 秒；重复事件与重启反序列化不会重新发预算", () => {
		const started = observe(initial(), "started", 3_000);
		expect(observe(started, "started", 4_000)).toEqual(started);
		const ended = observe(started, "completed", 203_000);
		expect(observe(ended, "completed", 204_000)).toEqual(ended);
		const restarted = JSON.parse(JSON.stringify(ended));
		const second = observe(restarted, "started", 204_000);
		expect(resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(second)).toBe(304_000);
		expect(observe(second, "completed", 305_000)).toEqual(second);
		expect(second.absoluteConfirmationDeadlineAtEpochMs).toBe(316_000);
	});
	it("缺开始、旧 turn、超时才到的开始与乱序事件均不能延长", () => {
		const state = initial();
		expect(observe(state, "completed", 2_000)).toEqual(state);
		expect(observe(state, "started", 16_000)).toEqual(state);
		const started = observe(state, "started", 3_000);
		expect(observe(started, "completed", 2_000)).toEqual(started);
		expect(
			applyCodexAutomaticCompactionPhaseObservation(state, {
				phase: "started",
				nativeTurnId: "old-turn",
				capturedAtEpochMs: 3_000,
				receivedAtEpochMs: 3_000,
				hookDeliveryId: "old",
			}),
		).toEqual(state);
	});
	it("热重启的停机时长计入当前阶段，持久截止始终不超过首次提交后 315 秒", () => {
		const started = JSON.parse(JSON.stringify(observe(initial(), "started", 15_999)));
		expect(resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(started)).toBe(315_999);
		const ended = observe(started, "completed", 315_998);
		expect(resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(ended)).toBe(315_999);
	});
});
