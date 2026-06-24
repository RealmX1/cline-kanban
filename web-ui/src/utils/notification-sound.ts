// 通知提示音播放子系统。仅在浏览器（web-ui）侧使用，经 howler.js 播放打包的 WAV 资源。
//
// 三档（tier）镜像 board-card-session-activity.ts 的 SESSION_ACTIVITY_COLOR 语义分组——不看屏也能凭
// 音色听出「完成 vs 需要你 vs 出错」：
//   - error              → "error"     （红：运行出错）
//   - needs_input / question / plan_review / permission → "attention"（金：阻塞等你）
//   - review / interrupted / null / undefined           → "complete" （绿：完成待审，默认档）
// 这与 use-review-ready-notifications.ts 的标题措辞表互不耦合：措辞细分到具体 kind，声音只分三档。
//
// 自动播放解锁：Howler 默认 autoUnlock 会在首次 touch/click/keydown 解锁 WebAudio；用户启动任务时早已
// 与页面交互过，故首条通知触发时音频已解锁。已解锁的音频在「隐藏/失焦」标签页可正常播放（音频不像
// requestAnimationFrame 那样被后台标签页节流），而通知恰恰只在标签页不可见/失焦时才发——契合。

import { Howl } from "howler";
import type { RuntimeTaskSessionUserTurnKind } from "@/runtime/types";

export type NotificationSoundTier = "complete" | "attention" | "error";

const NOTIFICATION_SOUND_TIER_BY_USER_TURN_KIND: Partial<
	Record<NonNullable<RuntimeTaskSessionUserTurnKind>, NotificationSoundTier>
> = {
	error: "error",
	needs_input: "attention",
	question: "attention",
	plan_review: "attention",
	permission: "attention",
};

export function resolveNotificationSoundTier(
	userTurnKind: RuntimeTaskSessionUserTurnKind | undefined,
): NotificationSoundTier {
	return (userTurnKind ? NOTIFICATION_SOUND_TIER_BY_USER_TURN_KIND[userTurnKind] : undefined) ?? "complete";
}

const NOTIFICATION_SOUND_SOURCE_BY_TIER: Record<NotificationSoundTier, string> = {
	complete: "/assets/sounds/notify-complete.wav",
	attention: "/assets/sounds/notify-attention.wav",
	error: "/assets/sounds/notify-error.wav",
};

const NOTIFICATION_SOUND_VOLUME = 0.5;

// 懒单例：每档一个 Howl，首次播放时构造（Howler 在构造期挂上 autoUnlock 手势监听）。
const howlByTier = new Map<NotificationSoundTier, Howl>();

function getNotificationHowl(tier: NotificationSoundTier): Howl {
	const existing = howlByTier.get(tier);
	if (existing) {
		return existing;
	}
	const howl = new Howl({
		src: [NOTIFICATION_SOUND_SOURCE_BY_TIER[tier]],
		volume: NOTIFICATION_SOUND_VOLUME,
		preload: true,
	});
	howlByTier.set(tier, howl);
	return howl;
}

export function playReviewReadyNotificationSound(userTurnKind: RuntimeTaskSessionUserTurnKind | undefined): void {
	try {
		const howl = getNotificationHowl(resolveNotificationSoundTier(userTurnKind));
		// 防叠音：同档若仍在播放，先停再播，确保每条通知是一次干净的短提示音。
		howl.stop();
		howl.play();
	} catch {
		// 音频不可用（无 WebAudio / 资源缺失 / 未解锁）一律静默——提示音是锦上添花，绝不阻断通知主流程。
	}
}
