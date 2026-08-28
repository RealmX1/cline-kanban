// Session Map 面板的数据编排 hook（蓝图 §G.1 + 姊妹蓝图 §2.3）。
//
// 两条数据源通道：
// 1. 查询（M0 起）：投影层不新增 WS 事件，重拉信号由调用方把低频会话信号拼成 refreshKey
//    传入。M0 用「全量重拉 + 内容短路」——重拉结果与现有数据内容真正相等才保留旧 state
//    引用、不惊扰下游 memo；sinceTurnNumber 增量拉取留待后续（蓝图 §2.3
//    已预留该参数，M0 会话 turn 量级下全量成本可忽略）。
// 2. 推送（M1 起）：exploratory_session_map_updated 广播经 runtime-state-stream 落到调用方，
//    以 pushedMapCollection 传入（undefined = 该会话尚未收到过推送）。推送携带服务端完整
//    集合，到达即替换 state 中的 mapCollection；与在飞查询响应按 updatedAt/到达时序归并，
//    谁新用谁（响应可能读自推送落盘之前，绝不用旧响应回退新推送）。

import { useEffect, useRef, useState } from "react";
import { fetchConversationSessionTurnProjection, fetchExploratorySessionMap } from "@/runtime/session-map-query";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeExploratorySessionMapCollection,
} from "@/runtime/types";

export type SessionMapPanelQueryPhase = "idle" | "loading" | "ready" | "error";

export interface SessionMapPanelData {
	queryPhase: SessionMapPanelQueryPhase;
	projection: RuntimeConversationSessionTurnProjectionResponse | null;
	mapCollection: RuntimeExploratorySessionMapCollection | null;
}

const IDLE_SESSION_MAP_PANEL_DATA: SessionMapPanelData = {
	queryPhase: "idle",
	projection: null,
	mapCollection: null,
};

// 内容相等判定（短路门槛）：必须覆盖影响渲染的响应全部字段，不能只比投影签名——
// 签名只含消息流 count:lastId:lastContentLength，而 turnIsInProgress（由 summary facet
// turnOwner 推导）、turnCheckpointCommit / turnCheckpointAlignmentConfidence（checkpoint
// 异步落地后 ref 枚举变化）、harnessSource（不可用占位签名与空消息流签名同形）都能在
// 签名不变时变化；只看签名会把这些变化短路丢弃，面板永久保留「仍在生成」spinner 或
// unaligned 旧投影。响应经同一 zod schema 序列化（key 序稳定）且体量小，整体比较
// 成本可忽略（仓内 runtime-state-stream / task-edit-drafts 同款先例）；schema 日后
// 新增字段也被自动覆盖，不会再长出同类漏比。
function areSessionMapPanelQueryResultsEqual(
	left: Pick<SessionMapPanelData, "projection" | "mapCollection">,
	right: Pick<SessionMapPanelData, "projection" | "mapCollection">,
): boolean {
	return (
		JSON.stringify(left.projection ?? null) === JSON.stringify(right.projection ?? null) &&
		JSON.stringify(left.mapCollection ?? null) === JSON.stringify(right.mapCollection ?? null)
	);
}

// 抓取响应落定时的 map 集合归并：推送若在抓取期间到达（receivedAt ≥ fetchStartedAt），
// 响应可能读自推送的 durable 写之前——按集合 updatedAt 取新，绝不回退已应用的推送；
// 推送为 null（服务端明示集合已不存在）时它必是更新的事实。抓取开始前就到的推送
// 必然已反映在服务端的读取结果里（请求发出晚于 durable 写），直接采用响应。
function resolveMapCollectionAfterFetch(
	latestPush: { receivedAt: number; collection: RuntimeExploratorySessionMapCollection | null } | null,
	fetchStartedAt: number,
	fetchedMapCollection: RuntimeExploratorySessionMapCollection | null,
): RuntimeExploratorySessionMapCollection | null {
	if (latestPush === null || latestPush.receivedAt < fetchStartedAt) {
		return fetchedMapCollection;
	}
	if (latestPush.collection === null || fetchedMapCollection === null) {
		return latestPush.collection;
	}
	return latestPush.collection.updatedAt >= fetchedMapCollection.updatedAt
		? latestPush.collection
		: fetchedMapCollection;
}

