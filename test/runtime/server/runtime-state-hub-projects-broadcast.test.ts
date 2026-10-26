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
	createRuntimeStateBroadcastCostRecorder,
	type RuntimeStateBroadcastCostWindowSample,
} from "../../../src/diagnostics/runtime-state-broadcast-cost-recorder";
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
// summary flush 触发的 projects 广播还要再等合并窗口（1 秒，PROJECTS_BROADCAST_COALESCING_WINDOW_AFTER_TASK_SESSION_SUMMARY_FLUSH_MS）
// 结束才构建；这一路的负面断言要等过 flush 批次窗口 + 合并窗口。
const FLUSH_AND_PROJECTS_BROADCAST_COALESCING_OVERSHOOT_MS = 150 + 1_000 + FLUSH_OVERSHOOT_MS;
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
	// queue 会被 waitForRuntimeMessage 按谓词摘走，看不出先后；顺序断言读这份只追加的记录。
	receivedMessageTypesInArrivalOrder: RuntimeStateStreamMessage["type"][];
	events: EventEmitter;
}

async function openQueuedRuntimeSocket(url: string): Promise<QueuedRuntimeSocket> {
	const socket = new WebSocket(url);
	const queued: QueuedRuntimeSocket = {
		socket,
		queue: [],
		receivedMessageTypesInArrivalOrder: [],
		events: new EventEmitter(),
	};
	socket.on("message", (rawData) => {
		try {
			const message = JSON.parse(String(rawData)) as RuntimeStateStreamMessage;
			queued.queue.push(message);
			queued.receivedMessageTypesInArrivalOrder.push(message.type);
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

interface HeldProjectsPayloadBuild {
	// 被扣住的那次构建已进入（握手已把连接放进全局广播集合、正在等 snapshot 所需的 projects）。
	heldProjectsPayloadBuildStarted: Promise<void>;
	releaseHeldProjectsPayloadBuild: () => void;
}

interface HubTestHarness {
	hub: RuntimeStateHub;
	streamUrl: string;
	projects: RuntimeProjectSummary[];
	buildProjectsPayload: ReturnType<typeof vi.fn>;
	readCostWindow: () => RuntimeStateBroadcastCostWindowSample;
	// 扣住下一次 projects payload 构建直到放行；被扣住的那次返回进入时的 projects 副本（模拟慢 snapshot 带的旧数据）。
	holdNextProjectsPayloadBuildUntilReleased: () => HeldProjectsPayloadBuild;
	emitTerminalSummary: (summary: RuntimeTaskSessionSummary) => void;
	cleanup: () => Promise<void>;
}

async function setupHubHarness(): Promise<HubTestHarness> {
	const projects: RuntimeProjectSummary[] = [makeProject("project-a")];
	let nextProjectsPayloadBuildHold: {
		markHeldProjectsPayloadBuildStarted: () => void;
		heldProjectsPayloadBuildReleased: Promise<void>;
	} | null = null;
	const buildProjectsPayload = vi.fn(async (preferredCurrentProjectId: string | null) => {
		const projectsPayloadBuildHold = nextProjectsPayloadBuildHold;
		if (!projectsPayloadBuildHold) {
			return { currentProjectId: preferredCurrentProjectId, projects };
		}
		nextProjectsPayloadBuildHold = null;
		const projectsAtHeldBuildStart = [...projects];
		projectsPayloadBuildHold.markHeldProjectsPayloadBuildStarted();
		await projectsPayloadBuildHold.heldProjectsPayloadBuildReleased;
		return { currentProjectId: preferredCurrentProjectId, projects: projectsAtHeldBuildStart };
	});
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
	const costWindows: RuntimeStateBroadcastCostWindowSample[] = [];
	const costRecorder = createRuntimeStateBroadcastCostRecorder({
		writeWindowSample: (sample) => costWindows.push(sample),
	});
	const hub = createRuntimeStateHub({ workspaceRegistry, runtimeStateBroadcastCostRecorder: costRecorder });

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
		readCostWindow: () => {
			costRecorder.flushWindow();
			return costWindows[costWindows.length - 1];
		},
		holdNextProjectsPayloadBuildUntilReleased: () => {
			let markHeldProjectsPayloadBuildStarted = () => {};
			const heldProjectsPayloadBuildStarted = new Promise<void>((resolve) => {
				markHeldProjectsPayloadBuildStarted = resolve;
			});
			let releaseHeldProjectsPayloadBuild = () => {};
			const heldProjectsPayloadBuildReleased = new Promise<void>((resolve) => {
				releaseHeldProjectsPayloadBuild = resolve;
			});
			nextProjectsPayloadBuildHold = { markHeldProjectsPayloadBuildStarted, heldProjectsPayloadBuildReleased };
			return { heldProjectsPayloadBuildStarted, releaseHeldProjectsPayloadBuild };
		},
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

// 「握手期间广播」用例单独挂超时：5 段「终会到达」等待（新客户端开 socket + 扣住的构建进入 + 既有客户端等广播 +
// 新客户端等首帧 + 等补发）+ 两个 FLUSH_OVERSHOOT_MS 观察窗 + 5s 关 socket 余量。
const TEST_TIMEOUT_MS_COVERING_FIVE_SERIAL_WAITS_AND_TWO_OBSERVATION_WINDOWS =
	5 * RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS + 2 * FLUSH_OVERSHOOT_MS + 5_000;

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
		const costs = harness.readCostWindow();
		expect(costs.operations.initial_snapshot.completedOperationCount).toBe(1);
		expect(costs.operations.projects_updated).toMatchObject({
			completedOperationCount: 2,
			serializedPayloadCount: 2,
			webSocketAcceptedSendCount: 1,
			outcomeCounts: { completed: 1, deduplicated: 1 },
		});
		expect(costs.operations.projects_updated.stages.projects_payload_build.completedStageCount).toBe(2);
		expect(costs.operations.projects_updated.stages.payload_json_stringify.completedStageCount).toBe(2);
	});

	it("无连接时记录早退，构建失败独立计数且下一次广播仍可成功", async () => {
		harness.readCostWindow();
		harness.buildProjectsPayload.mockRejectedValueOnce(new Error("合成私密错误，不得写入成本记录"));
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
		const costs = harness.readCostWindow();
		expect(costs.operations.projects_updated).toMatchObject({
			completedOperationCount: 2,
			serializedPayloadCount: 1,
			outcomeCounts: { failed: 1, completed: 1 },
		});
		expect(costs.operations.projects_updated.stages.projects_payload_build.failedStageCount).toBe(1);
		expect(JSON.stringify(costs)).not.toContain("合成私密错误");
		const disconnectedHarness = await setupHubHarness();
		try {
			await disconnectedHarness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
			await disconnectedHarness.hub.broadcastRuntimeWorkspaceStateUpdated(WORKSPACE_ID, tempHome.path);
			const disconnectedCosts = disconnectedHarness.readCostWindow();
			expect(disconnectedCosts.operations.projects_updated.outcomeCounts.no_clients).toBe(1);
			expect(disconnectedCosts.operations.workspace_state_updated.outcomeCounts.no_clients).toBe(1);
			expect(disconnectedHarness.buildProjectsPayload).not.toHaveBeenCalled();
		} finally {
			await disconnectedHarness.cleanup();
		}
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
		// flush 这一路不带自己的 workspaceId（harness 原样回显 preferredCurrentProjectId）：currentProjectId 不随轮到
		// flush 的工作区来回切，去重才可能命中。
		expect(first.currentProjectId).toBeNull();

		// 内容未变：又一次 flush 不再重发。
		harness.emitTerminalSummary(makeSummary("task-1"));
		await new Promise((resolve) => setTimeout(resolve, FLUSH_AND_PROJECTS_BROADCAST_COALESCING_OVERSHOOT_MS));
		expect(client.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);

		// 内容变化：下一次 flush 确实重发。
		harness.projects[0] = makeProject("project-a", 3);
		harness.emitTerminalSummary(makeSummary("task-1"));
		const second = await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
		expect(second.projects[0]?.taskCounts.in_progress).toBe(3);
	});

	it("合并窗口内的多次 flush 合并构建、广播 projects，最终送达最新状态", async () => {
		const projectsPayloadBuildCountBeforeFlushes = harness.buildProjectsPayload.mock.calls.length;
		// 4 个相隔 200ms 的 flush 批次（标称跨度 600ms，落在 1 秒合并窗口内），每批内容都在变：不合并的话要构建并广播 4 次。
		const flushCount = 4;
		for (let flushIndex = 1; flushIndex <= flushCount; flushIndex += 1) {
			harness.projects[0] = makeProject("project-a", flushIndex);
			harness.emitTerminalSummary(makeSummary(`task-${flushIndex}`));
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		await waitForRuntimeMessage(
			client,
			(message): message is Extract<RuntimeStateStreamMessage, { type: "projects_updated" }> =>
				isProjectsUpdatedMessage(message) && message.projects[0]?.taskCounts.in_progress === flushCount,
		);
		await new Promise((resolve) => setTimeout(resolve, FLUSH_AND_PROJECTS_BROADCAST_COALESCING_OVERSHOOT_MS));
		const projectsPayloadBuildsTriggeredByFlushes = harness.buildProjectsPayload.mock.calls.slice(
			projectsPayloadBuildCountBeforeFlushes,
		);
		// 标称只构建 1 次；宿主很忙、sleep 被拉长到跨过一个窗口边界时是 2 次。都远少于 4 次，且都不带 workspaceId。
		expect(projectsPayloadBuildsTriggeredByFlushes.length).toBeGreaterThanOrEqual(1);
		expect(projectsPayloadBuildsTriggeredByFlushes.length).toBeLessThanOrEqual(2);
		expect(
			projectsPayloadBuildsTriggeredByFlushes.every(
				([preferredCurrentProjectId]) => preferredCurrentProjectId === null,
			),
		).toBe(true);
	});

	it("新客户端收到首帧后同内容广播仍发送（首帧发出后指纹复位）", async () => {
		// 既有客户端先收过一轮广播，把去重指纹推进到当前内容。
		await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		await waitForRuntimeMessage(client, isProjectsUpdatedMessage);

		// 新客户端首帧 snapshot 发出后指纹置回 null：此后第一次广播即使内容相同也必须发送，
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

	// 广播是 async（先 await 构建再比对 / 发送 / 打标），flush、tRPC mutation、首帧后补发会并发触发。先开始、后完成的
	// 旧代际广播若照常发送，会把旧 projects 推给全部在场客户端并把去重指纹倒退成旧内容，安静系统里不会再有广播纠正。
	it("先开始、后完成的旧代际广播被丢弃：不发旧内容、不倒退去重指纹", async () => {
		const heldStaleGenerationProjectsPayloadBuild = harness.holdNextProjectsPayloadBuildUntilReleased();
		const staleGenerationBroadcastCompletion = harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
		try {
			await heldStaleGenerationProjectsPayloadBuild.heldProjectsPayloadBuildStarted;

			harness.projects.push(makeProject("project-b", 2));
			await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
			const newerGenerationBroadcast = await waitForRuntimeMessage(client, isProjectsUpdatedMessage);
			expect(newerGenerationBroadcast.projects).toHaveLength(2);

			heldStaleGenerationProjectsPayloadBuild.releaseHeldProjectsPayloadBuild();
			await staleGenerationBroadcastCompletion;
			await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
			expect(client.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);
			// 指纹仍是较新内容：再来一次与较新内容相同的广播照常被去重跳过。
			await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
			await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
			expect(client.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);
			const costs = harness.readCostWindow().operations.projects_updated;
			expect(costs.outcomeCounts.superseded).toBe(1);
			expect(costs.outcomeCounts.deduplicated).toBe(1);
		} finally {
			heldStaleGenerationProjectsPayloadBuild.releaseHeldProjectsPayloadBuild();
			await staleGenerationBroadcastCompletion;
		}
	});

	// 切项目即重连：握手期间别的项目有 agent 在跑，flush 每 150ms 广播一次 projects_updated。若它抢在 snapshot 前
	// 到达，浏览器会先把 currentProjectId 换成目标项目、board 却仍是上一个项目的——此时再点目标项目的任务会在旧
	// board 里找卡，误报「That task is no longer on its project's board.」。
	it(
		"握手期间的 projects_updated 不抢在首帧 snapshot 之前，首帧后补发最新内容",
		{ timeout: TEST_TIMEOUT_MS_COVERING_FIVE_SERIAL_WAITS_AND_TWO_OBSERVATION_WINDOWS },
		async () => {
			const heldHandshakeProjectsPayloadBuild = harness.holdNextProjectsPayloadBuildUntilReleased();
			const lateClient = await openQueuedRuntimeSocket(harness.streamUrl);
			try {
				await heldHandshakeProjectsPayloadBuild.heldProjectsPayloadBuildStarted;

				harness.projects.push(makeProject("project-b", 2));
				await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
				const broadcastToExistingClientDuringHandshake = await waitForRuntimeMessage(
					client,
					isProjectsUpdatedMessage,
				);
				expect(broadcastToExistingClientDuringHandshake.projects).toHaveLength(2);

				heldHandshakeProjectsPayloadBuild.releaseHeldProjectsPayloadBuild();
				const snapshot = await waitForRuntimeMessage(
					lateClient,
					(message): message is Extract<RuntimeStateStreamMessage, { type: "snapshot" }> =>
						message.type === "snapshot",
				);
				// 首帧带的是握手开始时构建的旧 projects。
				expect(snapshot.projects).toHaveLength(1);
				const catchUpAfterSnapshot = await waitForRuntimeMessage(lateClient, isProjectsUpdatedMessage);
				expect(catchUpAfterSnapshot.projects).toHaveLength(2);
				expect(lateClient.receivedMessageTypesInArrivalOrder[0]).toBe("snapshot");
				expect(lateClient.receivedMessageTypesInArrivalOrder.indexOf("projects_updated")).toBeGreaterThan(
					lateClient.receivedMessageTypesInArrivalOrder.indexOf("snapshot"),
				);

				// 稳态去重不受影响：同内容连发两次，第二次对两个客户端都跳过。补发用的是握手时的 preferredCurrentProjectId
				// （本 harness 为 null），与下面的 WORKSPACE_ID 内容不同，故先发一次把指纹推进到同内容。
				await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
				await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
				client.queue.length = 0;
				lateClient.queue.length = 0;
				await harness.hub.broadcastRuntimeProjectsUpdated(WORKSPACE_ID);
				await new Promise((resolve) => setTimeout(resolve, FLUSH_OVERSHOOT_MS));
				expect(client.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);
				expect(lateClient.queue.filter(isProjectsUpdatedMessage)).toHaveLength(0);
				const costs = harness.readCostWindow();
				expect(costs.operations.initial_snapshot.completedOperationCount).toBe(2);
				expect(costs.operations.projects_updated.initialSnapshotAwaitingClientSkipCount).toBe(1);
			} finally {
				heldHandshakeProjectsPayloadBuild.releaseHeldProjectsPayloadBuild();
				if (
					lateClient.socket.readyState !== WebSocket.CLOSED &&
					lateClient.socket.readyState !== WebSocket.CLOSING
				) {
					lateClient.socket.close();
					await once(lateClient.socket, "close");
				}
			}
		},
	);
});
