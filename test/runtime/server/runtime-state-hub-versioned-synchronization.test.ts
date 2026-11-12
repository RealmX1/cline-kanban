import { EventEmitter, once } from "node:events";
import { createServer, IncomingMessage, type Server } from "node:http";
import { type AddressInfo, connect, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
	notifyAgentSessionPtyHostDiagnosticsChanged,
	subscribeToAgentSessionPtyHostDiagnosticsChanges,
} from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-diagnostics";
import {
	type RuntimeProjectSummary,
	type RuntimeStateStreamMessage,
	type RuntimeStateStreamSnapshotMessage,
	runtimeWorkspaceStateResponseSchema,
} from "../../../src/core/api-contract";
import { applyRuntimeStateEntityUpdate } from "../../../src/core/runtime-state-stream-entity-synchronization";
import {
	createRuntimeStateBroadcastCostRecorder,
	type RuntimeStateBroadcastCostWindowSample,
} from "../../../src/diagnostics/runtime-state-broadcast-cost-recorder";
import { getNotificationLifecycleArchive } from "../../../src/notifications/notification-lifecycle-archive";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../../src/server/runtime-state-hub";
import { createTempDir } from "../../utilities/temp-dir";

// 此处只替换诊断事件生产者；订阅门控、合并窗口和 WebSocket 均走真实 hub。
const diagnosticsProducer = vi.hoisted(() => ({ revision: 0, listeners: new Set<(revision: number) => void>() }));
vi.mock(
	"../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-diagnostics",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		subscribeToAgentSessionPtyHostDiagnosticsChanges: (listener: (revision: number) => void) => {
			diagnosticsProducer.listeners.add(listener);
			return () => diagnosticsProducer.listeners.delete(listener);
		},
		notifyAgentSessionPtyHostDiagnosticsChanged: () => {
			diagnosticsProducer.revision++;
			for (const listener of diagnosticsProducer.listeners) listener(diagnosticsProducer.revision);
		},
	}),
);

interface StreamClient {
	transportSocket: Socket | null;
	socket: WebSocket;
	messages: RuntimeStateStreamMessage[];
	events: EventEmitter;
}
async function nextMessage<Type extends RuntimeStateStreamMessage["type"]>(
	client: StreamClient,
	type: Type,
): Promise<Extract<RuntimeStateStreamMessage, { type: Type }>> {
	return await new Promise((done, reject) => {
		const timer = setTimeout(() => {
			client.events.off("message", read);
			reject(new Error(`等待状态帧超时：${type}`));
		}, 10000);
		const read = () => {
			const index = client.messages.findIndex((message) => message.type === type);
			if (index < 0) return;
			clearTimeout(timer);
			client.events.off("message", read);
			done(client.messages.splice(index, 1)[0] as Extract<RuntimeStateStreamMessage, { type: Type }>);
		};
		client.events.on("message", read);
		read();
	});
}

