import { describe, expect, it } from "vitest";

import {
	createEventLoopDelayDegradationReportingState,
	deriveEventLoopDelayDegradationReport,
	type EventLoopDelayDegradationReportingState,
	type EventLoopDelayWindowSample,
} from "../../../src/diagnostics/event-loop-delay-monitor";

const REPORT_INTERVAL_MS = 30_000;
const BASE_EPOCH_MS = 1_786_868_000_000;

function makeWindowSample(
	windowIndex: number,
	overrides: Partial<Omit<EventLoopDelayWindowSample, "sampledAtEpochMs">> = {},
): EventLoopDelayWindowSample {
	return {
		p50Ms: 1.2,
		p99Ms: 3.4,
		maxMs: 9.9,
		sampledAtEpochMs: BASE_EPOCH_MS + windowIndex * REPORT_INTERVAL_MS,
		...overrides,
	};
}

function feedWindowSamples(
	initialState: EventLoopDelayDegradationReportingState,
	samples: EventLoopDelayWindowSample[],
): { finalState: EventLoopDelayDegradationReportingState; emittedLines: string[] } {
	let state = initialState;
	const emittedLines: string[] = [];
	for (const sample of samples) {
		const { nextState, stderrWarningLine } = deriveEventLoopDelayDegradationReport(state, sample);
		state = nextState;
		if (stderrWarningLine !== null) {
			emittedLines.push(stderrWarningLine);
		}
	}
	return { finalState: state, emittedLines };
}

