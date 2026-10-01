// 建卡 id 分配的浏览器侧查询助手（dd2db Y-EVENT-12：新卡 id 只由 runtime 分配，全局唯一、删卡后永不复用）。
// 把 TRPC 传输细节挡在 prefetch 池与 hook 之外。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

// null = 这个 runtime 没有激活关系账本（例如打不开 better-sqlite3 的启动路径），分配不出 id；
// 这种实例的 board 本来就只读，建卡会在保存时失败。
export async function allocateRuntimeTaskIdForNewWebUiTaskCard(workspaceId: string): Promise<string | null> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response = await trpcClient.workspace.allocateTaskIdForNewWebUiTaskCard.mutate();
	return response.allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry;
}
