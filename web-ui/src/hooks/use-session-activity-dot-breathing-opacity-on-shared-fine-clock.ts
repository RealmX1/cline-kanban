import { useSharedFineClockTimestampMs } from "@/hooks/use-shared-fine-clock";

/**
 * 「agent 正在产出」状态点的 1Hz 呼吸：跟着共享细时钟（1 秒一跳）在两档不透明度之间离散切换，**不加 transition**。
 *
 * 为什么不用 Tailwind 的 `animate-pulse`：无限 CSS 动画让浏览器在高刷屏上每帧都提交合成（144Hz 屏即每秒 144 次），
 * 只要看板标签页可见，系统合成器（macOS WindowServer）就一直在忙。2026-10-12 实测：同一看板页关掉动画 60 秒，
 * WindowServer 从约 41% 降到约 8.5% 个核。离散切换每秒只改一次 DOM，合成器也就每秒只合成一次。
 * 共享细时钟在标签页不可见时整体停摆；需要呼吸的卡本来就订阅着它（computing 判定），不额外增加重渲。
 */
// EXPERIMENT_NODE: 呼吸点暗相的不透明度（0.45）；亮相为 1
export const SESSION_ACTIVITY_DOT_BREATHING_DIMMED_PHASE_OPACITY = 0.45;

export function resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(
	sharedFineClockNowMs: number,
): number {
	return Math.floor(sharedFineClockNowMs / 1_000) % 2 === 0 ? 1 : SESSION_ACTIVITY_DOT_BREATHING_DIMMED_PHASE_OPACITY;
}

/**
 * 没有现成细时钟订阅的组件用这个：`isBreathing=false` 时不订阅、返回 undefined（不设 opacity）。
 */
export function useSessionActivityDotBreathingOpacityOnSharedFineClock(isBreathing: boolean): number | undefined {
	const sharedFineClockNowMs = useSharedFineClockTimestampMs(isBreathing);
	return isBreathing
		? resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(sharedFineClockNowMs)
		: undefined;
}
