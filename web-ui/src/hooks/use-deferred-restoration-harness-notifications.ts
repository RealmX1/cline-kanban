// 恢复期被暂存的 harness 通知：拉取 + 一键放行的领域逻辑。
//
// 背景：会话经 resumeFromTrash 重启（点「刷新终端」/ 陈旧会话自动续跑 / Kanban 进程重启）后，恢复守卫
// 会拦下**上一个活体遗留的孤儿** task-notification 并暂存到 workspace 账本，等真人回来的首个回合再随
// additionalContext 捎给 agent。放行入口让用户不必干等那个回合——点一下即把攒下的通知作为一条 prompt
// 注入并发送，同时解除守卫。

import { useCallback, useEffect, useRef, useState } from "react";

import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import {
	fetchDeferredRestorationHarnessNotifications,
	releaseDeferredRestorationHarnessNotifications,
} from "@/runtime/deferred-restoration-harness-notifications-query";
import type { RuntimeDeferredRestorationHarnessNotification } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

// 账本只在「守卫武装 + 恰好有通知到达」这个窄窗口里变化，是不折不扣的低频状态：15s 已经比用户
// 察觉得到的延迟更快，再密只是白费请求。标签页不可见时整个停掉（delayMs=null）。
const DEFERRED_RESTORATION_HARNESS_NOTIFICATION_POLL_INTERVAL_MS = 15_000;

export function useDeferredRestorationHarnessNotifications({
	workspaceId,
	taskId,
	isEnabled,
}: {
	workspaceId: string | null;
	taskId: string | null;
	isEnabled: boolean;
}): {
	deferredNotifications: RuntimeDeferredRestorationHarnessNotification[];
	isReleaseInFlight: boolean;
	releaseFailureMessage: string | null;
	releaseDeferredNotifications: () => void;
} {
	const [deferredNotifications, setDeferredNotifications] = useState<RuntimeDeferredRestorationHarnessNotification[]>(
		[],
	);
	const [isReleaseInFlight, setIsReleaseInFlight] = useState(false);
	const [releaseFailureMessage, setReleaseFailureMessage] = useState<string | null>(null);
	const isDocumentVisible = useDocumentVisibility();
	const isPollingEnabled = isEnabled && isDocumentVisible && workspaceId !== null && taskId !== null;

	// 横幅上的条数与失败信息必须始终属于当前这张卡。详情视图不按 taskId 重新挂载，所以 A→B 切卡时本
	// hook 实例是复用的；而下面 `!isPollingEnabled` 那条清空路径在两张卡都 enabled 时根本走不到，于是
	// 旧任务的在途 fetch / release 回调会把上一张卡的结果写进新卡的状态——按钮闭包却已指向新卡，用户
	// 会照着旧任务的横幅对当前任务误点放行。故给每次请求打上发起时的「世代」，回调落地前先比对。
	// 用单调自增的世代而不是账本身份本身比对，是为了 A→B→A 也能作废 A 那次早已过期的请求。
	const currentDeferredNotificationRequestGenerationRef = useRef(0);
	const deferredNotificationLedgerIdentity = JSON.stringify([workspaceId, taskId]);
	const [renderedDeferredNotificationLedgerIdentity, setRenderedDeferredNotificationLedgerIdentity] = useState(
		deferredNotificationLedgerIdentity,
	);
	if (renderedDeferredNotificationLedgerIdentity !== deferredNotificationLedgerIdentity) {
		// 渲染期同步复位：换卡的那一帧就不该再显示上一张卡的条数与失败信息，交给 effect 会先闪一帧旧数据。
		currentDeferredNotificationRequestGenerationRef.current += 1;
		setRenderedDeferredNotificationLedgerIdentity(deferredNotificationLedgerIdentity);
		setDeferredNotifications([]);
		setIsReleaseInFlight(false);
		setReleaseFailureMessage(null);
	}

	const hasDeferredNotificationRequestBeenSupersededByTaskSwitch = useCallback(
		(requestGeneration: number): boolean =>
			requestGeneration !== currentDeferredNotificationRequestGenerationRef.current,
		[],
	);

	const refreshDeferredNotifications = useCallback(() => {
		if (workspaceId === null || taskId === null) {
			return;
		}
		const requestGeneration = currentDeferredNotificationRequestGenerationRef.current;
		void fetchDeferredRestorationHarnessNotifications(workspaceId, taskId)
			.then((notifications) => {
				if (hasDeferredNotificationRequestBeenSupersededByTaskSwitch(requestGeneration)) {
					return;
				}
				setDeferredNotifications(notifications);
			})
			// 读失败只让入口不显示，绝不冒泡：这条信息驱动的是一个可选入口的显隐，不该让详情视图整块炸掉。
			.catch(() => {
				if (hasDeferredNotificationRequestBeenSupersededByTaskSwitch(requestGeneration)) {
					return;
				}
				setDeferredNotifications([]);
			});
	}, [workspaceId, taskId, hasDeferredNotificationRequestBeenSupersededByTaskSwitch]);

	// 切任务 / 刚展开时立刻拉一次，不必等第一个轮询周期。
	useEffect(() => {
		if (!isPollingEnabled) {
			setDeferredNotifications([]);
			return;
		}
		refreshDeferredNotifications();
	}, [isPollingEnabled, refreshDeferredNotifications]);

	useInterval(
		refreshDeferredNotifications,
		isPollingEnabled ? DEFERRED_RESTORATION_HARNESS_NOTIFICATION_POLL_INTERVAL_MS : null,
	);

	const releaseDeferredNotifications = useCallback(() => {
		if (workspaceId === null || taskId === null || isReleaseInFlight) {
			return;
		}
		const requestGeneration = currentDeferredNotificationRequestGenerationRef.current;
		setIsReleaseInFlight(true);
		setReleaseFailureMessage(null);
		void releaseDeferredRestorationHarnessNotifications(workspaceId, taskId)
			.then((response) => {
				if (hasDeferredNotificationRequestBeenSupersededByTaskSwitch(requestGeneration)) {
					return;
				}
				if (!response.ok) {
					// 服务端在投递失败时已把通知放回账本，所以这里刷新后入口仍在——用户可以再试一次。
					setReleaseFailureMessage(response.error ?? "放行失败");
				}
			})
			.catch((error: unknown) => {
				if (hasDeferredNotificationRequestBeenSupersededByTaskSwitch(requestGeneration)) {
					return;
				}
				setReleaseFailureMessage(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				// 旧任务的收尾同样不许回写，否则它会拿旧任务的结果把新卡横幅再覆盖一遍。
				if (hasDeferredNotificationRequestBeenSupersededByTaskSwitch(requestGeneration)) {
					return;
				}
				setIsReleaseInFlight(false);
				refreshDeferredNotifications();
			});
	}, [
		workspaceId,
		taskId,
		isReleaseInFlight,
		refreshDeferredNotifications,
		hasDeferredNotificationRequestBeenSupersededByTaskSwitch,
	]);

	return { deferredNotifications, isReleaseInFlight, releaseFailureMessage, releaseDeferredNotifications };
}
