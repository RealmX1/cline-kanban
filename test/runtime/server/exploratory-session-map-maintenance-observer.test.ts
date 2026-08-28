// Exploratory session map 维护观察器（蓝图 §B.3，M1）：观察门（模式/transport/活体）、
// 「未入图用户轮次」判据、stale 落账 + 广播、防抖静默窗 + 冷却的再维护提醒投递。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeExploratorySessionMapCollection, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	createExploratorySessionMapMaintenanceObserver,
	EXPLORATORY_SESSION_MAP_MAINTENANCE_NUDGE_TEXT,
	isExploratorySessionMapProjectionAheadOfCollection,
	shouldObserveExploratorySessionMapMaintenance,
} from "../../../src/server/exploratory-session-map-maintenance-observer";
import {
	mutateExploratorySessionMapState,
	readExploratorySessionMapCollection,
	type WorkspaceExploratorySessionMapState,
} from "../../../src/state/exploratory-session-map-store";

vi.mock("../../../src/state/exploratory-session-map-store", () => ({
	readExploratorySessionMapCollection: vi.fn(),
	mutateExploratorySessionMapState: vi.fn(),
}));

const readCollectionMock = vi.mocked(readExploratorySessionMapCollection);
const mutateStateMock = vi.mocked(mutateExploratorySessionMapState);

const WORKSPACE_ID = "ws-1";
const TASK_ID = "task-a";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: TASK_ID,
		state: "awaiting_review",
		agentId: "cline",
		workspacePath: "/repo",
		pid: null,
		startedAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		taskConversationMode: "exploratory",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		...overrides,
	};
}

function makeUserTurnMessage(id: string): {
	id: string;
	role: "user";
	content: string;
	createdAt: number;
} {
	return { id, role: "user", content: `用户轮次 ${id}`, createdAt: 1_700_000_000_000 };
}

function makeCollection(
	overrides: Partial<RuntimeExploratorySessionMapCollection> = {},
): RuntimeExploratorySessionMapCollection {
	return {
		sourceTurnProjectionSignature: "3:m3:10",
		mapNodes: [
			{
				mapNodeId: "turn-1-milestone",
				anchorConversationSessionTaskId: TASK_ID,
				anchorTurnNumber: 1,
				anchorTurnCheckpointCommit: null,
				anchorTurnUserMessagePreview: null,
				nodeKind: "milestone",
				nodeTitle: "旧节点",
				nodeSummaryMarkdown: null,
				referencedFindingId: null,
				nodeGenerationSource: "agent_live_session_maintenance",
				createdAt: 1,
				updatedAt: 1,
			},
		],
		mapStaleReason: null,
		lastMaintenanceJobCompletedAt: null,
		updatedAt: 1,
		...overrides,
	};
}

function makeFakeClineService(options: { summary: RuntimeTaskSessionSummary | null; messageCount: number }) {
	// 可变消息数组：测试可 push 新消息改变投影签名。
	const messages = Array.from({ length: options.messageCount }, (_, index) => makeUserTurnMessage(`m${index + 1}`));
	const loadTaskSessionMessagesMock = vi.fn(async (taskId: string) => (taskId === TASK_ID ? messages : []));
	return {
		messages,
		loadTaskSessionMessagesMock,
		getSummary: (taskId: string) => (taskId === TASK_ID ? options.summary : null),
		loadTaskSessionMessages: loadTaskSessionMessagesMock,
		// 与生产实现同构的 O(1) 只读签名（条数/末条 id/末条 content 长度）。
		getTaskSessionMessagesProjectionSignature: (taskId: string) => {
			if (taskId !== TASK_ID) {
				return null;
			}
			const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
			return {
				messageCount: messages.length,
				lastMessageId: lastMessage?.id ?? null,
				lastMessageContentLength: lastMessage?.content.length ?? 0,
			};
		},
	};
}

interface ObserverHarness {
	observer: ReturnType<typeof createExploratorySessionMapMaintenanceObserver>;
	sentNudges: Array<{ workspaceId: string; taskId: string; text: string }>;
	broadcasts: Array<{ workspaceId: string; taskId: string; mapCollection: RuntimeExploratorySessionMapCollection }>;
	messages: Array<{ id: string; role: "user"; content: string; createdAt: number }>;
	loadTaskSessionMessagesMock: ReturnType<typeof vi.fn>;
	fireScheduledNudge: () => Promise<void>;
	hasScheduledNudge: () => boolean;
	advanceTime: (deltaMs: number) => void;
}

