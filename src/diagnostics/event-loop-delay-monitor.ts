import { monitorEventLoopDelay } from "node:perf_hooks";

import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";
import { logTuiFreezeWarning } from "./tui-freeze-logger";

// 事件循环延迟探针:TUI 键盘输入卡顿的服务端主因之一是单事件循环被每-chunk 输出分析 /
// 快照序列化等同步重活占据(整体 CPU 仍然很低,多核机器上单核忙碌不显眼)。这里周期采样
// perf_hooks 的事件循环延迟直方图,既作为修复前后的对照基线,也作为长期回归绊线。
//
// 上报分两层，因为「稳态零输出」这个原始设计在**持续退化**时会失效——一旦事件循环长期越阈，
// 原来的逐窗口无节流打印会以每 30 秒一行的速度刷屏：实测一次长时间退化里，2000 行的终端
// 回滚缓冲有 904 行是本探针，把服务启动日志和别的诊断全挤没了，反而让排障更难。
//   1) 人读的 stderr：只在**边沿**（进入退化 / 恢复正常）与**持续退化期的周期摘要**时输出，
//      信息量比原来更大——原来只有一串孤立数值，看不出「何时开始、持续多久、峰值多高」。
//   2) 机器读的 JSONL journal：**每个窗口一条，无论是否越阈**，一条不丢。降噪只降 stderr，
//      不降数据；事后要算分位、画时间线、对齐别的诊断通道，都从 journal 取。
const EVENT_LOOP_DELAY_SAMPLE_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_REPORT_INTERVAL_MS = 30_000;
const EVENT_LOOP_DELAY_P99_WARN_THRESHOLD_MS = 50;
const EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS = 250;
const EVENT_LOOP_DELAY_DEGRADED_PERIODIC_SUMMARY_INTERVAL_MS = 600_000;

const NANOSECONDS_PER_MILLISECOND = 1e6;

export interface EventLoopDelayWindowSample {
	p50Ms: number;
	p99Ms: number;
	maxMs: number;
	sampledAtEpochMs: number;
}

// degradedSinceEpochMs 为 null 即当前处于正常态。
export interface EventLoopDelayDegradationReportingState {
	degradedSinceEpochMs: number | null;
	degradedWindowCount: number;
	peakP99MsDuringDegradation: number;
	peakMaxMsDuringDegradation: number;
	lastPeriodicSummaryEmittedAtEpochMs: number | null;
}

export function createEventLoopDelayDegradationReportingState(): EventLoopDelayDegradationReportingState {
	return {
		degradedSinceEpochMs: null,
		degradedWindowCount: 0,
		peakP99MsDuringDegradation: 0,
		peakMaxMsDuringDegradation: 0,
		lastPeriodicSummaryEmittedAtEpochMs: null,
	};
}

export function isEventLoopDelayWindowSampleOverWarnThreshold(sample: EventLoopDelayWindowSample): boolean {
	return (
		sample.p99Ms >= EVENT_LOOP_DELAY_P99_WARN_THRESHOLD_MS || sample.maxMs >= EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS
	);
}

function roundToOneDecimal(value: number): number {
	return Number(value.toFixed(1));
}

