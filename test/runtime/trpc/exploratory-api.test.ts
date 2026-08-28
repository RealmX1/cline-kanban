// exploratory-api 的 ingestSessionMapUpdate handler：投影快照 → 漏斗（串行写队列内）→
// durable 落盘后 ack + 广播的接线契约。漏斗四道闸本身的断言在
// test/runtime/state/exploratory-session-map-apply-funnel.test.ts，这里只钉 handler 的
// 三态分派（applied 广播 / rejected 透传 / dedup_ack 不广播）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConversationSessionTurnProjection } from "../../../src/conversation-tree/load-conversation-session-turn-projection";
import type {
	RuntimeExploratorySessionMapCollection,
	RuntimeIngestExploratorySessionMapUpdateRequest,
} from "../../../src/core/api-contract";
import {
	mutateExploratorySessionMapState,
	readExploratorySessionMapCollection,
	type WorkspaceExploratorySessionMapState,
} from "../../../src/state/exploratory-session-map-store";
import { createExploratoryApi } from "../../../src/trpc/exploratory-api";

vi.mock("../../../src/conversation-tree/load-conversation-session-turn-projection", () => ({
	loadConversationSessionTurnProjection: vi.fn(),
}));

vi.mock("../../../src/state/exploratory-session-map-store", () => ({
	readExploratorySessionMapCollection: vi.fn(),
	mutateExploratorySessionMapState: vi.fn(),
}));

const loadProjectionMock = vi.mocked(loadConversationSessionTurnProjection);
const readCollectionMock = vi.mocked(readExploratorySessionMapCollection);
const mutateStateMock = vi.mocked(mutateExploratorySessionMapState);

const SCOPE = { workspaceId: "ws-1", workspacePath: "/repo" };
const TASK_ID = "task-a";
const SIGNATURE = "3:m3:10";

function makeRequest(
	overrides: Partial<RuntimeIngestExploratorySessionMapUpdateRequest> = {},
): RuntimeIngestExploratorySessionMapUpdateRequest {
	return {
		conversationSessionTaskId: TASK_ID,
		clientProposalId: "proposal-1",
		sourceTurnProjectionSignature: SIGNATURE,
		nodes: [
			{
				anchorTurnNumber: 3,
				anchorTurnCheckpointCommit: null,
				nodeKind: "milestone",
				nodeTitle: "里程碑",
				nodeSummaryMarkdown: null,
				referencedFindingId: null,
			},
		],
		...overrides,
	};
}

function makeAvailableProjectionSnapshot() {
	return {
		harnessSource: "exact_structured" as const,
		projection: {
			entries: [1, 2, 3].map((turnNumber) => ({
				turnNumber,
				turnStartedAt: 1,
				turnUserMessageExcerpt: `第 ${turnNumber} 轮`,
				turnAssistantResponseExcerpt: null,
				turnMessageCount: 2,
				turnCheckpointCommit: null,
				turnCheckpointAlignmentConfidence: "unaligned" as const,
				turnIsInProgress: false,
				turnHasConversationTreeForkAnchor: false,
			})),
			signature: SIGNATURE,
		},
		retainedCheckpointCommits: new Set<string>(),
	};
}

interface HarnessOptions {
	collection: RuntimeExploratorySessionMapCollection | null;
}

function makeHarness(options: HarnessOptions) {
	const broadcasts: Array<{
		workspaceId: string;
		taskId: string;
		mapCollection: RuntimeExploratorySessionMapCollection;
	}> = [];
	readCollectionMock.mockResolvedValue(options.collection);
	mutateStateMock.mockImplementation(async (_workspaceId, mutator) => {
		// 快照到局部常量：options.collection 会被重赋值，闭包内直接引用会被 TS 去掉窄化；
		// 显式标注 state 类型，否则条件表达式被推断成 { "task-a"?: undefined } 的畸形可选属性。
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
	const api = createExploratoryApi({
		getScopedClineTaskSessionService: async () => {
			throw new Error("不应被调用：投影加载走 loader mock");
		},
		loadBoardCardAgentId: async () => null,
		onExploratorySessionMapUpdated: (workspaceId, taskId, mapCollection) => {
			broadcasts.push({ workspaceId, taskId, mapCollection });
		},
	});
	return { api, broadcasts };
}

beforeEach(() => {
	vi.clearAllMocks();
	loadProjectionMock.mockResolvedValue(makeAvailableProjectionSnapshot());
});

describe("exploratory.getSessionMap", () => {
	it("读路径直传 store（无集合 → null）", async () => {
		const { api } = makeHarness({ collection: null });
		const response = await api.getSessionMap(SCOPE, { conversationSessionTaskId: TASK_ID });
		expect(response.mapCollection).toBeNull();
	});
});

describe("exploratory.ingestSessionMapUpdate", () => {
	it("applied：durable 落盘后 ack + 广播完整集合（durable-write-before-ack）", async () => {
		const { api, broadcasts } = makeHarness({ collection: null });
		const response = await api.ingestSessionMapUpdate(SCOPE, makeRequest());
		expect(response.applied).toBe(true);
		expect(response.rejectionReason).toBeNull();
		expect(response.mapCollection?.mapNodes).toHaveLength(1);
		expect(response.mapCollection?.mapNodes[0]?.mapNodeId).toBe("turn-3-milestone");
		expect(response.mapCollection?.mapNodes[0]?.anchorTurnUserMessagePreview).toBe("第 3 轮");
		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]?.workspaceId).toBe("ws-1");
		expect(broadcasts[0]?.taskId).toBe(TASK_ID);
		expect(broadcasts[0]?.mapCollection).toEqual(response.mapCollection);
	});

	it("rejected（投影源不可用）：applied=false + reason 透传 + 不广播 + 不落盘", async () => {
		loadProjectionMock.mockResolvedValue({
			harnessSource: "unavailable_live_terminal_pty",
			projection: { entries: [], signature: "0:none:0" },
			retainedCheckpointCommits: new Set<string>(),
		});
		const { api, broadcasts } = makeHarness({ collection: null });
		const response = await api.ingestSessionMapUpdate(SCOPE, makeRequest());
		expect(response.applied).toBe(false);
		expect(response.rejectionReason).toBe("projection_source_unavailable");
		expect(response.mapCollection).toBeNull();
		expect(broadcasts).toHaveLength(0);
	});

	it("dedup_ack：同 clientProposalId 重试 → applied=true、不广播、回现状集合", async () => {
		const current: RuntimeExploratorySessionMapCollection = {
			sourceTurnProjectionSignature: SIGNATURE,
			mapNodes: [],
			mapStaleReason: null,
			lastMaintenanceJobCompletedAt: null,
			recentAppliedClientProposalIds: ["proposal-1"],
			updatedAt: 1,
		};
		const { api, broadcasts } = makeHarness({ collection: current });
		const response = await api.ingestSessionMapUpdate(SCOPE, makeRequest());
		expect(response.applied).toBe(true);
		expect(response.rejectionReason).toBeNull();
		expect(response.mapCollection).toBe(current);
		expect(broadcasts).toHaveLength(0);
	});
});
