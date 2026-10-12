import type { RuntimeTaskCommitIntegrationTrackingStatus } from "@/runtime/types";

// 任务 worktree 相对 base 分支的提交关系（ahead / behind / 已集成提交数）的文字说明。This project 卡片目录行与
// 跨项目切换面板的行共用这一份；返回 null 表示没有可说的（此时宿主也不渲染 ahead/behind 那一组）。
export function describeTaskWorkspaceGitStatusAgainstBaseRef(input: {
	baseRef: string;
	commitsAheadOfBaseRef: number | null;
	commitsBehindBaseRef: number | null;
	taskCommitsIntegratedIntoBaseRef: number | null;
	taskCommitIntegrationTrackingStatus: RuntimeTaskCommitIntegrationTrackingStatus | undefined;
}): string | null {
	const pluralizeCommits = (count: number) => `${count} ${count === 1 ? "commit" : "commits"}`;
	const parts: string[] = [];
	if (input.commitsAheadOfBaseRef) {
		parts.push(`${pluralizeCommits(input.commitsAheadOfBaseRef)} ahead of ${input.baseRef}`);
	}
	if (input.commitsBehindBaseRef) {
		parts.push(`${pluralizeCommits(input.commitsBehindBaseRef)} behind ${input.baseRef}`);
	}
	if (input.taskCommitsIntegratedIntoBaseRef !== null) {
		parts.push(
			`${pluralizeCommits(input.taskCommitsIntegratedIntoBaseRef)} from this task integrated into ${input.baseRef}`,
		);
	} else if (input.taskCommitIntegrationTrackingStatus === "legacy_history_unavailable") {
		parts.push(`Integrated commit history is unavailable for this legacy task`);
	} else if (input.taskCommitIntegrationTrackingStatus === "task_commit_ownership_history_incomplete") {
		parts.push(`Integrated task commit count cannot be proven from recorded history`);
	} else if (input.taskCommitIntegrationTrackingStatus === "inplace_task_commit_ownership_unavailable") {
		parts.push(`Integrated task commit ownership cannot be isolated in inplace mode`);
	} else if (input.taskCommitIntegrationTrackingStatus === "git_probe_unavailable") {
		parts.push(`Integrated task commit count is temporarily unavailable`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}
