// 聊天内导航锚 chip（蓝图 §C.2）：助手消息里的 `<!-- kanban:map-anchor <id> -->` marker 被
// extractConversationAnchorMarkers 解析后，在原位渲染成这个小胶囊。
//
// 【休眠】marker 机制已随 session map 退役（agent 不再埋 marker；宿主不再传 resolver ⇒ 永不渲染）。
// 保留原因见 conversation-anchor-kind-display.ts 头注释。
//
// 反注入铁律（蓝图 §C.1）的渲染侧落实：marker 载荷只有一个 id，chip 的显示内容恒来自
// 服务端 map store——调用方按 id 查当前会话 map 集合，不可解析（id 不在集合里 / 没有
// 集合上下文）→ 不渲染 chip，整条 marker 按不可见处理，绝不让 agent 输出直接变成 UI 元素。

import { MapPin } from "lucide-react";
import type { ReactElement } from "react";
import {
	type ConversationAnchorKind,
	getConversationAnchorKindDisplay,
} from "@/components/conversation-anchor/conversation-anchor-kind-display";
import { cn } from "@/components/ui/cn";

export interface ConversationAnchorChipNodeData {
	nodeTitle: string;
	nodeKind: ConversationAnchorKind;
}

export type ResolveConversationAnchor = (anchorId: string) => ConversationAnchorChipNodeData | null;

export function ConversationAnchorChip({
	anchorId,
	resolve,
	onClick,
}: {
	anchorId: string;
	resolve: ResolveConversationAnchor;
	onClick?: (anchorId: string) => void;
}): ReactElement | null {
	const node = resolve(anchorId);
	if (!node) {
		return null;
	}
	const kindDisplay = getConversationAnchorKindDisplay(node.nodeKind);
	return (
		<button
			type="button"
			onClick={onClick ? () => onClick(anchorId) : undefined}
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
