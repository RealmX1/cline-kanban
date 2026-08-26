// Session Map 面板（蓝图 §G.1）：Focus View 侧栏的可折叠 section，挂在
// TaskConversationSessionsPanel 同位下方（不抢占其挂载点）。
//
// M0 形态（裸锚点骨架）：agent 写入通道属 M1，map 集合恒为空，面板渲染投影层 turn
// 骨架（turn 号胶囊 + 用户消息摘录 + 运行中指示 + checkpoint 对齐置信度标注）。
// map 集合非空时（M1 起）切换为节点列表渲染，节点挂 data-session-map-node-anchor
// 供聊天内锚 chip spotlight（§C.2）。
//
// 默认折叠：蓝图定的「exploratory 任务默认展开」依赖 taskConversationMode 模式标记
// （M1 才落地），M0 没有模式字段，先按「不打扰」的折叠默认；M1 接模式默认值。
// 出现条件由调用方（card-detail-view）按「会话是否渲染为 conversation 面板」把关。

import { AlertTriangle, ChevronDown, ChevronRight, Map as MapIcon } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { SESSION_MAP_NODE_ANCHOR_ATTR } from "@/components/session-map/session-map-anchor-registry";
import { getSessionMapNodeKindDisplay } from "@/components/session-map/session-map-node-kind-display";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { SessionMapPanelQueryPhase } from "@/hooks/use-session-map-panel-data";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeConversationTurnCheckpointAlignmentConfidence,
	RuntimeConversationTurnProjectionEntry,
	RuntimeExploratorySessionMapCollection,
} from "@/runtime/types";

// checkpoint 对齐置信度的展示文案（蓝图「能力/降级矩阵」的置信度标注要求）：
// 非 exact_ordinal_match 的 turn 行弱化显示 + tooltip 说明——锚点编号三源偏移
// （姊妹蓝图风险 1）必须显式可见，绝不静默展示可能错位的 turn 号。
const CHECKPOINT_ALIGNMENT_CONFIDENCE_TOOLTIP: Record<
	Exclude<RuntimeConversationTurnCheckpointAlignmentConfidence, "exact_ordinal_match">,
	string
> = {
	best_effort_ordinal_match:
		"Turn numbering is best-effort: the checkpoint sequence drifted from the message-derived turn order.",
	unaligned: "No resolvable checkpoint anchor for this turn (time anchor only).",
};

function firstLineOf(text: string | null): string {
	if (!text) {
		return "";
	}
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.trim();
}

function SessionMapTurnRow({ entry }: { entry: RuntimeConversationTurnProjectionEntry }): ReactElement {
	// 三元（而非 boolean 变量）是为了让 TS 在 else 分支把置信度收窄到 Exclude<..., "exact_ordinal_match">。
	const confidenceTooltip =
		entry.turnCheckpointAlignmentConfidence === "exact_ordinal_match"
			? null
			: CHECKPOINT_ALIGNMENT_CONFIDENCE_TOOLTIP[entry.turnCheckpointAlignmentConfidence];
	const turnCapsule = (
		<span
			className={cn(
				"shrink-0 rounded-sm px-1.5 py-px text-[11px] font-medium",
				confidenceTooltip !== null ? "bg-surface-2 text-text-tertiary" : "bg-surface-3 text-text-secondary",
			)}
		>
			T{entry.turnNumber}
		</span>
	);
	return (
		<div className="flex items-center gap-2 px-2 py-1 hover:bg-surface-2">
			{confidenceTooltip !== null ? <Tooltip content={confidenceTooltip}>{turnCapsule}</Tooltip> : turnCapsule}
			<span className="min-w-0 flex-1 truncate text-xs text-text-primary">
				{firstLineOf(entry.turnUserMessageExcerpt) || "…"}
			</span>
			{entry.turnIsInProgress ? <Spinner size={12} className="shrink-0" /> : null}
		</div>
	);
}

