import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Pin } from "lucide-react";
import { BacklogTaskDescriptionLastUpdatedPill } from "@/components/backlog-task-description-last-updated-pill";
import { CrossProjectTaskSwitcherRowPromptCacheWarmthPill } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-prompt-cache-warmth-pill";
import { TaskActivityElapsedTimePills } from "@/components/task-activity-elapsed-time-pills";
import { TaskCardSummaryMetadata } from "@/components/task-card-summary-metadata";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveBoardColumnTitle } from "@/data/board-data";
import { useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry } from "@/hooks/use-task-worktree-git-metadata-for-cross-project-task-switcher-entry";

export function CrossProjectTaskSwitcherRowSummaryMetadata({
	entryInProject,
	currentProjectId,
	projectName,
	nowMs,
	section,
	promptCacheWarmthEstimate,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	currentProjectId: string | null;
	projectName?: string | null;
	nowMs: number;
	section?: string;
	promptCacheWarmthEstimate?: CrossProjectTaskSwitcherPromptCacheWarmthEstimate;
}) {
	const { workspaceId, entry } = entryInProject;
	const snapshot = useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry(
		workspaceId,
		entry.taskId,
		currentProjectId,
	);
	return (
		<TaskCardSummaryMetadata
			workspaceId={workspaceId}
			projectName={projectName}
			task={{ id: entry.taskId, baseRef: entry.baseRef, worktreeMode: entry.worktreeMode }}
			snapshot={snapshot}
			showGitMetadata={entry.columnId !== "backlog" && snapshot != null}
			timePills={
				<>
					{section === "pinned" || section === "shelved" ? (
						<span className="inline-flex shrink-0 items-center gap-0.5">
							<ColumnIndicator columnId={entry.columnId} size={10} />
							{resolveBoardColumnTitle(entry.columnId)}
						</span>
					) : null}
					{promptCacheWarmthEstimate ? (
						<CrossProjectTaskSwitcherRowPromptCacheWarmthPill
							promptCacheWarmthEstimate={promptCacheWarmthEstimate}
							nowMs={nowMs}
						/>
					) : null}
					<TaskActivityElapsedTimePills task={entry} nowMs={nowMs} />
					{entry.columnId === "backlog" ? (
						<BacklogTaskDescriptionLastUpdatedPill
							card={{
								taskDescriptionLastUpdatedAt: entry.taskDescriptionLastUpdatedAt,
								updatedAt: entry.taskDescriptionLastUpdatedAt,
							}}
							elapsedNowMs={nowMs}
							revealHoverActionTooltip={(label) => label ?? undefined}
						/>
					) : null}
					{entry.pinnedToTaskPinboardAt !== null && section !== "pinned" ? (
						<span
							data-cross-project-task-switcher-row-pinned-marker=""
							className="inline-flex shrink-0 text-accent"
							title={entry.taskPinboardPinReason ?? "已置顶"}
						>
							<Pin size={8} />
						</span>
					) : null}
				</>
			}
		/>
	);
}
