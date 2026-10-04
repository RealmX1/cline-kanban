// exploration thread graph 面板（B.2）：Focus View 侧栏里的可折叠 section，挂在
// TaskConversationSessionsPanel 同位下方、「本会话 findings」之上。
//
// 它显示的是「这次探索场次分出了哪几条线、每一轮属于哪条」——git-graph 语义，行序新→旧。
// 泳道几何由服务端随投影算好（核心包的 laneLayout），这里只画。
//
// **成本纪律**：面板的读路径免费（只读落盘 collection 与 transcript 增量）。唯一花钱的是
// 「立即维护一次」——它让服务端 fork 一个分身，重型会话上一次约 $4.5（成因见
// docs/exploratory-mode-host-integration.md §3b）。所以它必须是一次明确的点击，
// 按钮上写明代价，绝不做成自动刷新。

import { ChevronDown, ChevronRight, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactElement, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	computeThreadGraphSvgWidth,
	ExplorationThreadGraphLaneRowSvg,
} from "@/components/exploration-thread-graph/exploration-thread-graph-lane-row-svg";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { ExplorationThreadGraphData } from "@/hooks/use-exploration-thread-graph";
import { requestExplorationThreadGraphMaintenance } from "@/runtime/exploration-thread-graph-query";

const STALE_REASON_DISPLAY: Record<string, string> = {
	new_turns_not_yet_placed: "有新轮次尚未归位",
	turn_source_signature_changed: "转录已变化，归属待复核",
};

const NOT_STARTED_REASON_DISPLAY: Record<string, string> = {
	not_exploratory_mode: "这张卡片不是探索模式，不维护探索线",
	no_usable_sessions: "没有可用会话（缺少原生会话身份或启动参数快照，需重启会话后重试）",
	already_in_flight: "已有一次维护在进行中",
	throttled: "新轮次还不够，暂不维护",
	no_completed_turns: "没有已完成的轮次可判",
};

const JOB_OUTCOME_DISPLAY: Record<string, string> = {
	accepted: "探索线已更新",
	rejected: "判定结果未通过校验，本次未改动",
	skipped: "没有需要判定的轮次",
	fork_failed: "分身进程未能完成判定",
};

