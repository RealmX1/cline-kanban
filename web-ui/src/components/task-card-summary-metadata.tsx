import type { ReactNode } from "react";
import { ProjectIcon } from "@/components/project-visual-identity";
import { AheadBehindIndicator } from "@/components/ui/ahead-behind-indicator";
import { TaskCommitCoverageInCurrentDeploymentIndicator } from "@/components/ui/task-commit-coverage-in-current-deployment-indicator";
import { TaskCommitsIntegratedIntoBaseRefIndicator } from "@/components/ui/task-commits-integrated-into-base-ref-indicator";
import {
	shouldDisplayTaskRetainedCommittedLineChangeSummary,
	TaskRetainedCommittedLineChangeIndicator,
} from "@/components/ui/task-retained-committed-line-change-indicator";
import { describeTaskWorkspaceGitStatusAgainstBaseRef } from "@/components/ui/task-workspace-git-status-against-base-ref-description";
import { TaskWorkspaceModeIconWithTooltip } from "@/components/ui/task-workspace-mode-icon-with-tooltip";
import { Tooltip } from "@/components/ui/tooltip";
import {
	shouldDisplayWorktreeUncommittedChangeSummary,
	WorktreeUncommittedChangeSummaryIndicator,
} from "@/components/ui/worktree-uncommitted-change-summary-indicator";
import type { BoardCard, ReviewTaskWorkspaceSnapshot } from "@/types";

/** 缩略行和完整卡片共用分组、字号及 Git 判据；展开详情不进入摘要的布局流。 */
export function TaskCardSummaryMetadata({
	workspaceId,
	projectName,
	task,
	snapshot,
	showGitMetadata,
	timePills,
	revealTooltip = true,
}: {
	workspaceId: string | null;
	projectName?: string | null;
	task: Pick<BoardCard, "id" | "worktreeMode"> & { baseRef?: string };
	snapshot: ReviewTaskWorkspaceSnapshot | null | undefined;
	showGitMetadata: boolean;
	timePills: ReactNode;
	revealTooltip?: boolean;
}) {
	const description = snapshot
		? describeTaskWorkspaceGitStatusAgainstBaseRef({
				baseRef: task.baseRef ?? "base branch",
				commitsAheadOfBaseRef: snapshot.commitsAheadOfBaseRef,
				commitsBehindBaseRef: snapshot.commitsBehindBaseRef,
				taskCommitsIntegratedIntoBaseRef: snapshot.taskCommitsIntegratedIntoBaseRef ?? null,
				taskCommitIntegrationTrackingStatus: snapshot.taskCommitIntegrationTrackingStatus,
			})
		: null;
	const showsDirty = snapshot?.changedFiles != null && shouldDisplayWorktreeUncommittedChangeSummary(snapshot);
	const showsCommitted = shouldDisplayTaskRetainedCommittedLineChangeSummary(
		snapshot?.taskRetainedCommittedLineChangeSummary,
	);
	return (
		<div
			data-task-card-secondary-metadata-row=""
			data-task-card-compact-metadata-row=""
			className="relative mb-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-none text-text-secondary"
		>
			{projectName ? (
				<span
					data-task-card-project-metadata-group=""
					className="inline-flex min-w-[min(14ch,100%)] max-w-full items-center gap-1"
				>
					<ProjectIcon workspaceId={workspaceId ?? undefined} projectName={projectName} size={14} />
					<span className="min-w-0 [overflow-wrap:anywhere]">{projectName}</span>
				</span>
			) : null}
			{showGitMetadata ? (
				<span
					data-task-directory=""
					className="pointer-events-auto inline-flex w-max min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] leading-[1.4]"
				>
					<span
						data-cross-project-task-switcher-row-worktree-git-metadata=""
						title={description ?? undefined}
						className="contents"
					>
						<span
							data-task-card-base-branch-relation-group=""
							className="inline-flex min-w-[min(20ch,100%)] max-w-full flex-wrap items-center gap-1"
						>
							<TaskWorkspaceModeIconWithTooltip worktreeMode={task.worktreeMode} />
							{description ? (
								<Tooltip side="bottom" content={revealTooltip ? description : undefined}>
									<span className="inline-flex flex-wrap items-center gap-1">
										<AheadBehindIndicator
											ahead={snapshot?.commitsAheadOfBaseRef}
											behind={snapshot?.commitsBehindBaseRef}
											tone="semantic"
											iconSize={10}
										/>
										{snapshot?.taskCommitIntegrationTrackingStatus !== undefined ? (
											<TaskCommitsIntegratedIntoBaseRefIndicator
												taskCommitsIntegratedIntoBaseRef={snapshot.taskCommitsIntegratedIntoBaseRef ?? null}
											/>
										) : null}
									</span>
								</Tooltip>
							) : null}
							<TaskCommitCoverageInCurrentDeploymentIndicator
								coverage={snapshot?.taskCommitCoverageInCurrentDeployment}
							/>
						</span>
						{showsDirty || showsCommitted ? (
							<span
								data-task-card-line-change-statistics-group=""
								className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-1"
							>
								{showsDirty && snapshot?.changedFiles != null ? (
									<WorktreeUncommittedChangeSummaryIndicator
										changedFiles={snapshot.changedFiles}
										additions={snapshot.additions ?? 0}
										deletions={snapshot.deletions ?? 0}
										showUncommittedChangeBackground
										allowLineWrapping
									/>
								) : null}
								{showsCommitted ? (
									<TaskRetainedCommittedLineChangeIndicator
										showCommittedChangeBackground
										allowLineWrapping
										workspaceId={workspaceId}
										taskId={task.id}
										baseRef={task.baseRef ?? "main"}
										summary={snapshot?.taskRetainedCommittedLineChangeSummary}
									/>
								) : null}
							</span>
						) : null}
					</span>
				</span>
			) : null}
			<span
				data-task-card-time-metadata-group=""
				className="ml-auto inline-flex max-w-full flex-wrap items-center gap-1"
			>
				{timePills}
			</span>
		</div>
	);
}
