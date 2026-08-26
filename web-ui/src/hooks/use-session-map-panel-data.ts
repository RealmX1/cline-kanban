// Session Map 面板的数据编排 hook（蓝图 §G.1 + 姊妹蓝图 §2.3）。
//
// 投影层不新增 WS 事件：重拉信号由调用方把低频会话信号拼成 refreshKey 传入。
// M0 用「全量重拉 + 内容短路」——重拉结果与现有数据内容真正相等才保留旧 state
// 引用、不惊扰下游 memo；sinceTurnNumber 增量拉取留待后续（蓝图 §2.3
// 已预留该参数，M0 会话 turn 量级下全量成本可忽略）。

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

export function useSessionMapPanelData(input: {
	workspaceId: string | null;
	// null = 面板不出现（非 conversation 面板会话），不发任何请求。
	conversationSessionTaskId: string | null;
	// 重拉信号：调用方把「值得重拉投影/map 的低频会话信号」拼成 refreshKey（构成归
	// 调用方所有，本 hook 只在它变化时重拉）；null = 无活会话 summary（重启后未启动），
	// 仅在会话切换时拉一次。
	refreshKey: string | null;
}): SessionMapPanelData {
	const [data, setData] = useState<SessionMapPanelData>(IDLE_SESSION_MAP_PANEL_DATA);
	// 会话切换要立即清空旧数据（不能把上一会话的投影当成本会话的渲染）；同会话的
	// refreshKey 推进则保留旧数据静默重拉，避免每次 summary 广播都把面板闪回 loading。
	const lastConversationSessionTaskIdRef = useRef<string | null>(null);

	useEffect(() => {
		const { workspaceId, conversationSessionTaskId } = input;
		if (!workspaceId || !conversationSessionTaskId) {
			lastConversationSessionTaskIdRef.current = null;
			setData(IDLE_SESSION_MAP_PANEL_DATA);
			return;
		}
		if (lastConversationSessionTaskIdRef.current !== conversationSessionTaskId) {
			lastConversationSessionTaskIdRef.current = conversationSessionTaskId;
			setData({ queryPhase: "loading", projection: null, mapCollection: null });
		}
		let cancelled = false;
		void (async () => {
			let projection: RuntimeConversationSessionTurnProjectionResponse;
			let mapCollection: RuntimeExploratorySessionMapCollection | null;
			try {
				const [nextProjection, mapResponse] = await Promise.all([
					fetchConversationSessionTurnProjection(workspaceId, { conversationSessionTaskId }),
					fetchExploratorySessionMap(workspaceId, conversationSessionTaskId),
				]);
				projection = nextProjection;
				mapCollection = mapResponse.mapCollection;
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

	return data;
}
