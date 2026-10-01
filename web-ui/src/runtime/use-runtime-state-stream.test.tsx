import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	StreamedTaskSessionSummariesApplier,
	UseRuntimeStateStreamResult,
} from "@/runtime/use-runtime-state-stream";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";

const reloadBrowserIfServedBuildAssetsChangedMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/browser-build-asset-refresh", () => ({
	reloadBrowserIfServedBuildAssetsChanged: reloadBrowserIfServedBuildAssetsChangedMock,
}));

const reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock = vi.hoisted(() =>
	vi.fn(async () => "nonce-issued-on-stream-open"),
);

vi.mock("@/runtime/kanban-web-ui-page-load-request-origin-nonce-store", () => ({
	reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime:
		reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock,
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
	onTaskSessionSummaries,
}: {
	onSnapshot: (snapshot: UseRuntimeStateStreamResult) => void;
	onTaskSessionSummaries?: StreamedTaskSessionSummariesApplier;
}): null {
	const snapshot = useRuntimeStateStream(null, onTaskSessionSummaries);

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
		reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock.mockClear();
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

	it("reacquires the page-load nonce from the runtime on every stream connect and reconnect", async () => {
		await act(async () => {
			root.render(
				<RuntimeStateStreamHarness
					onSnapshot={() => {
						// Only the nonce reacquisition side effect matters here.
					}}
				/>,
			);
		});
		// 建连本身不算连上：只有 open 之后才向 runtime 签发。
		expect(reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock).not.toHaveBeenCalled();

		const initialSocket = MockRuntimeStateWebSocket.instances[0];
		if (!initialSocket) {
			throw new Error("Expected the initial runtime stream socket.");
		}
		await act(async () => {
			initialSocket.triggerOpen();
		});
		expect(reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock).toHaveBeenCalledTimes(1);

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
		expect(reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock).toHaveBeenCalledTimes(2);
	});

	it("keeps the stream running when reacquiring the page-load nonce fails", async () => {
		reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock.mockRejectedValueOnce(new Error("runtime down"));
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
		const initialSocket = MockRuntimeStateWebSocket.instances[0];
		if (!initialSocket) {
			throw new Error("Expected the initial runtime stream socket.");
		}
		await act(async () => {
			initialSocket.triggerOpen();
		});

		expect(reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntimeMock).toHaveBeenCalledTimes(1);
		expect(captured.current?.isRuntimeDisconnected).toBe(false);
	});

	it("rechecks project availability by replacing the current runtime stream connection", async () => {
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
		const initialSocket = MockRuntimeStateWebSocket.instances[0];
		if (!initialSocket || !captured.current) {
			throw new Error("Expected the initial runtime stream state.");
		}
		act(() => initialSocket.triggerOpen());

		act(() => captured.current?.recheckProjectAvailability());

		expect(initialSocket.readyState).toBe(MockRuntimeStateWebSocket.CLOSED);
		expect(MockRuntimeStateWebSocket.instances).toHaveLength(2);
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

	it("exploratory_findings_updated 全量替换落 store、按 workspace 过滤；快照保留 last-known", async () => {
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

		const finding = (findingId: string) => ({
			findingId,
			findingTitle: `Finding ${findingId}`,
			findingBodyMarkdown: "正文",
			findingStatus: "active",
			supersededByFindingId: null,
			findingGenerationSource: "user_saved",
			provenanceLinks: [
				{
					linkKind: "turn_anchor",
					conversationSessionTaskId: "session-1",
					turnNumber: 1,
					turnCheckpointCommit: null,
				},
			],
			originConversationSessionTaskId: "session-1",
			createdAt: 1,
			updatedAt: 1,
		});
		const triggerSnapshot = () =>
			socket.triggerMessage({
				type: "snapshot",
				currentProjectId: "ws-a",
				projects: [],
				workspaceState: null,
				workspaceMetadata: null,
				clineSessionContextVersion: 0,
				notificationLog: [],
			});

		await act(async () => {
			triggerSnapshot();
		});
		expect(captured.current?.exploratoryFindings).toBeNull();

		// 全量替换：第二次推送完整覆盖第一次（不是增量合并）。
		await act(async () => {
			socket.triggerMessage({
				type: "exploratory_findings_updated",
				workspaceId: "ws-a",
				findings: [finding("f-1"), finding("f-2")],
			});
		});
		expect(captured.current?.exploratoryFindings).toHaveLength(2);
		await act(async () => {
			socket.triggerMessage({
				type: "exploratory_findings_updated",
				workspaceId: "ws-a",
				findings: [finding("f-3")],
			});
		});
		expect(captured.current?.exploratoryFindings).toHaveLength(1);
		expect(captured.current?.exploratoryFindings?.[0]?.findingId).toBe("f-3");

		// 其它 workspace 的推送按 activeWorkspaceId 过滤，不得入 store。
		await act(async () => {
			socket.triggerMessage({
				type: "exploratory_findings_updated",
				workspaceId: "ws-b",
				findings: [finding("f-foreign")],
			});
		});
		expect(captured.current?.exploratoryFindings).toHaveLength(1);

		// 重连后的新快照：已推送的集合保留作 last-known（查询落定前不出现空窗），
		// 断连窗口的变更由 use-exploratory-findings 经快照代数重拉对齐。
		await act(async () => {
			triggerSnapshot();
		});
		expect(captured.current?.streamSnapshotGeneration).toBe(2);
		expect(captured.current?.exploratoryFindings).toHaveLength(1);
	});

	it("task_sessions_updated 不再经 reducer 产新 state：summaries 经旁路回调直送、workspaceState 引用不变", async () => {
		const applier = vi.fn();
		const snapshotCalls: UseRuntimeStateStreamResult[] = [];
		await act(async () => {
			root.render(
				<RuntimeStateStreamHarness
					onTaskSessionSummaries={applier}
					onSnapshot={(snapshot) => {
						snapshotCalls.push(snapshot);
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

		await act(async () => {
			socket.triggerMessage({
				type: "snapshot",
				currentProjectId: "ws-a",
				projects: [],
				workspaceState: {
					repoPath: "/tmp/ws-a",
					statePath: "/tmp/ws-a/.cline/kanban",
					git: null,
					board: { columns: [] },
					sessions: {},
					revision: 1,
				},
				workspaceMetadata: null,
				clineSessionContextVersion: 0,
				notificationLog: [],
			});
		});
		const snapshotCallsBeforeSessionsUpdate = snapshotCalls.length;
		const workspaceStateBeforeSessionsUpdate = snapshotCalls[snapshotCalls.length - 1]?.workspaceState;
		expect(workspaceStateBeforeSessionsUpdate).not.toBeNull();

		const summary = {
			taskId: "task-1",
			state: "running",
			agentId: "claude",
			workspacePath: "/tmp/ws-a",
			pid: 4242,
			startedAt: 1_000,
			updatedAt: 2_000,
			lastOutputAt: 2_000,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
		};
		await act(async () => {
			socket.triggerMessage({ type: "task_sessions_updated", workspaceId: "ws-a", summaries: [summary] });
		});

		// 旁路：summaries 原样送达 applier（经 JSON 往返，按深比较断言）。
		expect(applier).toHaveBeenCalledTimes(1);
		expect(applier).toHaveBeenCalledWith([summary]);
		// reducer 不再为该消息产新 state：没有重渲染，workspaceState 引用保持不动。
		expect(snapshotCalls.length).toBe(snapshotCallsBeforeSessionsUpdate);
		expect(snapshotCalls[snapshotCalls.length - 1]?.workspaceState).toBe(workspaceStateBeforeSessionsUpdate);

		// 其它 workspace 的批次仍被 activeWorkspaceId 过滤，不触达 applier。
		await act(async () => {
			socket.triggerMessage({ type: "task_sessions_updated", workspaceId: "ws-b", summaries: [summary] });
		});
		expect(applier).toHaveBeenCalledTimes(1);
		expect(snapshotCalls.length).toBe(snapshotCallsBeforeSessionsUpdate);
	});
});
