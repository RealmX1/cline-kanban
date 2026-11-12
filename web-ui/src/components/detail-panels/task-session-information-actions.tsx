import * as Popover from "@radix-ui/react-popover";
import {
	resolveAgentCurrentWorkPhaseGoalForDisplay,
	resolveAgentWorkProgressEntriesForDisplay,
} from "@runtime-session-activity";
import { Ellipsis, Info } from "lucide-react";
import { AgentWorkProgress } from "@/components/agent-work-progress";
import { AgentRaisedUserDecisionHistoryPanel } from "@/components/detail-panels/agent-raised-user-decision-history-panel";
import { TaskResourceUsageDetailPanel } from "@/components/detail-panels/task-resource-usage-detail-panel";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

/** 宿主按任务和所选会话身份设 key，切换身份即关闭旧浮层。 */
export function TaskSessionInformationActions({
	workspaceId,
	taskId,
	taskConversationSessionId,
	taskCreatedAtEpochMs,
	summary,
	pendingUserDecisionIdentityForRefresh,
	hasNarrowMobileResourceDetailsInTerminalTools = false,
}: {
	workspaceId: string | null;
	taskId: string;
	taskConversationSessionId: string;
	taskCreatedAtEpochMs: number;
	summary: RuntimeTaskSessionSummary | null;
	pendingUserDecisionIdentityForRefresh: string | null;
	hasNarrowMobileResourceDetailsInTerminalTools?: boolean;
}) {
	const phaseGoal = resolveAgentCurrentWorkPhaseGoalForDisplay(summary);
	const latestProgress = resolveAgentWorkProgressEntriesForDisplay(summary).at(-1);
	return (
		<div className="flex min-w-0 flex-1 items-center gap-1 max-[769px]:flex-none">
			<AgentRaisedUserDecisionHistoryPanel
				presentation="toolbar_popover"
				workspaceId={workspaceId}
				taskId={taskConversationSessionId}
				pendingUserDecisionIdentityForRefresh={pendingUserDecisionIdentityForRefresh}
			/>
			<div className="hidden min-[360px]:contents">
				<TaskResourceUsageDetailPanel taskCardId={taskId} presentation="toolbar_popover" />
			</div>
			{!hasNarrowMobileResourceDetailsInTerminalTools ? (
				<div className="contents min-[360px]:hidden">
					<Popover.Root>
						<Popover.Trigger asChild>
							<button
								type="button"
								aria-label="会话更多信息"
								className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-text-secondary hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
							>
								<Ellipsis size={16} />
							</button>
						</Popover.Trigger>
						<Popover.Portal>
							<Popover.Content
								aria-label="会话更多信息"
								align="end"
								sideOffset={4}
								data-mobile-focus-view-idle-collapse-suspension=""
								className="z-50 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-1 text-text-primary"
							>
								<TaskResourceUsageDetailPanel taskCardId={taskId} presentation="toolbar_popover" />
							</Popover.Content>
						</Popover.Portal>
					</Popover.Root>
				</div>
			) : null}
			<div className="hidden min-w-0 flex-1 min-[769px]:block">
				<Popover.Root>
					<Popover.Trigger asChild>
						<button
							type="button"
							aria-label="任务信息与进展"
							className="flex h-7 w-full min-w-0 items-center gap-1 rounded-sm px-1 text-xs text-text-secondary hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
						>
							<Info size={13} className="shrink-0" />
							<span className="truncate">
								{latestProgress
									? `${latestProgress.isHistorical ? "上次" : "当前"}进展：${latestProgress.progressText}`
									: phaseGoal
										? `${phaseGoal.isHistorical ? "上次" : "当前"}目标：${phaseGoal.goalText}`
										: "任务信息"}
							</span>
						</button>
					</Popover.Trigger>
					<Popover.Portal>
						<Popover.Content
							aria-label="任务信息与进展"
							align="start"
							sideOffset={4}
							data-mobile-focus-view-idle-collapse-suspension=""
							className="z-50 max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-3 text-xs text-text-primary"
						>
							<p>
								任务创建于{" "}
								<time dateTime={new Date(taskCreatedAtEpochMs).toISOString()}>
									{new Date(taskCreatedAtEpochMs).toLocaleString()}
								</time>
							</p>
							<AgentWorkProgress summary={summary} isProgressHistoryVisible />
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			</div>
		</div>
	);
}
