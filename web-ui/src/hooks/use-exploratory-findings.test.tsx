import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExploratoryFindingsData, useExploratoryFindings } from "@/hooks/use-exploratory-findings";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

const { fetchFindingsMock } = vi.hoisted(() => ({
	fetchFindingsMock: vi.fn(),
}));

vi.mock("@/runtime/findings-query", () => ({
	fetchExploratoryFindings: fetchFindingsMock,
}));

function createFinding(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "存储方案定了",
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
		...overrides,
	};
}

function HookHarness({
	workspaceId,
	refreshKey,
	pushedFindings,
	onSnapshot,
}: {
	workspaceId: string | null;
	refreshKey: number | null;
	pushedFindings: RuntimeExploratoryFindingEntry[] | null;
	onSnapshot: (data: ExploratoryFindingsData) => void;
}): null {
	onSnapshot(useExploratoryFindings({ workspaceId, refreshKey, pushedFindings }));
	return null;
}

describe("useExploratoryFindings", () => {
	let container: HTMLDivElement;
	let root: Root;
	let snapshots: ExploratoryFindingsData[];

	async function renderHarness(props: {
		workspaceId: string | null;
		refreshKey: number | null;
		pushedFindings?: RuntimeExploratoryFindingEntry[] | null;
	}): Promise<void> {
		await act(async () => {
			root.render(<HookHarness pushedFindings={null} {...props} onSnapshot={(data) => snapshots.push(data)} />);
		});
		// 等 effect 里的异步拉取落定。
		await act(async () => {
			await Promise.resolve();
		});
	}

	function lastSnapshot(): ExploratoryFindingsData {
		const snapshot = snapshots.at(-1);
		expect(snapshot).toBeDefined();
		return snapshot!;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		snapshots = [];
		fetchFindingsMock.mockReset();
		fetchFindingsMock.mockImplementation(async () => ({ findings: [createFinding()] }));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
	});

	it("workspaceId 为 null 时不发任何请求", async () => {
		await renderHarness({ workspaceId: null, refreshKey: null });
		expect(fetchFindingsMock).not.toHaveBeenCalled();
		expect(lastSnapshot().queryPhase).toBe("idle");
		expect(lastSnapshot().findings).toBeNull();
	});

	it("进 workspace 拉一次全量（getFindings）", async () => {
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1 });
		expect(fetchFindingsMock).toHaveBeenCalledWith("workspace-1");
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().findings).toHaveLength(1);
	});

	it("refreshKey 推进触发重拉；内容相等时保留旧 state 引用（内容短路）", async () => {
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1 });
		const readySnapshot = lastSnapshot();
		expect(readySnapshot.queryPhase).toBe("ready");

		fetchFindingsMock.mockClear();
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 2 });
		expect(fetchFindingsMock).toHaveBeenCalledTimes(1);
		expect(lastSnapshot()).toBe(readySnapshot);
	});

	it("切换 workspace 立即清空旧集合，绝不用上一 workspace 的 findings 渲染", async () => {
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1 });
		expect(lastSnapshot().findings).toHaveLength(1);

		let resolveSecond!: (value: { findings: RuntimeExploratoryFindingEntry[] }) => void;
		fetchFindingsMock.mockImplementation(
			async () =>
				await new Promise<{ findings: RuntimeExploratoryFindingEntry[] }>((resolve) => {
					resolveSecond = resolve;
				}),
		);
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="workspace-2"
					refreshKey={1}
					pushedFindings={null}
					onSnapshot={(data) => snapshots.push(data)}
				/>,
			);
		});
		expect(lastSnapshot().queryPhase).toBe("loading");
		expect(lastSnapshot().findings).toBeNull();

		resolveSecond({ findings: [createFinding({ findingId: "finding-w2" })] });
		await act(async () => {
			await Promise.resolve();
		});
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().findings?.[0]?.findingId).toBe("finding-w2");
	});

	it("拉取失败标 error 相位并保留旧数据，下一次 refreshKey 变化自然重试", async () => {
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1 });
		expect(lastSnapshot().queryPhase).toBe("ready");

		fetchFindingsMock.mockImplementation(async () => {
			throw new Error("network down");
		});
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 2 });
		expect(lastSnapshot().queryPhase).toBe("error");
		expect(lastSnapshot().findings).toHaveLength(1);
	});

	it("WS 推送到达即全量替换，不等下一次重拉", async () => {
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1 });
		expect(lastSnapshot().findings).toHaveLength(1);

		const pushed = [createFinding({ findingId: "f-1" }), createFinding({ findingId: "f-2" })];
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1, pushedFindings: pushed });
		expect(lastSnapshot().findings).toBe(pushed);
		// 推送不触发重拉（查询通道只认 refreshKey / workspace 切换）。
		expect(fetchFindingsMock).toHaveBeenCalledTimes(1);
	});

	it("内容与现状相等的推送保留旧 state 引用（不打扰下游 memo）", async () => {
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1 });
		const readySnapshot = lastSnapshot();

		await renderHarness({
			workspaceId: "workspace-1",
			refreshKey: 1,
			// 同内容不同对象：推送与查询响应常携带同一集合的另一份序列化拷贝。
			pushedFindings: [createFinding()],
		});
		expect(lastSnapshot()).toBe(readySnapshot);
	});

	it("抓取期间到达的推送不被更旧的查询响应回退（推送是全量替换的更新事实）", async () => {
		// 挂起查询：推送先于响应到达，响应可能读自推送落盘之前。
		let resolveFetch!: (value: { findings: RuntimeExploratoryFindingEntry[] }) => void;
		fetchFindingsMock.mockImplementation(
			async () =>
				await new Promise<{ findings: RuntimeExploratoryFindingEntry[] }>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="workspace-1"
					refreshKey={1}
					pushedFindings={null}
					onSnapshot={(data) => snapshots.push(data)}
				/>,
			);
		});
		// 推进时钟再应用推送：receivedAt 严格晚于 fetchStartedAt（真实场景即如此，
		// 测试里靠 fake timers 消除同毫秒边界的偶然性）。
		vi.advanceTimersByTime(1000);
		const pushed = [createFinding({ findingId: "pushed-new" })];
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1, pushedFindings: pushed });
		expect(lastSnapshot().findings).toBe(pushed);

		resolveFetch({ findings: [createFinding({ findingId: "stale-fetch" })] });
		await act(async () => {
			await Promise.resolve();
		});
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().findings?.[0]?.findingId).toBe("pushed-new");
	});

	it("从 workspaceId=null 恢复时，旧 last-known 推送快照不得压掉恢复后的重拉响应", async () => {
		// 建立 last-known：推送先应用，初次查询落定（内容同为该快照）。
		const stalePush = [createFinding({ findingId: "stale-last-known" })];
		fetchFindingsMock.mockImplementation(async () => ({ findings: stalePush }));
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1, pushedFindings: stalePush });
		expect(lastSnapshot().findings).toBe(stalePush);

		// workspaceId 掉 null：父级（runtime-state-stream）保留 last-known 推送 prop，
		// hook 自身回到 idle。
		await renderHarness({ workspaceId: null, refreshKey: null, pushedFindings: stalePush });
		expect(lastSnapshot().queryPhase).toBe("idle");
		expect(lastSnapshot().findings).toBeNull();

		// 恢复：同一份旧推送快照随 prop 重放（并非新广播），getFindings 返回空窗期
		// 更新后的集合——重拉结果必须胜出，否则界面永远停在旧集合（无新推送可救）。
		fetchFindingsMock.mockImplementation(async () => ({
			findings: [createFinding({ findingId: "refetched-newer" })],
		}));
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 2, pushedFindings: stalePush });
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().findings?.[0]?.findingId).toBe("refetched-newer");
	});

	it("抓取开始前已应用的推送不阻挡更新的查询响应（重连后重拉对齐的真实路径）", async () => {
		// 推送先应用（内容 = 推送），随后断连窗口的变更经 refreshKey 重拉对齐：
		// 推送的 receivedAt 早于新一轮抓取的 fetchStartedAt → 采用响应。
		const pushed = [createFinding({ findingId: "pushed" })];
		fetchFindingsMock.mockImplementation(async () => ({ findings: pushed }));
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 1, pushedFindings: pushed });
		expect(lastSnapshot().findings).toBe(pushed);

		vi.advanceTimersByTime(1000);
		fetchFindingsMock.mockImplementation(async () => ({ findings: [createFinding({ findingId: "fetched-newer" })] }));
		await renderHarness({ workspaceId: "workspace-1", refreshKey: 2, pushedFindings: pushed });
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().findings?.[0]?.findingId).toBe("fetched-newer");
	});
});
