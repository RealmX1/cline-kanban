// B6：runtime-state-hub 的 projects_updated 广播内容去重。
// payload 序列化结果与上次实际发送值相同 ⇒ 在场客户端已持有这份数据，整条广播跳过；
// 内容变化（项目增删 / 计数变化 / currentProjectId 切换）⇒ 照常重发。flushTaskSessionSummaries
// 每 150ms 触发的那路恒定重发也走同一去重，这里一并锁 wiring。
import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type {
	RuntimeProjectSummary,
	RuntimeStateStreamMessage,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	type CreateRuntimeStateHubDependencies,
	createRuntimeStateHub,
	type RuntimeStateHub,
} from "../../../src/server/runtime-state-hub";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTempDir } from "../../utilities/temp-dir";

const WORKSPACE_ID = "workspace-1";
// flush 批次窗口 150ms + 处理裕量；负面断言（不应再收到消息）必须等过这个窗口。
const FLUSH_OVERSHOOT_MS = 400;
// 「终会到达」的单档等待（WS 连接、正向广播消息）：原先 2s 在高负载（两个 worker 共享宿主）下不够；
// 断言判的是「最终收到了什么」，放宽不损失判别力。FLUSH_OVERSHOOT_MS 是反向观察窗口，不在此列。
const RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS = 10_000;

function makeProject(id: string, inProgressCount = 0): RuntimeProjectSummary {
	const taskCounts = { backlog: 0, in_progress: inProgressCount, review: 0, validation: 0, trash: 0 };
	return {
		id,
		path: `/repos/${id}`,
		name: id,
		taskCounts,
		availability: { status: "available" },
		rawColumnTaskCounts: taskCounts,
		// 静态 payload（无活体 lastOutputAt）才能保证两次构建字节级相同、去重命中；活体输出期间广播照常。
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: [],
		gitRemoteOriginUrl: null,
	};
}

function makeSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		// codex：转录推进探测只支持 claude，其它 agentId 让该观察器对 fake manager 保持惰性。
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

interface QueuedRuntimeSocket {
	socket: WebSocket;
	queue: RuntimeStateStreamMessage[];
	events: EventEmitter;
}

async function openQueuedRuntimeSocket(url: string): Promise<QueuedRuntimeSocket> {
	const socket = new WebSocket(url);
	const queued: QueuedRuntimeSocket = { socket, queue: [], events: new EventEmitter() };
	socket.on("message", (rawData) => {
		try {
			queued.queue.push(JSON.parse(String(rawData)) as RuntimeStateStreamMessage);
			queued.events.emit("message");
		} catch {
			// Ignore malformed messages in tests.
		}
	});
	await new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(
			() => reject(new Error(`Timed out connecting websocket: ${url}`)),
			RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
		);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			reject(error);
		});
	});
	return queued;
}

async function waitForRuntimeMessage<T extends RuntimeStateStreamMessage = RuntimeStateStreamMessage>(
	queued: QueuedRuntimeSocket,
	predicate: (message: RuntimeStateStreamMessage) => message is T,
	timeoutMs = RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
): Promise<T> {
	return await new Promise((resolve, reject) => {
		const tryResolve = () => {
			const index = queued.queue.findIndex(predicate);
			if (index < 0) {
				return;
			}
			const [message] = queued.queue.splice(index, 1);
			clearTimeout(timeoutId);
			queued.events.removeListener("message", tryResolve);
			// 谓词已在该下标处判定为 T，窄化是可靠的。
			resolve(message as T);
		};
		const timeoutId = setTimeout(() => {
			queued.events.removeListener("message", tryResolve);
			reject(new Error("Timed out waiting for expected runtime state message."));
		}, timeoutMs);
		queued.events.on("message", tryResolve);
		tryResolve();
	});
}

function isProjectsUpdatedMessage(
	message: RuntimeStateStreamMessage,
): message is Extract<RuntimeStateStreamMessage, { type: "projects_updated" }> {
	return message.type === "projects_updated";
}

interface HubTestHarness {
	hub: RuntimeStateHub;
	streamUrl: string;
	projects: RuntimeProjectSummary[];
	buildProjectsPayload: ReturnType<typeof vi.fn>;
	emitTerminalSummary: (summary: RuntimeTaskSessionSummary) => void;
	cleanup: () => Promise<void>;
}

async function setupHubHarness(): Promise<HubTestHarness> {
	const projects: RuntimeProjectSummary[] = [makeProject("project-a")];
	const buildProjectsPayload = vi.fn(async (preferredCurrentProjectId: string | null) => ({
		currentProjectId: preferredCurrentProjectId,
		projects,
	}));
	const workspaceRegistry: CreateRuntimeStateHubDependencies["workspaceRegistry"] = {
		resolveWorkspaceForStream: async () => ({
			status: "no_registered_project",
			projectId: null,
			workspacePath: null,
		}),
		buildProjectsPayloadUsingCachedRuntimeProjectAvailability: buildProjectsPayload,
		buildWorkspaceStateSnapshot: async () => {
			throw new Error("not used in this test");
		},
	};
	const hub = createRuntimeStateHub({ workspaceRegistry });

	let terminalSummaryListener: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
	const fakeTerminalManager = {
		onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
			terminalSummaryListener = listener;
			return () => {
				terminalSummaryListener = null;
			};
		},
		listSummaries: () => [] as RuntimeTaskSessionSummary[],
	} as unknown as TerminalSessionManager;
	hub.trackTerminalManager(WORKSPACE_ID, fakeTerminalManager);

	const httpServer: Server = createServer();
	httpServer.on("upgrade", (request, socket, head) => {
		hub.handleUpgrade(request, socket, head, {
			requestedWorkspaceId: null,
			initialWorkspaceMetadataProbeScope: null,
		});
	});
	httpServer.listen(0, "127.0.0.1");
	await once(httpServer, "listening");
	const { port } = httpServer.address() as AddressInfo;

	return {
		hub,
		streamUrl: `ws://127.0.0.1:${port}/api/runtime/ws`,
		projects,
		buildProjectsPayload,
		emitTerminalSummary: (summary) => {
			if (!terminalSummaryListener) {
				throw new Error("terminal summary listener was not registered");
			}
			terminalSummaryListener(summary);
		},
		cleanup: async () => {
			await hub.close();
			await new Promise<void>((resolveClose, rejectClose) => {
				httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
			});
		},
	};
}

