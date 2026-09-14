// 「本会话 findings」section（蓝图 §G.2 任务级切片）：Focus View 侧栏的可折叠 section。
// 原先挂在 session map 面板底部；map 面板退役后独立成件，直接挂在 TaskConversationSessionsPanel
// 同位下方，B.2 的 exploration thread graph 面板落地后迁入其底部（挂载点由 card-detail-view 决定）。
//
// 过滤 provenanceLinks 含当前会话的条目（archived 不进切片）；待确认条目带角标 + 行内确认/拒绝；
// 点击条目展开正文（深链跳转属后续，这里只做简单展开）。操作直调 findings-query，状态经
// exploratory_findings_updated 推送收敛。

import { Check, ChevronDown, ChevronRight, Lightbulb, X } from "lucide-react";
import { type ReactElement, useState } from "react";
import { filterFindingsForConversationSession, getFindingStatusDisplay } from "@/components/findings/findings-model";
import { useFindingActionRunner } from "@/components/findings/use-finding-action-runner";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { confirmExploratoryFinding, rejectExploratoryFinding } from "@/runtime/findings-query";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

// 由调用方（card-detail-view）按当前会话组装；缺省 = 不渲染该 section。
export interface SessionFindingsContext {
	workspaceId: string;
	conversationSessionTaskId: string;
	// null = workspace 级集合尚未加载（初始查询未落定且未收到过推送）。
	findings: RuntimeExploratoryFindingEntry[] | null;
}

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
