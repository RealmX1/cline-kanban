import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionMapPanelData, useSessionMapPanelData } from "@/hooks/use-session-map-panel-data";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeConversationTurnProjectionEntry,
	RuntimeExploratorySessionMapCollection,
	RuntimeExploratorySessionMapNode,
} from "@/runtime/types";

const { fetchProjectionMock, fetchSessionMapMock } = vi.hoisted(() => ({
	fetchProjectionMock: vi.fn(),
	fetchSessionMapMock: vi.fn(),
}));

vi.mock("@/runtime/session-map-query", () => ({
	fetchConversationSessionTurnProjection: fetchProjectionMock,
	fetchExploratorySessionMap: fetchSessionMapMock,
}));

function createProjection(
	signature: string,
	entryOverrides?: Partial<RuntimeConversationTurnProjectionEntry>,
): RuntimeConversationSessionTurnProjectionResponse {
	return {
		harnessSource: "exact_structured",
		turnProjectionEntries: [
			{
				turnNumber: 1,
				turnStartedAt: 1,
				turnUserMessageExcerpt: "首轮消息",
				turnAssistantResponseExcerpt: null,
				turnMessageCount: 2,
				turnCheckpointCommit: "commit-1",
				turnCheckpointAlignmentConfidence: "exact_ordinal_match",
				turnIsInProgress: false,
				turnHasConversationTreeForkAnchor: false,
				...entryOverrides,
			},
		],
		turnProjectionSignature: signature,
		turnProjectionIsIncomplete: false,
	};
}

