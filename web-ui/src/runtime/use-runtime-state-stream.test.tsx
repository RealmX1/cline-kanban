import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseRuntimeStateStreamResult } from "@/runtime/use-runtime-state-stream";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";

const reloadBrowserIfServedBuildAssetsChangedMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/browser-build-asset-refresh", () => ({
	reloadBrowserIfServedBuildAssetsChanged: reloadBrowserIfServedBuildAssetsChangedMock,
}));

class MockRuntimeStateWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instances: MockRuntimeStateWebSocket[] = [];

	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	readyState = MockRuntimeStateWebSocket.CONNECTING;

	constructor(readonly url: string) {
		MockRuntimeStateWebSocket.instances.push(this);
	}

	close(): void {
		this.readyState = MockRuntimeStateWebSocket.CLOSED;
	}

	triggerMessage(message: unknown): void {
		this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
	}

	triggerOpen(): void {
		this.readyState = MockRuntimeStateWebSocket.OPEN;
		this.onopen?.();
	}

	triggerClose(): void {
		this.readyState = MockRuntimeStateWebSocket.CLOSED;
		this.onclose?.();
	}
}

function RuntimeStateStreamHarness({
	onSnapshot,
}: {
	onSnapshot: (snapshot: UseRuntimeStateStreamResult) => void;
}): null {
	const snapshot = useRuntimeStateStream(null);

	useEffect(() => {
		onSnapshot(snapshot);
	}, [onSnapshot, snapshot]);

	return null;
}

describe("useRuntimeStateStream", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousWebSocket: typeof WebSocket | undefined;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		reloadBrowserIfServedBuildAssetsChangedMock.mockReset();
		MockRuntimeStateWebSocket.instances = [];
		previousWebSocket = globalThis.WebSocket;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			value: MockRuntimeStateWebSocket,
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			value: previousWebSocket,
		});
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("checks whether the served frontend build changed after the runtime stream reconnects", async () => {
		await act(async () => {
			root.render(
				<RuntimeStateStreamHarness
					onSnapshot={() => {
						// Hook render snapshots are not relevant for this reconnect behavior.
					}}
				/>,
			);
		});

		const initialSocket = MockRuntimeStateWebSocket.instances[0];
		if (!initialSocket) {
			throw new Error("Expected the initial runtime stream socket.");
		}

		act(() => {
			initialSocket.triggerOpen();
		});
		expect(reloadBrowserIfServedBuildAssetsChangedMock).not.toHaveBeenCalled();

		act(() => {
			initialSocket.triggerClose();
			vi.advanceTimersByTime(500);
		});

		const reconnectedSocket = MockRuntimeStateWebSocket.instances[1];
		if (!reconnectedSocket) {
			throw new Error("Expected a reconnected runtime stream socket.");
		}
		await act(async () => {
			reconnectedSocket.triggerOpen();
		});

		expect(reloadBrowserIfServedBuildAssetsChangedMock).toHaveBeenCalledTimes(1);
	});

	it("快照按 workspaceId 分桶通知 feed，notification_log_updated 按桶替换且不碰其它 repo", async () => {
		const captured: { current: UseRuntimeStateStreamResult | null } = { current: null };
		await act(async () => {
			root.render(
				<RuntimeStateStreamHarness
					onSnapshot={(snapshot) => {
						captured.current = snapshot;
					}}
				/>,
			);
		});
		const socket = MockRuntimeStateWebSocket.instances[0];
		if (!socket) {
			throw new Error("Expected the initial runtime stream socket.");
		}
		act(() => {
			socket.triggerOpen();
		});

		const feedEntry = (workspaceId: string, taskId: string, triggeredAt: number) => ({
			id: `${taskId}:${triggeredAt}`,
			workspaceId,
			taskId,
			repoName: workspaceId,
			taskTitle: `Task ${taskId}`,
			userTurnKind: "review" as const,
			triggeredAt,
			visitedAt: null,
			isDone: false,
		});

		await act(async () => {
			socket.triggerMessage({
				type: "snapshot",
				currentProjectId: "ws-a",
				projects: [],
				workspaceState: null,
				workspaceMetadata: null,
				clineSessionContextVersion: 0,
				notificationLog: [feedEntry("ws-a", "t1", 1), feedEntry("ws-b", "t2", 2)],
			});
		});
		expect(captured.current?.notificationLogByWorkspaceId["ws-a"]).toHaveLength(1);
		expect(captured.current?.notificationLogByWorkspaceId["ws-b"]).toHaveLength(1);

		// 增量：仅替换 ws-a 桶（跨 repo 全局广播，不按 activeWorkspaceId 过滤），ws-b 保持不变。
		await act(async () => {
			socket.triggerMessage({
				type: "notification_log_updated",
				workspaceId: "ws-a",
				entries: [feedEntry("ws-a", "t1", 1), feedEntry("ws-a", "t3", 3)],
			});
		});
		expect(captured.current?.notificationLogByWorkspaceId["ws-a"]).toHaveLength(2);
		expect(captured.current?.notificationLogByWorkspaceId["ws-b"]).toHaveLength(1);
	});
});
