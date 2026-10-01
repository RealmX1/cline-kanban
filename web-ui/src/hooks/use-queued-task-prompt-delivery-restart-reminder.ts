// kanban 重启后聚焦任务时的「重启前排的，确认一下还要不要」提醒。
//
// 用户原话：重启之后聚焦一个任务时，队列应当还在；此时让它柔和地闪 5 秒边框，提醒我确认这些排队的 prompt
// 还需要；然后在下一次 stop hook 注入。所以「人看见了」就是闪这一下——**不额外要一次点击**：
//   - 命中条件：详情视图已挂载（本 hook 只在详情视图里用）∧ 页面此刻可见 ∧ Queue 页签**真的**呈现在用户眼前
//     （有面积、在视口里、没被藏起来、没被模态层盖住；窄屏横向溢出时先就近滚回来）∧ 该任务有待确认条目；
//   - 命中即播 5 秒高亮，**同时**发确认 mutation。两者并发、不等动画结束——否则开了「减少动效」的用户
//     永远确认不了（动画被关掉了，但静态 ring 与计时器仍在，见 globals.css）；
//   - 同时给屏幕阅读器一句 aria-live 播报：纯 CSS 高亮对看不见它的人不构成「提醒」；
//   - 没能呈现（后台标签页 / 被盖住 / 锚点不在）就**不确认**，每 2 秒与每次回到前台时再试；
//   - 只在服务端确认落盘后才算「提醒过」。确认失败时隔一段时间放回可重试状态——否则一次断连就会让条目永远
//     停在「待确认」、却再也不提醒。
//
// 确认是持久的（服务端落 humanReconfirmedAfterRuntimeRestartAtEpochMs），所以刷新页面、来回切 tab 都不会重播。

import { useEffect, useMemo, useRef, useState } from "react";

