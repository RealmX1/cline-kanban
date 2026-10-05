// 跨项目切换面板「其他项目」行的 git 元数据（ahead/behind、未提交改动）的浏览器侧传输助手。
// 轮询编排在 use-cross-project-task-worktree-git-metadata-polling.ts；这里只挡住 tRPC 细节。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest,
	RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse,
} from "@/runtime/types";

// 非 workspace-scoped（按每条的 workspaceId 读）；连接 scope 用当前项目即可。
export async function fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(
	currentWorkspaceId: string | null,
	request: RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest,
): Promise<RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse> {
	return await getRuntimeTrpcClient(
		currentWorkspaceId,
	).projects.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.query(request);
}
