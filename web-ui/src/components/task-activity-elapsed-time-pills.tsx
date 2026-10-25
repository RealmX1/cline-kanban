import {
	resolveLastAgentConversationUserHandoffObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "@runtime-agent-conversation-activity-observation";
import { Activity, Clock, Hourglass, MessagesSquare } from "lucide-react";
import { useMemo } from "react";
import { describePromptSubmissionAcceptance } from "@/components/prompt-submission-acceptance-description";
import { describeTaskConversationSessionActivityObservations } from "@/components/task-conversation-session-activity-description";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeInProgressTaskDetail } from "@/runtime/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";

/** 精简行与完整卡同源：创建时间、历史交棒、主对话推进；独立会话只在可聚焦的详情提示中分列。 */
export function TaskActivityElapsedTimePills({
	task,
	nowMs,
}: {
	task: Pick<
		RuntimeInProgressTaskDetail,
		| "createdAt"
		| "agentResponseGenerationStopped"
		| "lastConversationProgressObservation"
		| "lastEffectiveAgentConversationActivityObservation"
		| "lastAgentConversationUserHandoffObservation"
		| "agentConversationPromptSubmissionAcceptance"
	> &
		Partial<
			Pick<
				RuntimeCrossProjectTaskSwitcherEntry,
				"turnOwner" | "isParkedAwaitingDispatchedBackgroundWork" | "taskConversationSessionActivityObservations"
			>
		>;
	nowMs: number;
}): React.ReactElement {
	const taskCreatedAtTooltipContent = useMemo(
		() => `创建于 · ${new Date(task.createdAt).toLocaleString()}`,
		[task.createdAt],
	);
	const handoff =
		task.turnOwner !== "agent" && !task.isParkedAwaitingDispatchedBackgroundWork
			? resolveLastAgentConversationUserHandoffObservation(task)
			: null;
	const activity = resolveLastEffectiveAgentConversationActivityObservation(task);
	const description = task.taskConversationSessionActivityObservations
		? describeTaskConversationSessionActivityObservations(task.taskConversationSessionActivityObservations, nowMs)
		: activity
			? `主对话推进 · ${new Date(activity.observedAtMs).toLocaleString()} · ${activity.activityKind} · 证据：${activity.evidenceKind}`
			: "主对话尚无可信活动时间";
	return (
		<span className="ml-1 flex shrink-0 items-center gap-1.5 text-[10px] leading-none text-text-tertiary">
			<span
				data-task-created-at-pill=""
				title={taskCreatedAtTooltipContent}
				className="pointer-events-auto inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap"
			>
				<Clock size={10} className="shrink-0" />
				{formatCompactElapsedSince(task.createdAt, nowMs)}
			</span>
			{handoff ? (
				<span
					className="inline-flex items-center gap-0.5"
					title={`交回用户 · ${new Date(handoff.observedAtMs).toLocaleString()}`}
					data-agent-response-generation-stopped-pill=""
				>
					<Activity size={10} className="shrink-0" />
					{formatCompactElapsedSince(handoff.observedAtMs, nowMs)}
				</span>
			) : null}
			<Tooltip content={<span className="whitespace-pre-line">{description}</span>}>
				<span
					role="group"
					tabIndex={0}
					aria-label="各会话独立活动时间"
					className="pointer-events-auto inline-flex items-center gap-0.5"
					title={description}
					data-task-conversation-session-activity-details=""
					data-last-conversation-progress-pill={activity ? "" : undefined}
				>
					<MessagesSquare size={10} className="shrink-0" />
					{activity
						? `${activity.evidenceKind === "terminal_output_heuristic_classification" ? "~" : ""}${formatCompactElapsedSince(activity.observedAtMs, nowMs)}`
						: "活动未知"}
				</span>
			</Tooltip>
			{task.agentConversationPromptSubmissionAcceptance?.status === "pending" ||
			task.agentConversationPromptSubmissionAcceptance?.status === "unconfirmed" ? (
				<span
					role="status"
					title={describePromptSubmissionAcceptance(task.agentConversationPromptSubmissionAcceptance)}
					className="inline-flex items-center gap-0.5 text-status-gold"
				>
					<Hourglass size={10} />
					{task.agentConversationPromptSubmissionAcceptance.status === "pending" ? "提交待确认" : "尚未确认接受"}
				</span>
			) : null}
		</span>
	);
}
