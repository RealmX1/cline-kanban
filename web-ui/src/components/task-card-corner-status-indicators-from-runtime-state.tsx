import {
	buildCrossProjectTaskSwitcherEntryKey,
	isCrossProjectTaskSwitcherEntryRunning,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "@runtime-session-activity";
import { useCrossProjectRecentlyActiveTaskSwitcherHostContext } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { TaskCardCornerStatusIndicators } from "@/components/task-card-corner-status-indicators";
import { useSharedCoarseClockTimestampMs } from "@/hooks/use-shared-coarse-clock";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

/** 只让角标消费通知上下文，避免通知变化使整张卡片重新执行。 */
export function TaskCardCornerStatusIndicatorsFromRuntimeState({
	taskId,
	workspaceId,
	columnId,
	sessionSummary,
}: {
	taskId: string;
	workspaceId: string | null;
	columnId: BoardColumnId | null;
	sessionSummary: RuntimeTaskSessionSummary | undefined;
}) {
	const host = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const nowMs = useSharedCoarseClockTimestampMs();
	const resolvedWorkspaceId = workspaceId ?? host?.currentProjectId;
	const entryKey = resolvedWorkspaceId ? buildCrossProjectTaskSwitcherEntryKey(resolvedWorkspaceId, taskId) : null;
	const sectionsModel = host?.crossProjectTaskSwitcherSectionsModel;
	const hasUnreadHandoffNotification = Boolean(
		entryKey &&
			(sectionsModel
				? sectionsModel.unreadHandoffEntryKeys.has(entryKey)
				: host?.notificationLogByWorkspaceId[resolvedWorkspaceId ?? ""]?.some(
						(entry) => entry.taskId === taskId && entry.visitedAt === null,
					)),
	);
	const facets = sessionSummary ? resolveSessionFacets(sessionSummary) : null;
	const isAgentRunning =
		columnId !== null &&
		columnId !== "trash" &&
		(sessionSummary
			? isCrossProjectTaskSwitcherEntryRunning(
					{
						turnOwner: facets?.turnOwner ?? null,
						liveness: facets?.liveness ?? "none",
						isParkedAwaitingDispatchedBackgroundWork: isParkedAwaitingDispatchedBackgroundWork(sessionSummary),
					},
					nowMs,
				)
			: Boolean(
					entryKey &&
						sectionsModel?.sections.runningEntries.some(
							({ workspaceId: runningWorkspaceId, entry }) =>
								buildCrossProjectTaskSwitcherEntryKey(runningWorkspaceId, entry.taskId) === entryKey,
						),
				));
	return (
		<TaskCardCornerStatusIndicators
			isAgentRunning={isAgentRunning}
			hasUnreadHandoffNotification={hasUnreadHandoffNotification}
		/>
	);
}
