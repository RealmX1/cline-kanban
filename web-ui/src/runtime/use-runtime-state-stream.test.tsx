import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeLiveTaskResourceUsageSnapshot } from "@/runtime/types";
import type {
	StreamedTaskSessionSummariesApplier,
	UseRuntimeStateStreamResult,
} from "@/runtime/use-runtime-state-stream";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import {
	resetTaskResourceUsageSnapshotStore,
	useTaskResourceUsageSnapshotValue,
} from "@/stores/task-resource-usage-snapshot-store";

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

// 模拟卡体上的资源药丸：按卡片 id 订阅资源快照 store，把每次渲染看到的值交给测试。
function TaskResourceUsageSnapshotForTaskCardProbe({
	taskCardId,
	onTaskResourceUsageSnapshotRendered,
}: {
	taskCardId: string;
	onTaskResourceUsageSnapshotRendered: (snapshot: RuntimeLiveTaskResourceUsageSnapshot | null) => void;
}): null {
	onTaskResourceUsageSnapshotRendered(useTaskResourceUsageSnapshotValue(taskCardId));
	return null;
}

function buildTaskResourceUsageSnapshotForTaskCard(
	workspaceId: string,
	attributedTaskCardId: string,
	residentSetSizeKibibytesSumUpperBound: number,
): RuntimeLiveTaskResourceUsageSnapshot {
	return {
		workspaceId,
		attributedTaskCardId,
		sampledAtEpochMs: 1,
		attributedProcessCount: 3,
		residentSetSizeKibibytesSumUpperBound,
		cpuPercentOfOneCoreOverLastSampleInterval: 5,
		survivedSessionRootExitProcessCount: 0,
		survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
		agentHarnessRootPhysicalFootprintBytes: null,
		processCountByProcessClassification: {},
		residentSetSizeKibibytesSumUpperBoundByProcessClassification: {},
		mcpServerInstances: [],
	};
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
		// 资源快照 store 是模块级单例，跨用例会残留。
		resetTaskResourceUsageSnapshotStore();
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

	it("queued_task_prompt_deliveries_updated 整份替换落 store、按 workspace 过滤；快照保留 last-known", async () => {
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
		const projection = (queueEntryId: string) => ({
			queueEntryId,
			taskId: "task-1",
			deliveryState: "queued",
			textPreview: "跑测试",
			textLength: 3,
			deliverTogetherWithNextQueuedEntry: false,
			dispatchBlockReason: "agent_still_generating",
			awaitsHumanReconfirmationAfterRuntimeRestart: false,
			deliveryAttemptCount: 0,
			lastDeliveryFailureNote: null,
			sourcePromptLibraryEntryId: null,
			sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
			enqueuedAt: 1,
			expiresAt: 2,
			settledAt: null,
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
		expect(captured.current?.queuedTaskPromptDeliveryProjectionsByTaskId).toBeNull();

		await act(async () => {
			socket.triggerMessage({
				type: "queued_task_prompt_deliveries_updated",
				workspaceId: "ws-a",
				projectedEntriesByTaskId: { "task-1": [projection("q1"), projection("q2")] },
			});
		});
		expect(captured.current?.queuedTaskPromptDeliveryProjectionsByTaskId?.["task-1"]).toHaveLength(2);

		// 整份替换，不是增量合并：一次认领 / 落定会同时改好几条，增量补丁在断连重连之间极易错位。
		await act(async () => {
			socket.triggerMessage({
				type: "queued_task_prompt_deliveries_updated",
				workspaceId: "ws-a",
				projectedEntriesByTaskId: {},
			});
		});
		expect(captured.current?.queuedTaskPromptDeliveryProjectionsByTaskId).toEqual({});

		// 别的 workspace 的推送不得入 store（taskId 是 board-local 短 id，会撞号）。
		await act(async () => {
			socket.triggerMessage({
				type: "queued_task_prompt_deliveries_updated",
				workspaceId: "ws-b",
				projectedEntriesByTaskId: { "task-1": [projection("foreign")] },
			});
		});
		expect(captured.current?.queuedTaskPromptDeliveryProjectionsByTaskId).toEqual({});

		await act(async () => {
			socket.triggerMessage({
				type: "queued_task_prompt_deliveries_updated",
				workspaceId: "ws-a",
				projectedEntriesByTaskId: { "task-1": [projection("q3")] },
			});
		});
		await act(async () => {
			triggerSnapshot();
		});
		expect(captured.current?.queuedTaskPromptDeliveryProjectionsByTaskId?.["task-1"]?.[0]?.queueEntryId).toBe("q3");
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
					board: { columns: [], dependencies: [] },
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

	describe("资源快照 store 只装当前连接 workspace 的数据（卡片 id 只在一个看板内唯一）", () => {
		const buildProjectSummary = (projectId: string) => ({
			id: projectId,
			path: `/tmp/${projectId}`,
			name: projectId,
			taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
			availability: { status: "available" },
			inProgressTaskDetails: [],
		});
		const buildStreamSnapshotMessage = (currentProjectId: string, projectIds: string[]) => ({
			type: "snapshot",
			currentProjectId,
			projects: projectIds.map(buildProjectSummary),
			workspaceState: null,
			workspaceMetadata: null,
			clineSessionContextVersion: 0,
			notificationLog: [],
		});

		// requestedWorkspaceId 为 null 挂载 hook，并在同一棵树里挂一个订阅 "aa111" 卡片资源快照的药丸探针。
		async function mountStreamWithTaskCardResourceUsageProbe(): Promise<{
			latestRenderedSnapshotForTaskCard: () => RuntimeLiveTaskResourceUsageSnapshot | null;
		}> {
			const renderedSnapshotsForTaskCard: (RuntimeLiveTaskResourceUsageSnapshot | null)[] = [];
			await act(async () => {
				root.render(
					<>
						<RuntimeStateStreamHarness
							onSnapshot={() => {
								// 本组用例只看资源快照 store，不关心 hook 返回值。
							}}
						/>
						<TaskResourceUsageSnapshotForTaskCardProbe
							taskCardId="aa111"
							onTaskResourceUsageSnapshotRendered={(snapshot) => {
								renderedSnapshotsForTaskCard.push(snapshot);
							}}
						/>
					</>,
				);
			});
			return {
				latestRenderedSnapshotForTaskCard: () => renderedSnapshotsForTaskCard.at(-1) ?? null,
			};
		}

		it("projects_updated 在同一 effect 内自动切到另一个 workspace 时先清空，旧仓库同 id 卡片的 RSS/CPU 不得残留", async () => {
			const { latestRenderedSnapshotForTaskCard } = await mountStreamWithTaskCardResourceUsageProbe();
			const initialSocket = MockRuntimeStateWebSocket.instances[0];
			if (!initialSocket) {
				throw new Error("Expected the initial runtime stream socket.");
			}
			act(() => initialSocket.triggerOpen());
			await act(async () => {
				initialSocket.triggerMessage(buildStreamSnapshotMessage("ws-a", ["ws-a", "ws-b"]));
			});
			await act(async () => {
				initialSocket.triggerMessage({
					type: "task_resource_usage_snapshots_updated",
					workspaceId: "ws-a",
					snapshots: [buildTaskResourceUsageSnapshotForTaskCard("ws-a", "aa111", 777_000)],
				});
			});
			expect(latestRenderedSnapshotForTaskCard()?.residentSetSizeKibibytesSumUpperBound).toBe(777_000);

			// ws-a 被移除，服务端把当前项目改成 ws-b：hook 内部改连 ws-b，effect 本身不重建。
			await act(async () => {
				initialSocket.triggerMessage({
					type: "projects_updated",
					currentProjectId: "ws-b",
					projects: [buildProjectSummary("ws-b")],
				});
			});
			const switchedSocket = MockRuntimeStateWebSocket.instances[1];
			expect(switchedSocket?.url).toContain("workspaceId=ws-b");
			// ws-b 的首份资源快照尚未到达（hub 可能还没有缓存）：ws-a 的 aa111 不得冒充 ws-b 的 aa111。
			expect(latestRenderedSnapshotForTaskCard()).toBeNull();
		});

		it("未指定 workspace 的重连握手落到另一个 workspace 时同样清空；落回同一 workspace 则保留 last-known", async () => {
			const { latestRenderedSnapshotForTaskCard } = await mountStreamWithTaskCardResourceUsageProbe();
			const initialSocket = MockRuntimeStateWebSocket.instances[0];
			if (!initialSocket) {
				throw new Error("Expected the initial runtime stream socket.");
			}
			act(() => initialSocket.triggerOpen());
			await act(async () => {
				initialSocket.triggerMessage(buildStreamSnapshotMessage("ws-a", ["ws-a", "ws-b"]));
			});
			await act(async () => {
				initialSocket.triggerMessage({
					type: "task_resource_usage_snapshots_updated",
					workspaceId: "ws-a",
					snapshots: [buildTaskResourceUsageSnapshotForTaskCard("ws-a", "aa111", 777_000)],
				});
			});

			// 重连落回同一 workspace：保留 last-known，不在下一个采样 tick 前闪成空。
			act(() => {
				initialSocket.triggerClose();
				vi.advanceTimersByTime(500);
			});
			const sameWorkspaceReconnectedSocket = MockRuntimeStateWebSocket.instances[1];
			if (!sameWorkspaceReconnectedSocket) {
				throw new Error("Expected a reconnected runtime stream socket.");
			}
			act(() => sameWorkspaceReconnectedSocket.triggerOpen());
			await act(async () => {
				sameWorkspaceReconnectedSocket.triggerMessage(buildStreamSnapshotMessage("ws-a", ["ws-a", "ws-b"]));
			});
			expect(latestRenderedSnapshotForTaskCard()?.residentSetSizeKibibytesSumUpperBound).toBe(777_000);

			// 重连时没带 workspaceId，服务端按自己的 active workspace（可被别的标签页改掉）落到 ws-b。
			act(() => {
				sameWorkspaceReconnectedSocket.triggerClose();
				vi.advanceTimersByTime(500);
			});
			const otherWorkspaceReconnectedSocket = MockRuntimeStateWebSocket.instances[2];
			if (!otherWorkspaceReconnectedSocket) {
				throw new Error("Expected a second reconnected runtime stream socket.");
			}
			expect(otherWorkspaceReconnectedSocket.url).not.toContain("workspaceId=");
			act(() => otherWorkspaceReconnectedSocket.triggerOpen());
			await act(async () => {
				otherWorkspaceReconnectedSocket.triggerMessage(buildStreamSnapshotMessage("ws-b", ["ws-a", "ws-b"]));
			});
			expect(latestRenderedSnapshotForTaskCard()).toBeNull();
		});
	});
});
