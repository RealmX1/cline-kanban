import type { Dispatch, SetStateAction } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationTaskFocus } from "@/hooks/use-notification-task-focus";

function HookHarness({
	currentProjectId,
	setSelectedTaskId,
}: {
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}): null {
	useNotificationTaskFocus({ currentProjectId, setSelectedTaskId });
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

	function renderHook(
		setSelectedTaskId: Dispatch<SetStateAction<string | null>>,
		currentProjectId: string | null,
	): void {
		act(() => {
			root?.render(createElement(HookHarness, { currentProjectId, setSelectedTaskId }));
		});
	}

	function dispatchServiceWorkerMessage(data: unknown): void {
		act(() => {
			serviceWorkerTarget.dispatchEvent(new MessageEvent("message", { data }));
		});
	}

	it("收到当前项目的通知点击消息时选中对应任务", () => {
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		renderHook(setSelectedTaskId, "p1");
		dispatchServiceWorkerMessage({
			source: "cline-kanban",
			type: "focus-task-from-notification",
			taskId: "t1",
			workspaceId: "p1",
		});

		expect(setSelectedTaskId).toHaveBeenCalledWith("t1");
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it("忽略其他项目的通知点击消息", () => {
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		renderHook(setSelectedTaskId, "p1");
		dispatchServiceWorkerMessage({
			source: "cline-kanban",
			type: "focus-task-from-notification",
			taskId: "t1",
			workspaceId: "p2",
		});

		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("忽略形状不符合契约的消息", () => {
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		renderHook(setSelectedTaskId, "p1");
		dispatchServiceWorkerMessage({
			type: "other-message",
			taskId: "t1",
			workspaceId: "p1",
		});

		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("卸载后移除 service worker message 监听", () => {
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		renderHook(setSelectedTaskId, "p1");
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

		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});
});
