import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTaskCommentBeforeMoveIntoDone } from "@/hooks/use-task-comment-before-move-into-done";
import type { BoardCard } from "@/types";

let root: Root;
let container: HTMLDivElement;
let controller: ReturnType<typeof useTaskCommentBeforeMoveIntoDone>;
function HookHarness() {
	controller = useTaskCommentBeforeMoveIntoDone();
	return null;
}
function task(taskId: string, createdAt = 100): BoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: "需求",
		createdAt,
		updatedAt: createdAt,
		baseRef: "main",
		startInPlanMode: false,
	};
}
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () => root.render(<HookHarness />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("结案填写请求的对象边界", () => {
	it("同一世任务重复打开保留评论和幂等身份，并产生新的唤起请求", async () => {
		await act(async () => controller.open("project-a", task("task-a")));
		await act(async () => {
			controller.prepareSubmission("原评论");
			controller.returnToEditing("task-a");
		});
		const original = controller.request!;
		await act(async () => controller.open("project-a", task("task-a")));
		expect(controller.request?.closureRequestId).toBe(original.closureRequestId);
		expect(controller.request?.taskCommentEntryId).toBe(original.taskCommentEntryId);
		expect(controller.request?.commentText).toBe("原评论");
		expect(controller.request?.openingRequestIdentity).not.toBe(original.openingRequestIdentity);
	});
	it.each([
		["project-b", "task-a", 100],
		["project-a", "task-b", 100],
		["project-a", "task-a", 200],
	] as const)("已保留 A 窗口时仍可登记 %s/%s/%s 的独立请求", async (workspaceId, taskId, createdAt) => {
		await act(async () => controller.open("project-a", task("task-a")));
		const original = controller.request!;
		await act(async () => controller.open(workspaceId, task(taskId, createdAt)));
		expect(controller.request).toMatchObject({
			workspaceId,
			taskId,
			expectedTaskIncarnationCreatedAtEpochMs: createdAt,
		});
		expect(controller.request?.closureRequestId).not.toBe(original.closureRequestId);
	});
});
