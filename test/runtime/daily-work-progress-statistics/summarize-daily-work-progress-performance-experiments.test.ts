import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import type { DailyWorkProgressCollectionCostWindow } from "../../../src/diagnostics/daily-work-progress-collection-cost-recorder";
import { createTempDir } from "../../utilities/temp-dir";

const summarizerScriptPath = fileURLToPath(
	new URL("../../../scripts/summarize-daily-work-progress-performance-experiments.mjs", import.meta.url),
);

function createRefreshCost(wallTimeMs: number) {
	return {
		calls: 1,
		failures: 0,
		wallTimeMs,
		synchronousWallTimeMs: 0,
		readOperations: 0,
		readBytes: 0,
		writeOperations: 0,
		writtenBytes: 0,
	};
}

function createCostWindow(
	flushReason: DailyWorkProgressCollectionCostWindow["flushReason"],
	windowDurationMs: number,
	refreshTimeMs?: number,
): DailyWorkProgressCollectionCostWindow {
	return {
		schemaVersion: "daily-work-progress-collection-cost-window/v1",
		collectorInstanceId: "isolated-evidence-collector",
		windowStartedAtEpochMs: 1,
		windowDurationMs,
		flushReason,
		stages: refreshTimeMs === undefined ? {} : { refresh: createRefreshCost(refreshTimeMs) },
		counters: {},
		inFlightOperations: 0,
		inFlightAsynchronousStages: 0,
	};
}

function createExperimentSample(
	comparison: "recorder" | "optimizations",
	variant: "A" | "B",
	steadyDurationMs: number,
) {
	const costRecordingDisabled = comparison === "recorder" && variant === "A";
	return {
		options: {
			"cost-recording": costRecordingDisabled ? "disabled" : "enabled",
			"steady-duration-ms": String(steadyDurationMs),
		},
		corpusManifestSha256: "same-isolated-corpus",
		factsHash: "same-isolated-facts",
		history: {
			wallTimeMs: variant === "A" ? 1_000 : 1_010,
			cpuMicroseconds: { user: 1_000, system: 0 },
			facts: 1,
			factsPerSecond: 1,
		},
		steady: {
			durationMs: steadyDurationMs,
			cpuMicroseconds: { user: 1, system: 0 },
			eventLoopP95Ms: 1,
			eventLoopP99Ms: 1,
			readOnlyRequestP99Ms: 1,
		},
		historyWindowCount: costRecordingDisabled ? 0 : 1,
		windows: costRecordingDisabled
			? []
			: [
					createCostWindow("explicit", 1_000, variant === "A" ? 100 : 20),
					createCostWindow("closed", steadyDurationMs, steadyDurationMs >= 60_000 ? 1 : undefined),
				],
	};
}

function createEvidenceFixture(steadyDurationMs = 60_000) {
	const temporaryDirectory = createTempDir("daily-progress-performance-evidence-");
	onTestFinished(() => temporaryDirectory.cleanup());
	const rootDirectory = temporaryDirectory.path;
	const recorderDirectory = join(rootDirectory, "recorder-calibration");
	const comparisonDirectory = join(rootDirectory, "optimization-comparison");
	const outputFilePath = join(rootDirectory, "validated-summary.json");
	for (const comparison of ["recorder", "optimizations"] as const) {
		const directory = comparison === "recorder" ? recorderDirectory : comparisonDirectory;
		const durationMs = comparison === "recorder" ? 0 : steadyDurationMs;
		mkdirSync(directory);
		const receipts = [];
		for (let pair = 1; pair <= 5; pair++) {
			for (const variant of ["A", "B"] as const) {
				const sampleDirectory = join(directory, `pair-${pair}-${variant}`);
				mkdirSync(sampleDirectory);
				writeFileSync(
					join(sampleDirectory, "result.json"),
					JSON.stringify(createExperimentSample(comparison, variant, durationMs)),
				);
				writeFileSync(join(sampleDirectory, "semantic-state.json"), JSON.stringify({ facts: ["same-fact"] }));
				receipts.push({ pair, variant, exitCode: 0 });
			}
		}
		writeFileSync(
			join(directory, "executions.json"),
			JSON.stringify({ options: { comparison, "steady-duration-ms": String(durationMs) }, receipts }),
		);
	}
	return {
		recorderDirectory,
		comparisonDirectory,
		outputFilePath,
		changeSample(
			variant: "A" | "B",
			change: (sample: ReturnType<typeof createExperimentSample>) => void,
			directory = comparisonDirectory,
		) {
			const samplePath = join(directory, `pair-1-${variant}`, "result.json");
			const sample = JSON.parse(readFileSync(samplePath, "utf8")) as ReturnType<typeof createExperimentSample>;
			change(sample);
			writeFileSync(samplePath, JSON.stringify(sample));
		},
		run() {
			execFileSync(
				process.execPath,
				[
					summarizerScriptPath,
					"--recorder-directory",
					recorderDirectory,
					"--comparison-directory",
					comparisonDirectory,
					"--output-file",
					outputFilePath,
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { HOME: rootDirectory } },
			);
			return JSON.parse(readFileSync(outputFilePath, "utf8"));
		},
	};
}

