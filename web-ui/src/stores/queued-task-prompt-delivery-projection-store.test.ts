// per-task 外部 store：推送是 workspace 级整份，但订阅粒度是 taskId——一个任务的队列动一下，
// 别的卡片不能跟着重渲。useSyncExternalStore 靠引用判等，所以「没变的 task 保持原数组引用」就是这条性质本身。
// 另外钉住：别的 workspace 的写入一律丢弃（taskId 是 board-local 短 id，会撞号），以及写入代数。
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";
import {
	getQueuedTaskPromptDeliveryProjectionsForTask,
	getQueuedTaskPromptDeliveryProjectionWriteGeneration,
	replaceQueuedTaskPromptDeliveryProjections,
	resetQueuedTaskPromptDeliveryProjectionsForWorkspace,
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

beforeEach(() => {
	resetQueuedTaskPromptDeliveryProjectionsForWorkspace("ws-a");
});

afterEach(() => {
	resetQueuedTaskPromptDeliveryProjectionsForWorkspace(null);
});

describe("queued-task-prompt-delivery-projection-store", () => {
	it("整份替换时，内容没变的 task 保持原数组引用，变了的换新引用", () => {
		replaceQueuedTaskPromptDeliveryProjections("ws-a", {
			"task-a": [projection("task-a", "a1")],
			"task-b": [projection("task-b", "b1")],
		});
		const taskABefore = getQueuedTaskPromptDeliveryProjectionsForTask("task-a");
		const taskBBefore = getQueuedTaskPromptDeliveryProjectionsForTask("task-b");
		// 模拟推送：服务端每次发的都是新对象，哪怕 task-a 的内容一字未变。
		replaceQueuedTaskPromptDeliveryProjections("ws-a", {
			"task-a": [projection("task-a", "a1")],
			"task-b": [projection("task-b", "b1", "改了")],
		});
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-a")).toBe(taskABefore);
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-b")).not.toBe(taskBBefore);
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-b")[0]?.textPreview).toBe("改了");
	});

	it("从推送里消失的 task 读成空列表", () => {
		replaceQueuedTaskPromptDeliveryProjections("ws-a", { "task-a": [projection("task-a", "a1")] });
		replaceQueuedTaskPromptDeliveryProjections("ws-a", {});
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-a")).toEqual([]);
	});

	it("没有任何条目的 task 恒返回同一个空数组引用（避免订阅者白渲）", () => {
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("nope")).toBe(
			getQueuedTaskPromptDeliveryProjectionsForTask("still-nope"),
		);
	});

	// 切到 B 之后，A 那边一个迟到的 mutation 响应 / 拉取结果不得把 A 的 prompt 预览塞进 B 同名任务的卡片。
	it("别的 workspace 的写入被丢弃；切 workspace 即清空", () => {
		replaceQueuedTaskPromptDeliveryProjections("ws-a", { "task-1": [projection("task-1", "from-a")] });
		resetQueuedTaskPromptDeliveryProjectionsForWorkspace("ws-b");
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-1")).toEqual([]);
		expect(
			replaceQueuedTaskPromptDeliveryProjections("ws-a", { "task-1": [projection("task-1", "late-from-a")] }),
		).toBe(false);
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-1")).toEqual([]);
		expect(replaceQueuedTaskPromptDeliveryProjections("ws-b", { "task-1": [projection("task-1", "from-b")] })).toBe(
			true,
		);
		expect(getQueuedTaskPromptDeliveryProjectionsForTask("task-1")[0]?.queueEntryId).toBe("from-b");
	});

	// controller 据此丢弃被更新写入超过的 mutation 响应。
	it("每次接受的写入都推进写入代数；被丢弃的写入不推进", () => {
		const before = getQueuedTaskPromptDeliveryProjectionWriteGeneration();
		replaceQueuedTaskPromptDeliveryProjections("ws-a", {});
		expect(getQueuedTaskPromptDeliveryProjectionWriteGeneration()).toBe(before + 1);
		replaceQueuedTaskPromptDeliveryProjections("ws-other", {});
		expect(getQueuedTaskPromptDeliveryProjectionWriteGeneration()).toBe(before + 1);
	});
});
