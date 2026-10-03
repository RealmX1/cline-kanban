import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import type { RuntimeStateStreamTaskReadyForReviewMessage } from "@/runtime/types";

const deliveryMocks = vi.hoisted(() => ({
	claimDelivery: vi.fn(),
	recordClientFilter: vi.fn(),
	recordClientObservation: vi.fn(),
	getSettings: vi.fn(),
	playSummarySpeech: vi.fn(),
	playNotificationSound: vi.fn(),
}));
vi.mock("@/runtime/notification-intelligence-query", () => ({
	notificationIntelligenceClient: () => ({
		claimDelivery: { mutate: deliveryMocks.claimDelivery },
		recordClientFilter: { mutate: deliveryMocks.recordClientFilter },
		recordClientObservation: { mutate: deliveryMocks.recordClientObservation },
		getSettings: { query: deliveryMocks.getSettings },
	}),
}));
vi.mock("@/utils/notification-permission", () => ({ getBrowserNotificationPermission: () => "granted" }));
vi.mock("@/utils/notification-summary-speech", () => ({
	playNotificationSummarySpeech: deliveryMocks.playSummarySpeech,
}));
vi.mock("@/utils/notification-sound", () => ({
	playReviewReadyNotificationSound: deliveryMocks.playNotificationSound,
}));

function NotificationHarness({
	events,
	isDocumentVisible = false,
}: {
	events: RuntimeStateStreamTaskReadyForReviewMessage[];
	isDocumentVisible?: boolean;
}) {
	useReviewReadyNotifications({
		activeWorkspaceId: "workspace-a",
		board: { columns: [] },
		isDocumentVisible,
		latestTaskReadyForReview: null,
		taskReadyForReviewEvents: events,
		taskSessions: {},
		readyForReviewNotificationsEnabled: true,
		notificationSoundEnabled: true,
		workspacePath: "/projects/workspace-a",
		projects: [
			{
				id: "workspace-b",
				path: "/projects/workspace-b",
				name: "workspace-b",
				taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
				availability: { status: "available" },
				inProgressTaskDetails: [],
				crossProjectTaskSwitcherEntries: [],
			},
		],
	});
	return null;
}

