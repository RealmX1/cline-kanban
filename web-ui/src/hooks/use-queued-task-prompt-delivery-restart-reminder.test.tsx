// kanban 重启后聚焦任务时的 5 秒提醒。钉住的是「人看见了」这件事的判据：
//   - 页面真的可见、且 Queue 页签真的呈现在用户眼前才提醒、才确认（spotlight 带 requireVisibleToUser）；
//   - 高亮与确认并发（开了「减少动效」的人也照样能确认），并给屏幕阅读器一句播报；
//   - 没能呈现就不确认，之后定时再试；
//   - 只在服务端确认成功后才算提醒过：确认失败要能在退避之后重试；
//   - 每条只放一次电。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS,
	QUEUED_PROMPT_RESTART_REMINDER_PRESENTATION_RETRY_INTERVAL_MS,
	QUEUED_PROMPT_RESTART_REMINDER_RECONFIRM_FAILURE_RETRY_BACKOFF_MS,
	QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS,
	resetQueuedTaskPromptDeliveryRestartReminderBookkeepingForTests,
	useQueuedTaskPromptDeliveryRestartReminder,
} from "@/hooks/use-queued-task-prompt-delivery-restart-reminder";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";

function projection(
	queueEntryId: string,
	overrides: Partial<RuntimeQueuedTaskPromptDeliveryProjection> = {},
): RuntimeQueuedTaskPromptDeliveryProjection {
	return {
		queueEntryId,
		taskId: "task-1",
		deliveryState: "queued",
		textPreview: "跑测试",
		textLength: 3,
		deliverTogetherWithNextQueuedEntry: false,
		dispatchBlockReason: "awaiting_human_reconfirmation_after_runtime_restart",
		awaitsHumanReconfirmationAfterRuntimeRestart: true,
		deliveryAttemptCount: 0,
		lastDeliveryFailureNote: null,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
		enqueuedAt: 1,
		expiresAt: 2,
		settledAt: null,
		...overrides,
	};
}

let visibilityState: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
	visibilityState = next;
	document.dispatchEvent(new Event("visibilitychange"));
}

const captured: { announcement: string | null } = { announcement: null };

function ReminderHarness(props: {
	enabled?: boolean;
	projections: RuntimeQueuedTaskPromptDeliveryProjection[];
	reconfirm: (ids: readonly string[]) => Promise<boolean>;
	spotlight: (anchorKey: string, options?: unknown) => boolean;
}): null {
	const { restartReminderAnnouncement } = useQueuedTaskPromptDeliveryRestartReminder({
		enabled: props.enabled,
		taskId: "task-1",
		projections: props.projections,
		reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: props.reconfirm,
		spotlight: props.spotlight,
	});
	captured.announcement = restartReminderAnnouncement;
	return null;
}

