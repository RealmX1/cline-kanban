const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * 把「自某个 epoch 毫秒时间点到 now 经过的时长」格式化成最紧凑的单字符单位读数，
 * 用于任务卡片头部的微型时长药丸（空间极小，容不下 Intl.RelativeTimeFormat 的「5 minutes ago」）。
 *
 * 返回："now"（<1 分钟）/ "5m" / "3h" / "2d" / "4w" / "1y"。
 * 未来时间戳（now 早于 from，可能因时钟漂移）夹到 0，按 "now" 处理。
 */
export function formatCompactElapsedSince(fromEpochMs: number, nowEpochMs: number): string {
	const elapsedMs = Math.max(0, nowEpochMs - fromEpochMs);
	if (elapsedMs < MINUTE_MS) {
		return "now";
	}
	if (elapsedMs < HOUR_MS) {
		return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
	}
	if (elapsedMs < DAY_MS) {
		return `${Math.floor(elapsedMs / HOUR_MS)}h`;
	}
	if (elapsedMs < WEEK_MS) {
		return `${Math.floor(elapsedMs / DAY_MS)}d`;
	}
	if (elapsedMs < YEAR_MS) {
		return `${Math.floor(elapsedMs / WEEK_MS)}w`;
	}
	return `${Math.floor(elapsedMs / YEAR_MS)}y`;
}
