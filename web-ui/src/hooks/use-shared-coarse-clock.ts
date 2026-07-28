import { useSyncExternalStore } from "react";

/**
 * 粗粒度共享时钟。
 *
 * 存在理由：看板上每张卡都要显示「创建至今 / agent 上次响应至今」，读数粒度是分/时/天。
 * 原先每张卡各开一个 30s `setInterval`，200 张卡 = 200 个常开定时器 + 200 次
 * `setState`，且**完全不分标签页可见性**——后台标签页照样每 30s 把整列卡重渲一遍。
 * 这里改成进程内单例：一个定时器、一个 `visibilitychange` 监听，所有订阅者共享同一个
 * 时间戳。标签页不可见时定时器直接停摆，重新可见时立刻补发一次当前时间，
 * 所以「切回来看到的是陈旧读数」不会发生。
 *
 * 只适用于分钟级读数。需要秒级精度的（例如 computing 脉动的 1s tick）不要用它。
 */
const SHARED_COARSE_CLOCK_TICK_INTERVAL_MS = 30_000;

let currentCoarseTimestampMs = Date.now();
const coarseClockSubscribers = new Set<() => void>();
let coarseClockIntervalId: ReturnType<typeof setInterval> | null = null;
let isVisibilityListenerAttached = false;

function publishCoarseTimestamp(nextTimestampMs: number): void {
	if (nextTimestampMs === currentCoarseTimestampMs) {
		return;
	}
	currentCoarseTimestampMs = nextTimestampMs;
	for (const notifySubscriber of coarseClockSubscribers) {
		notifySubscriber();
	}
}

function isDocumentCurrentlyVisible(): boolean {
	if (typeof document === "undefined") {
		return true;
	}
	return document.visibilityState === "visible";
}

function stopCoarseClockTicking(): void {
	if (coarseClockIntervalId === null) {
		return;
	}
	clearInterval(coarseClockIntervalId);
	coarseClockIntervalId = null;
}

function syncCoarseClockTickingToVisibility(): void {
	if (coarseClockSubscribers.size === 0 || !isDocumentCurrentlyVisible()) {
		stopCoarseClockTicking();
		return;
	}
	// 重新可见时补发一次，避免切回来先看到陈旧读数、要等满一个 tick 才更新。
	publishCoarseTimestamp(Date.now());
	if (coarseClockIntervalId !== null) {
		return;
	}
	coarseClockIntervalId = setInterval(() => {
		publishCoarseTimestamp(Date.now());
	}, SHARED_COARSE_CLOCK_TICK_INTERVAL_MS);
}

function subscribeToSharedCoarseClock(onStoreChange: () => void): () => void {
	coarseClockSubscribers.add(onStoreChange);
	if (coarseClockSubscribers.size === 1) {
		if (typeof document !== "undefined" && !isVisibilityListenerAttached) {
			document.addEventListener("visibilitychange", syncCoarseClockTickingToVisibility);
			isVisibilityListenerAttached = true;
		}
		syncCoarseClockTickingToVisibility();
	}
	return () => {
		coarseClockSubscribers.delete(onStoreChange);
		if (coarseClockSubscribers.size > 0) {
			return;
		}
		stopCoarseClockTicking();
		if (typeof document !== "undefined" && isVisibilityListenerAttached) {
			document.removeEventListener("visibilitychange", syncCoarseClockTickingToVisibility);
			isVisibilityListenerAttached = false;
		}
	};
}

function getSharedCoarseClockSnapshot(): number {
	return currentCoarseTimestampMs;
}

/** 订阅共享粗时钟，返回当前时间戳（毫秒）。 */
export function useSharedCoarseClockTimestampMs(): number {
	return useSyncExternalStore(
		subscribeToSharedCoarseClock,
		getSharedCoarseClockSnapshot,
		getSharedCoarseClockSnapshot,
	);
}
