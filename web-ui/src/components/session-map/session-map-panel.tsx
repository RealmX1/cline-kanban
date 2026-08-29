// Session Map 面板（蓝图 §G.1）：Focus View 侧栏的可折叠 section，挂在
// TaskConversationSessionsPanel 同位下方（不抢占其挂载点）。
//
// map 集合非空时（M1 起）渲染 agent 维护的语义节点列表（kind 图标 + 标题 + 可选摘要，
// 按 anchorTurnNumber 升序——map 不存边，显示序由锚 turn 派生，蓝图 §B.1）；集合为空
// 回退投影层 turn 骨架（M0 行为：turn 号胶囊 + 用户消息摘录 + 运行中指示 + checkpoint
// 对齐置信度标注）。节点挂 data-session-map-node-anchor 供聊天内锚 chip spotlight（§C.2）。
//
// 默认展开跟随模式（蓝图 §A.2 效应 1）：调用方按「有活会话只读会话自己的
// summary.taskConversationMode（缺字段=旧会话，按 operational，绝不回退卡片声明值——
// 否则改卡片会热切换活会话面板）；无活会话读卡片 taskConversationMode ?? operational」
// 解析出 defaultOpen；exploratory 默认展开，
// operational 默认折叠（可手动开启）。默认值在用户首次手动开合后即让位——
// 用户表过态就不再被模式/会话切换推翻。出现条件由调用方（card-detail-view）按
// 「会话是否渲染为 conversation 面板」把关。

import { AlertTriangle, Check, ChevronDown, ChevronRight, Lightbulb, Map as MapIcon, X } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { filterFindingsForConversationSession, getFindingStatusDisplay } from "@/components/findings/findings-model";
import { useFindingActionRunner } from "@/components/findings/use-finding-action-runner";
import { SESSION_MAP_NODE_ANCHOR_ATTR } from "@/components/session-map/session-map-anchor-registry";
import { getSessionMapNodeKindDisplay } from "@/components/session-map/session-map-node-kind-display";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { SessionMapPanelQueryPhase } from "@/hooks/use-session-map-panel-data";
import { confirmExploratoryFinding, rejectExploratoryFinding } from "@/runtime/findings-query";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeConversationTurnCheckpointAlignmentConfidence,
	RuntimeConversationTurnProjectionEntry,
	RuntimeExploratoryFindingEntry,
	RuntimeExploratorySessionMapCollection,
	RuntimeExploratorySessionMapNode,
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

function SessionMapNodeRow({ node }: { node: RuntimeExploratorySessionMapNode }): ReactElement {
	const kindDisplay = getSessionMapNodeKindDisplay(node.nodeKind);
	const KindIcon = kindDisplay.icon;
	return (
		<div
			{...{ [SESSION_MAP_NODE_ANCHOR_ATTR]: node.mapNodeId }}
			// kind 标签走 native title 而不是 Radix Tooltip：本面板会被挂在没有 TooltipProvider
			// 的宿主树下（card-detail-view 直渲），与锚 chip 的 title 做法保持一致。
			title={kindDisplay.label}
			className="flex items-start gap-2 px-2 py-1 hover:bg-surface-2"
		>
			<KindIcon size={13} className={cn("mt-px shrink-0", kindDisplay.colorClassName)} />
			<div className="min-w-0 flex-1">
				<div className="truncate text-xs text-text-primary">{node.nodeTitle}</div>
				{/* 摘要按纯文本折叠两行展示（上限 400 字符）；完整 markdown 渲染留待 M3 的 stale/badge 一起考虑。 */}
				{node.nodeSummaryMarkdown ? (
					<div className="line-clamp-2 text-[11px] text-text-tertiary">{node.nodeSummaryMarkdown}</div>
				) : null}
			</div>
			<span className="shrink-0 rounded-sm bg-surface-3 px-1.5 py-px text-[11px] text-text-tertiary">
				T{node.anchorTurnNumber}
			</span>
		</div>
	);
}

// map 面板底部「本会话 findings」section 的上下文（蓝图 §G.2 任务级切片）：
// 由调用方（card-detail-view）按当前会话组装；缺省 = 不渲染该 section。
export interface SessionFindingsContext {
	workspaceId: string;
	conversationSessionTaskId: string;
	// null = workspace 级集合尚未加载（初始查询未落定且未收到过推送）。
	findings: RuntimeExploratoryFindingEntry[] | null;
}

