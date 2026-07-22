import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	requestWorkspaceTabFocusViaServiceWorker,
	WORKSPACE_TAB_FOCUS_REQUEST_MESSAGE_TYPE,
	WORKSPACE_TAB_FOCUS_RESPONSE_MESSAGE_TYPE,
	WORKSPACE_TAB_FOCUS_RESPONSE_TIMEOUT_MS,
} from "@/utils/workspace-tab-focus-via-service-worker";

// 双 port 最小实现：不依赖 jsdom / Node 对 MessageChannel 的具体实现，保证测试确定性。
// postMessage 同步派发到对端（真实实现为异步投递；用例不依赖该差异）。
class FakeMessagePort {
	onmessage: ((event: MessageEvent) => void) | null = null;
	pairedPort: FakeMessagePort | null = null;
	closed = false;

	postMessage(data: unknown): void {
		this.pairedPort?.onmessage?.({ data } as MessageEvent);
	}

	close(): void {
		this.closed = true;
	}

	start(): void {}
}

class FakeMessageChannel {
	port1 = new FakeMessagePort();
	port2 = new FakeMessagePort();

	constructor() {
		this.port1.pairedPort = this.port2;
		this.port2.pairedPort = this.port1;
	}
}

interface CapturedRequest {
	message: unknown;
	responsePort: FakeMessagePort;
}

const REQUEST_INPUT = {
	workspaceId: "workspace-1",
	taskId: "task-1",
	workspacePathname: "/workspace-1",
};

describe("requestWorkspaceTabFocusViaServiceWorker", () => {
	let originalServiceWorkerDescriptor: PropertyDescriptor | undefined;
	let originalMessageChannel: typeof MessageChannel;
	let capturedRequests: CapturedRequest[];
	let postMessageMock: ReturnType<typeof vi.fn>;

	function installServiceWorkerMock(controller: unknown): void {
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: { controller },
		});
	}

	beforeEach(() => {
		originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
		originalMessageChannel = globalThis.MessageChannel;
		globalThis.MessageChannel = FakeMessageChannel as unknown as typeof MessageChannel;
		capturedRequests = [];
		postMessageMock = vi.fn((message: unknown, transfer: FakeMessagePort[]) => {
			capturedRequests.push({ message, responsePort: transfer[0] as FakeMessagePort });
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.MessageChannel = originalMessageChannel;
		if (originalServiceWorkerDescriptor) {
			Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "serviceWorker");
		}
	});

	it("无 serviceWorker 支持时立即回 mechanism-unavailable", async () => {
		// jsdom 默认不实现 navigator.serviceWorker；若环境有残留定义则显式删除。
		Reflect.deleteProperty(navigator, "serviceWorker");
		await expect(requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT)).resolves.toBe("mechanism-unavailable");
	});

	it("controller 为 null（硬刷新后）时立即回 mechanism-unavailable", async () => {
		installServiceWorkerMock(null);
		await expect(requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT)).resolves.toBe("mechanism-unavailable");
	});

	it("postMessage 在调用栈内同步发生（锁住手势窗口纪律），且请求消息形状完整", () => {
		installServiceWorkerMock({ postMessage: postMessageMock });
		void requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT);
		expect(postMessageMock).toHaveBeenCalledTimes(1);
		expect(capturedRequests[0]?.message).toEqual({
			source: "cline-kanban",
			type: WORKSPACE_TAB_FOCUS_REQUEST_MESSAGE_TYPE,
			workspaceId: "workspace-1",
			taskId: "task-1",
			workspacePathname: "/workspace-1",
		});
	});

	function respondWith(outcome: unknown): Promise<string> {
		installServiceWorkerMock({ postMessage: postMessageMock });
		const resultPromise = requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT);
		capturedRequests[0]?.responsePort.postMessage({
			source: "cline-kanban",
			type: WORKSPACE_TAB_FOCUS_RESPONSE_MESSAGE_TYPE,
			outcome,
		});
		return resultPromise;
	}

	it('outcome "focused" → focused-existing-tab', async () => {
		await expect(respondWith("focused")).resolves.toBe("focused-existing-tab");
	});

	it('outcome "task-selected-in-background-tab" → task-selected-in-background-tab', async () => {
		await expect(respondWith("task-selected-in-background-tab")).resolves.toBe("task-selected-in-background-tab");
	});

	it('outcome "no-tab-found" → no-existing-tab', async () => {
		await expect(respondWith("no-tab-found")).resolves.toBe("no-existing-tab");
	});

	it('outcome "focus-failed" → mechanism-unavailable（降级）', async () => {
		await expect(respondWith("focus-failed")).resolves.toBe("mechanism-unavailable");
	});

	it("未知 outcome / 非法响应形状 → mechanism-unavailable", async () => {
		await expect(respondWith("some-future-outcome")).resolves.toBe("mechanism-unavailable");

		installServiceWorkerMock({ postMessage: postMessageMock });
		capturedRequests = [];
		const resultPromise = requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT);
		capturedRequests[0]?.responsePort.postMessage({ type: "unrelated-message" });
		await expect(resultPromise).resolves.toBe("mechanism-unavailable");
	});

	it("postMessage 抛异常 → mechanism-unavailable", async () => {
		installServiceWorkerMock({
			postMessage: () => {
				throw new Error("detached");
			},
		});
		await expect(requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT)).resolves.toBe("mechanism-unavailable");
	});

	it("超时无响应（旧 SW 不识别新消息类型）→ mechanism-unavailable，迟到响应被闩忽略且 port 已关闭", async () => {
		vi.useFakeTimers();
		installServiceWorkerMock({ postMessage: postMessageMock });
		const resultPromise = requestWorkspaceTabFocusViaServiceWorker(REQUEST_INPUT);
		vi.advanceTimersByTime(WORKSPACE_TAB_FOCUS_RESPONSE_TIMEOUT_MS);
		await expect(resultPromise).resolves.toBe("mechanism-unavailable");

		const responsePort = capturedRequests[0]?.responsePort;
		expect(responsePort?.pairedPort?.closed).toBe(true);
		// 迟到响应不改变已 settle 的结果、不抛异常。
		responsePort?.postMessage({
			source: "cline-kanban",
			type: WORKSPACE_TAB_FOCUS_RESPONSE_MESSAGE_TYPE,
			outcome: "focused",
		});
		await expect(resultPromise).resolves.toBe("mechanism-unavailable");
	});
});

describe("public/sw.js 协议字面量防漂移（sw.js 无法 import src 模块，两侧手工同步）", () => {
	const swSourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/sw.js");
	const swSource = readFileSync(swSourcePath, "utf-8");

	it("消息类型字面量与 TS 常量一致", () => {
		expect(swSource).toContain(`"${WORKSPACE_TAB_FOCUS_REQUEST_MESSAGE_TYPE}"`);
		expect(swSource).toContain(`"${WORKSPACE_TAB_FOCUS_RESPONSE_MESSAGE_TYPE}"`);
	});

	it("四种 outcome 回报路径齐备（与上方映射用例的字面量三角锁定）", () => {
		expect(swSource).toContain('respond("focused")');
		expect(swSource).toContain('respond("task-selected-in-background-tab")');
		expect(swSource).toContain('respond("no-tab-found")');
		expect(swSource).toContain('respond("focus-failed")');
	});

	it("转发给目标 tab 的选中消息类型与接收端 use-notification-task-focus 一致", () => {
		expect(swSource).toContain('"focus-task-from-notification"');
	});
});
