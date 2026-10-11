// `workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart` 的浏览器侧查询助手（cf427）。
// 把 TRPC 传输细节挡在建卡 hook 与「等待落盘确认」登记之外。

import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceStateResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

export async function persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(input: {
	workspaceId: string;
	// 按本地 backlog 列自上而下的顺序；runtime 把其中尚未落盘的卡整块插到 backlog 顶部。
	newBacklogTaskCardsCreatedFromWebUi: BoardCard[];
	boardMutationInitiatorOfNewBacklogTaskCards: WebUiBoardMutationInitiator;
}): Promise<RuntimeWorkspaceStateResponse> {
	const trpcClient = getRuntimeTrpcClient(input.workspaceId);
	return await trpcClient.workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart.mutate({
		newBacklogTaskCardsCreatedFromWebUi: input.newBacklogTaskCardsCreatedFromWebUi,
		boardMutationInitiatorOfNewBacklogTaskCards: input.boardMutationInitiatorOfNewBacklogTaskCards,
	});
}
