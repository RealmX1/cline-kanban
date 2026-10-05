import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline,
	LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE,
	LOAD_SENSITIVE_WALL_CLOCK_MEASUREMENTS_JSONL_OUTPUT_PATH_ENVIRONMENT_VARIABLE_NAME,
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveTwoTierDeadlineWaitDependencies,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "./load-sensitive-wall-clock-two-tier-deadline";
import { createTempDir } from "./temp-dir";

interface RecordedAnnotationOrFailureEvent {
	kind: "annotation_settled" | "judgement_rejected";
	message: string;
	type?: string;
}

function createAnnotationRecordingTestContext(recordedEvents: RecordedAnnotationOrFailureEvent[]) {
	const testContext: LoadSensitiveDeadlineAnnotatingTestContext = {
		async annotate(message, type) {
			// 让 annotation 晚一个宏任务才完成：如果 helper 没有 await 它就抛错，记录顺序会反过来。
			await new Promise<void>((resolveAnnotation) => {
				setTimeout(resolveAnnotation, 0);
			});
			recordedEvents.push({ kind: "annotation_settled", message, type });
		},
	};
	return testContext;
}

const UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "测试用等待对象",
	softDeadlineMsExpectedOnUncontendedHost: 1_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 5_000,
};

const PERFORMANCE_TRIPWIRE_STRICT_IN_CONTINUOUS_INTEGRATION_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	...UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
	strictAtSoftDeadlineWhenRunningInContinuousIntegration: true,
};

function createFakeClockWaitDependencies(input: { runningInGitHubActions: boolean }) {
	let fakeNowMs = 0;
	let sleepCallCount = 0;
	const dependencies: LoadSensitiveTwoTierDeadlineWaitDependencies = {
		now: () => fakeNowMs,
		sleepMs: async (durationMs) => {
			sleepCallCount += 1;
			fakeNowMs += durationMs;
		},
		isRunningInGitHubActionsContinuousIntegration: () => input.runningInGitHubActions,
	};
	return {
		dependencies,
		readFakeNowMs: () => fakeNowMs,
		readSleepCallCount: () => sleepCallCount,
	};
}

// 在假时钟之外再注入假的「挂起保护计时器」：下一个宏任务才到点，到点时把假时钟推进排定的时长；
// 被取消后什么都不做——用来证明 condition 先完成时保护计时器不会事后推进假时钟。
function createFakeClockWaitDependenciesWithFakeHungConditionCheckGuardTimer(input: {
	runningInGitHubActions: boolean;
}) {
	let fakeNowMs = 0;
	const startedGuardTimerDurationsMs: number[] = [];
	let cancelledGuardTimerCount = 0;
	const dependencies: LoadSensitiveTwoTierDeadlineWaitDependencies = {
		now: () => fakeNowMs,
		sleepMs: async (durationMs) => {
			fakeNowMs += durationMs;
		},
		isRunningInGitHubActionsContinuousIntegration: () => input.runningInGitHubActions,
		startCancellableTimerGuardingAgainstHungConditionCheck: (durationMs) => {
			startedGuardTimerDurationsMs.push(durationMs);
			let guardTimerCancelled = false;
			return {
				guardTimerElapsed: new Promise<void>((resolveGuardTimer) => {
					setTimeout(() => {
						if (!guardTimerCancelled) {
							fakeNowMs += durationMs;
							resolveGuardTimer();
						}
					}, 0);
				}),
				cancelGuardTimer() {
					guardTimerCancelled = true;
					cancelledGuardTimerCount += 1;
				},
			};
		},
	};
	return {
		dependencies,
		readFakeNowMs: () => fakeNowMs,
		readStartedGuardTimerDurationsMs: () => [...startedGuardTimerDurationsMs],
		readCancelledGuardTimerCount: () => cancelledGuardTimerCount,
	};
}

