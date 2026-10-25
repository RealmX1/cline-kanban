import {
	hasUsableTaskWorktreeGitMetadataSnapshot,
	useCrossProjectTaskWorktreeGitMetadataSnapshotValue,
} from "@/stores/cross-project-task-worktree-git-metadata-store";
import { useTaskWorkspaceInfoValue, useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

export function selectTaskWorktreeGitMetadataSnapshotForCrossProjectTaskSwitcherEntry({
	currentProjectSnapshot,
	currentProjectWorktreeExists,
	polledSnapshot,
}: {
	currentProjectSnapshot: ReviewTaskWorkspaceSnapshot | null;
	currentProjectWorktreeExists: boolean | null;
	polledSnapshot: ReviewTaskWorkspaceSnapshot | null;
}): { snapshot: ReviewTaskWorkspaceSnapshot | null; usesCurrentProjectStreamSnapshot: boolean } {
	const usesCurrentProjectStreamSnapshot =
		currentProjectWorktreeExists === false ||
		currentProjectSnapshot?.workspaceGitStatusObservationSource === "persisted_final_snapshot" ||
		hasUsableTaskWorktreeGitMetadataSnapshot(currentProjectSnapshot);
	return {
		snapshot: usesCurrentProjectStreamSnapshot ? currentProjectSnapshot : polledSnapshot,
		usesCurrentProjectStreamSnapshot,
	};
}

// 跨项目切换面板一行的 git 元数据（ahead/behind、未提交改动）的唯一取数入口，两种来源对行组件透明：
//   - 当前项目的行：推流有可用证据或明确说明工作树已删除 / 只有历史快照时优先，否则回落到轮询 store。
//     All projects 下推流只探焦点任务与 auto-review 的 Review 列任务，其余行也靠轮询补齐。
//   - 其他项目的行：读 use-cross-project-task-worktree-git-metadata-polling 轮询写入的复合键 store。
// 只按 taskId 分键的推流 store 跨项目会撞号，所以「是不是当前项目」必须先判，不能两边都读再取一个。
export function useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry(
	workspaceId: string,
	taskId: string,
	currentProjectId: string | null,
): ReviewTaskWorkspaceSnapshot | null {
	const isEntryInCurrentProject = workspaceId === currentProjectId;
	const currentProjectSnapshot = useTaskWorkspaceSnapshotValue(isEntryInCurrentProject ? taskId : null);
	const currentProjectWorkspaceInfo = useTaskWorkspaceInfoValue(isEntryInCurrentProject ? taskId : null);
	const polledSnapshot = useCrossProjectTaskWorktreeGitMetadataSnapshotValue(workspaceId, taskId, true);
	return selectTaskWorktreeGitMetadataSnapshotForCrossProjectTaskSwitcherEntry({
		currentProjectSnapshot,
		currentProjectWorktreeExists: currentProjectWorkspaceInfo?.exists ?? null,
		polledSnapshot,
	}).snapshot;
}
