// Workspace 级 findings 浏览器（蓝图 §G.2）：home 视图置换（isFindingsOpen，
// isGitHistoryOpen 同款形态），非 overlay——findings 是主浏览面。
// 列表 = 标题 + 状态 badge + 正文摘要 + provenance 来源标注；顶部 substring 搜索
// （标题 + 正文，§D.3 不引索引库）；archived 默认不进列表（「显示已归档」开关放行）。
// 操作接线：待确认 → 确认/拒绝；active → 归档；archived → 恢复。mutation 直调
// findings-query，状态经 exploratory_findings_updated 推送收敛，本地不做乐观更新。

import { Archive, ArchiveRestore, Check, Lightbulb, Search, X } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import {
	buildFindingBodyExcerpt,
	buildFindingProvenanceLabel,
	filterFindingsForBrowserView,
	getFindingStatusDisplay,
} from "@/components/findings/findings-model";
import { useFindingActionRunner } from "@/components/findings/use-finding-action-runner";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { ExploratoryFindingsQueryPhase } from "@/hooks/use-exploratory-findings";
import {
	archiveExploratoryFinding,
	confirmExploratoryFinding,
	rejectExploratoryFinding,
} from "@/runtime/findings-query";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

function FindingCard({
	finding,
	workspaceId,
	isActionPending,
	onRunAction,
}: {
	finding: RuntimeExploratoryFindingEntry;
	workspaceId: string;
	isActionPending: boolean;
	onRunAction: (findingId: string, action: () => Promise<unknown>) => void;
}): ReactElement {
	const statusDisplay = getFindingStatusDisplay(finding.findingStatus);
	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-2">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
					{finding.findingTitle}
				</span>
				<span
					className={cn("shrink-0 rounded-sm px-1.5 py-px text-[11px] font-medium", statusDisplay.badgeClassName)}
				>
					{statusDisplay.label}
				</span>
			</div>
			<div className="line-clamp-2 text-xs text-text-secondary">
				{buildFindingBodyExcerpt(finding.findingBodyMarkdown)}
			</div>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary">
					{buildFindingProvenanceLabel(finding)}
				</span>
				{isActionPending ? <Spinner size={12} className="shrink-0" /> : null}
				{finding.findingStatus === "suggested_pending_confirmation" ? (
					<>
						<Button
							variant="ghost"
							size="xs"
							icon={<Check size={12} />}
							disabled={isActionPending}
							onClick={() =>
								onRunAction(finding.findingId, () => confirmExploratoryFinding(workspaceId, finding.findingId))
							}
						>
							Confirm
						</Button>
						<Button
							variant="ghost"
							size="xs"
							icon={<X size={12} />}
							disabled={isActionPending}
							onClick={() =>
								onRunAction(finding.findingId, () => rejectExploratoryFinding(workspaceId, finding.findingId))
							}
						>
							Reject
						</Button>
					</>
				) : null}
				{finding.findingStatus === "active" ? (
					<Button
						variant="ghost"
						size="xs"
						icon={<Archive size={12} />}
						disabled={isActionPending}
						onClick={() =>
							onRunAction(finding.findingId, () =>
								archiveExploratoryFinding(workspaceId, finding.findingId, true),
							)
						}
					>
						Archive
					</Button>
				) : null}
				{finding.findingStatus === "archived" ? (
					<Button
						variant="ghost"
						size="xs"
						icon={<ArchiveRestore size={12} />}
						disabled={isActionPending}
						onClick={() =>
							onRunAction(finding.findingId, () =>
								archiveExploratoryFinding(workspaceId, finding.findingId, false),
							)
						}
					>
						Restore
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function FindingsView({
	workspaceId,
	findings,
	queryPhase,
}: {
	workspaceId: string;
	// null = 初始查询未落定且未收到过推送（加载中）。
	findings: RuntimeExploratoryFindingEntry[] | null;
	queryPhase: ExploratoryFindingsQueryPhase;
}): ReactElement {
	const [query, setQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const { isFindingActionPending, runFindingAction } = useFindingActionRunner();

	// 展示序：新条目在前（createdAt 降序）；过滤逻辑（搜索 + archived 开关）在 findings-model。
	const visibleFindings = useMemo(() => {
		const filtered = filterFindingsForBrowserView(findings ?? [], { query, showArchived });
		return [...filtered].sort((left, right) => right.createdAt - left.createdAt);
	}, [findings, query, showArchived]);

	const isInitialLoading = findings === null && queryPhase !== "error";
	const isInitialError = findings === null && queryPhase === "error";

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
				<Lightbulb size={14} className="shrink-0 text-text-tertiary" />
				<span className="text-sm font-semibold text-text-primary">Findings</span>
				<div className="relative ml-2 min-w-0 flex-1 max-w-md">
					<Search
						size={12}
						className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-tertiary"
					/>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search title and body…"
						aria-label="Search findings"
						className="h-7 w-full rounded-md border border-border bg-surface-2 pr-2 pl-7 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setShowArchived((current) => !current)}
					aria-pressed={showArchived}
					className={cn("ml-auto", showArchived && "ring-1 ring-accent")}
				>
					Show archived
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
				{isInitialLoading ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner size={24} />
					</div>
				) : isInitialError ? (
					<div className="flex flex-1 items-center justify-center text-xs text-text-tertiary">
						Could not load findings.
					</div>
				) : visibleFindings.length === 0 ? (
					<div className="flex flex-1 items-center justify-center text-xs text-text-tertiary">
						{(findings ?? []).length === 0
							? "No findings yet — save one from a chat message."
							: "No findings match the current filters."}
					</div>
				) : (
					visibleFindings.map((finding) => (
						<FindingCard
							key={finding.findingId}
							finding={finding}
							workspaceId={workspaceId}
							isActionPending={isFindingActionPending(finding.findingId)}
							onRunAction={runFindingAction}
						/>
					))
				)}
			</div>
		</div>
	);
}
