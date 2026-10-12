import { useCrossProjectTaskWorktreeGitMetadataSnapshotValue } from "@/stores/cross-project-task-worktree-git-metadata-store";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

// 跨项目切换面板一行的 git 元数据（ahead/behind、未提交改动）的唯一取数入口，两种来源对行组件透明：
//   - 当前项目的行：优先读 workspace_metadata_updated 推流 store（与 This project 卡片同源、更新更勤）。
//     All projects 下推流只探焦点任务与 auto-review 的 Review 列任务，其余行在推流里没有数据，回落到轮询 store。
//   - 其他项目的行：读 use-cross-project-task-worktree-git-metadata-polling 轮询写入的复合键 store。
// 只按 taskId 分键的推流 store 跨项目会撞号，所以「是不是当前项目」必须先判，不能两边都读再取一个。
export function useTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntry(
	workspaceId: string,
	taskId: string,
	currentProjectId: string | null,
): ReviewTaskWorkspaceSnapshot | null {
	const isEntryInCurrentProject = workspaceId === currentProjectId;
	const currentProjectSnapshot = useTaskWorkspaceSnapshotValue(isEntryInCurrentProject ? taskId : null);
	const polledSnapshot = useCrossProjectTaskWorktreeGitMetadataSnapshotValue(workspaceId, taskId, true);
	return isEntryInCurrentProject ? (currentProjectSnapshot ?? polledSnapshot) : polledSnapshot;
}
