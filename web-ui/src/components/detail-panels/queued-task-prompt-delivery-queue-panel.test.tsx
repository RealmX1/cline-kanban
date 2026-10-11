// Queue 面板：状态 chip、队首的「为什么还没发」、上移 / 下移的边界、合并开关、重启后待确认的 Keep、
// 以及终态条目归到 Recent 里（失败的给 Requeue）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueuedTaskPromptDeliveryQueuePanel } from "@/components/detail-panels/queued-task-prompt-delivery-queue-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueuedTaskPromptDeliveryQueueController } from "@/hooks/use-queued-task-prompt-delivery-queue-controller";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";

function projection(
	queueEntryId: string,
	overrides: Partial<RuntimeQueuedTaskPromptDeliveryProjection> = {},
): RuntimeQueuedTaskPromptDeliveryProjection {
	return {
		queueEntryId,
		taskId: "task-1",
		deliveryState: "queued",
		textPreview: `正文 ${queueEntryId}`,
		textLength: 5,
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
		...overrides,
	};
}

function createControllerDouble(
	projections: RuntimeQueuedTaskPromptDeliveryProjection[],
): QueuedTaskPromptDeliveryQueueController {
	return {
		projections,
		enqueuePromptForDeliveryAfterCurrentTurn: vi.fn(async () => true),
		cancelQueuedPromptDelivery: vi.fn(async () => {}),
		moveQueuedPromptDelivery: vi.fn(async () => {}),
		setQueuedPromptDeliveryMergeWithNext: vi.fn(async () => {}),
		dismissSettledQueuedPromptDelivery: vi.fn(async () => {}),
		retrySettledFailedQueuedPromptDelivery: vi.fn(async () => {}),
		reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: vi.fn(async () => true),
		fetchFullText: vi.fn(async () => "全文"),
	};
}