describe("今日进展性能汇总的成本观测证据门禁", () => {
	it("允许刻度校准 A 关闭、B 开启，并把未观测的成本保留为 null", () => {
		const summary = createEvidenceFixture().run();
		expect(summary.recorder.pairs[0].A.historyEffectiveCollectionMs).toBeNull();
		expect(summary.recorder.pairs[0].A.steadyHistoryReadBytes).toBeNull();
		expect(summary.recorder.pairs[0].B.historyEffectiveCollectionMs).toBeGreaterThan(0);
		expect(summary.comparisons[0]).toMatchObject({
			fullSteadyWindow: true,
			retentionGatePassed: true,
			sameDirectionPairCount: 5,
		});
	});

	it.each(["A", "B"] as const)("拒绝优化对照 %s 关闭刻度，即使空窗口看起来没有 I/O", (variant) => {
		const fixture = createEvidenceFixture();
		fixture.changeSample(variant, (sample) => {
			sample.options["cost-recording"] = "disabled";
			sample.historyWindowCount = 0;
			sample.windows = [];
		});
		expect(() => fixture.run()).toThrow(/成本窗口证据不完整/);
		expect(existsSync(fixture.outputFilePath)).toBe(false);
	});

	it("拒绝刻度校准 B 关闭刻度，例外只适用于 A", () => {
		const fixture = createEvidenceFixture();
		fixture.changeSample(
			"B",
			(sample) => {
				sample.options["cost-recording"] = "disabled";
				sample.windows = [];
				sample.historyWindowCount = 0;
			},
			fixture.recorderDirectory,
		);
		expect(() => fixture.run()).toThrow(/成本窗口证据不完整/);
	});

	it.each([
		[
			"空成本窗口",
			(sample) => {
				sample.windows = [];
			},
		],
		[
			"缺少历史 refresh",
			(sample) => {
				delete sample.windows[0].stages.refresh;
			},
		],
		[
			"历史 refresh 没有实际调用",
			(sample) => {
				sample.windows[0].stages.refresh = { ...createRefreshCost(1), calls: 0 };
			},
		],
		[
			"历史 refresh 缺少有效耗时",
			(sample) => {
				sample.windows[0].stages.refresh = createRefreshCost(0);
			},
		],
		[
			"缺少稳态 refresh",
			(sample) => {
				delete sample.windows[1].stages.refresh;
			},
		],
		[
			"缺少稳态成本窗口",
			(sample) => {
				sample.windows.length = sample.historyWindowCount;
			},
		],
		[
			"稳态观测窗口不足 60 秒",
			(sample) => {
				sample.windows[1].windowDurationMs = 1;
			},
		],
		[
			"稳态实际运行不足 60 秒",
			(sample) => {
				sample.steady.durationMs = 1;
			},
		],
		[
			"样本自行缩短稳态请求",
			(sample) => {
				sample.options["steady-duration-ms"] = "0";
			},
		],
		[
			"缺少历史显式分期",
			(sample) => {
				sample.windows[0].flushReason = "interval";
			},
		],
		[
			"缺少最终关闭窗口",
			(sample) => {
				sample.windows[1].flushReason = "interval";
			},
		],
		[
			"非法窗口时长",
			(sample) => {
				sample.windows[1].windowDurationMs = -1;
			},
		],
	] satisfies [string, (sample: ReturnType<typeof createExperimentSample>) => void][])("拒绝%s", (_label, change) => {
		const fixture = createEvidenceFixture();
		fixture.changeSample("B", change);
		expect(() => fixture.run()).toThrow(/成本窗口证据不完整/);
		expect(existsSync(fixture.outputFilePath)).toBe(false);
	});

	it.each([-1, 0, 0.5, 2, Number.NaN])("拒绝非法历史分期边界 %s", (boundary) => {
		const fixture = createEvidenceFixture();
		fixture.changeSample("B", (sample) => {
			sample.historyWindowCount = boundary;
		});
		expect(() => fixture.run()).toThrow(/成本窗口证据不完整/);
	});

	it("仍支持从显式 flush 推导旧结果的历史分期", () => {
		const fixture = createEvidenceFixture();
		fixture.changeSample("B", (sample) => {
			Reflect.deleteProperty(sample, "historyWindowCount");
		});
		expect(fixture.run().comparisons[0].retentionGatePassed).toBe(true);
	});

	it("零稳态时长的历史消融不要求调度器产生稳态 refresh", () => {
		const summary = createEvidenceFixture(0).run();
		expect(summary.comparisons[0].fullSteadyWindow).toBe(false);
		expect(summary.comparisons[0].pairs[0].B.historyEffectiveCollectionMs).toBeGreaterThan(0);
	});

	it("保留基线小数毫秒的真实分期边界，不改写原始时长", () => {
		const fixture = createEvidenceFixture();
		fixture.changeSample("A", (sample) => {
			sample.steady.durationMs = 59_999.9285;
			sample.windows[1].windowDurationMs = 59_999.588542;
		});
		const summary = fixture.run();
		expect(summary.comparisons[0].fullSteadyWindow).toBe(true);
		expect(summary.comparisons[0].pairs[0].A.steadyDurationMs).toBe(59_999.9285);
	});

	it("基线稳态超出 1 ms 边界容差仍拒绝", () => {
		const fixture = createEvidenceFixture();
		fixture.changeSample("A", (sample) => {
			sample.steady.durationMs = 59_998.9;
		});
		expect(() => fixture.run()).toThrow(/成本窗口证据不完整/);
	});

	it("候选的实际 60 秒门槛不受分期容差放宽", () => {
		const fixture = createEvidenceFixture();
		fixture.changeSample("B", (sample) => {
			sample.steady.durationMs = 59_999.5;
		});
		expect(() => fixture.run()).toThrow(/稳态 I\/O 验收未通过/);
	});

	it("优化对照不能通过改称刻度校准来使用关闭例外", () => {
		const fixture = createEvidenceFixture();
		const executionsPath = join(fixture.comparisonDirectory, "executions.json");
		const executions = JSON.parse(readFileSync(executionsPath, "utf8"));
		executions.options.comparison = "recorder";
		writeFileSync(executionsPath, JSON.stringify(executions));
		expect(() => fixture.run()).toThrow(/实验分组或稳态请求非法/);
	});

	it("拒绝覆盖已经存在的结果文件，保留原始字节", () => {
		const fixture = createEvidenceFixture();
		writeFileSync(fixture.outputFilePath, "原始证据不得覆盖");
		expect(() => fixture.run()).toThrow(/EEXIST/);
		expect(readFileSync(fixture.outputFilePath, "utf8")).toBe("原始证据不得覆盖");
	});
});