describe("状态流 v2 首帧失败的内存传输恢复", () => {
	it("缺基线请求进入真实 hub，失败后按来源变化恢复且继续订阅原工作区", async () => {
		const temporaryHome = createTempDir("runtime-state-initial-snapshot-recovery-");
		const previousHome = process.env.HOME;
		process.env.HOME = temporaryHome.path;
		let releaseNotificationReplay!: () => void;
		const notificationReplayRelease = new Promise<void>((resolve) => {
			releaseNotificationReplay = resolve;
		});
		const notificationReplayRead = vi
			.spyOn(getNotificationLifecycleArchive(), "recentReady")
			.mockImplementationOnce(async () => {
				await notificationReplayRelease;
				return [];
			});
		class InMemoryStateStreamClient extends EventEmitter {
			readyState: number = WebSocket.OPEN;
			bufferedAmount = 0;
			readonly messages: RuntimeStateStreamMessage[] = [];
			send(serializedPayload: string): void {
				this.messages.push(JSON.parse(serializedPayload) as RuntimeStateStreamMessage);
			}
			close(): void {
				this.readyState = WebSocket.CLOSED;
				this.emit("close");
			}
			terminate(): void {
				this.close();
			}
		}
		let client = new InMemoryStateStreamClient();
		let workspaceIsAvailable = true;
		const upgrade = vi
			.spyOn(WebSocketServer.prototype, "handleUpgrade")
			.mockImplementation((_request, _socket, _head, accept) => accept(client as unknown as WebSocket, _request));
		let workspaceState = runtimeWorkspaceStateResponseSchema.parse({
			repoPath: temporaryHome.path,
			statePath: temporaryHome.path,
			revision: 1,
			git: { currentBranch: "main", defaultBranch: "main", branches: [] },
			board: { columns: [] },
			sessions: {},
		});
		const buildWorkspaceStateSnapshot = vi
			.fn(async () => workspaceState)
			.mockRejectedValueOnce(new Error("首帧读取失败"))
			.mockRejectedValueOnce(new Error("首次补证失败"));
		const broadcastCostSamples: RuntimeStateBroadcastCostWindowSample[] = [];
		const broadcastCostRecorder = createRuntimeStateBroadcastCostRecorder({
			writeWindowSample: (sample) => broadcastCostSamples.push(sample),
		});
		const hub = createRuntimeStateHub({
			runtimeStateBroadcastCostRecorder: broadcastCostRecorder,
			workspaceRegistry: {
				resolveWorkspaceForStream: async () =>
					workspaceIsAvailable
						? { status: "available", projectId: "workspace", workspacePath: temporaryHome.path }
						: { status: "no_registered_project", projectId: null, workspacePath: null },
				buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async () => ({
					currentProjectId: workspaceIsAvailable ? "workspace" : null,
					projects: [],
				}),
				buildWorkspaceStateSnapshot,
			},
		});
		const transportSocket = new Socket();
		try {
			const request = new IncomingMessage(transportSocket);
			request.url = "/api/runtime/ws?stateProtocolVersion=2";
			hub.handleUpgrade(request, transportSocket, Buffer.alloc(0), {
				requestedWorkspaceId: "workspace",
				initialWorkspaceMetadataProbeScope: {
					workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
					focusedTaskIds: [],
				},
			});
			await vi.waitFor(() => expect(client.messages).toContainEqual({ type: "error", message: "首帧读取失败" }));
			client.emit("message", JSON.stringify({ type: "request_state_snapshot_v2" }), false);
			await vi.waitFor(() => expect(client.messages).toContainEqual({ type: "error", message: "首次补证失败" }));
			broadcastCostRecorder.flushWindow();
			workspaceState = { ...workspaceState, revision: 2 };
			await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
			const sourceVersion = client.messages.find((message) => message.type === "state_version_v2");
			expect(sourceVersion?.workspaceId).toBe("workspace");
			await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
			expect(client.messages.filter((message) => message.type === "state_version_v2")).toHaveLength(1);
			broadcastCostRecorder.flushWindow();
			expect(broadcastCostSamples.at(-1)?.operations.workspace_state_updated).toMatchObject({
				webSocketSendAttemptCount: 1,
				webSocketAcceptedSendCount: 1,
				webSocketDeduplicatedClientSkipCount: 1,
				webSocketSubmittedApplicationPayloadBytes: Buffer.byteLength(JSON.stringify(sourceVersion)),
			});
			client.emit("message", JSON.stringify({ type: "request_state_snapshot_v2" }), false);
			await vi.waitFor(() =>
				expect(client.messages.some((message) => message.type === "state_snapshot_v2")).toBe(true),
			);
			const restored = client.messages.find((message) => message.type === "state_snapshot_v2");
			expect(restored?.workspaceId).toBe("workspace");
			expect(restored?.snapshot.workspaceState?.revision).toBe(2);
			await vi.waitFor(() => expect(notificationReplayRead).toHaveBeenCalledTimes(1));
			// 首帧后的通知档案读取仍挂起，版本核对与再次补快照也必须得到响应。
			client.emit(
				"message",
				JSON.stringify({
					type: "confirm_state_version_v2",
					runtimeGenerationId: restored?.runtimeGenerationId,
					sequenceNumber: 0,
				}),
				false,
			);
			await vi.waitFor(() =>
				expect(client.messages.filter((message) => message.type === "state_snapshot_v2")).toHaveLength(2),
			);
			client.emit("message", JSON.stringify({ type: "request_state_snapshot_v2" }), false);
			await vi.waitFor(() =>
				expect(client.messages.filter((message) => message.type === "state_snapshot_v2")).toHaveLength(3),
			);
			releaseNotificationReplay();
			broadcastCostRecorder.flushWindow();
			workspaceState = { ...workspaceState, revision: 3 };
			await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
			broadcastCostRecorder.flushWindow();
			const submittedDelta = [...client.messages].reverse().find((message) => message.type === "state_delta_v2");
			expect(broadcastCostSamples.at(-1)?.operations.workspace_state_updated).toMatchObject({
				webSocketSendAttemptCount: 1,
				webSocketAcceptedSendCount: 1,
				webSocketDeduplicatedClientSkipCount: 0,
				webSocketSubmittedApplicationPayloadBytes: Buffer.byteLength(JSON.stringify(submittedDelta)),
			});
			expect(client.messages).toContainEqual(
				expect.objectContaining({
					type: "state_delta_v2",
					workspaceId: "workspace",
					update: expect.objectContaining({
						type: "workspace_patch",
						workspace: expect.objectContaining({ revision: 3 }),
					}),
				}),
			);
			broadcastCostRecorder.flushWindow();
			workspaceState = { ...workspaceState, revision: 4 };
			const originalStringify = JSON.stringify;
			const preparationFailure = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
				if (value?.type === "state_delta_v2") throw new Error("隔离消息转换失败");
				return originalStringify(value);
			});
			try {
				await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
			} finally {
				preparationFailure.mockRestore();
			}
			broadcastCostRecorder.flushWindow();
			expect(broadcastCostSamples.at(-1)?.operations.workspace_state_updated).toMatchObject({
				webSocketSendAttemptCount: 0,
				webSocketAcceptedSendCount: 0,
				webSocketMessagePreparationFailureCount: 1,
				webSocketSubmittedApplicationPayloadBytes: 0,
			});
			await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
			expect(client.messages.filter((message) => message.type === "state_delta_v2").at(-1)?.update).toMatchObject({
				type: "workspace_patch",
				workspace: { revision: 4 },
			});
			client.close();
			client = new InMemoryStateStreamClient();
			buildWorkspaceStateSnapshot.mockRejectedValueOnce(new Error("项目移除前首帧失败"));
			hub.handleUpgrade(request, transportSocket, Buffer.alloc(0), {
				requestedWorkspaceId: null,
				initialWorkspaceMetadataProbeScope: null,
			});
			await vi.waitFor(() =>
				expect(client.messages).toContainEqual({ type: "error", message: "项目移除前首帧失败" }),
			);
			workspaceIsAvailable = false;
			client.emit("message", JSON.stringify({ type: "request_state_snapshot_v2" }), false);
			await vi.waitFor(() =>
				expect(client.messages.some((message) => message.type === "state_snapshot_v2")).toBe(true),
			);
			expect(client.messages.find((message) => message.type === "state_snapshot_v2")?.workspaceId).toBeNull();
			const workspaceBuildCountBeforeRemovedWorkspaceBroadcast = buildWorkspaceStateSnapshot.mock.calls.length;
			await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
			expect(buildWorkspaceStateSnapshot).toHaveBeenCalledTimes(workspaceBuildCountBeforeRemovedWorkspaceBroadcast);
		} finally {
			releaseNotificationReplay();
			await hub.close();
			transportSocket.destroy();
			upgrade.mockRestore();
			notificationReplayRead.mockRestore();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			temporaryHome.cleanup();
		}
	});
});