// 本会话 findings 切片（蓝图 §G.2）：过滤 provenanceLinks 含当前会话的条目（archived 不进
// 切片）；待确认条目带角标 + 行内确认/拒绝；点击条目展开正文（深链跳转属 M3，这里只做
// 简单展开）。操作直调 findings-query，状态经 exploratory_findings_updated 推送收敛。
export function SessionFindingsSection({
	workspaceId,
	conversationSessionTaskId,
	findings,
}: SessionFindingsContext): ReactElement {
	const [open, setOpen] = useState(false);
	const [expandedFindingIds, setExpandedFindingIds] = useState<ReadonlySet<string>>(new Set());
	const { isFindingActionPending, runFindingAction } = useFindingActionRunner();
	const sessionFindings = filterFindingsForConversationSession(findings ?? [], conversationSessionTaskId);
	const pendingCount = sessionFindings.filter(
		(finding) => finding.findingStatus === "suggested_pending_confirmation",
	).length;

	const toggleFindingExpanded = (findingId: string) => {
		setExpandedFindingIds((current) => {
			const next = new Set(current);
			if (next.has(findingId)) {
				next.delete(findingId);
			} else {
				next.add(findingId);
			}
			return next;
		});
	};

	return (
		<div className="flex shrink-0 flex-col border-t border-border">
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
				<Lightbulb size={13} className="shrink-0 text-text-tertiary" />
				<span className="text-xs font-medium text-text-primary">Findings</span>
				{pendingCount > 0 ? (
					<span className="shrink-0 rounded-sm bg-status-orange/15 px-1.5 py-px text-[11px] font-medium text-status-orange">
						{pendingCount} to confirm
					</span>
				) : null}
				{sessionFindings.length > 0 ? (
					<span className="ml-auto text-[11px] text-text-tertiary">{sessionFindings.length}</span>
				) : null}
			</button>
			{open ? (
				<div className="max-h-48 min-h-0 overflow-y-auto border-t border-border py-1">
					{findings === null ? (
						<div className="flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary">
							<Spinner size={12} />
							Loading findings…
						</div>
					) : sessionFindings.length === 0 ? (
						<div className="px-3 py-2 text-xs text-text-tertiary">No findings in this session yet.</div>
					) : (
						sessionFindings.map((finding) => {
							const isExpanded = expandedFindingIds.has(finding.findingId);
							const isPending = finding.findingStatus === "suggested_pending_confirmation";
							const statusDisplay = getFindingStatusDisplay(finding.findingStatus);
							return (
								<div key={finding.findingId} className="px-2 py-1 hover:bg-surface-2">
									<div className="flex items-center gap-1.5">
										<button
											type="button"
											onClick={() => toggleFindingExpanded(finding.findingId)}
											aria-expanded={isExpanded}
											className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
										>
											{isExpanded ? (
												<ChevronDown size={12} className="shrink-0 text-text-tertiary" />
											) : (
												<ChevronRight size={12} className="shrink-0 text-text-tertiary" />
											)}
											<span className="min-w-0 flex-1 truncate text-xs text-text-primary">
												{finding.findingTitle}
											</span>
										</button>
										{isPending ? (
											<>
												<span
													className={cn(
														"shrink-0 rounded-sm px-1.5 py-px text-[11px] font-medium",
														statusDisplay.badgeClassName,
													)}
												>
													{statusDisplay.label}
												</span>
												<Button
													variant="ghost"
													size="xs"
													icon={<Check size={12} />}
													aria-label={`Confirm finding ${finding.findingTitle}`}
													disabled={isFindingActionPending(finding.findingId)}
													onClick={() =>
														runFindingAction(finding.findingId, () =>
															confirmExploratoryFinding(workspaceId, finding.findingId),
														)
													}
												/>
												<Button
													variant="ghost"
													size="xs"
													icon={<X size={12} />}
													aria-label={`Reject finding ${finding.findingTitle}`}
													disabled={isFindingActionPending(finding.findingId)}
													onClick={() =>
														runFindingAction(finding.findingId, () =>
															rejectExploratoryFinding(workspaceId, finding.findingId),
														)
													}
												/>
											</>
										) : null}
										{isFindingActionPending(finding.findingId) ? (
											<Spinner size={12} className="shrink-0" />
										) : null}
									</div>
									{isExpanded ? (
										<div className="mt-1 pr-1 pl-5 text-[11px] whitespace-pre-wrap break-words text-text-secondary">
											{finding.findingBodyMarkdown}
										</div>
									) : null}
								</div>
							);
						})
					)}
				</div>
			) : null}
		</div>
	);
}
export function SessionMapPanel({
	queryPhase,
	projection,
	mapCollection,
	expandToken,
	defaultOpen = false,
	sessionFindings = null,
}: {
	queryPhase: SessionMapPanelQueryPhase;
	projection: RuntimeConversationSessionTurnProjectionResponse | null;
	mapCollection: RuntimeExploratorySessionMapCollection | null;
	// 聊天内锚 chip 点击时递增（仓内 selectedPathExpandToken 同款先例）：变化即展开。
	expandToken?: number;
	// 模式驱动的默认展开（蓝图 §A.2 效应 1）：exploratory 会话 true。只是「默认」——
	// 用户首次手动开合后，默认值再变化（切会话/模式投影落定）也不再推翻用户的选择。
	defaultOpen?: boolean;
	// map 面板底部「本会话 findings」section（蓝图 §G.2）；null = 无 findings 上下文，不渲染。
	sessionFindings?: SessionFindingsContext | null;
}): ReactElement {
	const [open, setOpen] = useState(defaultOpen);
	// 用户是否已手动表过态：一旦表过，open 完全归用户；否则跟随 defaultOpen。
	const hasUserToggledOpenRef = useRef(false);
	useEffect(() => {
		if (!hasUserToggledOpenRef.current) {
			setOpen(defaultOpen);
		}
	}, [defaultOpen]);
	useEffect(() => {
		if (expandToken !== undefined && expandToken > 0) {
			setOpen(true);
		}
	}, [expandToken]);

	const turnEntries = projection?.turnProjectionEntries ?? [];
	// map 不存边：显示序由 anchorTurnNumber 派生（蓝图 §B.1），渲染前显式排序，
	// 不信写入通道的落地序（apply 漏斗按提案序归并，不保证锚 turn 单调）。
	const mapNodes = [...(mapCollection?.mapNodes ?? [])].sort(
		(left, right) => left.anchorTurnNumber - right.anchorTurnNumber,
	);
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
				{mapNodes.map((node) => (
					<SessionMapNodeRow key={node.mapNodeId} node={node} />
				))}
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
				onClick={() => {
					// 用户表过态后，open 不再跟随 defaultOpen（模式/会话切换不推翻用户选择）。
					hasUserToggledOpenRef.current = true;
					setOpen((current) => !current);
				}}
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
			{/* 本会话 findings 切片（蓝图 §G.2）：独立可折叠 section，挂在 map 内容下方。 */}
			{sessionFindings ? <SessionFindingsSection {...sessionFindings} /> : null}
		</div>
	);
}
