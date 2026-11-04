// 建卡起名的浏览器侧查询助手：把 TRPC 传输细节挡在组件与 hook 之外。
//
// 走 `getRuntimeTrpcClient` 而不是 workspace 客户端：起名是 runtime 级能力（密钥来自运行时进程的环境
// 变量），与当前打开哪个项目无关。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskNameSuggestionResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

export async function requestAutomaticTaskNameBackfill(workspaceId: string, card: BoardCard) {
	return getRuntimeTrpcClient(workspaceId).runtime.requestAutomaticTaskNameBackfill.mutate({
		taskId: card.id,
		expectedTaskNameVersion: card.taskNameVersion ?? 0,
		expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
		expectedTitle: card.title,
		expectedPrompt: card.prompt,
	});
}

export async function suggestTaskNamesFromTaskDescription(
	taskDescription: string,
	abortSignal?: AbortSignal,
	namingTarget?: "task" | "conversation_session",
): Promise<RuntimeTaskNameSuggestionResponse> {
	const trpcClient = getRuntimeTrpcClient(null);
	return await trpcClient.runtime.suggestTaskNamesFromTaskDescription.mutate(
		{ taskDescription, namingTarget },
		{ signal: abortSignal },
	);
}
