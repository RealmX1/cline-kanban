import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";
import {
	createNotificationAssessmentService,
	isNotificationSpeechSuppressedBecauseAgentEventWasDeliveredLate,
	LATE_DELIVERED_AGENT_EVENT_NOTIFICATION_SPEECH_SUPPRESSION_THRESHOLD_MS,
} from "../../src/notifications/notification-assessment-service";
import {
	closeDefaultNotificationLifecycleArchive,
	getNotificationLifecycleArchive,
} from "../../src/notifications/notification-lifecycle-archive";

const modelRequest = vi.hoisted(() => vi.fn());
const settingsRead = vi.hoisted(() => vi.fn());
const resolveAssessmentCredential = vi.hoisted(() => vi.fn());
vi.mock("../../src/model-provider-access/kanban-model-provider-settings", () => ({
	readNotificationIntelligenceSettings: settingsRead,
	resolveKanbanChatCredential: resolveAssessmentCredential,
}));
vi.mock("../../src/model-provider-access/request-model-provider-chat-completion", () => ({
	requestModelProviderJsonObject: modelRequest,
}));
vi.mock("../../src/state/notification-feed-builder", () => ({
	buildNotificationFeedEntries: async () => [{ taskTitle: "修复通知", repoName: "test" }],
}));
function summary(): RuntimeTaskSessionSummary {
	return {
		taskId: "task",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		agentId: "claude",
		workspacePath: "/isolated",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		lastHookAt: null,
		latestHookActivity: null,
		reviewReason: "hook",
		exitCode: null,
		runtimeSessionIncarnationId: "incarnation-a",
		agentResponseGenerationTurnSequence: 1,
	};
}
beforeEach(() => {
	settingsRead.mockResolvedValue(notificationIntelligenceSettingsSchema.parse({ assessmentEnabled: true }));
	modelRequest.mockReset();
	resolveAssessmentCredential.mockReset().mockResolvedValue({
		modelProviderId: "test",
		apiKey: "never-send",
		baseUrl: "https://example.invalid",
		modelId: "test",
	});
});
describe("智能通知状态机", () => {
	it("凭据读取异常只保留一次基础提醒，持久失败态阻止重启后重试", async () => {
		resolveAssessmentCredential.mockRejectedValue(new Error("credential store locked"));
		const publishUnarchived = vi.fn(async () => undefined);
		const dependencies = { publish: vi.fn(async () => undefined), publishUnarchived, getSummary: () => undefined };
		const service = createNotificationAssessmentService(dependencies);
		const notification = {
			workspaceId: "assessment",
			taskId: "task",
			candidateId: "credential-read-failure",
			userTurnKind: "review" as const,
		};
		try {
			await service.enqueue(notification);
			await service.recover();
			await service.recover();
			const failed = await getNotificationLifecycleArchive().get(notification.candidateId);
			expect(failed?.candidate.notificationProcessingStatus).toBe("assessment_failed");
			expect(failed?.events.some((event) => event.eventType === "notification_assessment_failed")).toBe(true);
			expect(publishUnarchived).toHaveBeenCalledTimes(1);
		} finally {
			service.close();
		}
		await closeDefaultNotificationLifecycleArchive();
		const restarted = createNotificationAssessmentService(dependencies);
		try {
			await restarted.recover();
			await restarted.enqueue(notification);
			expect(resolveAssessmentCredential).toHaveBeenCalledTimes(1);
			expect(modelRequest).not.toHaveBeenCalled();
			expect(publishUnarchived).toHaveBeenCalledTimes(1);
		} finally {
			restarted.close();
		}
	});

	it.each(["ai_assessment_requested", "ai_assessment_decided"])(
		"%s 写入故障期间不重复提醒或付费请求，恢复后只补写失败态",
		async (failedEventType) => {
			const archive = getNotificationLifecycleArchive();
			const originalUpdate = archive.update.bind(archive);
			let writesUnavailable = true;
			const update = vi.spyOn(archive, "update").mockImplementation(async (...args) => {
				if (writesUnavailable && [failedEventType, "notification_assessment_failed"].includes(args[2]))
					throw new Error("SQLITE_BUSY");
				return await originalUpdate(...args);
			});
			modelRequest.mockResolvedValue({
				status: "completed",
				parsedJsonObject: { decision: "completed_turn_or_user_handoff", reason: "完成", summaryText: "完成" },
			});
			const publishUnarchived = vi.fn(async () => undefined);
			const dependencies = { publish: vi.fn(async () => undefined), publishUnarchived, getSummary: () => undefined };
			const service = createNotificationAssessmentService(dependencies);
			const notification = {
				workspaceId: "assessment",
				taskId: "task",
				candidateId: `archive-write-failure-${failedEventType}`,
				userTurnKind: "review" as const,
			};
			try {
				await service.enqueue(notification);
				for (let cycle = 0; cycle < 3; cycle++) await service.recover();
				await service.enqueue(notification);
				expect(publishUnarchived).toHaveBeenCalledTimes(1);
				expect(resolveAssessmentCredential).toHaveBeenCalledTimes(1);
				expect(modelRequest).toHaveBeenCalledTimes(failedEventType === "ai_assessment_requested" ? 0 : 1);
				writesUnavailable = false;
				await service.recover();
				expect((await archive.get(notification.candidateId))?.candidate.notificationProcessingStatus).toBe(
					"assessment_failed",
				);
			} finally {
				service.close();
				update.mockRestore();
			}
			const restarted = createNotificationAssessmentService(dependencies);
			try {
				await restarted.recover();
				await restarted.enqueue(notification);
				expect(publishUnarchived).toHaveBeenCalledTimes(1);
				expect(resolveAssessmentCredential).toHaveBeenCalledTimes(1);
				expect(modelRequest).toHaveBeenCalledTimes(failedEventType === "ai_assessment_requested" ? 0 : 1);
			} finally {
				restarted.close();
			}
		},
	);

	it("等待子任务不进入面板，期限届满仅一次不确定提醒并保留判断", async () => {
		modelRequest.mockResolvedValue({
			status: "completed",
			parsedJsonObject: {
				decision: "awaiting_background_work",
				reason: "仍在等待 subagent",
				summaryText: "正在等待子任务",
			},
		});
		const publish = vi.fn(async () => undefined);
		const service = createNotificationAssessmentService({ publish, getSummary: () => undefined });
		const candidateId = "wait-for-subagent";
		try {
			await service.enqueue({
				workspaceId: "assessment",
				taskId: "task",
				candidateId,
				userTurnKind: "review",
				finalMessage: "waiting for subagent",
			});
			const archive = getNotificationLifecycleArchive();
			const deferred = await archive.get(candidateId);
			expect(deferred?.candidate.notificationProcessingStatus).toBe("deferred");
			expect(publish).not.toHaveBeenCalled();
			expect(deferred?.events.some((event) => event.eventType === "ai_assessment_decided")).toBe(true);
			await archive.update(candidateId, { deferredNotificationFallbackDeadlineAt: 1 }, "test_deadline_elapsed", {});
			await service.recover();
			await service.recover();
			expect(publish).toHaveBeenCalledTimes(1);
			expect(publish).toHaveBeenCalledWith(
				expect.objectContaining({
					summaryText: "尚未确认完成，可能需要查看。",
					notificationPanelVisibility: "visible",
				}),
			);
		} finally {
			service.close();
		}
	});
	it("触发通知的 agent 事件晚到超过阈值：照常发布，候选证据里带着晚到时长，据此不朗读", async () => {
		const publish = vi.fn(async (_candidate: { evidence?: Record<string, unknown> }) => undefined);
		const service = createNotificationAssessmentService({ publish, getSummary: () => summary() });
		try {
			await service.enqueue({
				workspaceId: "assessment",
				taskId: "task",
				candidateId: "delivered-late-after-runtime-restart",
				userTurnKind: "permission",
				summary: summary(),
				agentEventDeliveredLateToRuntimeByMilliseconds: 2 * 60 * 60 * 1000,
			});
			expect(publish).toHaveBeenCalledTimes(1);
			const publishedCandidate = publish.mock.calls[0]?.[0];
			expect(isNotificationSpeechSuppressedBecauseAgentEventWasDeliveredLate(publishedCandidate?.evidence)).toBe(
				true,
			);
			expect(
				isNotificationSpeechSuppressedBecauseAgentEventWasDeliveredLate({
					agentEventDeliveredLateToRuntimeByMilliseconds:
						LATE_DELIVERED_AGENT_EVENT_NOTIFICATION_SPEECH_SUPPRESSION_THRESHOLD_MS,
				}),
			).toBe(false);
			expect(isNotificationSpeechSuppressedBecauseAgentEventWasDeliveredLate(undefined)).toBe(false);
		} finally {
			service.close();
		}
	});
	it("权限请求跳过 AI；迟到的完成判断不能覆盖新一轮", async () => {
		let current = summary();
		const publish = vi.fn(async () => undefined);
		const service = createNotificationAssessmentService({ publish, getSummary: () => current });
		try {
			await service.enqueue({
				workspaceId: "assessment",
				taskId: "task",
				candidateId: "permission",
				userTurnKind: "permission",
				summary: current,
			});
			expect(modelRequest).not.toHaveBeenCalled();
			expect(publish).toHaveBeenCalledTimes(1);
			modelRequest.mockImplementation(async () => {
				current = { ...current, agentResponseGenerationTurnSequence: 2 };
				return {
					status: "completed",
					parsedJsonObject: { decision: "completed_turn_or_user_handoff", reason: "完成", summaryText: "完成" },
				};
			});
			await service.enqueue({
				workspaceId: "assessment",
				taskId: "task",
				candidateId: "late",
				userTurnKind: "review",
				summary: current,
			});
			expect(publish).toHaveBeenCalledTimes(1);
			expect((await getNotificationLifecycleArchive().get("late"))?.candidate.notificationProcessingStatus).toBe(
				"superseded",
			);
		} finally {
			service.close();
		}
	});
	it("同一信号并发到达只调用一次模型，关闭后不再投递", async () => {
		const publish = vi.fn(async () => undefined);
		const service = createNotificationAssessmentService({ publish, getSummary: () => undefined });
		modelRequest.mockImplementation(async () => {
			service.close();
			return {
				status: "completed",
				parsedJsonObject: { decision: "completed_turn_or_user_handoff", reason: "完成", summaryText: "完成" },
			};
		});
		const notification = {
			workspaceId: "assessment",
			taskId: "task",
			candidateId: "concurrent",
			userTurnKind: "review" as const,
		};
		await Promise.all([service.enqueue(notification), service.enqueue(notification)]);
		expect(modelRequest).toHaveBeenCalledTimes(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it("重启后的持久化进展使旧延期失效", async () => {
		modelRequest.mockResolvedValue({ status: "unavailable", unavailableReason: "request_failed" });
		const publish = vi.fn(async () => undefined);
		const first = createNotificationAssessmentService({ publish, getSummary: () => summary() });
		await first.enqueue({
			workspaceId: "assessment",
			taskId: "task",
			candidateId: "restart-progress",
			userTurnKind: "review",
		});
		first.close();
		const resumed = createNotificationAssessmentService({
			publish,
			getSummary: async () => ({ ...summary(), agentResponseGenerationTurnSequence: 2 }),
		});
		try {
			await resumed.recover();
			expect(
				(await getNotificationLifecycleArchive().get("restart-progress"))?.candidate.notificationProcessingStatus,
			).toBe("superseded");
			expect(publish).not.toHaveBeenCalled();
		} finally {
			resumed.close();
		}
	});

	it("模型请求失败进入兜底，重启不再次调用付费模型", async () => {
		modelRequest.mockResolvedValue({ status: "unavailable", unavailableReason: "request_failed" });
		const service = createNotificationAssessmentService({
			publish: async () => undefined,
			getSummary: () => undefined,
		});
		try {
			await service.enqueue({
				workspaceId: "assessment",
				taskId: "task",
				candidateId: "failed-model",
				userTurnKind: "review",
			});
			await service.recover();
			expect(modelRequest).toHaveBeenCalledTimes(1);
			expect(
				(await getNotificationLifecycleArchive().get("failed-model"))?.candidate
					.deferredNotificationFallbackDeadlineAt,
			).not.toBeNull();
		} finally {
			service.close();
		}
	});
	it.each([false, true])("交接后前主会话的迟到 AI 判断不会发布通知，包括失败兜底（抛错=%s）", async (throwFailure) => {
		let current = summary();
		const publish = vi.fn(async () => undefined);
		const publishUnarchived = vi.fn(async () => undefined);
		const service = createNotificationAssessmentService({ publish, publishUnarchived, getSummary: () => current });
		modelRequest.mockImplementation(async () => {
			current = {
				...current,
				taskConversationSessionMetadata: {
					workspaceTaskId: "task",
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionRoleAtCreation: "main",
					taskConversationSessionContextSource: "main",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				},
			};
			if (throwFailure) throw new Error("模拟交接期间通知判断失败");
			return {
				status: "completed",
				parsedJsonObject: { decision: "completed_turn_or_user_handoff", reason: "完成", summaryText: "完成" },
			};
		});
		try {
			await service.enqueue({
				workspaceId: "assessment",
				taskId: "task",
				candidateId: `former-main-${throwFailure}`,
				userTurnKind: "review",
				summary: current,
			});
			expect(publish).not.toHaveBeenCalled();
			expect(publishUnarchived).not.toHaveBeenCalled();
		} finally {
			service.close();
		}
	});
});