export function useSessionMapPanelData(input: {
	workspaceId: string | null;
	// null = 面板不出现（非 conversation 面板会话），不发任何请求。
	conversationSessionTaskId: string | null;
	// 重拉信号：调用方把「值得重拉投影/map 的低频会话信号」拼成 refreshKey（构成归
	// 调用方所有，本 hook 只在它变化时重拉）；null = 无活会话 summary（重启后未启动），
	// 仅在会话切换时拉一次。
	refreshKey: string | null;
	// WS 推送的该会话 map 集合（exploratory_session_map_updated，M1）：undefined = 尚未
	// 收到过该会话的推送；null = 服务端明示集合已不存在。调用方按当前会话从 stream
	// store 取条目传入，本 hook 不做会话归属过滤。
	pushedMapCollection?: RuntimeExploratorySessionMapCollection | null;
}): SessionMapPanelData {
	const [data, setData] = useState<SessionMapPanelData>(IDLE_SESSION_MAP_PANEL_DATA);
	// 会话切换要立即清空旧数据（不能把上一会话的投影当成本会话的渲染）；同会话的
	// refreshKey 推进则保留旧数据静默重拉，避免每次 summary 广播都把面板闪回 loading。
	const lastConversationSessionTaskIdRef = useRef<string | null>(null);
	// 最近一次应用到 state 的推送及其到达时序：抓取响应落定时按它判断响应是否可能更旧。
	// 按会话隔离——会话切换即清空（推送条目本身由调用方按会话选取）。
	const lastAppliedPushRef = useRef<{
		receivedAt: number;
		collection: RuntimeExploratorySessionMapCollection | null;
	} | null>(null);

	useEffect(() => {
		const { workspaceId, conversationSessionTaskId } = input;
		if (!workspaceId || !conversationSessionTaskId) {
			lastConversationSessionTaskIdRef.current = null;
			lastAppliedPushRef.current = null;
			setData(IDLE_SESSION_MAP_PANEL_DATA);
			return;
		}
		if (lastConversationSessionTaskIdRef.current !== conversationSessionTaskId) {
			lastConversationSessionTaskIdRef.current = conversationSessionTaskId;
			lastAppliedPushRef.current = null;
			setData({ queryPhase: "loading", projection: null, mapCollection: null });
		}
		const fetchStartedAt = Date.now();
		let cancelled = false;
		void (async () => {
			let projection: RuntimeConversationSessionTurnProjectionResponse;
			let fetchedMapCollection: RuntimeExploratorySessionMapCollection | null;
			try {
				const [nextProjection, mapResponse] = await Promise.all([
					fetchConversationSessionTurnProjection(workspaceId, { conversationSessionTaskId }),
					fetchExploratorySessionMap(workspaceId, conversationSessionTaskId),
				]);
				projection = nextProjection;
				fetchedMapCollection = mapResponse.mapCollection;
			} catch {
				if (cancelled) {
					return;
				}
				// 失败保留旧数据（旧投影好过没有），只把相位标成 error 让面板出提示；
				// 下一次 refreshKey 变化自然重试。
				setData((current) => ({ ...current, queryPhase: "error" }));
				return;
			}
			if (cancelled) {
				return;
			}
			setData((current) => {
				const mapCollection = resolveMapCollectionAfterFetch(
					lastAppliedPushRef.current,
					fetchStartedAt,
					fetchedMapCollection,
				);
				// 内容短路：重拉结果与现有数据真正相等 → 保留旧引用，下游 memo 零打扰。
				if (areSessionMapPanelQueryResultsEqual(current, { projection, mapCollection })) {
					return current.queryPhase === "ready" ? current : { ...current, queryPhase: "ready" };
				}
				return { queryPhase: "ready", projection, mapCollection };
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [input.workspaceId, input.conversationSessionTaskId, input.refreshKey]);

	// 推送通道：到达即应用（durable-write-before-ack 保证推送先于 ack，是最新事实）。
	// 内容相等的推送不打扰下游 memo（stale 置位广播与查询响应常携带同一集合）。
	useEffect(() => {
		const { conversationSessionTaskId, pushedMapCollection } = input;
		if (!conversationSessionTaskId || pushedMapCollection === undefined) {
			return;
		}
		lastAppliedPushRef.current = { receivedAt: Date.now(), collection: pushedMapCollection };
		setData((current) => {
			if (JSON.stringify(current.mapCollection ?? null) === JSON.stringify(pushedMapCollection)) {
				return current;
			}
			return { ...current, mapCollection: pushedMapCollection };
		});
	}, [input.conversationSessionTaskId, input.pushedMapCollection]);

	return data;
}