function buttonsWithLabel(container: HTMLElement, label: string): HTMLButtonElement[] {
	return Array.from(container.querySelectorAll("button")).filter(
		(candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
	);
}

describe("QueuedTaskPromptDeliveryQueuePanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

	function render(controller: QueuedTaskPromptDeliveryQueueController) {
		act(() => {
			root.render(
				<TooltipProvider>
					<QueuedTaskPromptDeliveryQueuePanel controller={controller} />
				</TooltipProvider>,
			);
		});
	}

	it("空队列给一句引导", () => {
		render(createControllerDouble([]));
		expect(container.textContent).toContain("Queue a prompt from the Prompts tab");
	});

	it("按顺序列出待发条目，队首写明为什么还没发", () => {
		render(
			createControllerDouble([
				projection("q1", { dispatchBlockReason: "agent_still_generating" }),
				projection("q2", { dispatchBlockReason: "agent_still_generating" }),
			]),
		);
		const rows = Array.from(container.querySelectorAll("[data-queued-prompt-entry-id]")).map((row) =>
			row.getAttribute("data-queued-prompt-entry-id"),
		);
		expect(rows).toEqual(["q1", "q2"]);
		expect(container.textContent).toContain("Waiting for the agent to finish its current turn.");
	});

	it("首行不能上移、末行不能下移；中间点击发出对应意图", () => {
		const controller = createControllerDouble([projection("q1"), projection("q2"), projection("q3")]);
		render(controller);
		const moveUpButtons = buttonsWithLabel(container, "Move queued prompt up");
		const moveDownButtons = buttonsWithLabel(container, "Move queued prompt down");
		expect(moveUpButtons[0]?.disabled).toBe(true);
		expect(moveDownButtons[2]?.disabled).toBe(true);
		act(() => {
			moveUpButtons[1]?.click();
		});
		expect(controller.moveQueuedPromptDelivery).toHaveBeenCalledWith("q2", "up");
	});

	it("相邻两行之间的链条开关切换合并", () => {
		const controller = createControllerDouble([projection("q1"), projection("q2")]);
		render(controller);
		const linkButtons = buttonsWithLabel(container, "Link with next queued prompt");
		expect(linkButtons).toHaveLength(1);
		act(() => {
			linkButtons[0]?.click();
		});
		expect(controller.setQueuedPromptDeliveryMergeWithNext).toHaveBeenCalledWith("q1", true);
	});

	// 那一串在认领时就冻结了：此时改开关，界面显示的与实际发出去的会不一致。
	it("任一侧已在发送时合并开关禁用", () => {
		const controller = createControllerDouble([
			projection("q1", { deliveryState: "handed_to_transport" }),
			projection("q2"),
			projection("q3"),
		]);
		render(controller);
		const toggles = [
			...buttonsWithLabel(container, "Link with next queued prompt"),
			...buttonsWithLabel(container, "Unlink from next queued prompt"),
		];
		expect(toggles).toHaveLength(2);
		expect(toggles[0]?.disabled).toBe(true);
		expect(toggles[1]?.disabled).toBe(false);
	});

	it("重启后待确认的条目给 Keep（显式版的同一条确认）", () => {
		const controller = createControllerDouble([
			projection("q1", {
				awaitsHumanReconfirmationAfterRuntimeRestart: true,
				dispatchBlockReason: "awaiting_human_reconfirmation_after_runtime_restart",
			}),
		]);
		render(controller);
		expect(container.textContent).toContain("Queued before Kanban restarted");
		act(() => {
			buttonsWithLabel(container, "Keep")[0]?.click();
		});
		expect(controller.reconfirmQueuedPromptDeliveriesAfterRuntimeRestart).toHaveBeenCalledWith(["q1"]);
	});

	it("终态条目归到 Recent，失败的给 Requeue 并显示失败说明", () => {
		const controller = createControllerDouble([
			projection("q1"),
			projection("done", { deliveryState: "settled_delivered" }),
			projection("failed", {
				deliveryState: "settled_failed",
				lastDeliveryFailureNote: "It may still be sitting in the input box.",
			}),
		]);
		render(controller);
		expect(container.textContent).toContain("Recent");
		expect(container.textContent).toContain("It may still be sitting in the input box.");
		const requeueButtons = buttonsWithLabel(container, "Requeue");
		expect(requeueButtons).toHaveLength(1);
		act(() => {
			requeueButtons[0]?.click();
		});
		expect(controller.retrySettledFailedQueuedPromptDelivery).toHaveBeenCalledWith("failed");
	});

	// 程序化条目（kanban task message --deliver-when-agent-idle）永远独占一次投递：服务端在它前面断链，
	// 界面不能显示一条「会一起发」的链、也不能让人点亮它两侧的开关。
	it("程序化条目挂 Automated 徽标；它两侧的合并开关禁用，链条竖线不跨过它", () => {
		const controller = createControllerDouble([
			projection("human-1", { deliverTogetherWithNextQueuedEntry: true }),
			projection("rvf", { programmaticInjectionSource: "rvf-out-of-band-decision-point" }),
			projection("human-2"),
		]);
		render(controller);
		expect(container.textContent).toContain("Automated · rvf-out-of-band-decision-point");
		const toggles = [
			...buttonsWithLabel(container, "Link with next queued prompt"),
			...buttonsWithLabel(container, "Unlink from next queued prompt"),
		];
		expect(toggles).toHaveLength(2);
		expect(toggles.every((toggle) => toggle.disabled)).toBe(true);
		// human-1 存着的开关值是 true，但它的下一条是程序化条目 ⇒ 实际不会一起发，界面不画「已合并」。
		expect(buttonsWithLabel(container, "Unlink from next queued prompt")).toHaveLength(0);
		const humanRow = container.querySelector('[data-queued-prompt-entry-id="human-1"]');
		expect(humanRow?.className).not.toContain("border-l-accent");
	});

	it("程序化条目到截止仍没等到 agent 空闲 ⇒ Recent 里说清楚没发的原因", () => {
		const controller = createControllerDouble([
			projection("rvf", { deliveryState: "expired", programmaticInjectionSource: "rvf" }),
		]);
		render(controller);
		expect(container.textContent).toContain("The agent never became idle before the automation's deadline");
	});

	it("正在发送的条目也能尝试取消（晚了由服务端回执如实告知）", () => {
		const controller = createControllerDouble([projection("q1", { deliveryState: "handed_to_transport" })]);
		render(controller);
		const cancelButton = buttonsWithLabel(container, "Cancel queued prompt")[0];
		expect(cancelButton?.disabled).toBe(false);
		act(() => {
			cancelButton?.click();
		});
		expect(controller.cancelQueuedPromptDelivery).toHaveBeenCalledWith("q1");
	});
});
