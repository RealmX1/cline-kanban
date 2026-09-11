import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExplorationThreadGraphData, useExplorationThreadGraph } from "@/hooks/use-exploration-thread-graph";
import type {
	RuntimeExplorationThreadGraphProjectionView,
	RuntimeStateStreamExplorationThreadGraphUpdatedMessage,
} from "@/runtime/types";

const { fetchGraphMock } = vi.hoisted(() => ({
	fetchGraphMock: vi.fn(),
}));

vi.mock("@/runtime/exploration-thread-graph-query", () => ({
	fetchExplorationThreadGraph: fetchGraphMock,
}));

// lastMaintenanceJobCompletedAt 在这里当「这张图是谁的」的标记用：跨 project 撞号的场景里
// explorationId 两边一模一样，只有它能把 A 的图和 B 的图区分开。
function createView(markerCompletedAt: number): RuntimeExplorationThreadGraphProjectionView {
	return {
		schemaVersion: 1,
		explorationId: "12",
		turnRows: [],
		threads: [],
		laneCount: 0,
		staleReason: null,
		unplacedTurnCountBySession: {},
		lastMaintenanceJobCompletedAt: markerCompletedAt,
		lastMaintenanceJobUsage: null,
		anyTurnSourceIsTranscriptReconstructed: false,
	};
}

function createPushedUpdate(
	workspaceId: string,
	explorationId: string,
	markerCompletedAt: number,
): RuntimeStateStreamExplorationThreadGraphUpdatedMessage {
	return {
		type: "exploration_thread_graph_updated",
		workspaceId,
		explorationId,
		view: createView(markerCompletedAt),
	};
}

function HookHarness({
	workspaceId,
	explorationId,
	refreshKey,
	pushedUpdate,
	onSnapshot,
}: {
	workspaceId: string | null;
	explorationId: string | null;
	refreshKey: number | null;
	pushedUpdate: RuntimeStateStreamExplorationThreadGraphUpdatedMessage | null;
	onSnapshot: (data: ExplorationThreadGraphData) => void;
}): null {
	onSnapshot(useExplorationThreadGraph({ workspaceId, explorationId, refreshKey, pushedUpdate }));
	return null;
}

describe("useExplorationThreadGraph", () => {
	let container: HTMLDivElement;
	let root: Root;
	let snapshots: ExplorationThreadGraphData[];

	async function renderHarness(props: {
		workspaceId: string | null;
		explorationId: string | null;
		refreshKey: number | null;
		pushedUpdate?: RuntimeStateStreamExplorationThreadGraphUpdatedMessage | null;
	}): Promise<void> {
		await act(async () => {
			root.render(<HookHarness pushedUpdate={null} {...props} onSnapshot={(data) => snapshots.push(data)} />);
		});
		// 等 effect 里的异步拉取落定。
		await act(async () => {
			await Promise.resolve();
		});
	}

	function lastSnapshot(): ExplorationThreadGraphData {
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
		fetchGraphMock.mockReset();
		fetchGraphMock.mockImplementation(async () => ({
			view: createView(1),
			turnSourceUnavailableSessionIds: [],
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("同 workspace 同 exploration 的推送到达即采纳，且不被随后落定的查询响应压掉", async () => {
		// 推送必须发生在**查询开始之后的另一次 render**，不能与首次 render 同批给进去：同一次 commit 内
		// 三个 effect 按声明序执行，推送 effect 恒先于查询 effect，于是 receivedAt ≤ fetchStartedAt，
		// 而归并判据是 `receivedAt >= fetchStartedAt`——只在同毫秒下成立。机器一忙（全量套件并行跑时）
		// 两个 Date.now() 之间走过 1ms，响应就会赢，断言随机翻面。那是测试写法的时序依赖，不是 hook
		// 的行为；把推送挪到独立 commit 后，两种情况（同毫秒 / 晚 1ms）都判推送赢，断言才是确定的。
		let resolveFetch!: (value: {
			view: RuntimeExplorationThreadGraphProjectionView;
			turnSourceUnavailableSessionIds: string[];
		}) => void;
		fetchGraphMock.mockImplementation(
			async () =>
				await new Promise<{
					view: RuntimeExplorationThreadGraphProjectionView;
					turnSourceUnavailableSessionIds: string[];
				}>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		await renderHarness({ workspaceId: "project-a", explorationId: "12", refreshKey: 1 });
		expect(lastSnapshot().queryPhase).toBe("loading");

		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="project-a"
					explorationId="12"
					refreshKey={1}
					pushedUpdate={createPushedUpdate("project-a", "12", 42)}
					onSnapshot={(data) => snapshots.push(data)}
				/>,
			);
		});
		expect(lastSnapshot().view?.lastMaintenanceJobCompletedAt).toBe(42);

		// 查询落定得比推送晚：推送恒为更新事实，绝不能被这份更早读出来的响应盖回去。
		resolveFetch({ view: createView(7), turnSourceUnavailableSessionIds: [] });
		await act(async () => {
			await Promise.resolve();
		});
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().view?.lastMaintenanceJobCompletedAt).toBe(42);
	});

	it("explorationId 撞号但 workspaceId 不同的推送一律不采纳（跨 project 撞号）", async () => {
		// 切到 project-b 的同号卡片，stream 层仍保留着 project-a 的最近一条推送。
		let resolveFetch!: (value: {
			view: RuntimeExplorationThreadGraphProjectionView;
			turnSourceUnavailableSessionIds: string[];
		}) => void;
		fetchGraphMock.mockImplementation(
			async () =>
				await new Promise<{
					view: RuntimeExplorationThreadGraphProjectionView;
					turnSourceUnavailableSessionIds: string[];
				}>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		await renderHarness({
			workspaceId: "project-b",
			explorationId: "12",
			refreshKey: 1,
			pushedUpdate: createPushedUpdate("project-a", "12", 42),
		});
		// 新 project 的查询还在飞：绝不能拿旧 project 的同号图顶上。
		expect(lastSnapshot().queryPhase).toBe("loading");
		expect(lastSnapshot().view).toBeNull();

		resolveFetch({ view: createView(7), turnSourceUnavailableSessionIds: [] });
		await act(async () => {
			await Promise.resolve();
		});
		// 落定后也只认本 workspace 的查询结果，绝不被旧推送按时序归并压掉。
		expect(lastSnapshot().queryPhase).toBe("ready");
		expect(lastSnapshot().view?.lastMaintenanceJobCompletedAt).toBe(7);
	});

	it("explorationId 不变、只换 workspace 时立即作废上一个 project 的图", async () => {
		await renderHarness({ workspaceId: "project-a", explorationId: "12", refreshKey: 1 });
		expect(lastSnapshot().view?.lastMaintenanceJobCompletedAt).toBe(1);

		fetchGraphMock.mockImplementation(
			async () =>
				await new Promise<{
					view: RuntimeExplorationThreadGraphProjectionView;
					turnSourceUnavailableSessionIds: string[];
				}>(() => {
					// 永不落定：模拟新 project 的加载窗口。
				}),
		);
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="project-b"
					explorationId="12"
					refreshKey={1}
					pushedUpdate={null}
					onSnapshot={(data) => snapshots.push(data)}
				/>,
			);
		});
		expect(lastSnapshot().queryPhase).toBe("loading");
		expect(lastSnapshot().view).toBeNull();
	});
});