// beforeEach 依次等 WS 握手与首帧 snapshot 两段「终会到达」等待，外加 5s 建临时 HOME 与起 HTTP server 的余量；
// 默认 hookTimeout 10s 只够一段，第二段到点前 hook 就会超时，内层带诊断的失败被截断。
const BEFORE_EACH_HOOK_TIMEOUT_MS_COVERING_SOCKET_OPEN_AND_FIRST_SNAPSHOT_WAITS =
	2 * RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS + 5_000;

// 用例超时挂在 describe 上，取组内串行等待最多的用例「新客户端注册后同内容广播仍发送」：4 段「终会到达」等待（既有
// 客户端等广播 + 新客户端开 socket + 等首帧 snapshot + 等广播）× 单段上限 + 一个 FLUSH_OVERSHOOT_MS 反向观察窗 + 5s 关 socket 余量。
const TEST_TIMEOUT_MS_COVERING_FOUR_SERIAL_WAITS =
	4 * RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS + FLUSH_OVERSHOOT_MS + 5_000;

describe("runtime-state-hub projects_updated 广播去重", { timeout: TEST_TIMEOUT_MS_COVERING_FOUR_SERIAL_WAITS }, () => {
	// 连接握手会聚合通知 feed（读 ~/.cline/kanban/workspaces/**）；把 HOME 指到临时目录保持 hermetic。
	let tempHome: { path: string; cleanup: () => void };
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	let harness: HubTestHarness;
	let client: QueuedRuntimeSocket;

	beforeEach(async () => {
		tempHome = createTempDir("kanban-hub-projects-broadcast-test-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = tempHome.path;
		process.env.USERPROFILE = tempHome.path;

		harness = await setupHubHarness();
		client = await openQueuedRuntimeSocket(harness.streamUrl);
		// 首帧 snapshot 到达即说明客户端已登记进全局广播集合；后续只盯 projects_updated 增量。
		await waitForRuntimeMessage(client, (message) => message.type === "snapshot");
	}, BEFORE_EACH_HOOK_TIMEOUT_MS_COVERING_SOCKET_OPEN_AND_FIRST_SNAPSHOT_WAITS);

	afterEach(async () => {
		if (client.socket.readyState !== WebSocket.CLOSED && client.socket.readyState !== WebSocket.CLOSING) {
			client.socket.close();
			await once(client.socket, "close");
		}
		await harness.cleanup();
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		tempHome.cleanup();
	});

	it("无内容变化时不重发 projects_updated", async () => {
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		const first = await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
		expect(first.currentProjectId).toBe(WORKSPACE_ID);
		expect(first.projects).toHaveLength(1);

		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
		expect(client.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);
		// 去重发生在发送层：payload 构建照常进行，只有广播被跳过。
		expect(harness.buildProjectsPayload).toHaveBeenCalledTimes(3);
	});

	it("内容变化时确实重发 projects_updated", async () => {
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		await waitForRuntimeMessage(client, isProjectsUpdatedMessage);

		harness.projects.push(makeProject("project-b", 2));
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		const second = await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
		expect(second.projects).toHaveLength(2);
		expect(second.projects[1]?.id).toBe("project-b");
	});

	it("flushTaskSessionSummaries 触发的 projects 广播同样按内容去重", async () => {
		harness.emitTerminalSummary(makeSummary("task-1"));
		const first = await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
		expect(first.currentProjectId).toBe(WORKSPACE_ID);

		// 内容未变：又一次 150ms flush 不再重发。
		harness.emitTerminalSummary(makeSummary("task-1"));
		await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
		expect(client.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);

		// 内容变化：下一次 flush 确实重发。
		harness.projects[0] = makeProject("project-a", 3);
		harness.emitTerminalSummary(makeSummary("task-1"));
		const second = await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
		expect(second.projects[0]?.taskCounts.in_progress).toBe(3);
	});

	it("新客户端注册后同内容广播仍发送（注册时指纹复位）", async () => {
		// 既有客户端先收过一轮广播，把去重指纹推进到当前内容。
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		await waitForRuntimeMessage(client, isProjectsUpdatedMessage);

		// 新客户端注册会把指纹置回 null：此后第一次广播即使内容相同也必须发送，
		// 自愈 snapshot 全量替换可能带回的旧数据。
		const lateClient = await openQueuedRuntimeSocket(harness.streamUrl);
		try {
			await waitForRuntimeMessage(lateClient, (message) => message.type === "snapshot");
			await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
			const message = await waitForRuntimeMessage(lateClient, isProjectsUpdatedMessage);
			expect(message.currentProjectId).toBe(WORKSPACE_ID);
			expect(message.projects).toHaveLength(1);

			// 稳态去重不受影响：再下一次同内容广播仍然跳过。
			await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
			await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
			expect(lateClient.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);
		} finally {
			if (lateClient.socket.readyState !== WebSocket.CLOSED && lateClient.socket.readyState !== WebSocket.CLOSING) {
				lateClient.socket.close();
				await once(lateClient.socket, "close");
			}
		}
	});
});