describe("event loop delay degradation reporting", () => {
	it("stays silent while the event loop is healthy", () => {
		const { emittedLines } = feedWindowSamples(
			createEventLoopDelayDegradationReportingState(),
			Array.from({ length: 40 }, (_unused, windowIndex) => makeWindowSample(windowIndex)),
		);

		expect(emittedLines).toEqual([]);
	});

	it("emits one line on the way into degradation instead of one per window", () => {
		// 20 个连续越阈窗口 = 10 分钟，正好是旧实现刷 20 行、新实现只应打 1 行进入边沿的场景。
		const { emittedLines } = feedWindowSamples(
			createEventLoopDelayDegradationReportingState(),
			Array.from({ length: 20 }, (_unused, windowIndex) => makeWindowSample(windowIndex, { p99Ms: 91.4 })),
		);

		expect(emittedLines).toHaveLength(1);
		expect(emittedLines[0]).toContain("degraded-entered");
		expect(emittedLines[0]).toContain("p99=91.4ms");
	});

	it("emits a periodic summary while degradation persists past the summary interval", () => {
		// 第 21 个窗口起跨过 10 分钟摘要间隔；60 个窗口 = 30 分钟，应得 1 条进入 + 2 条周期摘要。
		const { emittedLines } = feedWindowSamples(
			createEventLoopDelayDegradationReportingState(),
			Array.from({ length: 60 }, (_unused, windowIndex) =>
				makeWindowSample(windowIndex, { p99Ms: 60 + windowIndex, maxMs: 300 + windowIndex }),
			),
		);

		expect(emittedLines).toHaveLength(3);
		expect(emittedLines[0]).toContain("degraded-entered");
		expect(emittedLines[1]).toContain("still-degraded");
		expect(emittedLines[1]).toMatch(/\bdegradedWindows=21\b/);
		// 与 recovered 同一口径：21 个越阈窗口 × 30 秒 = 630000，两条线相减才有意义。
		expect(emittedLines[1]).toMatch(/\bdurationMs=630000\b/);
		expect(emittedLines[2]).toContain("still-degraded");
		expect(emittedLines[2]).toMatch(/\bdegradedWindows=41\b/);
		expect(emittedLines[2]).toMatch(/\bdurationMs=1230000\b/);
	});

	it("keeps the periodic summary clock across a hysteresis-absorbed quiet window", () => {
		// 迟滞分支靠 `{...state}` 隐式保住摘要时钟。若它被写丢，lastSummaryAt 会退回 degradedSince，
		// 紧接的越阈窗口立刻满足 600s 条件而多打一条摘要——按线上数据（约 100 个孤立正常窗口），
		// 这等于把本次改动省下的噪声原样还回去。
		const samples = [
			// 0..20：跨过 600 秒摘要间隔，在索引 20 打出第一条摘要。
			...Array.from({ length: 21 }, (_unused, windowIndex) => makeWindowSample(windowIndex, { p99Ms: 91.4 })),
			// 21：孤立正常窗口，被迟滞吸收。
			makeWindowSample(21),
			// 22..25：区间继续；此时距上一条摘要还不够 600 秒，不得再打。
			...Array.from({ length: 4 }, (_unused, offset) => makeWindowSample(22 + offset, { p99Ms: 91.4 })),
		];

		const { emittedLines, finalState } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), samples);

		expect(emittedLines.filter((line) => line.includes("still-degraded"))).toHaveLength(1);
		expect(finalState.lastPeriodicSummaryEmittedAtEpochMs).toBe(BASE_EPOCH_MS + 20 * REPORT_INTERVAL_MS);
		expect(finalState.absorbedIsolatedNormalWindowCountDuringDegradation).toBe(1);
	});

	it("reports duration, window count and peaks when the event loop recovers", () => {
		const degradedSamples = Array.from({ length: 4 }, (_unused, windowIndex) =>
			makeWindowSample(windowIndex, { p99Ms: 55 + windowIndex * 10, maxMs: 260 + windowIndex * 10 }),
		);
		const { emittedLines } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), [
			...degradedSamples,
			makeWindowSample(4),
			makeWindowSample(5),
		]);

		expect(emittedLines).toHaveLength(2);
		const recoveredLine = emittedLines[1];
		expect(recoveredLine).toContain("recovered");
		// 时长按 4 个越阈窗口算，确认恢复用掉的那 2 个正常窗口不得计入。
		// 用词边界匹配而非子串：`toContain("durationMs=120000")` 对 `durationMs=1200000` 同样成立。
		expect(recoveredLine).toMatch(/\bdurationMs=120000\b/);
		expect(recoveredLine).toMatch(/\bdegradedWindows=4\b/);
		expect(recoveredLine).toContain("peakP99=85.0ms");
		expect(recoveredLine).toContain("peakMax=290.0ms");
		// 这一段一路越阈到底，没有被吸收掉的孤立正常窗口。
		expect(recoveredLine).toMatch(/\babsorbedIsolatedNormalWindows=0\b/);
	});

	it("reports how many isolated quiet windows the hysteresis absorbed, so flapping stays visible", () => {
		// 这个数随数据变化，读出来就是「这段劣化抖得多厉害」；而「确认恢复用了几个窗口」恒等于阈值
		// 常量，写进日志只是复述策略，给不出现场信息。
		const { emittedLines } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), [
			makeWindowSample(0, { maxMs: 400 }),
			makeWindowSample(1),
			makeWindowSample(2, { maxMs: 400 }),
			makeWindowSample(3),
			makeWindowSample(4, { maxMs: 400 }),
			makeWindowSample(5),
			makeWindowSample(6),
		]);

		const recoveredLine = emittedLines[1];
		expect(recoveredLine).toContain("recovered");
		expect(recoveredLine).toMatch(/\babsorbedIsolatedNormalWindows=2\b/);
		// 区间内被吸收的正常窗口计入时长（索引 0→4 共 5 个窗口），尾部确认期的 2 个不计入。
		expect(recoveredLine).toMatch(/\bdurationMs=150000\b/);
		expect(recoveredLine).toMatch(/\bdegradedWindows=3\b/);
	});

	it("does not end a degraded episode on a single quiet window", () => {
		// 长期退化里偶发一个安静采样是常态；若据此判恢复，每抖一次就产出 recovered + entered 两行。
		// 真实数据重放：单窗口即判恢复要打 228 行，连续 2 个窗口才判则降到 57 行。
		const { emittedLines, finalState } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), [
			makeWindowSample(0, { maxMs: 400 }),
			makeWindowSample(1),
			makeWindowSample(2, { maxMs: 400 }),
			makeWindowSample(3),
			makeWindowSample(4, { maxMs: 400 }),
		]);

		expect(emittedLines).toHaveLength(1);
		expect(emittedLines[0]).toContain("degraded-entered");
		// 整段仍算同一个劣化区间，起点不变。
		expect(finalState.degradedSinceEpochMs).toBe(BASE_EPOCH_MS);
		expect(finalState.degradedWindowCount).toBe(3);
		expect(finalState.consecutiveNormalWindowCountWhileDegraded).toBe(0);
	});

	it("treats a fresh degradation after a confirmed recovery as a new edge", () => {
		const { emittedLines, finalState } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), [
			makeWindowSample(0, { maxMs: 400 }),
			makeWindowSample(1),
			makeWindowSample(2),
			makeWindowSample(3, { maxMs: 400 }),
		]);

		expect(emittedLines.map((line) => line.split(" ")[2])).toEqual([
			"degraded-entered",
			"recovered",
			"degraded-entered",
		]);
		expect(finalState.degradedSinceEpochMs).toBe(BASE_EPOCH_MS + 3 * REPORT_INTERVAL_MS);
	});
});