// 输入一个窗口采样与当前上报状态，输出下一个状态与「本窗口该不该打 stderr、打什么」。
// 抽成纯函数是为了能不依赖计时器地测状态机本身。
export function deriveEventLoopDelayDegradationReport(
	state: EventLoopDelayDegradationReportingState,
	sample: EventLoopDelayWindowSample,
): { nextState: EventLoopDelayDegradationReportingState; stderrWarningLine: string | null } {
	const sampleValues = `p50=${sample.p50Ms.toFixed(1)}ms p99=${sample.p99Ms.toFixed(1)}ms max=${sample.maxMs.toFixed(1)}ms`;

	if (!isEventLoopDelayWindowSampleOverWarnThreshold(sample)) {
		if (state.degradedSinceEpochMs === null) {
			return { nextState: state, stderrWarningLine: null };
		}
		const degradationDurationMs = sample.sampledAtEpochMs - state.degradedSinceEpochMs;
		return {
			nextState: createEventLoopDelayDegradationReportingState(),
			stderrWarningLine: `[tui-freeze] event-loop-delay recovered durationMs=${degradationDurationMs} degradedWindows=${state.degradedWindowCount} peakP99=${state.peakP99MsDuringDegradation.toFixed(1)}ms peakMax=${state.peakMaxMsDuringDegradation.toFixed(1)}ms`,
		};
	}

	if (state.degradedSinceEpochMs === null) {
		return {
			nextState: {
				degradedSinceEpochMs: sample.sampledAtEpochMs,
				degradedWindowCount: 1,
				peakP99MsDuringDegradation: sample.p99Ms,
				peakMaxMsDuringDegradation: sample.maxMs,
				lastPeriodicSummaryEmittedAtEpochMs: sample.sampledAtEpochMs,
			},
			stderrWarningLine: `[tui-freeze] event-loop-delay degraded-entered ${sampleValues} windowMs=${EVENT_LOOP_DELAY_REPORT_INTERVAL_MS}`,
		};
	}

	const nextState: EventLoopDelayDegradationReportingState = {
		degradedSinceEpochMs: state.degradedSinceEpochMs,
		degradedWindowCount: state.degradedWindowCount + 1,
		peakP99MsDuringDegradation: Math.max(state.peakP99MsDuringDegradation, sample.p99Ms),
		peakMaxMsDuringDegradation: Math.max(state.peakMaxMsDuringDegradation, sample.maxMs),
		lastPeriodicSummaryEmittedAtEpochMs: state.lastPeriodicSummaryEmittedAtEpochMs,
	};
	const lastSummaryAtEpochMs = state.lastPeriodicSummaryEmittedAtEpochMs ?? state.degradedSinceEpochMs;
	if (sample.sampledAtEpochMs - lastSummaryAtEpochMs < EVENT_LOOP_DELAY_DEGRADED_PERIODIC_SUMMARY_INTERVAL_MS) {
		return { nextState, stderrWarningLine: null };
	}
	nextState.lastPeriodicSummaryEmittedAtEpochMs = sample.sampledAtEpochMs;
	const degradationDurationMs = sample.sampledAtEpochMs - state.degradedSinceEpochMs;
	return {
		nextState,
		stderrWarningLine: `[tui-freeze] event-loop-delay still-degraded durationMs=${degradationDurationMs} degradedWindows=${nextState.degradedWindowCount} peakP99=${nextState.peakP99MsDuringDegradation.toFixed(1)}ms peakMax=${nextState.peakMaxMsDuringDegradation.toFixed(1)}ms latest ${sampleValues}`,
	};
}

export function startEventLoopDelayMonitor(): () => void {
	const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_SAMPLE_RESOLUTION_MS });
	histogram.enable();
	let reportingState = createEventLoopDelayDegradationReportingState();
	const reportTimer = setInterval(() => {
		const sample: EventLoopDelayWindowSample = {
			p50Ms: histogram.percentile(50) / NANOSECONDS_PER_MILLISECOND,
			p99Ms: histogram.percentile(99) / NANOSECONDS_PER_MILLISECOND,
			maxMs: histogram.max / NANOSECONDS_PER_MILLISECOND,
			sampledAtEpochMs: Date.now(),
		};

		appendDiagnosticEventToRotatingJsonlJournal("event-loop-delay-window-sample", {
			windowMs: EVENT_LOOP_DELAY_REPORT_INTERVAL_MS,
			p50Ms: roundToOneDecimal(sample.p50Ms),
			p99Ms: roundToOneDecimal(sample.p99Ms),
			maxMs: roundToOneDecimal(sample.maxMs),
			overWarnThreshold: isEventLoopDelayWindowSampleOverWarnThreshold(sample),
		});

		const { nextState, stderrWarningLine } = deriveEventLoopDelayDegradationReport(reportingState, sample);
		reportingState = nextState;
		if (stderrWarningLine !== null) {
			logTuiFreezeWarning(stderrWarningLine);
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
