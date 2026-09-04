// 恢复期被暂存的 harness 通知：列出与一键放行的浏览器侧传输助手。把 tRPC 细节挡在这里。
//
// 背景：会话经 resumeFromTrash 重启（点「刷新终端」/ 陈旧会话自动续跑 / Kanban 进程重启）后，恢复守卫
// 会拦下上一活体遗留的孤儿 task-notification 并暂存。放行入口让用户不必干等守卫自然解除。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeDeferredRestorationHarnessNotification,
	RuntimeDeferredRestorationHarnessNotificationsResponse,
	RuntimeReleaseDeferredRestorationHarnessNotificationsResponse,
} from "@/runtime/types";

// 读不出账本时回空列表而不是抛：这条信息只驱动一个可选入口的显隐，读失败不该让详情视图整块炸掉。
export async function fetchDeferredRestorationHarnessNotifications(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeDeferredRestorationHarnessNotification[]> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response: RuntimeDeferredRestorationHarnessNotificationsResponse =
		await trpcClient.runtime.getDeferredRestorationHarnessNotifications.query({ taskId });
	return response.ok ? response.notifications : [];
}

export async function releaseDeferredRestorationHarnessNotifications(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeReleaseDeferredRestorationHarnessNotificationsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.releaseDeferredRestorationHarnessNotificationsIntoTaskSession.mutate({ taskId });
}
