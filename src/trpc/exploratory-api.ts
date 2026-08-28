// Exploratory Mode 的 tRPC handler 层（蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md）。
// 纯委托：读写交给 src/state/exploratory-session-map-store.ts。
// M0 只有 getSessionMap 读路径；agent 写回通道（ingestSessionMapUpdate mutation + apply
// 漏斗四道闸）属 M1，届时进同一模块。

import type {
	RuntimeGetExploratorySessionMapRequest,
	RuntimeGetExploratorySessionMapResponse,
} from "../core/api-contract";
import { readExploratorySessionMapCollection } from "../state/exploratory-session-map-store";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export function createExploratoryApi(): RuntimeTrpcContext["exploratoryApi"] {
	return {
		getSessionMap: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetExploratorySessionMapRequest,
		): Promise<RuntimeGetExploratorySessionMapResponse> => {
			const mapCollection = await readExploratorySessionMapCollection(
				scope.workspaceId,
				input.conversationSessionTaskId,
			);
			return { mapCollection };
		},
	};
}