describe("状态流 v2 的真实连接与恢复", { timeout: 45000 }, () => {
	let temporaryHome: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let hub: RuntimeStateHub;
	let server: Server;
	let origin: string;
	let clients: StreamClient[];
	let state: ReturnType<typeof runtimeWorkspaceStateResponseSchema.parse>;
	let projects: RuntimeProjectSummary[];
	let workspaceSnapshotBuildFailuresRemaining: number;
	let holdBuild: { started: () => void; released: Promise<void> } | null;
	beforeEach(async () => {
		diagnosticsProducer.revision = 0;
		diagnosticsProducer.listeners.clear();
		temporaryHome = createTempDir("runtime-state-v2-");
		previousHome = process.env.HOME;
		process.env.HOME = temporaryHome.path;
		clients = [];
		holdBuild = null;
		workspaceSnapshotBuildFailuresRemaining = 0;
		state = runtimeWorkspaceStateResponseSchema.parse({
			repoPath: temporaryHome.path,
			statePath: temporaryHome.path,
			revision: 1,
			git: { currentBranch: "main", defaultBranch: "main", branches: [] },
			board: {
				columns: [
					{
						id: "backlog",
						title: "待办",
						cards: [
							{
								id: "task",
								title: "原始卡片",
								prompt: "保留完整提示词。".repeat(1000),
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			},
			sessions: {},
		});
		projects = [
			{
				id: "workspace",
				path: temporaryHome.path,
				name: "项目",
				taskCounts: { backlog: 1, in_progress: 0, review: 0, validation: 0, trash: 0 },
				availability: { status: "available" },
				inProgressTaskDetails: [],
				crossProjectTaskSwitcherEntries: [],
			},
		];
		hub = createRuntimeStateHub({
			runtimeStateBroadcastCostRecorder: null,
			workspaceRegistry: {
				resolveWorkspaceForStream: async () => ({
					status: "available",
					projectId: "workspace",
					workspacePath: temporaryHome.path,
				}),
				buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async () => ({
					currentProjectId: "workspace",
					projects: structuredClone(projects),
				}),
				buildWorkspaceStateSnapshot: async () => {
					if (workspaceSnapshotBuildFailuresRemaining > 0) {
						workspaceSnapshotBuildFailuresRemaining -= 1;
						throw new Error("测试首帧读取暂时失败");
					}
					const captured = structuredClone(state);
					const hold = holdBuild;
					if (hold) {
						holdBuild = null;
						hold.started();
						await hold.released;
					}
					return captured;
				},
			},
		});
		server = createServer();
		server.on("upgrade", (request, socket, head) =>
			hub.handleUpgrade(request, socket, head, {
				requestedWorkspaceId: "workspace",
				initialWorkspaceMetadataProbeScope: {
					workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
					focusedTaskIds: [],
				},
			}),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterEach(async () => {
		for (const client of clients) client.socket.terminate();
		await hub.close();
		await new Promise<void>((done) => server.close(() => done()));
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		temporaryHome.cleanup();
	});
	async function open(version = 2, perMessageDeflate = true): Promise<StreamClient> {
		let transportSocket: Socket | null = null;
		const socket = new WebSocket(`${origin}/api/runtime/ws?stateProtocolVersion=${version}`, {
			perMessageDeflate,
			createConnection: () => {
				transportSocket = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) });
				return transportSocket;
			},
		});
		const client: StreamClient = { socket, messages: [], events: new EventEmitter(), transportSocket: null };
		clients.push(client);
		socket.on("message", (raw) => {
			client.messages.push(JSON.parse(String(raw)) as RuntimeStateStreamMessage);
			client.events.emit("message");
		});
		await once(socket, "open");
		client.transportSocket = transportSocket;
		return client;
	}
	function holdNextBuild() {
		let started!: () => void;
		let release!: () => void;
		const startedPromise = new Promise<void>((done) => {
			started = done;
		});
		holdBuild = {
			started,
			released: new Promise<void>((done) => {
				release = done;
			}),
		};
		return { started: startedPromise, release };
	}

	it("首次快照失败后同一连接可补齐基线，重复请求不并发构建，随后继续接收增量", async () => {
		workspaceSnapshotBuildFailuresRemaining = 1;
		const client = await open();
		expect((await nextMessage(client, "error")).message).toBe("测试首帧读取暂时失败");
		const hold = holdNextBuild();
		client.socket.send(JSON.stringify({ type: "request_state_snapshot_v2" }));
		await hold.started;
		client.socket.send(JSON.stringify({ type: "request_state_snapshot_v2" }));
		client.socket.send(JSON.stringify({ type: "request_state_snapshot_v2" }));
		const duplicateRequestsProcessed = once(client.socket, "pong");
		client.socket.ping();
		await duplicateRequestsProcessed;
		projects = projects.map((project) => ({ ...project, name: "恢复中的项目" }));
		await hub.broadcastRuntimeProjectsUpdated("workspace");
		hold.release();
		const initial = await nextMessage(client, "state_snapshot_v2");
		expect(initial.snapshot.workspaceState).toEqual(state);
		expect(initial.workspaceId).toBe("workspace");
		state = { ...state, revision: 2 };
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		let current = initial.snapshot;
		while (current.workspaceState?.revision !== 2) {
			const delta = await nextMessage(client, "state_delta_v2");
			current = applyRuntimeStateEntityUpdate(current, delta.update);
		}
		expect(current.projects[0]?.name).toBe("恢复中的项目");
		expect(client.messages.filter((message) => message.type === "state_snapshot_v2")).toHaveLength(0);
	});

	it("缺基线连接耗尽补证后仍能收到去重的来源版本变化并恢复原工作区", async () => {
		workspaceSnapshotBuildFailuresRemaining = 4;
		const client = await open();
		await nextMessage(client, "error");
		for (let attempt = 0; attempt < 3; attempt++) {
			client.socket.send(JSON.stringify({ type: "request_state_snapshot_v2" }));
			await nextMessage(client, "error");
		}
		state = { ...state, revision: 2 };
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		const sourceChanged = await nextMessage(client, "state_version_v2");
		expect(sourceChanged.workspaceId).toBe("workspace");
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		const restored = await readFreshSnapshot(client);
		expect(restored.runtimeGenerationId).toBe(sourceChanged.runtimeGenerationId);
		expect(restored.sequenceNumber).toBe(sourceChanged.sequenceNumber + 1);
		expect(restored.snapshot.workspaceState?.revision).toBe(2);
		expect(client.messages.filter((message) => message.type === "state_version_v2")).toHaveLength(0);
	});

	it("压缩首帧，按实体更新且旧客户端继续收到原协议", async () => {
		const modern = await open();
		const initial = await nextMessage(modern, "state_snapshot_v2");
		expect(modern.socket.extensions).toContain("permessage-deflate");
		const legacy = await open(1);
		await nextMessage(legacy, "snapshot");
		state = {
			...state,
			revision: 2,
			board: {
				columns: state.board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => ({ ...card, title: "更新后的卡片" })),
				})),
			},
		};
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		const delta = await nextMessage(modern, "state_delta_v2");
		expect(delta.previousSequenceNumber).toBe(initial.sequenceNumber);
		expect(delta.runtimeGenerationId).toBe(initial.runtimeGenerationId);
		expect(applyRuntimeStateEntityUpdate(initial.snapshot, delta.update).workspaceState).toEqual(state);
		expect((await nextMessage(legacy, "workspace_state_updated")).workspaceState).toEqual(state);
	});

	it("首帧构建时发生的变化在首帧后定向补齐", async () => {
		const hold = holdNextBuild();
		const client = await open();
		await hold.started;
		state = { ...state, revision: 2 };
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		hold.release();
		const initial = await nextMessage(client, "state_snapshot_v2");
		expect(initial.snapshot.workspaceState?.revision).toBe(1);
		let current: RuntimeStateStreamSnapshotMessage = initial.snapshot;
		for (let count = 0; count < 5; count++) {
			const delta = await nextMessage(client, "state_delta_v2");
			current = applyRuntimeStateEntityUpdate(current, delta.update);
			if (current.workspaceState?.revision === 2) break;
		}
		expect(current.workspaceState?.revision).toBe(2);
	});

	it("较早启动而较晚完成的构建不能倒退工作区", async () => {
		const client = await open();
		await nextMessage(client, "state_snapshot_v2");
		state = { ...state, revision: 2 };
		const hold = holdNextBuild();
		const oldBroadcast = hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		await hold.started;
		state = { ...state, revision: 3 };
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		hold.release();
		await oldBroadcast;
		let revision = 0;
		while (revision !== 3) {
			const delta = await nextMessage(client, "state_delta_v2");
			if (delta.update.type === "workspace_patch") revision = delta.update.workspace.revision;
		}
		await new Promise((done) => setTimeout(done, 200));
		expect(
			client.messages.some(
				(message) =>
					message.type === "state_delta_v2" &&
					message.update.type === "workspace_patch" &&
					message.update.workspace.revision === 2,
			),
		).toBe(false);
	});

	it("确认版本会核验来源，缺口补完整快照，新连接不使已有连接重收项目", async () => {
		const client = await open();
		const initial = await nextMessage(client, "state_snapshot_v2");
		await hub.broadcastRuntimeProjectsUpdated("workspace");
		const second = await open();
		const secondInitial = await nextMessage(second, "state_snapshot_v2");
		expect(secondInitial.sequenceNumber).toBe(1);
		client.socket.send(
			JSON.stringify({
				type: "confirm_state_version_v2",
				runtimeGenerationId: initial.runtimeGenerationId,
				sequenceNumber: 0,
			}),
		);
		const restored = await nextMessage(client, "state_snapshot_v2");
		expect(restored.sequenceNumber).toBeGreaterThan(initial.sequenceNumber);
		expect(second.messages.some((message) => message.type === "state_snapshot_v2")).toBe(false);
		client.socket.send(
			JSON.stringify({
				type: "confirm_state_version_v2",
				runtimeGenerationId: restored.runtimeGenerationId,
				sequenceNumber: restored.sequenceNumber,
			}),
		);
		await nextMessage(client, "state_version_v2");
	});
	async function readFreshSnapshot(client: StreamClient) {
		client.socket.send(JSON.stringify({ type: "request_state_snapshot_v2" }));
		return await nextMessage(client, "state_snapshot_v2");
	}
	it("接收受阻的连接在发送缓冲上限后关闭，重新连接恢复完整内容", async () => {
		const slow = await open(2, false);
		await nextMessage(slow, "state_snapshot_v2");
		const transportSocket = slow.transportSocket;
		if (!transportSocket) throw new Error("未取得受控 TCP 连接");
		transportSocket.pause();
		const closed = once(slow.socket, "close");
		const originalCard = state.board.columns[0]?.cards[0];
		if (!originalCard) throw new Error("缺少压力场景的原始卡片");
		state = {
			...state,
			revision: 2,
			board: {
				columns: [
					{
						id: "backlog",
						title: "待办",
						cards: Array.from({ length: 1000 }, (_, index) => ({
							...originalCard,
							id: `pressure-${index}`,
							prompt: "p".repeat(16384),
						})),
					},
				],
			},
		};
		projects = projects.map((project) => ({ ...project, taskCounts: { ...project.taskCounts, backlog: 1000 } }));
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		state = { ...state, revision: 3 };
		await hub.broadcastRuntimeWorkspaceStateUpdated("workspace", temporaryHome.path);
		transportSocket.resume();
		expect((await closed)[0]).toBe(1013);
		const recovered = await open();
		const snapshot = await nextMessage(recovered, "state_snapshot_v2");
		expect(snapshot.snapshot.workspaceState?.revision).toBe(3);
		expect(snapshot.snapshot.workspaceState?.board.columns[0]?.cards).toHaveLength(1000);
		expect(snapshot.snapshot.workspaceState?.board.columns[0]?.cards[999]?.prompt).toHaveLength(16384);
	});
	it("PTY 诊断只发给订阅者，连续失效合并为最新 revision", async () => {
		const client = await open();
		await nextMessage(client, "state_snapshot_v2");
		notifyAgentSessionPtyHostDiagnosticsChanged();
		await readFreshSnapshot(client);
		expect(
			client.messages.filter((message) => message.type === "agent_session_pty_host_diagnostics_updated"),
		).toHaveLength(0);
		client.socket.send(JSON.stringify({ type: "declare_pty_host_diagnostics_subscription", subscribed: true }));
		await readFreshSnapshot(client);
		let latestRevision = 0;
		const unsubscribe = subscribeToAgentSessionPtyHostDiagnosticsChanges((revision) => {
			latestRevision = revision;
		});
		try {
			notifyAgentSessionPtyHostDiagnosticsChanged();
			notifyAgentSessionPtyHostDiagnosticsChanged();
			notifyAgentSessionPtyHostDiagnosticsChanged();
			const update = await nextMessage(client, "agent_session_pty_host_diagnostics_updated");
			expect(update.revision).toBe(latestRevision);
			await readFreshSnapshot(client);
			expect(
				client.messages.filter((message) => message.type === "agent_session_pty_host_diagnostics_updated"),
			).toHaveLength(0);
			client.socket.send(JSON.stringify({ type: "declare_pty_host_diagnostics_subscription", subscribed: false }));
			await readFreshSnapshot(client);
			notifyAgentSessionPtyHostDiagnosticsChanged();
			await readFreshSnapshot(client);
			expect(
				client.messages.filter((message) => message.type === "agent_session_pty_host_diagnostics_updated"),
			).toHaveLength(0);
		} finally {
			unsubscribe();
		}
	});
	it("相同内容的通知日志不会连续广播", async () => {
		const client = await open();
		await nextMessage(client, "state_snapshot_v2");
		await hub.broadcastNotificationLogUpdated("workspace");
		await hub.broadcastNotificationLogUpdated("workspace");
		await readFreshSnapshot(client);
		expect(
			client.messages.filter((message) => message.type === "notification_log_updated").length,
		).toBeLessThanOrEqual(1);
	});
});
