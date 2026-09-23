// kanban 重启后聚焦任务时的「重启前排的，确认一下还要不要」提醒。
//
// 用户原话：重启之后聚焦一个任务时，队列应当还在；此时让它柔和地闪 5 秒边框，提醒我确认这些排队的 prompt
// 还需要；然后在下一次 stop hook 注入。所以「人看见了」就是闪这一下——**不额外要一次点击**：
//   - 命中条件：详情视图已挂载（本 hook 只在详情视图里用）∧ 页面此刻真的可见 ∧ 该任务有重启后未确认的条目；
//   - 命中即播 5 秒高亮，**同时**发确认 mutation。两者并发、不等动画结束——否则开了「减少动效」的用户
//     永远确认不了（动画被关掉了，但静态 ring 与计时器仍在，见 globals.css）；
//   - 只在真人可见时确认：后台标签页里被程序化选中的卡片不算「人看见了」；
//   - 高亮没能挂上（锚点不在 DOM 里）时**不确认**：没闪就不算看见，留给面板里那个显式的 Keep 按钮。
//   - 每条条目只放一次电（模块级记账，跨组件实例）：确认请求失败时也不会一轮轮重放。
//
// 确认是持久的（服务端落 humanReconfirmedAfterRuntimeRestartAtEpochMs），所以刷新页面、来回切 tab 都不会重播。

import { useEffect, useMemo } from "react";

import {
	queuedTaskPromptDeliveryQueueTabAnchorKey,
	type SpotlightAnchorOptions,
	spotlightAnchor,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";

export const QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS = 5_000;
export const QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS = "queued-prompt-restart-reminder-active";

const remindedQueueEntryIds = new Set<string>();

// 测试用：模块级记账跨用例会串。
export function resetQueuedTaskPromptDeliveryRestartReminderBookkeepingForTests(): void {
	remindedQueueEntryIds.clear();
}

export function useQueuedTaskPromptDeliveryRestartReminder(input: {
	taskId: string;
	projections: readonly RuntimeQueuedTaskPromptDeliveryProjection[];
	reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: (queueEntryIds: readonly string[]) => Promise<void>;
	spotlight?: (anchorKey: string, options?: SpotlightAnchorOptions) => boolean;
}): void {
	const { taskId, projections, reconfirmQueuedPromptDeliveriesAfterRuntimeRestart } = input;
	const spotlight = input.spotlight ?? spotlightAnchor;
	const unconfirmedQueueEntryIdsKey = useMemo(
		() =>
			projections
				.filter((projection) => projection.awaitsHumanReconfirmationAfterRuntimeRestart)
				.map((projection) => projection.queueEntryId)
				.filter((queueEntryId) => !remindedQueueEntryIds.has(queueEntryId))
				.join("\n"),
		[projections],
	);

	useEffect(() => {
		if (unconfirmedQueueEntryIdsKey === "") {
			return;
		}
		const queueEntryIds = unconfirmedQueueEntryIdsKey.split("\n");
		const remindNow = (): boolean => {
			if (typeof document === "undefined" || document.visibilityState !== "visible") {
				return false;
			}
			const spotlighted = spotlight(queuedTaskPromptDeliveryQueueTabAnchorKey(taskId), {
				durationMs: QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS,
				spotlightClassName: QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS,
				scrollIntoView: false,
			});
			if (!spotlighted) {
				return false;
			}
			for (const queueEntryId of queueEntryIds) {
				remindedQueueEntryIds.add(queueEntryId);
			}
			void reconfirmQueuedPromptDeliveriesAfterRuntimeRestart(queueEntryIds);
			return true;
		};
		if (remindNow()) {
			return;
		}
		// 此刻不可见（后台标签页）：等它真的回到前台再提醒，而不是在没人看的时候把确认悄悄落掉。
		const handleVisibilityChange = () => {
			if (remindNow()) {
				document.removeEventListener("visibilitychange", handleVisibilityChange);
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [taskId, unconfirmedQueueEntryIdsKey, reconfirmQueuedPromptDeliveriesAfterRuntimeRestart, spotlight]);
}
