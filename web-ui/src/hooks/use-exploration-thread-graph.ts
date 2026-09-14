// exploration thread graph 的 per-exploration 数据编排 hook（B.2）。
//
// 两条数据源通道（与 use-exploratory-findings 同款双通道范式，但作用域不同）：
// 1. 查询：选中某张卡片时经 exploratory.getExplorationThreadGraph 拉一次整值。**读图免费**——
//    服务端只读落盘 collection 与 transcript 增量，不 fork 任何进程，所以重连重拉没有成本顾虑。
// 2. 推送：exploration_thread_graph_updated 在维护作业落盘后广播该 exploration 的整张图。
//
// 与 findings 的关键差别：findings 是 workspace 级全量集合，这里是**按 exploration 分的**。
// 推送携带 workspaceId + explorationId，两者必须**联合**过滤：同一个 workspace 下可以有多张图，
// 不按 explorationId 过滤就会让打开 A 卡片的人看到 B 卡片判完的图；而 explorationId 是 board-local
// 短 id，跨 project 撞号是常态，不按 workspaceId 过滤就会让刚切过来的新 project 显示上一个 project
// 的同号图（stream 层把最近一条推送保留作 last-known，切 workspace 时并不清空）。
//
// 维护动作（requestExplorationThreadGraphMaintenance）不在此 hook 内：它会花钱，必须由组件里
// 一次明确的点击直调 query 层，绝不能被 effect 依赖变化悄悄触发。

import { useEffect, useRef, useState } from "react";
import { fetchExplorationThreadGraph } from "@/runtime/exploration-thread-graph-query";
import type {
	RuntimeExplorationThreadGraphProjectionView,
	RuntimeStateStreamExplorationThreadGraphUpdatedMessage,
} from "@/runtime/types";

export type ExplorationThreadGraphQueryPhase = "idle" | "loading" | "ready" | "error";

export interface ExplorationThreadGraphData {
	queryPhase: ExplorationThreadGraphQueryPhase;
	// null = 尚未加载（初始查询未落定且未收到过推送）。空图不是 null——服务端对「还没有任何 turn
	// 归位」返回的是一张 turnRows 为空的图，两者对用户是不同的事。
	view: RuntimeExplorationThreadGraphProjectionView | null;
	// 转录暂时读不出来的会话（文件被删 / 格式漂移）。只有查询通道给得出，推送不带。
	turnSourceUnavailableSessionIds: string[];
}

const IDLE_EXPLORATION_THREAD_GRAPH_DATA: ExplorationThreadGraphData = {
	queryPhase: "idle",
	view: null,
	turnSourceUnavailableSessionIds: [],
};

export function useExplorationThreadGraph(input: {
	workspaceId: string | null;
	// 当前选中的 exploration（= 主任务卡片 id）。null = 不加载。
	explorationId: string | null;
	// 重拉信号：调用方传 stream 快照代数（每次重连握手完成即递增）——断连窗口的图变更不补发。
	refreshKey: number | null;
	// WS 推送的整张图；null = 尚未收到过推送。携带 explorationId，本 hook 负责过滤。
	pushedUpdate: RuntimeStateStreamExplorationThreadGraphUpdatedMessage | null;
}): ExplorationThreadGraphData {
	const { workspaceId, explorationId, refreshKey, pushedUpdate } = input;
	const [data, setData] = useState<ExplorationThreadGraphData>(IDLE_EXPLORATION_THREAD_GRAPH_DATA);
	// 最近一次「属于当前 exploration」的推送及其到达时刻，用于与在飞查询按时序归并。
	const latestMatchingPushRef = useRef<{
		receivedAt: number;
		view: RuntimeExplorationThreadGraphProjectionView;
	} | null>(null);

	// 切换 exploration **或 workspace**：上一张图与它的推送记录立刻作废，绝不让 A 的图在 B 的面板上
	// 多停一帧。workspaceId 必须一并计入依赖：explorationId 是 board-local 短 id，跨 project 撞号是
	// 常态，只看 explorationId 会在切到另一个 project 的同号卡片时整个漏掉重置。
	useEffect(() => {
		latestMatchingPushRef.current = null;
		setData(IDLE_EXPLORATION_THREAD_GRAPH_DATA);
	}, [workspaceId, explorationId]);

	useEffect(() => {
		if (pushedUpdate === null || workspaceId === null || explorationId === null) {
			return;
		}
		if (pushedUpdate.workspaceId !== workspaceId || pushedUpdate.explorationId !== explorationId) {
			// 不是本面板这张图：可能是同 workspace 下的另一张，也可能是切 project 前遗留的、
			// explorationId 恰好撞号的旧 workspace 推送（stream 层保留 last-known，不随切换清空）。
			// 两个 id 必须联合比对——与服务端 exploration-thread-graph-maintenance-trigger 的
			// workspace + exploration 联合计账同一条纪律。
			return;
		}
		latestMatchingPushRef.current = { receivedAt: Date.now(), view: pushedUpdate.view };
		setData((current) => ({
			queryPhase: current.queryPhase === "idle" ? "ready" : current.queryPhase,
			view: pushedUpdate.view,
			turnSourceUnavailableSessionIds: current.turnSourceUnavailableSessionIds,
		}));
	}, [pushedUpdate, explorationId]);

	useEffect(() => {
		if (workspaceId === null || explorationId === null) {
			setData(IDLE_EXPLORATION_THREAD_GRAPH_DATA);
			return;
		}
		let cancelled = false;
		const fetchStartedAt = Date.now();
		setData((current) => ({ ...current, queryPhase: "loading" }));
		void (async () => {
			try {
				const response = await fetchExplorationThreadGraph(workspaceId, explorationId);
				if (cancelled) {
					return;
				}
				// 抓取期间到达的推送（receivedAt ≥ fetchStartedAt）可能比响应更新：响应可能读自推送的
				// durable 写之前。推送恒为更新事实，优先采用；更早的推送必然已反映在响应里。
				const latestPush = latestMatchingPushRef.current;
				const view =
					latestPush !== null && latestPush.receivedAt >= fetchStartedAt ? latestPush.view : response.view;
				setData({
					queryPhase: "ready",
					view,
					turnSourceUnavailableSessionIds: response.turnSourceUnavailableSessionIds,
				});
			} catch {
				if (!cancelled) {
					setData((current) => ({ ...current, queryPhase: "error" }));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId, explorationId, refreshKey]);

	return data;
}
