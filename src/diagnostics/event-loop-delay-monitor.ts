import { monitorEventLoopDelay } from "node:perf_hooks";

import { logTuiFreezeWarning } from "./tui-freeze-logger";

// 事件循环延迟探针:TUI 键盘输入卡顿的服务端主因之一是单事件循环被每-chunk 输出分析 /
// 快照序列化等同步重活占据(整体 CPU 仍然很低,多核机器上单核忙碌不显眼)。这里周期采样
// perf_hooks 的事件循环延迟直方图,仅在越过阈值时打 [tui-freeze] 日志——既作为修复前后的
// 对照基线,也作为长期回归绊线。阈值门控保证稳态零输出、不刷屏。
const EVENT_LOOP_DELAY_SAMPLE_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_REPORT_INTERVAL_MS = 30_000;
const EVENT_LOOP_DELAY_P99_WARN_THRESHOLD_MS = 50;
const EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS = 250;

const NANOSECONDS_PER_MILLISECOND = 1e6;

export function startEventLoopDelayMonitor(): () => void {
	const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_SAMPLE_RESOLUTION_MS });
	histogram.enable();
	const reportTimer = setInterval(() => {
		const p50Ms = histogram.percentile(50) / NANOSECONDS_PER_MILLISECOND;
		const p99Ms = histogram.percentile(99) / NANOSECONDS_PER_MILLISECOND;
		const maxMs = histogram.max / NANOSECONDS_PER_MILLISECOND;
		if (p99Ms >= EVENT_LOOP_DELAY_P99_WARN_THRESHOLD_MS || maxMs >= EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS) {
			logTuiFreezeWarning(
				`[tui-freeze] event-loop-delay p50=${p50Ms.toFixed(1)}ms p99=${p99Ms.toFixed(1)}ms max=${maxMs.toFixed(1)}ms windowMs=${EVENT_LOOP_DELAY_REPORT_INTERVAL_MS}`,
			);
		}
		histogram.reset();
	}, EVENT_LOOP_DELAY_REPORT_INTERVAL_MS);
	// 诊断探针不得阻止进程退出。
	reportTimer.unref();
	return () => {
		clearInterval(reportTimer);
		histogram.disable();
	};
}
