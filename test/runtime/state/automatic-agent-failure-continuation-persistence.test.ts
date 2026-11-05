import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAutomaticAgentFailureContinuation } from "../../../src/core/api-contract";
import {
	getAutomaticAgentFailureContinuationDirectory,
	persistAutomaticAgentFailureContinuation,
	readAutomaticAgentFailureContinuations,
} from "../../../src/state/automatic-agent-failure-continuation-store";
import {
	createAutomaticAgentFailureContinuationCoordinator,
	hasCompletionReviewForSubmittedAutomaticFailureContinuation,
} from "../../../src/terminal/automatic-agent-failure-continuation-coordinator";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { persistTaskSessionResumeRequestWaitingForNativeConversationIdentity } from "../../../src/terminal/task-session-native-conversation-identity-recovery";

const isolatedRuntimeHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => isolatedRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(isolatedRuntimeHome.path, "workspaces"),
}));
vi.mock("../../../src/state/runtime-home-path", () => ({ getRuntimeHomePath: () => isolatedRuntimeHome.path }));

const managers: TerminalSessionManager[] = [];
function episode(conversationSessionId = "conversation"): RuntimeAutomaticAgentFailureContinuation {
	const coordinator = createAutomaticAgentFailureContinuationCoordinator({
		now: () => Date.now(),
		publish: () => {},
		schedule: () => {},
		clearScheduled: () => {},
		canAttempt: () => true,
		submit: async () => ({ outcome: "deferred" }),
		target: () => ({
			agentId: "codex",
			workspaceId: "isolated",
			taskId: conversationSessionId,
			conversationSessionId,
			taskIncarnationCreatedAtEpochMs: 1,
			runtimeSessionIncarnationId: "old-process",
			nativeSessionId: "native",
			ownerProcessId: process.pid,
			executionWorkingDirectoryPath: "/isolated",
			nativeTranscriptPath: "/isolated/native.jsonl",
			faultTurnIdentity: "failed-turn",
		}),
	});
	coordinator.observeFailure("model_capacity", "native-failed-turn");
	const result = coordinator.snapshot();
	if (!result) throw new Error("未建立测试故障记录");
	return result;
}
function manager() {
	const value = new TerminalSessionManager({
		automaticFailureContinuationWorkspaceId: "isolated",
		readAutomaticFailureContinuationEligibility: async () => ({
			eligible: true,
			taskIncarnationCreatedAtEpochMs: 1,
			connectionEnabled: true,
			capacityEnabled: true,
		}),
	});
	managers.push(value);
	return value;
}
beforeEach(async () => {
	isolatedRuntimeHome.path = await mkdtemp(join(tmpdir(), "automatic-failure-persistence-"));
	vi.useFakeTimers();
});
afterEach(async () => {
	for (const current of managers.splice(0)) {
		for (const summary of current.listSummaries()) {
			if (summary.automaticAgentFailureContinuation)
				await current.actOnAutomaticFailureContinuation(
					summary.taskId,
					summary.automaticAgentFailureContinuation.episodeId,
					"cancel",
				);
		}
		current.dispose();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
	await rm(isolatedRuntimeHome.path, { recursive: true, force: true });
});
describe("自动恢复意图的持久重建", () => {
	it("当前投递的真实待交棒跨写盘和重建保留，重启后的工具活动仍等待原生完工证据", async () => {
		const saved = episode();
		saved.activeDeliveryId = "submitted-delivery";
		saved.activeDeliverySubmissionStartedAtMs = Date.now();
		saved.lastAttemptAtMs = Date.now();
		saved.activeDeliveryAttemptCounted = true;
		saved.pendingCompletionReview = {
			reason: "idle_stall",
			observedAtMs: Date.now() + 1,
			activeDeliveryId: saved.activeDeliveryId,
		};
		await persistAutomaticAgentFailureContinuation(saved);
		const [persisted] = await readAutomaticAgentFailureContinuations("isolated");
		const resumed = createAutomaticAgentFailureContinuationCoordinator({
			now: () => Date.now() + 2,
			target: () => persisted,
			publish: () => {},
			schedule: () => {},
			clearScheduled: () => {},
			canAttempt: () => true,
			submit: async () => ({ outcome: "accepted_finished", nativeTurnId: "current-turn" }),
		});
		resumed.restore(persisted);
		resumed.observeProgress(Date.now() + 2);
		expect(resumed.snapshot()?.phase).not.toBe("recovered");
		await resumed.attempt(true);
		const completed = resumed.snapshot();
		if (!completed) throw new Error("未恢复待交棒记录");
		expect(completed).toMatchObject({ phase: "recovered", pendingCompletionReview: saved.pendingCompletionReview });
		expect(hasCompletionReviewForSubmittedAutomaticFailureContinuation(completed)).toBe(true);
	});
	it("旧所有者确证退出后复用原启动快照和明确原生身份，不重新发送初始提示", async () => {
		const saved = episode();
		await persistAutomaticAgentFailureContinuation(saved);
		const restored = manager();
		await restored.restoreAutomaticFailureContinuationsAfterRuntimeRestart();
		const summary = restored.getSummary("conversation");
		if (!summary) throw new Error("未恢复测试会话");
		await persistTaskSessionResumeRequestWaitingForNativeConversationIdentity(summary, {
			taskId: "conversation",
			workspaceId: "isolated",
			agentId: "codex",
			binary: "original-codex",
			args: ["--model", "original-model", "--dangerously-bypass-approvals-and-sandbox"],
			cwd: "/isolated",
			prompt: "首条提示不能重发",
			env: { CODEX_HOME: "/isolated/original-codex-home" },
		});
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("旧进程已退出"), { code: "ESRCH" });
		});
		const start = vi.spyOn(restored, "startTaskSession").mockResolvedValue(summary);
		await restored.actOnAutomaticFailureContinuation("conversation", saved.episodeId, "retry_now");
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				automaticFailureContinuationEpisodeId: saved.episodeId,
				prompt: "",
				resumePriorAgentConversationWithoutResendingPrompt: true,
				binary: "original-codex",
				args: ["--model", "original-model", "--dangerously-bypass-approvals-and-sandbox"],
				env: { CODEX_HOME: "/isolated/original-codex-home" },
			}),
			"durable_record_rebuilt_resume",
		);
		expect(restored.getSummary("conversation")?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
			"native",
		);
	});
	it("到期并重启后，原账本补证只补发送接受计数，不恢复资格", async () => {
		const saved = {
			...episode(),
			phase: "expired" as const,
			activeDeliveryId: "pending-delivery",
			nextCheckAtMs: null,
		};
		await persistAutomaticAgentFailureContinuation(saved);
		const restored = manager();
		await restored.restoreAutomaticFailureContinuationsAfterRuntimeRestart();
		restored.reconcileHistoricalAutomaticFailureContinuationDelivery(
			"conversation",
			"different-delivery",
			true,
			true,
		);
		expect(restored.getSummary("conversation")?.automaticAgentFailureContinuation?.acceptedCount).toBe(0);
		for (let pass = 0; pass < 2; pass++)
			restored.reconcileHistoricalAutomaticFailureContinuationDelivery(
				"conversation",
				"pending-delivery",
				true,
				true,
			);
		await restored.flushAutomaticFailureContinuationPersistence();
		expect(restored.getSummary("conversation")?.automaticAgentFailureContinuation).toMatchObject({
			phase: "expired",
			activeDeliveryId: "pending-delivery",
			attemptCount: 1,
			acceptedCount: 1,
			nextCheckAtMs: null,
		});
		expect((await readAutomaticAgentFailureContinuations("isolated"))[0]).toMatchObject({
			phase: "expired",
			acceptedCount: 1,
		});
	});

	it("独立保存身份、截止和进度，不复制消息正文或跨 workspace 读取", async () => {
		const saved = episode();
		saved.activeDeliveryObservedFailure = { reason: "model_capacity", nativeTurnId: "retry-turn" };
		saved.pendingCompletionReview = { reason: "hook", observedAtMs: Date.now(), activeDeliveryId: "delivery" };
		await persistAutomaticAgentFailureContinuation(saved);
		expect(await readAutomaticAgentFailureContinuations("isolated")).toEqual([saved]);
		expect(await readAutomaticAgentFailureContinuations("other-workspace")).toEqual([]);
		const directory = getAutomaticAgentFailureContinuationDirectory("isolated");
		const text = await readFile(join(directory, (await readdir(directory))[0]), "utf8");
		expect(text).not.toContain("请先核对");
	});
	it("运行时重启先恢复原意图，旧所有者仍存活时不启动第二个会话", async () => {
		const saved = episode();
		await persistAutomaticAgentFailureContinuation(saved);
		const restored = manager();
		await restored.restoreAutomaticFailureContinuationsAfterRuntimeRestart();
		expect(restored.getSummary("conversation")?.automaticAgentFailureContinuation).toMatchObject({
			episodeId: saved.episodeId,
			deadlineAtMs: saved.deadlineAtMs,
		});
		await restored.actOnAutomaticFailureContinuation("conversation", saved.episodeId, "retry_now");
		await vi.waitFor(() =>
			expect(restored.getSummary("conversation")?.automaticAgentFailureContinuation?.blockingReason).toBe(
				"waiting_for_previous_owner_exit_evidence",
			),
		);
		expect(restored.getSummary("conversation")?.pid).toBeNull();
		await restored.actOnAutomaticFailureContinuation("conversation", saved.episodeId, "cancel");
		const second = manager();
		await second.restoreAutomaticFailureContinuationsAfterRuntimeRestart();
		expect(second.getSummary("conversation")?.automaticAgentFailureContinuation?.phase).toBe("cancelled");
	});
	it("所有者退出未知时保留机器等待", async () => {
		const saved = { ...episode(), ownerProcessId: null };
		await persistAutomaticAgentFailureContinuation(saved);
		const restored = manager();
		await restored.restoreAutomaticFailureContinuationsAfterRuntimeRestart();
		await restored.actOnAutomaticFailureContinuation("conversation", saved.episodeId, "retry_now");
		await vi.waitFor(() =>
			expect(restored.getSummary("conversation")?.automaticAgentFailureContinuation?.blockingReason).toBe(
				"previous_owner_exit_unknown",
			),
		);
		expect(restored.getSummary("conversation")?.pid).toBeNull();
	});
	it("单条记录损坏不阻断其它恢复，修复后自动重读且不覆盖已取消的 episode", async () => {
		const saved = episode();
		const other = episode("other");
		await persistAutomaticAgentFailureContinuation(saved);
		await persistAutomaticAgentFailureContinuation(other);
		const directory = getAutomaticAgentFailureContinuationDirectory("isolated");
		const path = (await readdir(directory)).map((name) => join(directory, name));
		const damaged = (
			await Promise.all(path.map(async (name) => ({ name, body: await readFile(name, "utf8") })))
		).find((file) => JSON.parse(file.body).conversationSessionId === "conversation");
		if (!damaged) throw new Error("未找到测试记录");
		await writeFile(damaged.name, "{interrupted");
		const restored = manager();
		await restored.restoreAutomaticFailureContinuationsAfterRuntimeRestart();
		expect(restored.getSummary("other")?.automaticAgentFailureContinuation?.episodeId).toBe(other.episodeId);
		await restored.actOnAutomaticFailureContinuation("other", other.episodeId, "cancel");
		await writeFile(damaged.name, damaged.body);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.waitFor(() =>
			expect(restored.getSummary("conversation")?.automaticAgentFailureContinuation?.episodeId).toBe(
				saved.episodeId,
			),
		);
		expect(restored.getSummary("other")?.automaticAgentFailureContinuation?.phase).toBe("cancelled");
	});
});