function makeHarness(options: {
	summary: RuntimeTaskSessionSummary | null;
	messageCount: number;
	collection: RuntimeExploratorySessionMapCollection | null;
}): ObserverHarness {
	let currentTime = 1_700_000_000_000;
	const sentNudges: ObserverHarness["sentNudges"] = [];
	const broadcasts: ObserverHarness["broadcasts"] = [];
	let scheduledCallback: (() => void) | null = null;
	const service = makeFakeClineService({ summary: options.summary, messageCount: options.messageCount });
	// 读侧在调用时取 options.collection（而非 mockResolvedValue 快照），让 mutate 写回的结果
	// 对后续观察可见——与生产「读盘反映最新落账」的语义一致。
	readCollectionMock.mockImplementation(async () => options.collection);
	mutateStateMock.mockImplementation(async (_workspaceId, mutator) => {
		// 快照到局部常量再构造 state：options.collection 会在下方被重赋值，闭包内直接引用
		// 会被 TS 去掉窄化（与 handler 里 let 改对象属性的同款问题）。显式标注 state 类型——
		// 否则条件表达式会被推断成 { "task-a"?: undefined } 的畸形可选属性。
		const collectionAtCall = options.collection;
		const state: WorkspaceExploratorySessionMapState = {
			schemaVersion: 1,
			mapCollectionsByConversationSessionTaskId: collectionAtCall ? { [TASK_ID]: collectionAtCall } : {},
		};
		const mutated = mutator(state);
		if (mutated === null) {
			return null;
		}
		options.collection = mutated.mapCollectionsByConversationSessionTaskId[TASK_ID] ?? null;
		return mutated;
	});
	const observer = createExploratorySessionMapMaintenanceObserver({
		getClineTaskSessionService: () => service as never,
		onCollectionUpdated: (workspaceId, taskId, mapCollection) => {
			broadcasts.push({ workspaceId, taskId, mapCollection });
		},
		sendMaintenanceNudge: async (workspaceId, taskId, text) => {
			sentNudges.push({ workspaceId, taskId, text });
		},
		nowFn: () => currentTime,
		setTimeoutFn: (callback) => {
			scheduledCallback = callback;
			return {} as ReturnType<typeof setTimeout>;
		},
		clearTimeoutFn: () => {
			scheduledCallback = null;
		},
	});
	return {
		observer,
		sentNudges,
		broadcasts,
		messages: service.messages,
		loadTaskSessionMessagesMock: service.loadTaskSessionMessagesMock,
		fireScheduledNudge: async () => {
			const callback = scheduledCallback;
			scheduledCallback = null;
			callback?.();
			await flushAsyncWork();
		},
		hasScheduledNudge: () => scheduledCallback !== null,
		advanceTime: (deltaMs: number) => {
			currentTime += deltaMs;
		},
	};
}

