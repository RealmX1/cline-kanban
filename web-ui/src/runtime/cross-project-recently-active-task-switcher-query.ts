// 跨项目「最近活跃任务」切换面板（docs/context-cross-project-recently-active-task-switcher.md）的浏览器侧传输助手。
// 把 tRPC 细节挡在这里，hook / 组件只管状态编排（同 findings-query.ts 的分层）。
//
// 面板的主数据不经这里：条目随 projects_updated 广播（RuntimeProjectSummary.crossProjectTaskSwitcherEntries）。
// 这里只有三件按需的事：记「我最后打开」、「显示更早」、对非当前项目的卡置顶 / 取消置顶。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse,
	RuntimeRecordTaskOpenedByUserResponse,
	RuntimeSetTaskPinboardPinStateOfTaskCardRequest,
	RuntimeSetTaskPinboardPinStateOfTaskCardResponse,
} from "@/runtime/types";

// 非 workspace-scoped（按 input.workspaceId 写）；连接 scope 用目标项目即可。
export async function recordTaskOpenedByUserOnRuntime(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeRecordTaskOpenedByUserResponse> {
	return await getRuntimeTrpcClient(workspaceId).projects.recordTaskOpenedByUser.mutate({ workspaceId, taskId });
}

export async function fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon(
	currentWorkspaceId: string | null,
): Promise<RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse> {
	return await getRuntimeTrpcClient(
		currentWorkspaceId,
	).projects.listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon.query();
}

// workspace-scoped：连接 scope 必须是卡片所在的项目。
export async function setTaskPinboardPinStateOfTaskCardInProject(
	workspaceId: string,
	request: RuntimeSetTaskPinboardPinStateOfTaskCardRequest,
): Promise<RuntimeSetTaskPinboardPinStateOfTaskCardResponse> {
	return await getRuntimeTrpcClient(workspaceId).workspace.setTaskPinboardPinStateOfTaskCard.mutate(request);
}
