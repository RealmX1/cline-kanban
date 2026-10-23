import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import type { ReactElement } from "react";
import { AheadBehindIndicator } from "@/components/ui/ahead-behind-indicator";
import { TaskCommitCoverageInCurrentDeploymentIndicator } from "@/components/ui/task-commit-coverage-in-current-deployment-indicator";
import { TaskCommitsIntegratedIntoBaseRefIndicator } from "@/components/ui/task-commits-integrated-into-base-ref-indicator";
import { TaskRetainedCommittedLineChangeIndicator } from "@/components/ui/task-retained-committed-line-change-indicator";
import { describeTaskWorkspaceGitStatusAgainstBaseRef } from "@/components/ui/task-workspace-git-status-against-base-ref-description";
import { TaskWorkspaceModeIconWithTooltip } from "@/components/ui/task-workspace-mode-icon-with-tooltip";
import {
	shouldDisplayWorktreeUncommittedChangeSummary,
	WorktreeUncommittedChangeSummaryIndicator,
} from "@/components/ui/worktree-uncommitted-change-summary-indicator";
import { useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry } from "@/hooks/use-task-worktree-git-metadata-for-cross-project-task-switcher-entry";

// 跨项目切换面板一行的 git 元数据：相对 base 分支的提交关系（ahead / behind / 已集成）与未提交改动（dirty）。
// 显隐规则与 This project 卡片目录行一致：Backlog 没有 worktree 不显示；ahead/behind 一组只在有可说的时显示；
// 未提交改动全为 0 时隐藏；已提交累计保持常驻，工作区图标沿用统一 tooltip。
export function CrossProjectRecentlyActiveTaskSwitcherTaskRowWorktreeGitMetadata({
	entryInProject,
	currentProjectId,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	currentProjectId: string | null;
}): ReactElement | null {
	const { workspaceId, entry } = entryInProject;
	const snapshot = useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry(
		workspaceId,
		entry.taskId,
		currentProjectId,
	);
	if (entry.columnId === "backlog" || !snapshot) {
		return null;
	}
	const baseRef = entry.baseRef ?? "base branch";
	const gitStatusAgainstBaseRefDescription = describeTaskWorkspaceGitStatusAgainstBaseRef({
		baseRef,
		commitsAheadOfBaseRef: snapshot.commitsAheadOfBaseRef,
		commitsBehindBaseRef: snapshot.commitsBehindBaseRef,
		taskCommitsIntegratedIntoBaseRef: snapshot.taskCommitsIntegratedIntoBaseRef ?? null,
		taskCommitIntegrationTrackingStatus: snapshot.taskCommitIntegrationTrackingStatus,
	});
	const showsUncommittedChangeSummary =
		snapshot.changedFiles != null && shouldDisplayWorktreeUncommittedChangeSummary(snapshot);
	return (
		<span
			className="inline-flex shrink-0 items-center gap-1 font-mono text-text-tertiary"
			data-cross-project-task-switcher-row-worktree-git-metadata=""
			title={gitStatusAgainstBaseRefDescription ?? undefined}
		>
			<TaskWorkspaceModeIconWithTooltip worktreeMode={entry.worktreeMode} />
			{gitStatusAgainstBaseRefDescription ? (
				<>
					<AheadBehindIndicator
						ahead={snapshot.commitsAheadOfBaseRef}
						behind={snapshot.commitsBehindBaseRef}
						tone="semantic"
						iconSize={10}
					/>
					{snapshot.taskCommitIntegrationTrackingStatus !== undefined ? (
						<TaskCommitsIntegratedIntoBaseRefIndicator
							taskCommitsIntegratedIntoBaseRef={snapshot.taskCommitsIntegratedIntoBaseRef ?? null}
						/>
					) : null}
				</>
			) : null}
			<TaskCommitCoverageInCurrentDeploymentIndicator coverage={snapshot.taskCommitCoverageInCurrentDeployment} />
			{showsUncommittedChangeSummary && snapshot.changedFiles != null ? (
				<span>
					<WorktreeUncommittedChangeSummaryIndicator
						showUncommittedChangeBackground
						changedFiles={snapshot.changedFiles}
						additions={snapshot.additions ?? 0}
						deletions={snapshot.deletions ?? 0}
					/>
				</span>
			) : null}
			<TaskRetainedCommittedLineChangeIndicator
				showCommittedChangeBackground
				workspaceId={workspaceId}
				taskId={entry.taskId}
				baseRef={entry.baseRef ?? "main"}
				summary={snapshot.taskRetainedCommittedLineChangeSummary}
			/>
		</span>
	);
}
