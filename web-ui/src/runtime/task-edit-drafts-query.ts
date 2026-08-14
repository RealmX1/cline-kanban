// 任务编辑草稿的浏览器侧传输助手。把 tRPC 细节挡在这里，store 只管状态编排。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskEditDraftsResponse,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "@/runtime/types";

export const EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT: WorkspaceTaskEditDraftsSnapshot = {
	draftsByTaskId: {},
	supersededDraftCopies: [],
};

// 服务端读不出草稿文件时会回 ok:false + drafts:null。如实传出去，别折叠成空集——把损坏当空集会让
// 迁移再叠一份重复草稿上去。
export async function fetchWorkspaceTaskEditDrafts(
	workspaceId: string,
): Promise<WorkspaceTaskEditDraftsSnapshot | null> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response: RuntimeTaskEditDraftsResponse = await trpcClient.runtime.getWorkspaceTaskEditDrafts.query({});
	return response.ok ? response.drafts : null;
}

export async function mutateWorkspaceTaskEditDrafts(
	workspaceId: string,
	mutation: WorkspaceTaskEditDraftMutation,
): Promise<WorkspaceTaskEditDraftsSnapshot | null> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response: RuntimeTaskEditDraftsResponse = await trpcClient.runtime.mutateWorkspaceTaskEditDrafts.mutate({
		mutation,
	});
	return response.ok ? response.drafts : null;
}
