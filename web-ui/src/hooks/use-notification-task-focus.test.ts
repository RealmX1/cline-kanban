import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationTaskFocus } from "@/hooks/use-notification-task-focus";

const openTaskInProjectInPlace = vi.fn<(workspaceId: string, taskId: string) => void>();

function HookHarness(): null {
	useNotificationTaskFocus({ openTaskInProjectInPlace });
	return null;
}

describe("useNotificationTaskFocus", () => {
	let container: HTMLDivElement;
	let root: Root | null;
	let serviceWorkerTarget: EventTarget;
	let originalServiceWorkerDescriptor: PropertyDescriptor | undefined;
	let previousActEnvironment: boolean | undefined;
	let focusSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
		serviceWorkerTarget = new EventTarget();
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: serviceWorkerTarget,
		});
		focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
		openTaskInProjectInPlace.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		if (root) {
			act(() => {
				root?.unmount();
			});
		}
		root = null;
		container.remove();
		focusSpy.mockRestore();
		if (originalServiceWorkerDescriptor) {
			Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "serviceWorker");
		}
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderHook(): void {
		act(() => {
			root?.render(createElement(HookHarness));
		});
	}

	function dispatchServiceWorkerMessage(data: unknown): void {
		act(() => {
			serviceWorkerTarget.dispatchEvent(new MessageEvent("message", { data }));
		});
	}

	// 同项目与跨项目一律交给统一入口：它在切项目途中挂 pending、目标 board 落定再选中，找不到卡时提示而不关 Focus
	// （cf427：此前同项目分支直接 setSelectedTaskId，切项目途中会被 closeDetail 吞掉）。
	it.each([
		["当前项目", "p1"],
		["其他项目（单标签页管全部项目时原地切过去）", "p2"],
	])("%s的通知点击消息交给统一的「在项目里打开任务」入口", (_label, workspaceId) => {
		renderHook();
		dispatchServiceWorkerMessage({
			source: "cline-kanban",
			type: "focus-task-from-notification",
			taskId: "t1",
			workspaceId,
		});

		expect(openTaskInProjectInPlace).toHaveBeenCalledWith(workspaceId, "t1");
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it("忽略形状不符合契约的消息", () => {
		renderHook();
		dispatchServiceWorkerMessage({
			type: "other-message",
			taskId: "t1",
			workspaceId: "p1",
		});

		expect(openTaskInProjectInPlace).not.toHaveBeenCalled();
	});

	it("卸载后移除 service worker message 监听", () => {
		renderHook();
		act(() => {
			root?.unmount();
		});
		root = null;
		dispatchServiceWorkerMessage({
			source: "cline-kanban",
			type: "focus-task-from-notification",
			taskId: "t1",
			workspaceId: "p1",
		});

		expect(openTaskInProjectInPlace).not.toHaveBeenCalled();
	});
});