import {
	queuedTaskPromptDeliveryQueueTabAnchorKey,
	type SpotlightAnchorOptions,
	spotlightAnchor,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";

export const QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS = 5_000;
export const QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS = "queued-prompt-restart-reminder-active";
// 没能呈现时多久再试一次。
export const QUEUED_PROMPT_RESTART_REMINDER_PRESENTATION_RETRY_INTERVAL_MS = 2_000;
// 确认请求失败后多久放回可重试。不立刻重试：服务端连着失败时会变成每秒闪一次 + 每秒一个请求。
export const QUEUED_PROMPT_RESTART_REMINDER_RECONFIRM_FAILURE_RETRY_BACKOFF_MS = 10_000;

// 已经提醒过（确认在途或已成功）的条目。模块级：详情视图卸载重挂、切换会话都不该让同一条重播。
const remindedQueueEntryIds = new Set<string>();

// 测试用：模块级记账跨用例会串。
export function resetQueuedTaskPromptDeliveryRestartReminderBookkeepingForTests(): void {
	remindedQueueEntryIds.clear();
}

export function describeQueuedPromptRestartReminderAnnouncement(queueEntryCount: number): string {
	return `${queueEntryCount} queued prompt${queueEntryCount === 1 ? "" : "s"} from before Kanban restarted ${
		queueEntryCount === 1 ? "is" : "are"
	} still waiting. ${queueEntryCount === 1 ? "It" : "They"} will be sent after the agent's next turn — cancel in the Queue tab if no longer needed.`;
}

export function useQueuedTaskPromptDeliveryRestartReminder(input: {
	taskId: string;
	projections: readonly RuntimeQueuedTaskPromptDeliveryProjection[];
	reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: (queueEntryIds: readonly string[]) => Promise<boolean>;
	spotlight?: (anchorKey: string, options?: SpotlightAnchorOptions) => boolean;
}): { restartReminderAnnouncement: string | null } {
	const { taskId, projections, reconfirmQueuedPromptDeliveriesAfterRuntimeRestart } = input;
	const spotlight = input.spotlight ?? spotlightAnchor;
	// 确认失败、条目被放回可重试时递增，让下面的 useMemo 重新算一遍待提醒集合。
	const [reminderRetryGeneration, setReminderRetryGeneration] = useState(0);
	const [restartReminderAnnouncement, setRestartReminderAnnouncement] = useState<string | null>(null);
	const isMountedRef = useRef(true);
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const unconfirmedQueueEntryIdsKey = useMemo(
		() =>
			// reminderRetryGeneration 只作重算触发：放回可重试之后集合变了（模块级 Set），但 projections 没变。
			reminderRetryGeneration >= 0
				? projections
						.filter((projection) => projection.awaitsHumanReconfirmationAfterRuntimeRestart)
						.map((projection) => projection.queueEntryId)
						.filter((queueEntryId) => !remindedQueueEntryIds.has(queueEntryId))
						.join("\n")
				: "",
		[projections, reminderRetryGeneration],
	);

	useEffect(() => {
		if (unconfirmedQueueEntryIdsKey === "") {
			return;
		}
		const queueEntryIds = unconfirmedQueueEntryIdsKey.split("\n");
		let cancelled = false;
		// 本轮已经提醒过：重试定时器与前台监听谁先成功都算数，另一个不得再放第二次电。
		let remindedInThisRound = false;
		const remindNow = (): boolean => {
			if (cancelled || remindedInThisRound) {
				return true;
			}
			if (typeof document === "undefined" || document.visibilityState !== "visible") {
				return false;
			}
			const presented = spotlight(queuedTaskPromptDeliveryQueueTabAnchorKey(taskId), {
				durationMs: QUEUED_PROMPT_RESTART_REMINDER_DURATION_MS,
				spotlightClassName: QUEUED_PROMPT_RESTART_REMINDER_SPOTLIGHT_CLASS,
				scrollIntoView: "only_if_out_of_view",
				requireVisibleToUser: true,
			});
			if (!presented) {
				return false;
			}
			remindedInThisRound = true;
			for (const queueEntryId of queueEntryIds) {
				remindedQueueEntryIds.add(queueEntryId);
			}
			setRestartReminderAnnouncement(describeQueuedPromptRestartReminderAnnouncement(queueEntryIds.length));
			void reconfirmQueuedPromptDeliveriesAfterRuntimeRestart(queueEntryIds).then((confirmed) => {
				if (confirmed) {
					return;
				}
				window.setTimeout(() => {
					for (const queueEntryId of queueEntryIds) {
						remindedQueueEntryIds.delete(queueEntryId);
					}
					if (isMountedRef.current) {
						setReminderRetryGeneration((generation) => generation + 1);
					}
				}, QUEUED_PROMPT_RESTART_REMINDER_RECONFIRM_FAILURE_RETRY_BACKOFF_MS);
			});
			return true;
		};
		if (remindNow()) {
			return;
		}
		// 此刻没能呈现：回到前台那一刻立即再试，其余情况（被模态层盖住、页签还没挂上）每 2 秒再试。
		const retryTimer = window.setInterval(() => {
			if (remindNow()) {
				window.clearInterval(retryTimer);
			}
		}, QUEUED_PROMPT_RESTART_REMINDER_PRESENTATION_RETRY_INTERVAL_MS);
		const handleVisibilityChange = () => {
			if (remindNow()) {
				window.clearInterval(retryTimer);
				document.removeEventListener("visibilitychange", handleVisibilityChange);
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			cancelled = true;
			window.clearInterval(retryTimer);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
		// reminderRetryGeneration 必须在依赖里：确认失败放回可重试后，待提醒集合的 key 字符串往往与上一轮
		// 一模一样（还是那几条），只靠 key 这个 effect 不会重跑，条目就永远停在「待确认」却再也不提醒。
	}, [
		taskId,
		unconfirmedQueueEntryIdsKey,
		reminderRetryGeneration,
		reconfirmQueuedPromptDeliveriesAfterRuntimeRestart,
		spotlight,
	]);

	return { restartReminderAnnouncement };
}
