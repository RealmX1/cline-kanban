// per-task 外部 store：推送是 workspace 级整份，但订阅粒度是 taskId——一个任务的队列动一下，
// 别的卡片不能跟着重渲。useSyncExternalStore 靠引用判等，所以「没变的 task 保持原数组引用」就是这条性质本身。
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";
import {
	clearQueuedTaskPromptDeliveryProjections,
	getQueuedTaskPromptDeliveryProjectionsForTask,
	replaceQueuedTaskPromptDeliveryProjections,
} from "@/stores/queued-task-prompt-delivery-projection-store";

function projection(
	taskId: string,
	queueEntryId: string,
	textPreview = "跑测试",
): RuntimeQueuedTaskPromptDeliveryProjection {
	return {
		queueEntryId,
		taskId,
		deliveryState: "queued",
		textPreview,
		textLength: textPreview.length,
		deliverTogetherWithNextQueuedEntry: false,
		dispatchBlockReason: null,
		awaitsHumanReconfirmationAfterRuntimeRestart: false,
		deliveryAttemptCount: 0,
		lastDeliveryFailureNote: null,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
		enqueuedAt: 1,
		expiresAt: 2,
		settledAt: null,
	};
}

afterEach(() => {
	clearQueuedTaskPromptDeliveryProjections();
});

describe("queued-task-prompt-delivery-projection-store", () => {
	it("整份替换时，内容没变的 task 保持原数组引用，变了的换新引用", () => {
		replaceQueuedTaskPromptDeliveryProjections({
			"task-a": [projection("task-a", "a1")],
			"task-b": [projection("task-b", "b1")],
		});
		const taskABefore = getQueuedTaskPromptDeliveryProjectionsForTask("task-a");
		const taskBBefore = getQueuedTaskPromptDeliveryProjectionsForTask("task-b");
		// 模拟推送：服务端每次发的都是新对象，哪怕 task-a 的内容一字未变。
		replaceQueuedTaskPromptDeliveryProjections({
			"task-a": [projection("task-a", "a1")],
			"task-b": [projection("task-b", "b1", "改了")],
		});
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-a")).toBe(taskABefore);
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-b")).not.toBe(taskBBefore);
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-b")[0]?.textPreview).toBe("改了");
	});

	it("从推送里消失的 task 读成空列表", () => {
		replaceQueuedTaskPromptDeliveryProjections({ "task-a": [projection("task-a", "a1")] });
		replaceQueuedTaskPromptDeliveryProjections({});
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-a")).toEqual([]);
	});

	it("没有任何条目的 task 恒返回同一个空数组引用（避免订阅者白渲）", () => {
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("nope")).toBe(
			getQueuedTaskPromptDeliveryProjectionsForTask("still-nope"),
		);
	});
});