function createMapNode(overrides: Partial<RuntimeExploratorySessionMapNode> = {}): RuntimeExploratorySessionMapNode {
	return {
		mapNodeId: "turn-1-milestone",
		anchorConversationSessionTaskId: "session-1",
		anchorTurnNumber: 1,
		anchorTurnCheckpointCommit: "commit-1",
		anchorTurnUserMessagePreview: null,
		nodeKind: "milestone",
		nodeTitle: "定了存储方案",
		nodeSummaryMarkdown: null,
		referencedFindingId: null,
		nodeGenerationSource: "agent_live_session_maintenance",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createMapCollection(
	updatedAt: number,
	overrides: Partial<RuntimeExploratorySessionMapCollection> = {},
): RuntimeExploratorySessionMapCollection {
	return {
		sourceTurnProjectionSignature: "1:first:10",
		mapNodes: [createMapNode()],
		mapStaleReason: null,
		lastMaintenanceJobCompletedAt: null,
		updatedAt,
		...overrides,
	};
}

function HookHarness({
	workspaceId,
	conversationSessionTaskId,
	refreshKey,
	pushedMapCollection,
	onSnapshot,
}: {
	workspaceId: string | null;
	conversationSessionTaskId: string | null;
	refreshKey: string | null;
	pushedMapCollection?: RuntimeExploratorySessionMapCollection | null;
	onSnapshot: (data: SessionMapPanelData) => void;
}): null {
	onSnapshot(useSessionMapPanelData({ workspaceId, conversationSessionTaskId, refreshKey, pushedMapCollection }));
	return null;
}

describe("useSessionMapPanelData", () => {
	let container: HTMLDivElement;
	let root: Root;
	let snapshots: SessionMapPanelData[];

	async function renderHarness(props: {
		workspaceId: string | null;
		conversationSessionTaskId: string | null;
		refreshKey: string | null;
		pushedMapCollection?: RuntimeExploratorySessionMapCollection | null;
	}): Promise<void> {
		await act(async () => {
			root.render(<HookHarness {...props} onSnapshot={(data) => snapshots.push(data)} />);
		});
		// 等 effect 里的异步拉取落定。
		await act(async () => {
			await Promise.resolve();
		});
	}

	function lastSnapshot(): SessionMapPanelData {
		const snapshot = snapshots.at(-1);
		expect(snapshot).toBeDefined();
		return snapshot!;
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		snapshots = [];
		fetchProjectionMock.mockReset();
		fetchSessionMapMock.mockReset();
		fetchProjectionMock.mockImplementation(async () => createProjection("1:first:10"));
		fetchSessionMapMock.mockImplementation(async () => ({ mapCollection: null }));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("conversationSessionTaskId 为 null 时不发任何请求（面板不出现）", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: null, refreshKey: null });
		expect(fetchProjectionMock).not.toHaveBeenCalled();
		expect(fetchSessionMapMock).not.toHaveBeenCalled();
		expect(lastSnapshot().queryPhase).toBe("idle");
	});

	it("挂载后拉取投影与 map 集合", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		expect(fetchProjectionMock).toHaveBeenCalledWith("workspace-1", { conversationSessionTaskId: "session-1" });
		expect(fetchSessionMapMock).toHaveBeenCalledWith("workspace-1", "session-1");
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().projection?.turnProjectionSignature).toBe("1:first:10");
	});

	it("refreshKey 推进触发重拉；响应内容完全相等时保留旧 state 引用（内容短路）", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		const readySnapshot = lastSnapshot();
		expect(readySnapshot.queryPhase).toBe("ready");

		fetchProjectionMock.mockClear();
		fetchSessionMapMock.mockClear();
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "2:0:" });
		expect(fetchProjectionMock).toHaveBeenCalledTimes(1);
		// 同签名 → state 引用不变（下游 memo 不被打扰），且不会闪回 loading。
		expect(lastSnapshot()).toBe(readySnapshot);
	});

	it("投影签名变化时换成新数据", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		const firstSnapshot = lastSnapshot();

		fetchProjectionMock.mockImplementation(async () => createProjection("2:second:20"));
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "2:0:" });
		expect(lastSnapshot().projection?.turnProjectionSignature).toBe("2:second:20");
		expect(lastSnapshot()).not.toBe(firstSnapshot);
	});

	it("签名相同但 turnIsInProgress 翻转时不短路（回合结束必须停掉 spinner）", async () => {
		// 签名只含消息流 count:lastId:lastContentLength；回合结束（turnOwner agent→user）
		// 时最后一条消息未必再变 → 签名不变，但 turnIsInProgress 必须如实落到面板。
		fetchProjectionMock.mockImplementation(async () => createProjection("1:first:10", { turnIsInProgress: true }));
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		const generatingSnapshot = lastSnapshot();
		expect(generatingSnapshot.projection?.turnProjectionEntries[0]?.turnIsInProgress).toBe(true);

		fetchProjectionMock.mockImplementation(async () => createProjection("1:first:10", { turnIsInProgress: false }));
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "2:0:" });
		expect(lastSnapshot().projection?.turnProjectionEntries[0]?.turnIsInProgress).toBe(false);
		expect(lastSnapshot()).not.toBe(generatingSnapshot);
	});

	it("签名相同但 checkpoint 落地（commit / 对齐置信度变化）时不短路", async () => {
		// checkpoint 在回合结束后异步写 git ref：消息流没变 → 签名不变，
		// 但 turnCheckpointCommit / turnCheckpointAlignmentConfidence 从 unaligned 翻成已对齐。
		fetchProjectionMock.mockImplementation(async () =>
			createProjection("1:first:10", {
				turnCheckpointCommit: null,
				turnCheckpointAlignmentConfidence: "unaligned",
			}),
		);
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		const unalignedSnapshot = lastSnapshot();
		expect(unalignedSnapshot.projection?.turnProjectionEntries[0]?.turnCheckpointAlignmentConfidence).toBe(
			"unaligned",
		);

		fetchProjectionMock.mockImplementation(async () => createProjection("1:first:10"));
		await renderHarness({
			workspaceId: "workspace-1",
			conversationSessionTaskId: "session-1",
			refreshKey: "2:1:commit-1",
		});
		const alignedEntry = lastSnapshot().projection?.turnProjectionEntries[0];
		expect(alignedEntry?.turnCheckpointCommit).toBe("commit-1");
		expect(alignedEntry?.turnCheckpointAlignmentConfidence).toBe("exact_ordinal_match");
		expect(lastSnapshot()).not.toBe(unalignedSnapshot);
	});

	it("切换会话时立即清空旧会话数据，绝不用上一会话的投影渲染", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		expect(lastSnapshot().projection?.turnProjectionSignature).toBe("1:first:10");

		// 让 session-2 的拉取挂起：切换瞬间必须先落入「清空的 loading」，而不是带着旧数据。
		let resolveSecond!: (value: RuntimeConversationSessionTurnProjectionResponse) => void;
		fetchProjectionMock.mockImplementation(
			async () =>
				await new Promise<RuntimeConversationSessionTurnProjectionResponse>((resolve) => {
					resolveSecond = resolve;
				}),
		);
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="workspace-1"
					conversationSessionTaskId="session-2"
					refreshKey="1:0:"
					onSnapshot={(data) => snapshots.push(data)}
				/>,
			);
		});
		expect(lastSnapshot().queryPhase).toBe("loading");
		expect(lastSnapshot().projection).toBeNull();

		resolveSecond(createProjection("3:third:30"));
		await act(async () => {
			await Promise.resolve();
		});
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().projection?.turnProjectionSignature).toBe("3:third:30");
	});

	it("拉取失败标 error 相位并保留旧数据，下一次 refreshKey 变化自然重试", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		expect(lastSnapshot().queryPhase).toBe("ready");

		fetchProjectionMock.mockImplementation(async () => {
			throw new Error("network down");
		});
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "2:0:" });
		expect(lastSnapshot().queryPhase).toBe("error");
		expect(lastSnapshot().projection?.turnProjectionSignature).toBe("1:first:10");
	});

	it("WS 推送到达即替换 map 集合，不等下一次重拉", async () => {
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		expect(lastSnapshot().mapCollection).toBeNull();

		const pushed = createMapCollection(100);
		await renderHarness({
			workspaceId: "workspace-1",
			conversationSessionTaskId: "session-1",
			refreshKey: "1:0:",
			pushedMapCollection: pushed,
		});
		expect(lastSnapshot().mapCollection).toBe(pushed);
		// 推送不触发重拉（查询通道只认 refreshKey / 会话切换）。
		expect(fetchProjectionMock).toHaveBeenCalledTimes(1);
		expect(fetchSessionMapMock).toHaveBeenCalledTimes(1);
	});

	it("内容与现状相等的推送保留旧 state 引用（不打扰下游 memo）", async () => {
		const collection = createMapCollection(100);
		fetchSessionMapMock.mockImplementation(async () => ({ mapCollection: collection }));
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		const readySnapshot = lastSnapshot();
		expect(readySnapshot.mapCollection).toBe(collection);

		await renderHarness({
			workspaceId: "workspace-1",
			conversationSessionTaskId: "session-1",
			refreshKey: "1:0:",
			// 同内容不同对象：stale 置位广播与查询响应常携带同一集合的另一份序列化拷贝。
			pushedMapCollection: createMapCollection(100),
		});
		expect(lastSnapshot()).toBe(readySnapshot);
	});

	it("抓取期间到达的推送不被更旧的查询响应回退（按 updatedAt 归并）", async () => {
		// 挂起 map 查询：推送先于响应到达，响应读自推送落盘之前（updatedAt 更旧）。
		let resolveSessionMap!: (value: { mapCollection: RuntimeExploratorySessionMapCollection | null }) => void;
		fetchSessionMapMock.mockImplementation(
			async () =>
				await new Promise<{ mapCollection: RuntimeExploratorySessionMapCollection | null }>((resolve) => {
					resolveSessionMap = resolve;
				}),
		);
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="workspace-1"
					conversationSessionTaskId="session-1"
					refreshKey="1:0:"
					onSnapshot={(data) => snapshots.push(data)}
				/>,
			);
		});
		const pushed = createMapCollection(200);
		await renderHarness({
			workspaceId: "workspace-1",
			conversationSessionTaskId: "session-1",
			refreshKey: "1:0:",
			pushedMapCollection: pushed,
		});
		expect(lastSnapshot().mapCollection).toBe(pushed);

		resolveSessionMap({ mapCollection: createMapCollection(100) });
		await act(async () => {
			await Promise.resolve();
		});
		// 响应更旧：保留推送的集合，相位照常翻 ready。
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().mapCollection?.updatedAt).toBe(200);
	});

	it("抓取开始前已应用的推送不阻挡更新的查询响应（响应读自 durable 写之后）", async () => {
		const pushed = createMapCollection(100);
		fetchSessionMapMock.mockImplementation(async () => ({ mapCollection: createMapCollection(300) }));
		await renderHarness({
			workspaceId: "workspace-1",
			conversationSessionTaskId: "session-1",
			refreshKey: "1:0:",
			pushedMapCollection: pushed,
		});
		// 推送先于抓取应用，但响应 updatedAt 更新（落盘在推送之后）→ 采用响应。
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().mapCollection?.updatedAt).toBe(300);
	});

	it("null 推送清除集合（服务端明示此会话无集合）", async () => {
		fetchSessionMapMock.mockImplementation(async () => ({ mapCollection: createMapCollection(100) }));
		await renderHarness({ workspaceId: "workspace-1", conversationSessionTaskId: "session-1", refreshKey: "1:0:" });
		expect(lastSnapshot().mapCollection?.updatedAt).toBe(100);

		await renderHarness({
			workspaceId: "workspace-1",
			conversationSessionTaskId: "session-1",
			refreshKey: "1:0:",
			pushedMapCollection: null,
		});
		expect(lastSnapshot().mapCollection).toBeNull();
	});
});