async function flushAsyncWork(): Promise<void> {
	// 观察链有多级 await（loadMessages → 读集合 → mutate → 复核链），用多轮 macrotask 边界
	// 让整条 promise 链走完（三轮 microtask 不足以覆盖）。
	for (let round = 0; round < 10; round += 1) {
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
	}
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("shouldObserveExploratorySessionMapMaintenance（观察门）", () => {
	it("exploratory + cline + live → 观察", () => {
		expect(shouldObserveExploratorySessionMapMaintenance(makeSummary())).toBe(true);
	});
	it("缺省模式（无字段 = operational）→ 不观察", () => {
		expect(shouldObserveExploratorySessionMapMaintenance(makeSummary({ taskConversationMode: undefined }))).toBe(
			false,
		);
	});
	it("operational 显式声明 → 不观察", () => {
		expect(shouldObserveExploratorySessionMapMaintenance(makeSummary({ taskConversationMode: "operational" }))).toBe(
			false,
		);
	});
	it("非 Cline（M1 唯一可解析投影源）→ 不观察", () => {
		expect(shouldObserveExploratorySessionMapMaintenance(makeSummary({ agentId: "claude" }))).toBe(false);
	});
	it("会话已退出（liveness≠live）→ 不观察", () => {
		expect(shouldObserveExploratorySessionMapMaintenance(makeSummary({ liveness: "exited", state: "failed" }))).toBe(
			false,
		);
	});
});

describe("isExploratorySessionMapProjectionAheadOfCollection（未入图用户轮次判据）", () => {
	it("空投影（0 轮）→ false", () => {
		expect(isExploratorySessionMapProjectionAheadOfCollection(null, 0)).toBe(false);
	});
	it("无集合 + 有轮次 → true（还什么都没入图）", () => {
		expect(isExploratorySessionMapProjectionAheadOfCollection(null, 3)).toBe(true);
	});
	it("锚点已追平投影 → false", () => {
		expect(
			isExploratorySessionMapProjectionAheadOfCollection(
				makeCollection({ mapNodes: [{ ...makeCollection().mapNodes[0], anchorTurnNumber: 3 }] }),
				3,
			),
		).toBe(false);
	});
	it("投影领先锚点 → true", () => {
		expect(isExploratorySessionMapProjectionAheadOfCollection(makeCollection(), 3)).toBe(true);
	});
});

describe("stale 落账 + 防抖再维护", () => {
	it("投影领先 + 球在用户侧：标 stale（广播），并挂起静默窗；到点投递提醒", async () => {
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: makeCollection() });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		// stale 已置位并广播。
		expect(mutateStateMock).toHaveBeenCalledOnce();
		expect(harness.broadcasts).toHaveLength(1);
		expect(harness.broadcasts[0]?.mapCollection.mapStaleReason).toBe("turn_projection_signature_drift");
		// 静默窗已挂起，提醒尚未投递。
		expect(harness.hasScheduledNudge()).toBe(true);
		expect(harness.sentNudges).toHaveLength(0);
		// 到点：复核通过（仍 live / 球仍在用户侧 / 仍领先）→ 投递。
		await harness.fireScheduledNudge();
		expect(harness.sentNudges).toHaveLength(1);
		expect(harness.sentNudges[0]?.text).toBe(EXPLORATORY_SESSION_MAP_MAINTENANCE_NUDGE_TEXT);
	});

	it("球在 agent 侧：标 stale 但不挂静默窗（绝不往回合正文里插提醒）", async () => {
		const agentTurnSummary = makeSummary({ state: "running", turnOwner: "agent", userTurnKind: null });
		const harness = makeHarness({ summary: agentTurnSummary, messageCount: 3, collection: makeCollection() });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, agentTurnSummary);
		await flushAsyncWork();
		expect(harness.broadcasts).toHaveLength(1);
		expect(harness.hasScheduledNudge()).toBe(false);
		await harness.fireScheduledNudge();
		expect(harness.sentNudges).toHaveLength(0);
	});

	it("map 已追平（锚点覆盖最新轮次）：不标 stale、不挂窗", async () => {
		const caughtUp = makeCollection({
			mapNodes: [{ ...makeCollection().mapNodes[0], anchorTurnNumber: 3 }],
		});
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: caughtUp });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		expect(mutateStateMock).not.toHaveBeenCalled();
		expect(harness.hasScheduledNudge()).toBe(false);
	});

	it("缓存快照落后、磁盘集合已在缓存窗口内被新 apply 追平：串行写队列内复核后放弃置位（不假 stale、不广播）", async () => {
		const lagging = makeCollection(); // 锚点 1，投影 3 轮 → 缓存快照视角领先
		const caughtUp = makeCollection({
			mapNodes: [{ ...makeCollection().mapNodes[0], anchorTurnNumber: 3 }],
		});
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: lagging });
		// 模拟竞态：observe 侧判「领先」用的是缓存快照（lagging），但串行写队列真正读到的
		// 是 agent 刚 apply 的追平集合（apply 不 bump summary、observer 缓存不失效）。
		mutateStateMock.mockImplementation(async (_workspaceId, mutator) => {
			const state: WorkspaceExploratorySessionMapState = {
				schemaVersion: 1,
				mapCollectionsByConversationSessionTaskId: { [TASK_ID]: caughtUp },
			};
			return mutator(state);
		});
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		// 确实走到了落账关口，但 mutator 内复核真实集合已追平 → 无写回、无广播、无置位。
		expect(mutateStateMock).toHaveBeenCalledOnce();
		expect(caughtUp.mapStaleReason).toBeNull();
		expect(harness.broadcasts).toHaveLength(0);
	});

	it("已标 stale 的集合不重复置位（幂等），但静默窗仍会挂起", async () => {
		const harness = makeHarness({
			summary: makeSummary(),
			messageCount: 3,
			collection: makeCollection({ mapStaleReason: "turn_projection_signature_drift" }),
		});
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		expect(mutateStateMock).not.toHaveBeenCalled();
		expect(harness.hasScheduledNudge()).toBe(true);
	});

	it("消息签名未变：后续 observation 命中门控，不再重复 load+derive", async () => {
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: makeCollection() });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		// 首次 observation：签名缓存未建立 → 全量 load+derive → 标 stale 并广播。
		expect(harness.loadTaskSessionMessagesMock).toHaveBeenCalledTimes(1);
		expect(mutateStateMock).toHaveBeenCalledOnce();
		expect(harness.broadcasts).toHaveLength(1);
		// 第二次 observation：消息集未变 → 签名命中，沿用上次 latestTurnNumber，跳过一次
		// O(history) 的全量克隆 + derive；stale 判定照常推进（集合已置位 → 幂等不再置位）。
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		expect(harness.loadTaskSessionMessagesMock).toHaveBeenCalledTimes(1);
		expect(mutateStateMock).toHaveBeenCalledOnce();
		expect(harness.broadcasts).toHaveLength(1);
	});

	it("消息签名变化（新用户轮次入会话）：重新 load+derive 并按新投影判定", async () => {
		const caughtUp = makeCollection({
			mapNodes: [{ ...makeCollection().mapNodes[0], anchorTurnNumber: 3 }],
		});
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: caughtUp });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		// 已追平：不标 stale。
		expect(harness.loadTaskSessionMessagesMock).toHaveBeenCalledTimes(1);
		expect(mutateStateMock).not.toHaveBeenCalled();
		// 新增一轮用户消息 → 签名变化 → 重新 derive（投影 4 轮 > 锚点 3）→ 标 stale。
		harness.messages.push(makeUserTurnMessage("m4"));
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		expect(harness.loadTaskSessionMessagesMock).toHaveBeenCalledTimes(2);
		expect(mutateStateMock).toHaveBeenCalledOnce();
		expect(harness.broadcasts).toHaveLength(1);
		expect(harness.broadcasts[0]?.mapCollection.mapStaleReason).toBe("turn_projection_signature_drift");
	});

	it("到点复核不通过（会话已翻回 agent 回合）→ 不投递", async () => {
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: makeCollection() });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		expect(harness.hasScheduledNudge()).toBe(true);
		// 计时器排队期间会话翻回 agent 回合。
		const agentTurnSummary = makeSummary({ state: "running", turnOwner: "agent", userTurnKind: null });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, agentTurnSummary);
		await flushAsyncWork();
		// 新 observation 已把旧窗清掉并重挂（agent 回合不挂窗 → 清空）。
		expect(harness.hasScheduledNudge()).toBe(false);
		await harness.fireScheduledNudge();
		expect(harness.sentNudges).toHaveLength(0);
	});

	it("冷却：上一次投递后 10 分钟内不再重挂静默窗", async () => {
		const harness = makeHarness({ summary: makeSummary(), messageCount: 3, collection: makeCollection() });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		await harness.fireScheduledNudge();
		expect(harness.sentNudges).toHaveLength(1);
		// 冷却期内再次观察到「仍领先 + 球在用户侧」。
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, makeSummary());
		await flushAsyncWork();
		expect(harness.hasScheduledNudge()).toBe(false);
	});

	it("非 exploratory 会话：完全不工作（不读集合、不标 stale、不挂窗）", async () => {
		const operationalSummary = makeSummary({ taskConversationMode: "operational" });
		const harness = makeHarness({ summary: operationalSummary, messageCount: 3, collection: makeCollection() });
		harness.observer.observeTaskSessionSummary(WORKSPACE_ID, operationalSummary);
		await flushAsyncWork();
		expect(readCollectionMock).not.toHaveBeenCalled();
		expect(mutateStateMock).not.toHaveBeenCalled();
		expect(harness.hasScheduledNudge()).toBe(false);
	});
});
