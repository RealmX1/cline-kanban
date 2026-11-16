import type { ReactNode } from "react";
import { ProjectIcon, useProjectNameFromVisualIdentityContext } from "@/components/project-visual-identity";
import { AheadBehindIndicator } from "@/components/ui/ahead-behind-indicator";
import { cn } from "@/components/ui/cn";
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

const projectNameVisibleCharacterSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 缩略行和完整卡片共用分组、字号及 Git 判据；展开详情不进入摘要的布局流。 */
export function TaskCardSummaryMetadata({
	workspaceId,
	projectName: fallbackProjectName,
	task,
	snapshot,
	showGitMetadata,
	timePills,
	className,
}: {
	workspaceId: string | null;
	projectName?: string | null;
	task: Pick<BoardCard, "id" | "worktreeMode"> & { baseRef?: string };
	snapshot: ReviewTaskWorkspaceSnapshot | null | undefined;
	showGitMetadata: boolean;
	timePills: ReactNode;
	className?: string;
}) {
	const projectName = useProjectNameFromVisualIdentityContext(workspaceId) ?? fallbackProjectName;
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
	const projectNameCharacters = projectName ? [...projectNameVisibleCharacterSegmenter.segment(projectName)] : [];
	const visibleProjectName =
		projectNameCharacters.length > 20
			? `${projectNameCharacters
					.slice(0, 20)
					.map(({ segment }) => segment)
					.join("")}…`
			: projectName;
	const statisticCellClassName =
		"pointer-events-auto flex min-w-0 flex-wrap content-center items-center gap-1 font-mono text-[11px] leading-[1.4] [overflow-wrap:anywhere]";
	return (
		<div
			role="group"
			data-task-card-secondary-metadata-row=""
			data-task-card-compact-metadata-row=""
			data-task-directory={showGitMetadata ? "" : undefined}
			aria-label={description ?? undefined}
			className={cn(
				"relative mb-1 grid min-w-0 items-stretch gap-x-1.5 gap-y-1 text-[10px] leading-[1.4] text-text-secondary",
				showGitMetadata && (showsDirty || showsCommitted)
					? "grid-cols-[minmax(0,32%)_minmax(min(26%,6rem),1fr)_fit-content(40%)]"
					: "grid-cols-[minmax(0,1fr)_fit-content(30%)_fit-content(40%)]",
				className,
			)}
		>
			<span
				role="group"
				data-task-card-summary-cell="project"
				data-task-card-project-metadata-group=""
				className="flex min-w-0 items-center gap-1"
				aria-label={projectName ?? undefined}
			>
				{projectName ? (
					<>
						<ProjectIcon workspaceId={workspaceId ?? undefined} projectName={projectName} size={14} />
						<Tooltip content={projectName}>
							<span className="pointer-events-auto min-w-0 truncate" tabIndex={0}>
								{visibleProjectName}
							</span>
						</Tooltip>
					</>
				) : null}
			</span>
			<span
				data-task-card-summary-cell="base_relation"
				data-task-card-base-branch-relation-group=""
				className={statisticCellClassName}
			>
				{showGitMetadata ? (
					<>
						<TaskWorkspaceModeIconWithTooltip worktreeMode={task.worktreeMode} />
						{description ? (
							<Tooltip side="bottom" content={description}>
								<span
									role="group"
									data-cross-project-task-switcher-row-worktree-git-metadata=""
									title={description}
									className="flex min-w-0 flex-wrap items-center gap-1"
									tabIndex={0}
									aria-label={description}
								>
									<AheadBehindIndicator
										ahead={snapshot?.commitsAheadOfBaseRef}
										behind={snapshot?.commitsBehindBaseRef}
										tone="semantic"
										iconSize={10}
										className="min-w-0 max-w-full flex-wrap [&>span]:min-w-0"
									/>
									{snapshot?.taskCommitIntegrationTrackingStatus !== undefined ? (
										<TaskCommitsIntegratedIntoBaseRefIndicator
											taskCommitsIntegratedIntoBaseRef={snapshot.taskCommitsIntegratedIntoBaseRef ?? null}
										/>
									) : null}
								</span>
							</Tooltip>
						) : null}
					</>
				) : null}
			</span>
			<span
				data-task-card-summary-cell="dirty"
				data-task-card-line-change-statistics-group=""
				className={statisticCellClassName}
			>
				{showGitMetadata && showsDirty && snapshot?.changedFiles != null ? (
					<Tooltip content="工作树未提交改动：文件数、新增与删除行数">
						<span className="min-w-0 max-w-full" tabIndex={0}>
							<WorktreeUncommittedChangeSummaryIndicator
								changedFiles={snapshot.changedFiles}
								additions={snapshot.additions ?? 0}
								deletions={snapshot.deletions ?? 0}
								showUncommittedChangeBackground
								allowLineWrapping
								showChangedFileCountWithIcon
							/>
						</span>
					</Tooltip>
				) : null}
			</span>
			<span
				data-task-card-summary-cell="time"
				data-task-card-time-metadata-group=""
				className="pointer-events-auto flex min-w-0 flex-wrap content-center items-center gap-1 [overflow-wrap:anywhere] [&_span]:min-w-0 [&_span]:max-w-full [&_span]:shrink [&_span]:flex-wrap [&_span]:whitespace-normal"
			>
				{timePills}
			</span>
			<span data-task-card-summary-cell="deployment_coverage" className={statisticCellClassName}>
				{showGitMetadata ? (
					<TaskCommitCoverageInCurrentDeploymentIndicator
						coverage={snapshot?.taskCommitCoverageInCurrentDeployment}
						allowLineWrapping
					/>
				) : null}
			</span>
			<span data-task-card-summary-cell="committed_diff" className={statisticCellClassName}>
				{showGitMetadata && showsCommitted ? (
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
		</div>
	);
}
