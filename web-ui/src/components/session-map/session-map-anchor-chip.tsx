// 聊天内导航锚 chip（蓝图 §C.2）：agent 埋在助手消息里的 `<!-- kanban:map-anchor <id> -->`
// marker 被 extractSessionMapAnchorMarkers 解析后，在原位渲染成这个小胶囊。
//
// 反注入铁律（蓝图 §C.1）的渲染侧落实：marker 载荷只有一个 id，chip 的显示内容恒来自
// 服务端 map store——调用方按 id 查当前会话 map 集合，不可解析（id 不在集合里 / 没有
// 集合上下文）→ 不渲染 chip，整条 marker 按不可见处理，绝不让 agent 输出直接变成 UI 元素。

import { MapPin } from "lucide-react";
import type { ReactElement } from "react";
import { getSessionMapNodeKindDisplay } from "@/components/session-map/session-map-node-kind-display";
import { cn } from "@/components/ui/cn";
import type { RuntimeExploratorySessionMapNodeKind } from "@/runtime/types";

export interface SessionMapAnchorChipNodeData {
	nodeTitle: string;
	nodeKind: RuntimeExploratorySessionMapNodeKind;
}

export type ResolveSessionMapAnchor = (mapNodeId: string) => SessionMapAnchorChipNodeData | null;

export function SessionMapAnchorChip({
	mapNodeId,
	resolve,
	onClick,
}: {
	mapNodeId: string;
	resolve: ResolveSessionMapAnchor;
	onClick?: (mapNodeId: string) => void;
}): ReactElement | null {
	const node = resolve(mapNodeId);
	if (!node) {
		return null;
	}
	const kindDisplay = getSessionMapNodeKindDisplay(node.nodeKind);
	return (
		<button
			type="button"
			onClick={onClick ? () => onClick(mapNodeId) : undefined}
			title={`${kindDisplay.label} — locate in Session Map`}
			className={cn(
				"my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-0.5",
				"text-xs text-text-secondary",
				onClick && "cursor-pointer hover:border-border-bright hover:bg-surface-3 hover:text-text-primary",
			)}
		>
			<MapPin size={12} className={cn("shrink-0", kindDisplay.colorClassName)} />
			<span className="min-w-0 truncate">{node.nodeTitle}</span>
		</button>
	);
}
