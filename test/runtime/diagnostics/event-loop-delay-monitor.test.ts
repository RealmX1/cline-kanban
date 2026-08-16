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
		expect(emittedLines[1]).toContain("degradedWindows=21");
		expect(emittedLines[2]).toContain("still-degraded");
		expect(emittedLines[2]).toContain("durationMs=1200000");
	});

	it("reports duration, window count and peaks when the event loop recovers", () => {
		const degradedSamples = Array.from({ length: 4 }, (_unused, windowIndex) =>
			makeWindowSample(windowIndex, { p99Ms: 55 + windowIndex * 10, maxMs: 260 + windowIndex * 10 }),
		);
		const { emittedLines } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), [
			...degradedSamples,
			makeWindowSample(4),
		]);

		expect(emittedLines).toHaveLength(2);
		const recoveredLine = emittedLines[1];
		expect(recoveredLine).toContain("recovered");
		expect(recoveredLine).toContain("durationMs=120000");
		expect(recoveredLine).toContain("degradedWindows=4");
		expect(recoveredLine).toContain("peakP99=85.0ms");
		expect(recoveredLine).toContain("peakMax=290.0ms");
	});

	it("treats a fresh degradation after recovery as a new edge", () => {
		const { emittedLines, finalState } = feedWindowSamples(createEventLoopDelayDegradationReportingState(), [
			makeWindowSample(0, { maxMs: 400 }),
			makeWindowSample(1),
			makeWindowSample(2, { maxMs: 400 }),
		]);

		expect(emittedLines.map((line) => line.split(" ")[2])).toEqual([
			"degraded-entered",
			"recovered",
			"degraded-entered",
		]);
		expect(finalState.degradedSinceEpochMs).toBe(BASE_EPOCH_MS + 2 * REPORT_INTERVAL_MS);
	});
});
