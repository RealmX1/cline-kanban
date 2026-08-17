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
//      边沿判定带**迟滞**：单个正常窗口不算恢复，否则长期退化中的偶发安静采样会让状态反复横跳，
//      每跳一次产出两行，反而比逐窗口打印更吵（见下方迟滞常量处的实测数据）。
//   2) 机器读的 JSONL journal：**每个窗口一条，无论是否越阈**，一条不丢。降噪只降 stderr，
//      不降数据；事后要算分位、画时间线、对齐别的诊断通道，都从 journal 取。
const EVENT_LOOP_DELAY_SAMPLE_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_REPORT_INTERVAL_MS = 30_000;
const EVENT_LOOP_DELAY_P99_WARN_THRESHOLD_MS = 50;
const EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS = 250;
const EVENT_LOOP_DELAY_DEGRADED_PERIODIC_SUMMARY_INTERVAL_MS = 600_000;

// 迟滞：判「已恢复」需要**连续**这么多个正常窗口（中途出现越阈窗口即清零重数），单个不算数。
//
// 没有迟滞时边沿上报会**自己制造噪声**。把一段 8 小时真实运行的 1000 个窗口重放进本状态机：
// 越阈窗口 890 个（89%），而夹在中间的「正常段」绝大多数只有 1 个窗口——即偶发的一次安静采样，
// 并非真的恢复。每出现一次这种孤立安静窗口就产出 recovered + degraded-entered 两行，于是
// 单窗口即判恢复要打 228 行（其中 106 进入 + 105 恢复，几乎全是抖动），改成连续 2 个窗口后
// 降到 57 行（6 进入 + 5 恢复 + 46 周期摘要），周期摘要反而成了主要来源。
//
// 取 2 而不是更大：3 及以上会把这整段运行压成**单一**劣化区间，行数几乎不再下降（周期摘要占大头），
// 却丢掉了「劣化分几段、各段何时起止」这个排障时真正要看的结构。
const EVENT_LOOP_DELAY_RECOVERY_REQUIRES_CONSECUTIVE_NORMAL_WINDOW_COUNT = 2;

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
	// 最后一个**越阈**窗口的时刻。恢复摘要里的持续时长按它算，好让迟滞期间那些正常窗口
	// 不被算进劣化时长。
	lastDegradedWindowAtEpochMs: number | null;
	// 迟滞计数：劣化态下已连续观察到的正常窗口数，遇到越阈窗口即清零。
	consecutiveNormalWindowCountWhileDegraded: number;
	// 本劣化区间内被迟滞吸收掉的孤立正常窗口数（即那些没能凑够连续数、随后又被越阈窗口打断的）。
	// 它随数据变化，读出来就是「这段劣化抖得多厉害」——而「确认恢复用了几个窗口」恒等于阈值常量，
	// 写进日志只是复述策略，给不出任何现场信息。
	absorbedIsolatedNormalWindowCountDuringDegradation: number;
}

export function createEventLoopDelayDegradationReportingState(): EventLoopDelayDegradationReportingState {
	return {
		degradedSinceEpochMs: null,
		degradedWindowCount: 0,
		peakP99MsDuringDegradation: 0,
		peakMaxMsDuringDegradation: 0,
		lastPeriodicSummaryEmittedAtEpochMs: null,
		lastDegradedWindowAtEpochMs: null,
		consecutiveNormalWindowCountWhileDegraded: 0,
		absorbedIsolatedNormalWindowCountDuringDegradation: 0,
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
		// 迟滞：正常窗口数没攒够就只记账不上报——劣化区间尚未结束，只是这一窗口碰巧安静。
		const consecutiveNormalWindowCount = state.consecutiveNormalWindowCountWhileDegraded + 1;
		if (consecutiveNormalWindowCount < EVENT_LOOP_DELAY_RECOVERY_REQUIRES_CONSECUTIVE_NORMAL_WINDOW_COUNT) {
			return {
				nextState: { ...state, consecutiveNormalWindowCountWhileDegraded: consecutiveNormalWindowCount },
				stderrWarningLine: null,
			};
		}
		// 劣化时长截到最后一个越阈窗口，确认恢复期间的正常窗口不计入。采样时刻是窗口的**结束**时刻，
		// 故 degradedSinceEpochMs 只标出第一个越阈窗口的终点，那个窗口自身覆盖的一个采样周期还在
		// 区间之前——补的就是它，不是最后那个窗口的。
		const lastDegradedWindowAtEpochMs = state.lastDegradedWindowAtEpochMs ?? state.degradedSinceEpochMs;
		const degradationDurationMs =
			lastDegradedWindowAtEpochMs - state.degradedSinceEpochMs + EVENT_LOOP_DELAY_REPORT_INTERVAL_MS;
		return {
			nextState: createEventLoopDelayDegradationReportingState(),
			stderrWarningLine: `[tui-freeze] event-loop-delay recovered durationMs=${degradationDurationMs} degradedWindows=${state.degradedWindowCount} peakP99=${state.peakP99MsDuringDegradation.toFixed(1)}ms peakMax=${state.peakMaxMsDuringDegradation.toFixed(1)}ms absorbedIsolatedNormalWindows=${state.absorbedIsolatedNormalWindowCountDuringDegradation}`,
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
				lastDegradedWindowAtEpochMs: sample.sampledAtEpochMs,
				consecutiveNormalWindowCountWhileDegraded: 0,
				absorbedIsolatedNormalWindowCountDuringDegradation: 0,
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
		lastDegradedWindowAtEpochMs: sample.sampledAtEpochMs,
		// 又见越阈窗口，先前攒的迟滞计数作废——那些正常窗口就此成为被吸收掉的孤立窗口。
		consecutiveNormalWindowCountWhileDegraded: 0,
		absorbedIsolatedNormalWindowCountDuringDegradation:
			state.absorbedIsolatedNormalWindowCountDuringDegradation + state.consecutiveNormalWindowCountWhileDegraded,
	};
	const lastSummaryAtEpochMs = state.lastPeriodicSummaryEmittedAtEpochMs ?? state.degradedSinceEpochMs;
	if (sample.sampledAtEpochMs - lastSummaryAtEpochMs < EVENT_LOOP_DELAY_DEGRADED_PERIODIC_SUMMARY_INTERVAL_MS) {
		return { nextState, stderrWarningLine: null };
	}
	nextState.lastPeriodicSummaryEmittedAtEpochMs = sample.sampledAtEpochMs;
	// 与 recovered 同一口径（同样补上第一个越阈窗口自身覆盖的采样周期）。两条线走的是同一个 stderr
	// 通道，读者会直接把它们相减；口径不一致会凭空造出 30 秒的差，且 durationMs 与 degradedWindows
	// 对不上账。
	const degradationDurationMs =
		sample.sampledAtEpochMs - state.degradedSinceEpochMs + EVENT_LOOP_DELAY_REPORT_INTERVAL_MS;
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