async function judgeAndRecordRejection(
	recordedEvents: RecordedAnnotationOrFailureEvent[],
	judgement: Promise<unknown>,
): Promise<void> {
	await judgement.catch((judgementFailure: unknown) => {
		recordedEvents.push({
			kind: "judgement_rejected",
			message: judgementFailure instanceof Error ? judgementFailure.message : String(judgementFailure),
		});
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline", () => {
	it("实测恰好等于软档时判为未超过，不写 annotation", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const judgement = await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			createAnnotationRecordingTestContext(recordedEvents),
			UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
			1_000,
		);

		expect(judgement).toEqual({ verdict: "within_soft_deadline", elapsedMs: 1_000 });
		expect(recordedEvents).toEqual([]);
	});

	it("超过软档但恰好等于硬档时只告警：写一条目标类型的 annotation，不抛错", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const judgement = await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			createAnnotationRecordingTestContext(recordedEvents),
			UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
			5_000,
		);

		expect(judgement).toEqual({ verdict: "exceeded_soft_deadline_only_warned", elapsedMs: 5_000 });
		expect(recordedEvents).toHaveLength(1);
		expect(recordedEvents[0]).toMatchObject({
			kind: "annotation_settled",
			type: LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE,
		});
		expect(recordedEvents[0]?.message).toContain("测试用等待对象：实测 5000ms，软档 1000ms / 硬档 5000ms");
	});

	it("超过硬档时先等 annotation 完成再抛错", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		await judgeAndRecordRejection(
			recordedEvents,
			judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(recordedEvents),
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				5_001,
			),
		);

		expect(recordedEvents.map((event) => event.kind)).toEqual(["annotation_settled", "judgement_rejected"]);
		expect(recordedEvents[1]?.message).toContain("超过硬档");
	});

	it("未测到（null）按超过硬档处理", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		await judgeAndRecordRejection(
			recordedEvents,
			judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(recordedEvents),
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				null,
			),
		);

		expect(recordedEvents.map((event) => event.kind)).toEqual(["annotation_settled", "judgement_rejected"]);
		expect(recordedEvents[1]?.message).toContain("实测 未测到");
	});

	it("D1-b：性能绊线在 GitHub Actions 上超过软档即失败，本地只告警；非绊线在 CI 上也只告警", async () => {
		const strictInContinuousIntegrationEvents: RecordedAnnotationOrFailureEvent[] = [];
		await judgeAndRecordRejection(
			strictInContinuousIntegrationEvents,
			judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(strictInContinuousIntegrationEvents),
				PERFORMANCE_TRIPWIRE_STRICT_IN_CONTINUOUS_INTEGRATION_DEADLINE,
				1_001,
				{ dependencies: { isRunningInGitHubActionsContinuousIntegration: () => true } },
			),
		);
		expect(strictInContinuousIntegrationEvents.map((event) => event.kind)).toEqual([
			"annotation_settled",
			"judgement_rejected",
		]);
		expect(strictInContinuousIntegrationEvents[1]?.message).toContain("GitHub Actions 上性能绊线超过软档即失败");

		const locallyWarnedEvents: RecordedAnnotationOrFailureEvent[] = [];
		await expect(
			judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(locallyWarnedEvents),
				PERFORMANCE_TRIPWIRE_STRICT_IN_CONTINUOUS_INTEGRATION_DEADLINE,
				1_001,
				{ dependencies: { isRunningInGitHubActionsContinuousIntegration: () => false } },
			),
		).resolves.toMatchObject({ verdict: "exceeded_soft_deadline_only_warned" });

		const nonTripwireInContinuousIntegrationEvents: RecordedAnnotationOrFailureEvent[] = [];
		await expect(
			judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(nonTripwireInContinuousIntegrationEvents),
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				1_001,
				{ dependencies: { isRunningInGitHubActionsContinuousIntegration: () => true } },
			),
		).resolves.toMatchObject({ verdict: "exceeded_soft_deadline_only_warned" });
	});

	it("设置 JSONL 输出路径时，每次判定都追加一行测量记录（含未超过软档的）", async () => {
		const temporaryDirectory = createTempDir("kanban-load-sensitive-measurements-");
		try {
			const measurementsOutputPath = join(temporaryDirectory.path, "measurements.jsonl");
			vi.stubEnv(
				LOAD_SENSITIVE_WALL_CLOCK_MEASUREMENTS_JSONL_OUTPUT_PATH_ENVIRONMENT_VARIABLE_NAME,
				measurementsOutputPath,
			);
			const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
			const testContext = createAnnotationRecordingTestContext(recordedEvents);

			await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				testContext,
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				10,
			);
			await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				testContext,
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				2_000,
			);

			const measurementRecords = readFileSync(measurementsOutputPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { elapsedMs: number; exceededSoftDeadline: boolean });
			expect(measurementRecords.map((record) => [record.elapsedMs, record.exceededSoftDeadline])).toEqual([
				[10, false],
				[2_000, true],
			]);
		} finally {
			temporaryDirectory.cleanup();
		}
	});
});