export function SessionMapPanel({
	queryPhase,
	projection,
	mapCollection,
	expandToken,
}: {
	queryPhase: SessionMapPanelQueryPhase;
	projection: RuntimeConversationSessionTurnProjectionResponse | null;
	mapCollection: RuntimeExploratorySessionMapCollection | null;
	// 聊天内锚 chip 点击时递增（仓内 selectedPathExpandToken 同款先例）：变化即展开。
	expandToken?: number;
}): ReactElement {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (expandToken !== undefined && expandToken > 0) {
			setOpen(true);
		}
	}, [expandToken]);

	const turnEntries = projection?.turnProjectionEntries ?? [];
	const mapNodes = mapCollection?.mapNodes ?? [];
	const isUnavailable = projection?.harnessSource === "unavailable_live_terminal_pty";
	const isInitialLoading = (queryPhase === "idle" || queryPhase === "loading") && projection === null;
	const isInitialError = queryPhase === "error" && projection === null;

	let bodyContent: ReactElement;
	if (isInitialLoading) {
		bodyContent = (
			<div className="flex items-center gap-2 px-3 py-3 text-xs text-text-tertiary">
				<Spinner size={12} />
				Loading session structure…
			</div>
		);
	} else if (isInitialError) {
		bodyContent = <div className="px-3 py-3 text-xs text-text-tertiary">Could not load the session structure.</div>;
	} else if (isUnavailable) {
		// ACP 会话在 M0 同样落入此降级档（server 侧实施注记），占位文案刻意不点名 PTY——
		// 蓝图能力矩阵的枚举名字面语义对 ACP 不精确，后续随 ACP 投影源落地修正。
		bodyContent = (
			<div className="px-3 py-3 text-xs text-text-tertiary">
				Session structure view is not available for this session type yet.
			</div>
		);
	} else if (mapNodes.length > 0) {
		// M1 起的形态：agent 维护的语义节点列表。节点只读展示——点击 → 聊天跳转
		// （reveal-to-index）属 M3，这里仅挂 DOM 锚供 chip 反向 spotlight。
		bodyContent = (
			<div className="py-1">
				{mapNodes.map((node) => {
					const kindDisplay = getSessionMapNodeKindDisplay(node.nodeKind);
					const KindIcon = kindDisplay.icon;
					return (
						<div
							key={node.mapNodeId}
							{...{ [SESSION_MAP_NODE_ANCHOR_ATTR]: node.mapNodeId }}
							className="flex items-center gap-2 px-2 py-1 hover:bg-surface-2"
							title={node.nodeSummaryMarkdown ?? undefined}
						>
							<KindIcon size={13} className={cn("shrink-0", kindDisplay.colorClassName)} />
							<span className="min-w-0 flex-1 truncate text-xs text-text-primary">{node.nodeTitle}</span>
							<span className="shrink-0 rounded-sm bg-surface-3 px-1.5 py-px text-[11px] text-text-tertiary">
								T{node.anchorTurnNumber}
							</span>
						</div>
					);
				})}
			</div>
		);
	} else if (turnEntries.length > 0) {
		// M0 主形态：map 集合为空，纯展示投影层 turn 骨架。
		bodyContent = (
			<div className="py-1">
				{turnEntries.map((entry) => (
					<SessionMapTurnRow key={entry.turnNumber} entry={entry} />
				))}
			</div>
		);
	} else {
		bodyContent = <div className="px-3 py-3 text-xs text-text-tertiary">No turns in this session yet.</div>;
	}

	return (
		<div className="flex shrink-0 flex-col border-t border-border bg-surface-1">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-left hover:bg-surface-3"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown size={14} className="shrink-0 text-text-secondary" />
				) : (
					<ChevronRight size={14} className="shrink-0 text-text-secondary" />
				)}
				<MapIcon size={13} className="shrink-0 text-text-tertiary" />
				<span className="text-xs font-medium text-text-primary">Session Map</span>
				{mapNodes.length > 0 ? (
					<span className="ml-auto text-[11px] text-text-tertiary">{mapNodes.length}</span>
				) : turnEntries.length > 0 ? (
					<span className="ml-auto text-[11px] text-text-tertiary">{turnEntries.length} turns</span>
				) : null}
			</button>
			{open ? (
				<div className="max-h-64 min-h-0 overflow-y-auto border-t border-border">
					{/* map 落后于会话时明示（蓝图解法定调 4：标 stale，绝不静默展示过期结构）。 */}
					{mapCollection?.mapStaleReason ? (
						<div className="mx-2 mt-2 flex items-center gap-1.5 rounded-sm border border-status-orange/40 bg-status-orange/10 px-2 py-1 text-[11px] text-status-orange">
							<AlertTriangle size={12} className="shrink-0" />
							Map is behind the conversation
						</div>
					) : null}
					{bodyContent}
				</div>
			) : null}
		</div>
	);
}
