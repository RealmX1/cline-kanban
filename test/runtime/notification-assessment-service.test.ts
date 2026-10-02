import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";
import { createNotificationAssessmentService } from "../../src/notifications/notification-assessment-service";
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
				spokenSummaryText: "正在等待子任务。",
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
			// 评估时写的「还在等」朗读版与兜底文案矛盾，兜底播报只念兜底文案。
			expect(publish).toHaveBeenCalledWith(
				expect.objectContaining({
					summaryText: "尚未确认完成，可能需要查看。",
					notificationPanelVisibility: "visible",
					spokenSummaryTextForNotificationSpeech: null,
					notificationSpeechAnnouncementScript: {
						leadInText: "项目 test，任务：修复通知。",
						bodyText: "尚未确认完成，可能需要查看。",
					},
				}),
			);
		} finally {
			service.close();
		}
	});
	it.each([
		["带朗读版摘要", "通知语音模块已修复，需要你 review。", "通知语音模块已修复，需要你 review。"],
		["弱模型漏给朗读版时回退面板摘要并规整", undefined, "已修复 notification speech synthesis。"],
		["朗读版类型错误也不让评估失败", 42, "已修复 notification speech synthesis。"],
	])("prompt v2：%s", async (_case, spokenSummaryText, expectedBodyText) => {
		modelRequest.mockImplementation(async (_request, schema) => ({
			status: "completed",
			parsedJsonObject: schema.parse({
				decision: "completed_turn_or_user_handoff",
				reason: "完成",
				summaryText: "已修复 `src/notifications/notification-speech-synthesis.ts`。",
				spokenSummaryText,
			}),
		}));
		const publish = vi.fn(async () => undefined);
		const service = createNotificationAssessmentService({ publish, getSummary: () => undefined });
		const candidateId = `prompt-v2-${String(spokenSummaryText)}`;
		try {
			await service.enqueue({ workspaceId: "assessment", taskId: "task", candidateId, userTurnKind: "review" });
			expect(publish).toHaveBeenCalledWith(
				expect.objectContaining({
					summaryText: "已修复 `src/notifications/notification-speech-synthesis.ts`。",
					notificationSpeechAnnouncementScript: {
						leadInText: "项目 test，任务：修复通知。",
						bodyText: expectedBodyText,
					},
				}),
			);
			const requested = (await getNotificationLifecycleArchive().get(candidateId))?.events.find(
				(event) => event.eventType === "ai_assessment_requested",
			)?.details as { promptVersion: number; systemPrompt: string };
			expect(requested.promptVersion).toBe(2);
			expect(requested.systemPrompt).toContain("spokenSummaryText");
			expect(requested.systemPrompt).toContain("relative to the repository root");
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
});
