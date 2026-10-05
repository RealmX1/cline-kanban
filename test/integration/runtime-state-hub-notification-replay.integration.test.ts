import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RuntimeStateStreamMessage, RuntimeWorkspaceStateResponse } from "../../src/core/api-contract";
import type { NotificationCandidate } from "../../src/core/notification-lifecycle-contract";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../src/server/runtime-state-hub";

const { recentReady, disconnectWorkspace } = vi.hoisted(() => ({
	recentReady: vi.fn<() => Promise<NotificationCandidate[]>>(),
	disconnectWorkspace: vi.fn(),
}));
vi.mock("../../src/notifications/notification-lifecycle-archive", () => ({
	getNotificationLifecycleArchive: () => ({ recentReady }),
}));
vi.mock("../../src/notifications/notification-assessment-service", () => ({
	createNotificationAssessmentService: () => ({ close: vi.fn() }),
}));
vi.mock("../../src/state/notification-log-store", () => ({
	readAllNotificationLogs: async () => ({}),
	readNotificationLog: async () => [],
}));
vi.mock("../../src/server/workspace-metadata-monitor", () => ({
	createWorkspaceMetadataMonitor: () => ({
		connectWorkspace: async () => ({ homeGitSummary: null, homeGitStateVersion: 0, taskWorkspaces: [] }),
		updateWorkspaceState: vi.fn(),
		disconnectWorkspace,
		close: vi.fn(),
	}),
}));

// 「终会发生」的单档等待（档案读取是 mock，等的是 WS snapshot 与广播送达）：vi.waitFor 默认 1s 在高负载下不够。
// 放宽不损失判别力——断言判的是「最终收到了什么」，不是多快。
const STREAM_MESSAGE_ARRIVAL_WAIT_OPTIONS_TOLERANT_OF_HOST_LOAD = { timeout: 10_000 };

// 用例超时覆盖：一个用例里最多三次上述等待 + WS 连接与关闭。
describe("通知档案重放不阻塞核心 workspace 推送", { timeout: 40_000 }, () => {
	let hub: RuntimeStateHub;
	let server: Server;
	let client: WebSocket | undefined;
	let streamUrl: string;
	let messages: RuntimeStateStreamMessage[];
	const workspaceId = "notification-replay-workspace";
	const workspacePath = "/isolated-notification-replay-workspace";
	const workspaceState: RuntimeWorkspaceStateResponse = {
		repoPath: workspacePath,
		statePath: `${workspacePath}/state.json`,
		git: { currentBranch: null, defaultBranch: null, branches: [] },
		board: { columns: [] },
		sessions: {},
		revision: 1,
	};
	const buildWorkspaceStateSnapshot = vi.fn(async () => workspaceState);

	beforeEach(async () => {
		vi.clearAllMocks();
		recentReady.mockReset();
		messages = [];
		client = undefined;
		hub = createRuntimeStateHub({
			workspaceRegistry: {
				resolveWorkspaceForStream: async () => ({ status: "available", projectId: workspaceId, workspacePath }),
				buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async () => ({
					currentProjectId: workspaceId,
					projects: [],
				}),
				buildWorkspaceStateSnapshot,
			},
		});
		server = createServer();
		server.on("upgrade", (request, socket, head) => {
			hub.handleUpgrade(request, socket, head, {
				requestedWorkspaceId: workspaceId,
				initialWorkspaceMetadataProbeScope: null,
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		streamUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		client?.terminate();
		await hub.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	async function connectAndReceiveSnapshot() {
		client = new WebSocket(streamUrl);
		client.on("message", (message) => messages.push(JSON.parse(String(message)) as RuntimeStateStreamMessage));
		await once(client, "open");
		await vi.waitFor(
			() => expect(messages.some((message) => message.type === "snapshot")).toBe(true),
			STREAM_MESSAGE_ARRIVAL_WAIT_OPTIONS_TOLERANT_OF_HOST_LOAD,
		);
		return client;
	}

	async function expectWorkspaceUpdate() {
		await hub.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
		await vi.waitFor(
			() => expect(messages.some((message) => message.type === "workspace_state_updated")).toBe(true),
			STREAM_MESSAGE_ARRIVAL_WAIT_OPTIONS_TOLERANT_OF_HOST_LOAD,
		);
		expect(messages.some((message) => message.type === "error")).toBe(false);
	}

	it("档案读取拒绝后仍收到核心 workspace 更新", async () => {
		recentReady.mockRejectedValue(new Error("SQLITE_BUSY"));
		await connectAndReceiveSnapshot();
		await expectWorkspaceUpdate();
		expect(disconnectWorkspace).not.toHaveBeenCalled();
	});

	it.each(["resolve", "reject"] as const)("重放等待中仍推送；断连后 %s 不会重注册或重复释放", async (outcome) => {
		let completeReplay!: () => void;
		recentReady.mockImplementation(
			() =>
				new Promise((resolve, reject) => {
					completeReplay = () => (outcome === "resolve" ? resolve([]) : reject(new Error("archive unavailable")));
				}),
		);
		try {
			const connectedClient = await connectAndReceiveSnapshot();
			await expectWorkspaceUpdate();
			connectedClient.close();
			await once(connectedClient, "close");
			await vi.waitFor(
				() => expect(disconnectWorkspace).toHaveBeenCalledTimes(1),
				STREAM_MESSAGE_ARRIVAL_WAIT_OPTIONS_TOLERANT_OF_HOST_LOAD,
			);
		} finally {
			completeReplay?.();
		}
		// 等待重放 continuation 完成，再确认 workspace 集合已清理。
		await new Promise<void>((resolve) => setImmediate(resolve));
		buildWorkspaceStateSnapshot.mockClear();
		await hub.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
		expect(buildWorkspaceStateSnapshot).not.toHaveBeenCalled();
		expect(disconnectWorkspace).toHaveBeenCalledTimes(1);
	});
});
