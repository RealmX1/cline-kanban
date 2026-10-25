// exploration thread graph 的浏览器侧传输助手（B.2）。把 tRPC 细节挡在这里，
// hook / 组件只管状态编排（镜像 findings-query.ts 的同款分层）。
//
// 两条通道的成本差异必须记住：
// - `getExplorationThreadGraph` 是**免费**的——服务端只读落盘 collection 与 transcript 增量，
//   合成投影后返回，绝不 fork 任何进程。想刷新就刷新。
// - `requestExplorationThreadGraphMaintenance` 会让服务端 **fork 一个分身**去判定话题归属。
//   在重型会话上一次约 $4.5（成因见 docs/exploratory-mode-host-integration.md §3b）。
//   它只该由用户的显式点击触发，绝不放进 effect / 轮询 / 重连回调里。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeGetExplorationThreadGraphResponse,
	RuntimeRequestExplorationThreadGraphMaintenanceResponse,
} from "@/runtime/types";

export async function fetchExplorationThreadGraph(
	workspaceId: string,
	explorationId: string,
	signal?: AbortSignal,
): Promise<RuntimeGetExplorationThreadGraphResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.getExplorationThreadGraph.query({ explorationId }, { signal });
}

/** 只在用户显式点「立即维护一次」时调用——这一下会花钱。 */
export async function requestExplorationThreadGraphMaintenance(
	workspaceId: string,
	explorationId: string,
): Promise<RuntimeRequestExplorationThreadGraphMaintenanceResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.requestExplorationThreadGraphMaintenance.mutate({ explorationId });
}