describe("waitForConditionWithinLoadSensitiveTwoTierDeadline", () => {
	it("条件在软档内成立时直接返回，不写 annotation", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const fakeClock = createFakeClockWaitDependencies({ runningInGitHubActions: false });

		const judgement = await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			createAnnotationRecordingTestContext(recordedEvents),
			UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
			() => fakeClock.readFakeNowMs() >= 300,
			{ pollIntervalMs: 100, dependencies: fakeClock.dependencies },
		);

		expect(judgement).toEqual({ verdict: "within_soft_deadline", elapsedMs: 300 });
		expect(recordedEvents).toEqual([]);
	});

	it("条件在软档与硬档之间成立时告警并返回实测耗时", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const fakeClock = createFakeClockWaitDependencies({ runningInGitHubActions: false });

		const judgement = await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			createAnnotationRecordingTestContext(recordedEvents),
			UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
			() => fakeClock.readFakeNowMs() >= 2_500,
			{ pollIntervalMs: 100, dependencies: fakeClock.dependencies },
		);

		expect(judgement).toEqual({ verdict: "exceeded_soft_deadline_only_warned", elapsedMs: 2_500 });
		expect(recordedEvents).toHaveLength(1);
		expect(recordedEvents[0]?.type).toBe(LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE);
	});

	it("条件始终不成立时在硬档之后失败，失败消息带最后观察到的状态", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const fakeClock = createFakeClockWaitDependencies({ runningInGitHubActions: false });

		await judgeAndRecordRejection(
			recordedEvents,
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(recordedEvents),
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				() => false,
				{
					pollIntervalMs: 100,
					dependencies: fakeClock.dependencies,
					describeLastObservedStateForFailureMessage: () => "browser open 计数=0",
				},
			),
		);

		expect(fakeClock.readFakeNowMs()).toBe(5_100);
		expect(recordedEvents.map((event) => event.kind)).toEqual(["annotation_settled", "judgement_rejected"]);
		expect(recordedEvents[1]?.message).toContain("超过硬档");
		expect(recordedEvents[1]?.message).toContain("最后观察到的状态：browser open 计数=0");
	});

	it("D1-b：性能绊线在 GitHub Actions 上过了软档就放弃等待并失败", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const fakeClock = createFakeClockWaitDependencies({ runningInGitHubActions: true });

		await judgeAndRecordRejection(
			recordedEvents,
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(recordedEvents),
				PERFORMANCE_TRIPWIRE_STRICT_IN_CONTINUOUS_INTEGRATION_DEADLINE,
				() => false,
				{ pollIntervalMs: 100, dependencies: fakeClock.dependencies },
			),
		);

		expect(fakeClock.readFakeNowMs()).toBe(1_100);
		expect(recordedEvents.map((event) => event.kind)).toEqual(["annotation_settled", "judgement_rejected"]);
		expect(recordedEvents[1]?.message).toContain("GitHub Actions 上性能绊线超过软档即失败");
	});

	it("条件抛错时原样透传，不写 annotation、不再继续轮询", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const fakeClock = createFakeClockWaitDependencies({ runningInGitHubActions: false });
		const conditionFailure = new Error("被测进程提前以 exit 3 退出");

		await expect(
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(recordedEvents),
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				() => {
					if (fakeClock.readFakeNowMs() >= 200) {
						throw conditionFailure;
					}
					return false;
				},
				{ pollIntervalMs: 100, dependencies: fakeClock.dependencies },
			),
		).rejects.toBe(conditionFailure);
		expect(fakeClock.readSleepCallCount()).toBe(2);
		expect(recordedEvents).toEqual([]);
	});

	it("异步条件检查本身永不 settle 时：本地在硬档、CI 严格绊线在软档放弃等待，先 annotation 再抛错", async () => {
		for (const scenario of [
			{ runningInGitHubActions: false, expectedGiveUpAtFakeNowMs: 5_001, expectedFailureText: "超过硬档" },
			{
				runningInGitHubActions: true,
				expectedGiveUpAtFakeNowMs: 1_001,
				expectedFailureText: "GitHub Actions 上性能绊线超过软档即失败",
			},
		]) {
			const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
			const fakeClock = createFakeClockWaitDependenciesWithFakeHungConditionCheckGuardTimer({
				runningInGitHubActions: scenario.runningInGitHubActions,
			});
			let conditionCheckCount = 0;

			await judgeAndRecordRejection(
				recordedEvents,
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					createAnnotationRecordingTestContext(recordedEvents),
					PERFORMANCE_TRIPWIRE_STRICT_IN_CONTINUOUS_INTEGRATION_DEADLINE,
					() => {
						conditionCheckCount += 1;
						return new Promise<boolean>(() => {});
					},
					{
						pollIntervalMs: 100,
						dependencies: fakeClock.dependencies,
						describeLastObservedStateForFailureMessage: () => "ps 读取未返回",
					},
				),
			);

			// 只发起了一轮检查；保护计时器恰好排到「严格超过放弃边界」的那一毫秒，放弃时被取消。
			expect(conditionCheckCount).toBe(1);
			expect(fakeClock.readStartedGuardTimerDurationsMs()).toEqual([scenario.expectedGiveUpAtFakeNowMs]);
			expect(fakeClock.readCancelledGuardTimerCount()).toBe(1);
			expect(fakeClock.readFakeNowMs()).toBe(scenario.expectedGiveUpAtFakeNowMs);
			expect(recordedEvents.map((event) => event.kind)).toEqual(["annotation_settled", "judgement_rejected"]);
			expect(recordedEvents[0]).toMatchObject({ type: LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE });
			expect(recordedEvents[0]?.message).toContain("条件检查本身挂起");
			expect(recordedEvents[1]?.message).toContain(scenario.expectedFailureText);
			expect(recordedEvents[1]?.message).toContain("条件检查本身挂起");
			expect(recordedEvents[1]?.message).toContain("最后观察到的状态：ps 读取未返回");
		}
	});

	it("异步条件在放弃边界前 resolve 为 true 时判定不变：挂起保护计时器每轮都被取消，且不推进假时钟", async () => {
		const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
		const fakeClock = createFakeClockWaitDependenciesWithFakeHungConditionCheckGuardTimer({
			runningInGitHubActions: false,
		});

		const judgement = await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			createAnnotationRecordingTestContext(recordedEvents),
			UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
			async () => fakeClock.readFakeNowMs() >= 300,
			{ pollIntervalMs: 100, dependencies: fakeClock.dependencies },
		);
		// 让被取消的保护计时器的宏任务有机会执行：它不得事后推进假时钟。
		await new Promise<void>((resolveAfterCancelledGuardTimers) => {
			setTimeout(resolveAfterCancelledGuardTimers, 0);
		});

		expect(judgement).toEqual({ verdict: "within_soft_deadline", elapsedMs: 300 });
		expect(fakeClock.readStartedGuardTimerDurationsMs()).toEqual([5_001, 4_901, 4_801, 4_701]);
		expect(fakeClock.readCancelledGuardTimerCount()).toBe(4);
		expect(fakeClock.readFakeNowMs()).toBe(300);
		expect(recordedEvents).toEqual([]);
	});

	it("默认挂起保护计时器在异步条件先完成或抛错时都被 clearTimeout，不残留定时器", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
			const fakeClock = createFakeClockWaitDependencies({ runningInGitHubActions: false });

			const judgement = await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				createAnnotationRecordingTestContext(recordedEvents),
				UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
				async () => true,
				{ dependencies: fakeClock.dependencies },
			);
			expect(judgement).toEqual({ verdict: "within_soft_deadline", elapsedMs: 0 });
			expect(vi.getTimerCount()).toBe(0);

			const conditionFailure = new Error("进程表读取失败");
			await expect(
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					createAnnotationRecordingTestContext(recordedEvents),
					UNCONTENDED_SOFT_1000_HARD_5000_DEADLINE,
					async () => {
						throw conditionFailure;
					},
					{ dependencies: fakeClock.dependencies },
				),
			).rejects.toBe(conditionFailure);
			expect(vi.getTimerCount()).toBe(0);
			expect(recordedEvents).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("默认真实计时：条件检查永不 settle 时也会在放弃边界后带诊断失败，而不是挂到用例超时", async () => {
		for (const runningInGitHubActions of [false, true]) {
			const recordedEvents: RecordedAnnotationOrFailureEvent[] = [];
			await judgeAndRecordRejection(
				recordedEvents,
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					createAnnotationRecordingTestContext(recordedEvents),
					{
						waitedForDescription: "永不 settle 的进程表读取",
						softDeadlineMsExpectedOnUncontendedHost: 10,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30,
						strictAtSoftDeadlineWhenRunningInContinuousIntegration: true,
					},
					() => new Promise<boolean>(() => {}),
					{ dependencies: { isRunningInGitHubActionsContinuousIntegration: () => runningInGitHubActions } },
				),
			);

			expect(recordedEvents.map((event) => event.kind)).toEqual(["annotation_settled", "judgement_rejected"]);
			expect(recordedEvents[1]?.message).toContain(
				runningInGitHubActions ? "GitHub Actions 上性能绊线超过软档即失败" : "超过硬档",
			);
			expect(recordedEvents[1]?.message).toContain("条件检查本身挂起");
		}
	});
});
