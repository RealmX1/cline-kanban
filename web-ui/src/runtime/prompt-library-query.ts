// Prompt Library 的浏览器侧传输助手。把 tRPC 细节挡在这里，hook 只管状态编排。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimePromptLibraryResponse,
	WorkspacePromptLibraryMutation,
	WorkspacePromptLibrarySnapshot,
} from "@/runtime/types";

export const EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT: WorkspacePromptLibrarySnapshot = {
	globalScopedPrompts: [],
	repoScopedPrompts: [],
	taskScopedPromptsByTaskId: {},
};

// 服务端在读不出库时会回 ok:false + library:null（例如库文件损坏）。对读路径而言空库是安全默认值，
// 但**不能**把它当成「库里真的没东西」去做迁移播种——那会把损坏当空库、再往上叠一份重复数据。
// 所以这里如实把 null 传出去，由调用方区分。
export async function fetchWorkspacePromptLibrary(workspaceId: string): Promise<WorkspacePromptLibrarySnapshot | null> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response: RuntimePromptLibraryResponse = await trpcClient.runtime.getWorkspacePromptLibrary.query({});
	return response.ok ? response.library : null;
}

export async function mutateWorkspacePromptLibrary(
	workspaceId: string,
	mutation: WorkspacePromptLibraryMutation,
): Promise<WorkspacePromptLibrarySnapshot | null> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response: RuntimePromptLibraryResponse = await trpcClient.runtime.mutateWorkspacePromptLibrary.mutate({
		mutation,
	});
	return response.ok ? response.library : null;
}
