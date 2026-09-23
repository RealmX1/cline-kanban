// 排队 prompt 投影的 App 层同步：首屏拉一次 + 推送归并 + 断连重连后重拉对齐，统一写进
// queued-task-prompt-delivery-projection-store。全应用只挂一份（App.tsx），消费者按 taskId 订阅 store。
//
// 与 use-exploratory-findings 同一套纪律：推送只覆盖「在场期间」的变更，断连窗口不补发，所以每次（重）连
// 握手完成（refreshKey = streamSnapshotGeneration 递增）都要重拉一次。

import { useEffect, useRef } from "react";

import { fetchTaskPromptDeliveryQueue } from "@/runtime/queued-task-prompt-delivery-query";
import type { RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId } from "@/runtime/types";
import {
	clearQueuedTaskPromptDeliveryProjections,
	replaceQueuedTaskPromptDeliveryProjections,
} from "@/stores/queued-task-prompt-delivery-projection-store";

export function useQueuedTaskPromptDeliveryProjectionSync(input: {
	workspaceId: string | null;
	refreshKey: number;
	pushedProjectedEntriesByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId | null;
}): void {
	const { workspaceId, refreshKey, pushedProjectedEntriesByTaskId } = input;
	// 每应用一次推送就递增。拉取发出时记下当时的值，回来时若已被推送超过，就丢掉这份更旧的拉取结果——
	// 否则「推送先到、拉取后到」会把刚推来的新状态回滚成旧的。
	const pushedProjectionGenerationRef = useRef(0);

	useEffect(() => {
		clearQueuedTaskPromptDeliveryProjections();
	}, [workspaceId]);

	useEffect(() => {
		if (!workspaceId) {
			return;
		}
		let cancelled = false;
		const pushedProjectionGenerationAtFetchStart = pushedProjectionGenerationRef.current;
		void fetchTaskPromptDeliveryQueue(workspaceId)
			.then((response) => {
				if (
					cancelled ||
					!response.ok ||
					response.projectedEntriesByTaskId === null ||
					pushedProjectionGenerationRef.current !== pushedProjectionGenerationAtFetchStart
				) {
					return;
				}
				replaceQueuedTaskPromptDeliveryProjections(response.projectedEntriesByTaskId);
			})
			.catch(() => {
				// 拉不到就保持上一份（或空）：队列是附加信息，拉取失败不该弹错打扰用户；下次重连会再拉。
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, refreshKey]);

	useEffect(() => {
		if (pushedProjectedEntriesByTaskId === null) {
			return;
		}
		pushedProjectionGenerationRef.current += 1;
		replaceQueuedTaskPromptDeliveryProjections(pushedProjectedEntriesByTaskId);
	}, [pushedProjectedEntriesByTaskId]);
}
