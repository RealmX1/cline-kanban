// Exploratory findings 的浏览器侧传输助手（蓝图 §D，M2）。把 tRPC 细节挡在这里，
// hook/组件只管状态编排（镜像 conversation-turn-projection-query.ts 的同款分层）。
//
// 数据源（server 侧 M2 已落地）：
// - exploratory.getFindings：workspace 级全量读取（集合恒小，上限 500）——进 workspace
//   拉一次，之后靠 exploratory_findings_updated 推送全量替换；
// - exploratory.saveFinding：人工保存主路径（§D.2.1），落库即 active + user_saved；
// - confirm/reject/archive：建议确认态机（§D.2.2）与软删/恢复。
// 所有 mutation 落盘成功后服务端都会广播全量集合，客户端状态经推送收敛，不在本地乐观改。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeArchiveExploratoryFindingResponse,
	RuntimeConfirmExploratoryFindingResponse,
	RuntimeGetExploratoryFindingsResponse,
	RuntimeRejectExploratoryFindingResponse,
	RuntimeSaveExploratoryFindingRequest,
	RuntimeSaveExploratoryFindingResponse,
} from "@/runtime/types";

export async function fetchExploratoryFindings(workspaceId: string): Promise<RuntimeGetExploratoryFindingsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.getFindings.query({});
}

export async function saveExploratoryFinding(
	workspaceId: string,
	request: RuntimeSaveExploratoryFindingRequest,
): Promise<RuntimeSaveExploratoryFindingResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.saveFinding.mutate(request);
}

export async function confirmExploratoryFinding(
	workspaceId: string,
	findingId: string,
): Promise<RuntimeConfirmExploratoryFindingResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.confirmFinding.mutate({ findingId });
}

export async function rejectExploratoryFinding(
	workspaceId: string,
	findingId: string,
): Promise<RuntimeRejectExploratoryFindingResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.rejectFinding.mutate({ findingId });
}

export async function archiveExploratoryFinding(
	workspaceId: string,
	findingId: string,
	archived: boolean,
): Promise<RuntimeArchiveExploratoryFindingResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.archiveFinding.mutate({ findingId, archived });
}
