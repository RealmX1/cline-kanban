// kanban 重启后聚焦任务时的 5 秒提醒。钉住的是「人看见了」这件事的判据：
//   - 页面真的可见才提醒、才确认（后台标签页里被程序化选中的卡片不算看见）；
//   - 高亮与确认并发（开了「减少动效」的人也照样能确认）；
//   - 高亮没挂上就不确认（没闪就不算看见）；
//   - 每条只放一次电。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS,
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

function ReminderHarness(props: {
	projections: RuntimeQueuedTaskPromptDeliveryProjection[];
	reconfirm: (ids: readonly string[]) => Promise<void>;
	spotlight: (anchorKey: string, options?: unknown) => boolean;
}): null {
	useQueuedTaskPromptDeliveryRestartReminder({
		taskId: "task-1",
		projections: props.projections,
		reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: props.reconfirm,
		spotlight: props.spotlight,
	});
	return null;
}

describe("useQueuedTaskPromptDeliveryRestartReminder", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
		visibilityState = "visible";
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
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function render(props: Parameters<typeof ReminderHarness>[0]) {
		act(() => {
			root.render(createElement(ReminderHarness, props));
		});
	}

	it("可见时：Queue 页签闪 5 秒（warning 样式、不滚动），同时确认这些条目", () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => {});
		render({ projections: [projection("q1"), projection("q2")], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledWith("queued-prompt-queue-tab:task-1", {
			durationMs: QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS,
			spotlightClassName: QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS,
			scrollIntoView: false,
		});
		expect(QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS).toBe(5_000);
		expect(reconfirm).toHaveBeenCalledWith(["q1", "q2"]);
	});

	it("没有待确认条目时什么都不做", () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => {});
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
		const reconfirm = vi.fn(async () => {});
		render({ projections: [projection("q1")], reconfirm, spotlight });
		expect(spotlight).not.toHaveBeenCalled();
		expect(reconfirm).not.toHaveBeenCalled();
		act(() => {
			setVisibility("visible");
		});
		expect(spotlight).toHaveBeenCalledTimes(1);
		expect(reconfirm).toHaveBeenCalledWith(["q1"]);
	});

	// 没闪就不算看见：留给面板里那个显式的 Keep 按钮。
	it("高亮没挂上（锚点不在 DOM 里）时不确认", () => {
		const spotlight = vi.fn(() => false);
		const reconfirm = vi.fn(async () => {});
		render({ projections: [projection("q1")], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledTimes(1);
		expect(reconfirm).not.toHaveBeenCalled();
	});

	// 确认请求失败时条目仍是「待确认」；不能因此每次重渲都再闪一遍。
	it("每条只放一次电", () => {
		const spotlight = vi.fn(() => true);
		const reconfirm = vi.fn(async () => {});
		render({ projections: [projection("q1")], reconfirm, spotlight });
		render({ projections: [projection("q1", { textPreview: "变了一点" })], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledTimes(1);
		expect(reconfirm).toHaveBeenCalledTimes(1);
		// 新出现的待确认条目照样提醒。
		render({ projections: [projection("q1"), projection("q2")], reconfirm, spotlight });
		expect(spotlight).toHaveBeenCalledTimes(2);
		expect(reconfirm).toHaveBeenLastCalledWith(["q2"]);
	});
});