describe("通知领取失败后的去重边界", () => {
	let root: Root;
	let container: HTMLDivElement;
	let event: RuntimeStateStreamTaskReadyForReviewMessage;
	const browserNotification = vi.fn(function BrowserNotification() {});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("Notification", browserNotification);
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		localStorage.clear();
		deliveryMocks.claimDelivery.mockResolvedValue({ claimed: true });
		deliveryMocks.recordClientFilter.mockResolvedValue({});
		deliveryMocks.recordClientObservation.mockResolvedValue({});
		deliveryMocks.getSettings.mockResolvedValue({ settings: { speechMode: "summary" } });
		deliveryMocks.playSummarySpeech.mockResolvedValue(undefined);
		container = document.createElement("div");
		root = createRoot(container);
		event = {
			type: "task_ready_for_review",
			workspaceId: "workspace-a",
			taskId: "task-a",
			candidateId: "candidate-a",
			triggeredAt: Date.now(),
		};
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function renderEvents(events: RuntimeStateStreamTaskReadyForReviewMessage[]) {
		await act(async () => root.render(createElement(NotificationHarness, { events })));
	}

	it("瞬时领取失败后允许事件重放，成功后的重放不再通知或合成语音", async () => {
		await renderEvents([]);
		deliveryMocks.claimDelivery.mockRejectedValueOnce(new Error("连接中断"));
		await renderEvents([event]);
		expect(browserNotification).not.toHaveBeenCalled();
		await renderEvents([event]);
		await renderEvents([event]);
		expect(deliveryMocks.claimDelivery).toHaveBeenCalledTimes(2);
		expect(browserNotification).toHaveBeenCalledTimes(1);
		expect(deliveryMocks.playSummarySpeech).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("(1) workspace-a");
	});

	it("初次挂载携带事件时，领取进行中的重复事件不发起并发领取", async () => {
		let finishClaim: ((result: { claimed: boolean }) => void) | undefined;
		deliveryMocks.claimDelivery.mockReturnValueOnce(
			new Promise<{ claimed: boolean }>((resolve) => {
				finishClaim = resolve;
			}),
		);
		await renderEvents([event, event]);
		await renderEvents([event]);
		expect(deliveryMocks.claimDelivery).toHaveBeenCalledTimes(1);
		await act(async () => finishClaim?.({ claimed: true }));
		expect(browserNotification).toHaveBeenCalledTimes(1);
	});

	it("服务端明确拒绝领取后不重试，保留跨标签页的唯一领取边界", async () => {
		await renderEvents([]);
		deliveryMocks.claimDelivery.mockResolvedValue({ claimed: false });
		await renderEvents([event]);
		await renderEvents([event]);
		expect(deliveryMocks.claimDelivery).toHaveBeenCalledTimes(1);
		expect(browserNotification).not.toHaveBeenCalled();
		expect(deliveryMocks.playSummarySpeech).not.toHaveBeenCalled();
	});

	it("领取后的语音与回退声音失败不释放去重，不重复已发起的付费操作", async () => {
		await renderEvents([]);
		deliveryMocks.playSummarySpeech.mockRejectedValueOnce(new Error("语音播放失败"));
		deliveryMocks.playNotificationSound.mockImplementationOnce(() => {
			throw new Error("声音播放失败");
		});
		await renderEvents([event]);
		await renderEvents([event]);
		expect(deliveryMocks.claimDelivery).toHaveBeenCalledTimes(1);
		expect(browserNotification).toHaveBeenCalledTimes(1);
		expect(deliveryMocks.playSummarySpeech).toHaveBeenCalledTimes(1);
	});
});

describe("就绪通知跨项目投递（单标签页管全部项目）", () => {
	let root: Root;
	let container: HTMLDivElement;
	const browserNotification = vi.fn(function BrowserNotification() {});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("Notification", browserNotification);
		localStorage.clear();
		deliveryMocks.claimDelivery.mockResolvedValue({ claimed: true });
		deliveryMocks.recordClientFilter.mockResolvedValue({});
		deliveryMocks.recordClientObservation.mockResolvedValue({});
		deliveryMocks.getSettings.mockResolvedValue({ settings: { speechMode: "off" } });
		container = document.createElement("div");
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function readyEvent(workspaceId: string, taskId: string): RuntimeStateStreamTaskReadyForReviewMessage {
		return {
			type: "task_ready_for_review",
			workspaceId,
			taskId,
			candidateId: `candidate-${workspaceId}-${taskId}`,
			triggeredAt: Date.now(),
			taskTitleSnapshot: `Title of ${taskId}`,
		};
	}

	it("标签页正前台看着 A 项目时，B 项目的任务完成照样弹 OS 通知，正文带 B 的项目名与标题快照", async () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		await act(async () =>
			root.render(
				createElement(NotificationHarness, {
					events: [readyEvent("workspace-b", "task-b")],
					isDocumentVisible: true,
				}),
			),
		);
		expect(deliveryMocks.claimDelivery).toHaveBeenCalledTimes(1);
		expect(browserNotification).toHaveBeenCalledTimes(1);
		expect(browserNotification).toHaveBeenCalledWith(
			"Ready for review",
			expect.objectContaining({ body: "workspace-b\nTitle of task-b" }),
		);
	});

	it("标签页正前台看着 A 项目时，A 项目自己的任务完成仍按前台可见让位（不弹）", async () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		await act(async () =>
			root.render(
				createElement(NotificationHarness, {
					events: [readyEvent("workspace-a", "task-a")],
					isDocumentVisible: true,
				}),
			),
		);
		expect(deliveryMocks.claimDelivery).not.toHaveBeenCalled();
		expect(browserNotification).not.toHaveBeenCalled();
	});
});
