// Exploratory findings 的 workspace 级数据编排 hook（蓝图 §D.3 / §G.2，M2）。
// 单一真相：App 实例化一次，findings 浏览器 / map 面板切片 / save 对话框查重都消费
// 同一份结果，绝不在多个组件各存一份。
//
// 两条数据源通道（查询 + WS 推送归并的双通道范式）：
// 1. 查询：进 workspace 经 exploratory.getFindings 拉一次全量（集合恒小，上限 500）；
//    断连窗口的变更不补发，靠 refreshKey（stream 快照代数）递增触发重拉对齐。
// 2. 推送：exploratory_findings_updated 全量替换广播经 runtime-state-stream 以
//    pushedFindings 传入（null = 尚未收到过推送）。推送携带服务端完整集合，
//    到达即替换；与在飞查询响应按到达时序归并——响应可能读自推送落盘之前，
//    绝不用旧响应回退新推送。
// mutation（save/confirm/reject/archive）不在此 hook 内：组件直调 findings-query，
// 状态经服务端落盘后的推送收敛，本地不做乐观更新。

import { useEffect, useRef, useState } from "react";
import { fetchExploratoryFindings } from "@/runtime/findings-query";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

export type ExploratoryFindingsQueryPhase = "idle" | "loading" | "ready" | "error";

export interface ExploratoryFindingsData {
	queryPhase: ExploratoryFindingsQueryPhase;
	// null = 尚未加载（初始查询未落定且未收到过推送）。
	findings: RuntimeExploratoryFindingEntry[] | null;
}

const IDLE_EXPLORATORY_FINDINGS_DATA: ExploratoryFindingsData = {
	queryPhase: "idle",
	findings: null,
};

// 内容相等判定（短路门槛）：集合经同一 zod schema 序列化（key 序稳定）且恒小，
// 整体比较成本可忽略（use-conversation-session-turn-projection 同款先例）。
function areFindingsEqual(
	left: readonly RuntimeExploratoryFindingEntry[] | null,
	right: readonly RuntimeExploratoryFindingEntry[] | null,
): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// 抓取响应落定时的归并：推送若在抓取期间到达（receivedAt ≥ fetchStartedAt），响应可能
// 读自推送的 durable 写之前——推送是全量替换且恒为更新事实，采用推送；抓取开始前就
// 到的推送必然已反映在服务端读取结果里（请求发出晚于 durable 写），直接采用响应。
function resolveFindingsAfterFetch(
	latestPush: { receivedAt: number; findings: RuntimeExploratoryFindingEntry[] } | null,
	fetchStartedAt: number,
	fetchedFindings: RuntimeExploratoryFindingEntry[],
): RuntimeExploratoryFindingEntry[] {
	if (latestPush !== null && latestPush.receivedAt >= fetchStartedAt) {
		return latestPush.findings;
	}
	return fetchedFindings;
}

export function useExploratoryFindings(input: {
	workspaceId: string | null;
	// 重拉信号：调用方传 stream 快照代数（每次重连握手完成即递增）——断连窗口的
	// findings 变更不补发，靠这次重拉对齐。
	refreshKey: number | null;
	// WS 推送的全量集合（exploratory_findings_updated）：null = 尚未收到过推送。
	pushedFindings: RuntimeExploratoryFindingEntry[] | null;
}): ExploratoryFindingsData {
	const [data, setData] = useState<ExploratoryFindingsData>(IDLE_EXPLORATORY_FINDINGS_DATA);
	// workspace 切换要立即清空旧数据（上一 workspace 的 findings 不得带进新 workspace）；
	// 同 workspace 的 refreshKey 推进则保留旧数据静默重拉，避免列表闪回 loading。
	const lastWorkspaceIdRef = useRef<string | null>(null);
	// 最近一次应用到 state 的推送及其到达时序：抓取响应落定时按它判断响应是否可能更旧。
	const lastAppliedPushRef = useRef<{ receivedAt: number; findings: RuntimeExploratoryFindingEntry[] } | null>(null);
	// 推送通道上一次见到的 prop 本体（引用即身份：新广播恒反序列化出新数组）。跨 workspaceId
	// 的 null 过渡期保留，专用来识别「恢复后随 prop 重放的 last-known 快照」——重放不得刷新
	// 到达时序，否则 resolveFindingsAfterFetch 把它误判成「抓取期间到达」，压掉恢复后重拉回来
	// 的更新集合（服务端不重播无变更推送，界面就此停在旧集合，重连重查对齐失效）。
	const lastSeenPushedFindingsRef = useRef<RuntimeExploratoryFindingEntry[] | null>(null);

	useEffect(() => {
		const { workspaceId } = input;
		if (!workspaceId) {
			lastWorkspaceIdRef.current = null;
			lastAppliedPushRef.current = null;
			setData(IDLE_EXPLORATORY_FINDINGS_DATA);
			return;
		}
		if (lastWorkspaceIdRef.current !== workspaceId) {
			lastWorkspaceIdRef.current = workspaceId;
			lastAppliedPushRef.current = null;
			setData({ queryPhase: "loading", findings: null });
		}
		const fetchStartedAt = Date.now();
		let cancelled = false;
		void (async () => {
			let fetchedFindings: RuntimeExploratoryFindingEntry[];
			try {
				const response = await fetchExploratoryFindings(workspaceId);
				fetchedFindings = response.findings;
			} catch {
				if (cancelled) {
					return;
				}
				// 失败保留旧数据（旧集合好过没有），只把相位标成 error；下一次 refreshKey 变化自然重试。
				setData((current) => ({ ...current, queryPhase: "error" }));
				return;
			}
			if (cancelled) {
				return;
			}
			setData((current) => {
				const findings = resolveFindingsAfterFetch(lastAppliedPushRef.current, fetchStartedAt, fetchedFindings);
				// 内容短路：重拉结果与现有数据真正相等 → 保留旧引用，下游 memo 零打扰。
				if (areFindingsEqual(current.findings, findings)) {
					return current.queryPhase === "ready" ? current : { ...current, queryPhase: "ready" };
				}
				return { queryPhase: "ready", findings };
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [input.workspaceId, input.refreshKey]);

	// 推送通道：到达即应用（durable-write-before-ack 保证推送先于 ack，是最新事实）。
	// 内容相等的推送不打扰下游 memo。
	useEffect(() => {
		const { workspaceId, pushedFindings } = input;
		if (!workspaceId || pushedFindings === null) {
			return;
		}
		// 仅推送值真正更新（新广播）才记「新到达」并刷新 receivedAt；同一份 last-known
		// 快照经 null 恢复期重放时保留原记录，恢复后的重拉响应据此优先于历史快照。
		if (lastSeenPushedFindingsRef.current !== pushedFindings) {
			lastSeenPushedFindingsRef.current = pushedFindings;
			lastAppliedPushRef.current = { receivedAt: Date.now(), findings: pushedFindings };
		}
		setData((current) => {
			if (areFindingsEqual(current.findings, pushedFindings)) {
				return current;
			}
			return {
				queryPhase: current.queryPhase === "idle" ? "ready" : current.queryPhase,
				findings: pushedFindings,
			};
		});
	}, [input.workspaceId, input.pushedFindings]);

	return data;
}
