import { useCallback, useSyncExternalStore } from "react";

/**
 * 细粒度共享时钟（1s）。
 *
 * 存在理由：「近期活动脉动」需要一个秒级 tick 让卡片在可信活动跨过近期窗口后停止脉动
 * （近期可信活动／quiet 是随时间漂移的展示派生，summary 静默期不再广播）。
 * 原先每张需要脉动的卡各开一个 1s `setInterval`，且**完全不分标签页可见性**——后台标签页照样
 * 每秒把这些卡重渲一遍。这里改成与 use-shared-coarse-clock 同款的进程内单例：一个定时器、
 * 一个 `visibilitychange` 监听，所有订阅者共享同一个时间戳。标签页不可见时定时器停摆，
 * 重新可见时立刻补发一次当前时间。
 *
 * 只适用于秒级读数（近期活动派生）。分钟级读数（时长药丸）请用更省的
 * `useSharedCoarseClockTimestampMs`，别用本时钟让整列卡每秒重渲。
 */
const SHARED_FINE_CLOCK_TICK_INTERVAL_MS = 1_000;

let currentFineTimestampMs = Date.now();
const fineClockSubscribers = new Set<() => void>();
let fineClockIntervalId: ReturnType<typeof setInterval> | null = null;
let isVisibilityListenerAttached = false;

function publishFineTimestamp(nextTimestampMs: number): void {
	if (nextTimestampMs === currentFineTimestampMs) {
		return;
	}
	currentFineTimestampMs = nextTimestampMs;
	for (const notifySubscriber of fineClockSubscribers) {
		notifySubscriber();
	}
}

function isDocumentCurrentlyVisible(): boolean {
	if (typeof document === "undefined") {
		return true;
	}
	return document.visibilityState === "visible";
}

function stopFineClockTicking(): void {
	if (fineClockIntervalId === null) {
		return;
	}
	clearInterval(fineClockIntervalId);
	fineClockIntervalId = null;
}

function syncFineClockTickingToVisibility(): void {
	if (fineClockSubscribers.size === 0 || !isDocumentCurrentlyVisible()) {
		stopFineClockTicking();
		return;
	}
	// 重新可见时补发一次，避免切回来先看到陈旧读数、要等满一个 tick 才更新。
	publishFineTimestamp(Date.now());
	if (fineClockIntervalId !== null) {
		return;
	}
	fineClockIntervalId = setInterval(() => {
		publishFineTimestamp(Date.now());
	}, SHARED_FINE_CLOCK_TICK_INTERVAL_MS);
}

function subscribeToSharedFineClock(onStoreChange: () => void): () => void {
	fineClockSubscribers.add(onStoreChange);
	if (fineClockSubscribers.size === 1) {
		if (typeof document !== "undefined" && !isVisibilityListenerAttached) {
			document.addEventListener("visibilitychange", syncFineClockTickingToVisibility);
			isVisibilityListenerAttached = true;
		}
		syncFineClockTickingToVisibility();
	}
	return () => {
		fineClockSubscribers.delete(onStoreChange);
		if (fineClockSubscribers.size > 0) {
			return;
		}
		stopFineClockTicking();
		if (typeof document !== "undefined" && isVisibilityListenerAttached) {
			document.removeEventListener("visibilitychange", syncFineClockTickingToVisibility);
			isVisibilityListenerAttached = false;
		}
	};
}

function getSharedFineClockSnapshot(): number {
	return currentFineTimestampMs;
}

function subscribeNoop(): () => void {
	return () => {};
}

/**
 * 订阅共享细时钟，返回当前时间戳（毫秒）。
 *
 * `enabled=false` 时不订阅（挂空 subscribe）：computing 脉动只有「agent 回合 + live + 未 parked」
 * 的卡需要，其余卡不该为一个自己用不到的秒级读数每秒重渲。`enabled` 翻转时 `useSyncExternalStore`
 * 会因 subscribe 身份变化自动退订/重订，重订当刻即补发当前时间。
 */
export function useSharedFineClockTimestampMs(enabled: boolean): number {
	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) =>
			enabled ? subscribeToSharedFineClock(onStoreChange) : subscribeNoop(),
		[enabled],
	);
	return useSyncExternalStore(subscribe, getSharedFineClockSnapshot, getSharedFineClockSnapshot);
}
