// 恢复守卫暂存了 harness 通知时的一键放行入口。摆在终端正上方，与 TerminalDeliveryContentionBanner
// 并排：两者说的都是「你手上这个会话此刻被什么挡住了」。没有待放行通知时整块不渲染，日常不占高度。

import { Inbox } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { useDeferredRestorationHarnessNotifications } from "@/hooks/use-deferred-restoration-harness-notifications";

export function DeferredRestorationHarnessNotificationReleaseBanner({
	taskId,
	workspaceId,
	isEnabled,
}: {
	taskId: string;
	workspaceId: string | null;
	isEnabled: boolean;
}): React.ReactElement | null {
	const { deferredNotifications, isReleaseInFlight, releaseFailureMessage, releaseDeferredNotifications } =
		useDeferredRestorationHarnessNotifications({ workspaceId, taskId, isEnabled });

	if (deferredNotifications.length === 0) {
		return null;
	}
	return (
		<div className="mb-1 flex items-start gap-2 rounded-md border border-status-blue/30 bg-status-blue/10 px-2 py-1.5 text-status-blue text-xs">
			<Inbox size={13} className="mt-0.5 shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="font-medium">
					恢复会话时暂存了 {deferredNotifications.length} 条系统任务通知，未自动启动新回合
				</div>
				<div className="mt-0.5 text-text-secondary">
					{releaseFailureMessage === null
						? "放行会把它们作为一条消息发给 agent，并解除恢复守卫。"
						: `上次放行失败：${releaseFailureMessage}（通知已放回暂存，可以重试）`}
				</div>
			</div>
			<Button variant="default" size="xs" disabled={isReleaseInFlight} onClick={releaseDeferredNotifications}>
				{isReleaseInFlight ? "放行中…" : "放行并发送"}
			</Button>
		</div>
	);
}