describe("useQueuedTaskPromptDeliveryRestartReminder", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	it("Done 浏览停用提醒和自动重确认，保留原有队列", () => {
		const reconfirm = vi.fn(async () => true);
		const spotlight = vi.fn(() => true);
		render({ enabled: false, projections: [projection("done-entry")], reconfirm, spotlight });
		act(() => {
			vi.advanceTimersByTime(10_000);
		});
		expect(spotlight).not.toHaveBeenCalled();
		expect(reconfirm).not.toHaveBeenCalled();
		expect(captured.announcement).toBeNull();
	});

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
		visibilityState = "visible";
		captured.announcement = null;
		resetQueuedTaskPromptDeliveryRestartReminderBookkeepingForTests();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function render(props: Parameters<typeof ReminderHarness>[0]) {
		act(() => {
			root.render(createElement(ReminderHarness, props));
		});
	}

	it("可见时：要求 Queue 页签真的呈现（必要时就近滚回来），闪 5 秒 warning 样式，同时确认并播报", async () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => true);
		render({ projections: [projection("q1"), projection("q2")], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledWith("queued-prompt-queue-tab:task-1", {
			durationMs: QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS,
			spotlightClassName: QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS,
			scrollIntoView: "only_if_out_of_view",
			requireVisibleToUser: true,
		});
		expect(QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS).toBe(5_000);
		expect(reconfirm).toHaveBeenCalledWith(["q1", "q2"]);
		expect(captured.announcement).toContain("2 queued prompts from before Kanban restarted");
	});

	it("没有待确认条目时什么都不做", () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => true);
		render({
			projections: [projection("q1", { awaitsHumanReconfirmationAfterRuntimeRestart: false })],
			reconfirm,
			spotlight,
		});
		expect(spotlight).not.toHaveBeenCalled();
		expect(reconfirm).not.toHaveBeenCalled();
	});

	// 后台标签页里被程序化选中的卡片不算「人看见了」。
	it("页面不可见时不提醒、不确认；回到前台那一刻再提醒", () => {
		visibilityState = "hidden";
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => true);
		render({ projections: [projection("q1")], reconfirm, spotlight });
		expect(spotlight).not.toHaveBeenCalled();
		expect(reconfirm).not.toHaveBeenCalled();
		act(() => {
			setVisibility("visible");
		});
		expect(spotlight).toHaveBeenCalledTimes(1);
		expect(reconfirm).toHaveBeenCalledWith(["q1"]);
	});

	// 没呈现就不算看见（被模态层盖住 / 窄屏里还没滚到 / 锚点还没挂上）。之后定时再试，呈现了才确认。
	it("没能呈现时不确认，之后定时重试直到呈现", () => {
		let presentable = false;
		const spotlight = vi.fn(() => presentable);
		const reconfirm = vi.fn(async () => true);
		render({ projections: [projection("q1")], reconfirm, spotlight });
		expect(reconfirm).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(QUEUED_PROMPT_RESTART_REMINDER_PRESENTATION_RETRY_INTERVAL_MS);
		});
		expect(reconfirm).not.toHaveBeenCalled();
		presentable = true;
		act(() => {
			vi.advanceTimersByTime(QUEUED_PROMPT_RESTART_REMINDER_PRESENTATION_RETRY_INTERVAL_MS);
		});
		expect(reconfirm).toHaveBeenCalledTimes(1);
		// 定时重试成功之后，回到前台的监听不得再放第二次电。
		act(() => {
			setVisibility("visible");
			vi.advanceTimersByTime(QUEUED_PROMPT_RESTART_REMINDER_PRESENTATION_RETRY_INTERVAL_MS * 3);
		});
		expect(reconfirm).toHaveBeenCalledTimes(1);
	});

	// 一次断连就让条目永远停在「待确认」、又再也不提醒，是比不提醒更糟的状态。
	it("确认失败时，退避之后重新提醒并重试确认", async () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => false);
		render({ projections: [projection("q1")], reconfirm, spotlight });
		expect(reconfirm).toHaveBeenCalledTimes(1);
		// 让「确认失败」的 then 回调跑完，退避定时器才会被登记。
		await act(async () => {
			for (let tick = 0; tick < 5; tick += 1) {
				await Promise.resolve();
			}
		});
		reconfirm.mockImplementation(async () => true);
		await act(async () => {
			vi.advanceTimersByTime(QUEUED_PROMPT_RESTART_REMINDER_RECONFIRM_FAILURE_RETRY_BACKOFF_MS);
		});
		expect(spotlight).toHaveBeenCalledTimes(2);
		expect(reconfirm).toHaveBeenCalledTimes(2);
	});

	it("每条只放一次电；新出现的待确认条目照样提醒", () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => true);
		render({ projections: [projection("q1")], reconfirm, spotlight });
		render({ projections: [projection("q1", { textPreview: "变了一点" })], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledTimes(1);
		expect(reconfirm).toHaveBeenCalledTimes(1);
		render({ projections: [projection("q1"), projection("q2")], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledTimes(2);
		expect(reconfirm).toHaveBeenLastCalledWith(["q2"]);
	});
});