export function ExplorationThreadGraphPanel({
	workspaceId,
	explorationId,
	data,
}: {
	workspaceId: string;
	explorationId: string;
	data: ExplorationThreadGraphData;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [expandedTurnRowIds, setExpandedTurnRowIds] = useState<ReadonlySet<string>>(new Set());
	const [isMaintenancePending, setIsMaintenancePending] = useState(false);

	const view = data.view;
	const turnRows = view?.turnRows ?? [];
	const threadCount = view?.threads.length ?? 0;
	const unplacedTurnCount = Object.values(view?.unplacedTurnCountBySession ?? {}).reduce(
		(total, count) => total + count,
		0,
	);
	const svgWidth = computeThreadGraphSvgWidth(view?.laneCount ?? 1);
	const threadTitleById = new Map(
		view?.threads.map((entry) => [entry.thread.threadId, entry.thread.threadTitle]) ?? [],
	);

	const toggleTurnRowExpanded = (turnRowId: string) => {
		setExpandedTurnRowIds((current) => {
			const next = new Set(current);
			if (next.has(turnRowId)) {
				next.delete(turnRowId);
			} else {
				next.add(turnRowId);
			}
			return next;
		});
	};

	const runMaintenanceNow = async () => {
		setIsMaintenancePending(true);
		try {
			const response = await requestExplorationThreadGraphMaintenance(workspaceId, explorationId);
			if (response.kind === "not_started") {
				// 「按闸门有意没开跑」不是失败：说成失败会让人去点第二次，而点一次是要花钱的。
				showAppToast({ message: NOT_STARTED_REASON_DISPLAY[response.reason] ?? "本次未开始维护" });
				return;
			}
			if (response.kind === "failed") {
				showAppToast({ message: `维护失败：${response.message}`, intent: "danger" });
				return;
			}
			const outcomeText = JOB_OUTCOME_DISPLAY[response.jobOutcome] ?? "维护已结束";
			// 图本体经 exploration_thread_graph_updated 推送收敛，这里只报结果、不本地改。
			showAppToast({
				message: response.detail === null ? outcomeText : `${outcomeText}：${response.detail}`,
				intent: response.jobOutcome === "accepted" ? "success" : "warning",
			});
		} catch (error) {
			showAppToast({
				message: `维护请求失败：${error instanceof Error ? error.message : String(error)}`,
				intent: "danger",
			});
		} finally {
			setIsMaintenancePending(false);
		}
	};

	return (
		<div className="flex shrink-0 flex-col border-t border-border bg-surface-1">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-left hover:bg-surface-3"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-xs font-medium">探索线</span>
				{turnRows.length > 0 ? (
					<span className="text-[11px] text-muted-foreground">
						{threadCount} 条线 · {turnRows.length} 轮
					</span>
				) : null}
				{view?.staleReason ? (
					<span
						className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400"
						title={STALE_REASON_DISPLAY[view.staleReason] ?? "图已过期"}
					>
						待更新
					</span>
				) : null}
			</button>

			{open ? (
				<div className="flex min-h-0 flex-col">
					<div className="flex shrink-0 items-center gap-2 px-2 pb-1.5">
						<span className="text-[11px] text-muted-foreground">
							{data.queryPhase === "loading" && view === null
								? "加载中…"
								: unplacedTurnCount > 0
									? `${unplacedTurnCount} 轮尚未归位`
									: "全部轮次已归位"}
						</span>
						<Button
							size="sm"
							variant="ghost"
							className="ml-auto h-6 gap-1 px-1.5 text-[11px]"
							disabled={isMaintenancePending}
							onClick={() => void runMaintenanceNow()}
							// 代价写在按钮上：这一下会 fork 一个分身，长会话上是真金白银。
							title="立即判定新轮次的归属。这会从主会话 fork 一个分身，长会话上单次开销可达数美元。"
						>
							{isMaintenancePending ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
							立即维护
						</Button>
					</div>

					{data.turnSourceUnavailableSessionIds.length > 0 ? (
						<div className="flex shrink-0 items-center gap-1.5 px-2 pb-1.5 text-[11px] text-amber-400">
							<TriangleAlert className="size-3 shrink-0" />
							{data.turnSourceUnavailableSessionIds.length} 条会话的转录暂时读不到，其轮次未显示
						</div>
					) : null}

					{turnRows.length === 0 ? (
						<div className="px-2 pb-2 text-[11px] text-muted-foreground">
							{data.queryPhase === "error"
								? "探索线读取失败。"
								: "还没有归位的轮次——探索几轮之后它会自己长出来。"}
						</div>
					) : (
						<div className="max-h-80 min-h-0 overflow-y-auto">
							{turnRows.map((turnRow, rowIndex) => {
								const isExpanded = expandedTurnRowIds.has(turnRow.turnRowId);
								const threadTitle = turnRow.threadId === null ? null : threadTitleById.get(turnRow.threadId);
								return (
									<div key={turnRow.turnRowId} className="border-t border-border/50 first:border-t-0">
										<button
											type="button"
											onClick={() => toggleTurnRowExpanded(turnRow.turnRowId)}
											className="flex w-full items-stretch gap-1 text-left hover:bg-surface-3"
											aria-expanded={isExpanded}
										>
											<div style={{ width: svgWidth }} className="shrink-0">
												<ExplorationThreadGraphLaneRowSvg
													laneLayout={turnRow.laneLayout}
													laneCount={view?.laneCount ?? 1}
													isLastRow={rowIndex === turnRows.length - 1}
												/>
											</div>
											<div className="flex min-w-0 flex-1 flex-col justify-center py-1 pr-2">
												<div className="flex min-w-0 items-center gap-1.5">
													<span className="shrink-0 text-[10px] text-muted-foreground">
														#{turnRow.turnRef.turnNumber}
													</span>
													<span className="truncate text-xs">{turnRow.userPromptExcerpt}</span>
												</div>
												<div className="flex min-w-0 items-center gap-1.5">
													<span
														className={cn(
															"truncate text-[10px]",
															threadTitle === undefined || threadTitle === null
																? "text-muted-foreground/60 italic"
																: "text-muted-foreground",
														)}
													>
														{threadTitle ?? "尚未归位"}
													</span>
													{turnRow.eventMarks.length > 0 ? (
														<span className="shrink-0 text-[10px] text-sky-400">
															{turnRow.eventMarks.length} 个标注
														</span>
													) : null}
												</div>
											</div>
										</button>

										{isExpanded ? (
											<div className="flex flex-col gap-1.5 px-2 pb-2 pl-3 text-[11px]">
												<div className="whitespace-pre-wrap text-muted-foreground">
													{turnRow.userPromptExcerpt}
												</div>
												<div className="whitespace-pre-wrap text-muted-foreground/80">
													{turnRow.assistantResponseExcerpt}
												</div>
												{turnRow.deviationRationale !== null ? (
													<div className="text-amber-400/90">偏离理由：{turnRow.deviationRationale}</div>
												) : null}
												{turnRow.turnSubjectTags.length > 0 ? (
													<div className="flex flex-wrap gap-1">
														{turnRow.turnSubjectTags.map((tag) => (
															<span key={tag} className="rounded bg-surface-3 px-1 py-0.5 text-[10px]">
																{tag}
															</span>
														))}
													</div>
												) : null}
												{turnRow.eventMarks.map((eventMark) => (
													<div
														key={`${eventMark.mark}-${eventMark.note ?? ""}`}
														className="text-sky-400/90"
													>
														{eventMark.mark}
														{eventMark.note === null ? "" : `：${eventMark.note}`}
													</div>
												))}
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}
