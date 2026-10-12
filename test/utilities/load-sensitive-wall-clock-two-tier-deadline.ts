// 负载敏感的墙钟等待 / 测量判定：超过软期限只写 annotation 告警，超过硬期限才失败。
// 背景：本机高负载（load 15–33 / 10 核）下，计时类断言时绿时红，而产品语义并没有被违反；
// 取值规则、类别划分与已知代价见 test/README.md「负载敏感的墙钟 / 资源断言」。
//
// 宿主 CPU 争用信号（loadavg、窗口内 os.cpus busy 比例）只写进 annotation 作诊断，绝不参与判定：
// 2026-10-05 实测这些信号在同一负载下剧烈跳动，用来放过失败会制造新的假通过。
import { appendFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";

export const LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE = "load-sensitive-soft-deadline-exceeded";

// 设置后，每次两档判定（无论是否超过软档）都追加一行 JSON，用于在负载下标定硬档与 RSS 阈值。
export const LOAD_SENSITIVE_WALL_CLOCK_MEASUREMENTS_JSONL_OUTPUT_PATH_ENVIRONMENT_VARIABLE_NAME =
	"KANBAN_TEST_LOAD_SENSITIVE_WALL_CLOCK_MEASUREMENTS_JSONL_OUTPUT_PATH";

export interface LoadSensitiveWallClockTwoTierDeadline {
	// 出现在告警与失败消息里，说明「等的是什么」，例如「task list 子进程退出（从 spawn 起算）」。
	waitedForDescription: string;
	softDeadlineMsExpectedOnUncontendedHost: number;
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: number;
	// D1-b（2026-10-05 开发者拍板）：只有 C 类性能绊线填 true——GitHub Actions 上超过软档即失败，
	// 与改动前的判据一致；本地仍按两档处理。
	strictAtSoftDeadlineWhenRunningInContinuousIntegration?: boolean;
}

// 只要求 annotate 能力，单测可以注入记录器；vitest 的 TestContext 天然满足。
export interface LoadSensitiveDeadlineAnnotatingTestContext {
	annotate(message: string, type?: string): Promise<unknown>;
}

export interface LoadSensitiveTwoTierDeadlineJudgementDependencies {
	now?: () => number;
	isRunningInGitHubActionsContinuousIntegration?: () => boolean;
}

// 「条件检查本身挂起」保护用的可取消计时器：与 condition 的单次异步检查赛跑。
export interface CancellableTimerGuardingAgainstHungConditionCheck {
	// 计时到点后 resolve；被 cancel 之后永不 resolve。
	guardTimerElapsed: Promise<void>;
	cancelGuardTimer(): void;
}

export interface LoadSensitiveTwoTierDeadlineWaitDependencies
	extends LoadSensitiveTwoTierDeadlineJudgementDependencies {
	sleepMs?: (durationMs: number) => Promise<void>;
	// 只给「条件检查本身挂起」保护用，刻意不复用 sleepMs：注入的假 sleepMs 一被调用就推进假时钟，
	// 而保护计时器在 condition 先返回时必须没有副作用（不推进假时钟、不残留真实定时器）。
	// 注入假 now 且 condition 为异步时应一并注入它：否则真实定时器到点后按假时钟复核仍未超过放弃边界，会一直重新计时。
	startCancellableTimerGuardingAgainstHungConditionCheck?: (
		durationMs: number,
	) => CancellableTimerGuardingAgainstHungConditionCheck;
}

export type LoadSensitiveTwoTierDeadlineVerdict = "within_soft_deadline" | "exceeded_soft_deadline_only_warned";

export interface LoadSensitiveTwoTierDeadlineJudgement {
	verdict: LoadSensitiveTwoTierDeadlineVerdict;
	elapsedMs: number;
}

export function isRunningInGitHubActionsContinuousIntegration(): boolean {
	return process.env.GITHUB_ACTIONS === "true";
}

function sleepMsWithRealTimer(durationMs: number): Promise<void> {
	return new Promise<void>((resolveSleep) => {
		setTimeout(resolveSleep, durationMs);
	});
}

function startCancellableRealTimerGuardingAgainstHungConditionCheck(
	durationMs: number,
): CancellableTimerGuardingAgainstHungConditionCheck {
	let realGuardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const guardTimerElapsed = new Promise<void>((resolveGuardTimer) => {
		realGuardTimeoutHandle = setTimeout(resolveGuardTimer, durationMs);
	});
	return {
		guardTimerElapsed,
		cancelGuardTimer() {
			clearTimeout(realGuardTimeoutHandle);
		},
	};
}

interface HostCpuTimesSnapshot {
	busyMs: number;
	totalMs: number;
}

function snapshotHostCpuTimes(): HostCpuTimesSnapshot {
	let busyMs = 0;
	let totalMs = 0;
	for (const cpu of cpus()) {
		const { user, nice, sys, idle, irq } = cpu.times;
		busyMs += user + nice + sys + irq;
		totalMs += user + nice + sys + idle + irq;
	}
	return { busyMs, totalMs };
}

export interface HostCpuContentionDiagnosticsWindow {
	// 只用于诊断：返回「窗口内宿主 CPU busy 比例 + 当前 loadavg」的一行描述，不参与任何判定。
	describeHostCpuContentionSinceWindowStart(): string;
}

export function startHostCpuContentionDiagnosticsWindow(): HostCpuContentionDiagnosticsWindow {
	const windowStartSnapshot = snapshotHostCpuTimes();
	return {
		describeHostCpuContentionSinceWindowStart() {
			const windowEndSnapshot = snapshotHostCpuTimes();
			const totalDeltaMs = windowEndSnapshot.totalMs - windowStartSnapshot.totalMs;
			const busyPercentText =
				totalDeltaMs > 0
					? `${Math.round(((windowEndSnapshot.busyMs - windowStartSnapshot.busyMs) / totalDeltaMs) * 100)}%`
					: "n/a";
			const [loadAverageOneMinute] = loadavg();
			return `窗口内宿主 CPU busy=${busyPercentText} loadavg1m=${(loadAverageOneMinute ?? 0).toFixed(1)} cpus=${cpus().length}`;
		},
	};
}

export function collectHostCpuContentionDiagnosticsForAnnotation(
	diagnosticsWindow: HostCpuContentionDiagnosticsWindow | undefined,
): string {
	if (diagnosticsWindow) {
		return diagnosticsWindow.describeHostCpuContentionSinceWindowStart();
	}
	const [loadAverageOneMinute] = loadavg();
	return `loadavg1m=${(loadAverageOneMinute ?? 0).toFixed(1)} cpus=${cpus().length}`;
}

function formatElapsedMs(elapsedMs: number | null): string {
	return elapsedMs === null ? "未测到" : `${Math.round(elapsedMs)}ms`;
}

function describeTwoTierDeadlineMeasurement(
	deadline: LoadSensitiveWallClockTwoTierDeadline,
	elapsedMs: number | null,
	hostCpuContentionDiagnostics: string,
): string {
	return `${deadline.waitedForDescription}：实测 ${formatElapsedMs(elapsedMs)}，软档 ${deadline.softDeadlineMsExpectedOnUncontendedHost}ms / 硬档 ${deadline.hardDeadlineMsOnlyExplainedByRealHangOrRegression}ms；${hostCpuContentionDiagnostics}`;
}

// 资源阈值（RSS 等）的两档判定也走这里，标定硬档时与墙钟测量落在同一份 JSONL 里。
export function appendLoadSensitiveMeasurementRecordWhenRequested(record: Record<string, unknown>): void {
	const outputPath = process.env[LOAD_SENSITIVE_WALL_CLOCK_MEASUREMENTS_JSONL_OUTPUT_PATH_ENVIRONMENT_VARIABLE_NAME];
	if (!outputPath) {
		return;
	}
	appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
}

// 判定一次已经测得的耗时。elapsedMs 为 null 表示「没测到」（例如等待对象始终没出现），按超过硬档处理。
// 超过软档时先 await annotation 再决定是否抛错：失败路径不会等待未完成的 annotation。
export async function judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	deadline: LoadSensitiveWallClockTwoTierDeadline,
	elapsedMs: number | null,
	options: {
		hostCpuContentionDiagnosticsWindow?: HostCpuContentionDiagnosticsWindow;
		dependencies?: LoadSensitiveTwoTierDeadlineJudgementDependencies;
		// 等待因「条件检查本身挂起」而被放弃时由 wait helper 传入，追加进 annotation 与失败消息。
		conditionCheckItselfHungDescriptionForAnnotationAndFailureMessage?: string;
	} = {},
): Promise<LoadSensitiveTwoTierDeadlineJudgement> {
	const isStrictInContinuousIntegration =
		deadline.strictAtSoftDeadlineWhenRunningInContinuousIntegration === true &&
		(
			options.dependencies?.isRunningInGitHubActionsContinuousIntegration ??
			isRunningInGitHubActionsContinuousIntegration
		)();
	const exceededHardDeadline =
		elapsedMs === null || elapsedMs > deadline.hardDeadlineMsOnlyExplainedByRealHangOrRegression;
	const exceededSoftDeadline = elapsedMs === null || elapsedMs > deadline.softDeadlineMsExpectedOnUncontendedHost;

	appendLoadSensitiveMeasurementRecordWhenRequested({
		waitedForDescription: deadline.waitedForDescription,
		elapsedMs,
		softDeadlineMs: deadline.softDeadlineMsExpectedOnUncontendedHost,
		hardDeadlineMs: deadline.hardDeadlineMsOnlyExplainedByRealHangOrRegression,
		exceededSoftDeadline,
		exceededHardDeadline,
		loadAverageOneMinute: loadavg()[0] ?? null,
	});

	if (!exceededSoftDeadline) {
		return { verdict: "within_soft_deadline", elapsedMs };
	}

	const measurementDescription = `${describeTwoTierDeadlineMeasurement(
		deadline,
		elapsedMs,
		collectHostCpuContentionDiagnosticsForAnnotation(options.hostCpuContentionDiagnosticsWindow),
	)}${
		options.conditionCheckItselfHungDescriptionForAnnotationAndFailureMessage
			? `；${options.conditionCheckItselfHungDescriptionForAnnotationAndFailureMessage}`
			: ""
	}`;
	await testContext.annotate(measurementDescription, LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE);

	if (exceededHardDeadline) {
		throw new Error(`超过硬档（只有真实挂死或退化能解释）：${measurementDescription}`);
	}
	if (isStrictInContinuousIntegration) {
		throw new Error(`GitHub Actions 上性能绊线超过软档即失败（D1-b）：${measurementDescription}`);
	}
	return { verdict: "exceeded_soft_deadline_only_warned", elapsedMs };
}

type ConditionCheckOutcomeGuardedAgainstHangPastGiveUpBoundary =
	| "condition_satisfied"
	| "condition_not_yet_satisfied"
	| "condition_check_still_pending_after_give_up_boundary_exceeded";

// 发起一轮条件检查。同步 condition 无从打断，直接用其返回值；异步 condition 与保护计时器赛跑：
// 计时器只排到「已用时间严格超过放弃边界」那一刻（剩余毫秒向下取整 +1），到点后按 now 复核，
// 未严格超过（真实定时器略早触发等）就重新计时。无论谁先完成都 cancel 计时器；condition 抛错原样透传。
// 被放弃的那次检查之后再 settle（含 reject）都由 Promise.race 挂上的处理器吸收，不会成为 unhandled rejection。
async function checkConditionOnceGuardedAgainstHangPastGiveUpBoundary(input: {
	condition: () => boolean | Promise<boolean>;
	readElapsedMsSinceWaitStarted: () => number;
	effectiveGiveUpDeadlineMs: number;
	startCancellableTimerGuardingAgainstHungConditionCheck: (
		durationMs: number,
	) => CancellableTimerGuardingAgainstHungConditionCheck;
}): Promise<ConditionCheckOutcomeGuardedAgainstHangPastGiveUpBoundary> {
	const conditionCheckResult = input.condition();
	if (typeof conditionCheckResult === "boolean") {
		return conditionCheckResult ? "condition_satisfied" : "condition_not_yet_satisfied";
	}
	const conditionCheckSettledOutcome = Promise.resolve(conditionCheckResult).then(
		(conditionSatisfied): ConditionCheckOutcomeGuardedAgainstHangPastGiveUpBoundary =>
			conditionSatisfied ? "condition_satisfied" : "condition_not_yet_satisfied",
	);
	for (;;) {
		const guardTimer = input.startCancellableTimerGuardingAgainstHungConditionCheck(
			Math.max(0, Math.floor(input.effectiveGiveUpDeadlineMs - input.readElapsedMsSinceWaitStarted())) + 1,
		);
		try {
			const raceWinner = await Promise.race([
				conditionCheckSettledOutcome,
				guardTimer.guardTimerElapsed.then(() => "guard_timer_elapsed" as const),
			]);
			if (raceWinner !== "guard_timer_elapsed") {
				return raceWinner;
			}
		} finally {
			guardTimer.cancelGuardTimer();
		}
		if (input.readElapsedMsSinceWaitStarted() > input.effectiveGiveUpDeadlineMs) {
			return "condition_check_still_pending_after_give_up_boundary_exceeded";
		}
	}
}

// 轮询等待条件成立。condition 抛错时原样透传（那是被测行为的失败，不是超时）；
// 超过硬档、或 CI 上的严格绊线超过软档时，先 await annotation 再抛错。
// 某一轮异步检查本身挂起（例如进程表读取卡住）时，同样在放弃边界被严格超过时停止等待，按同一口径 annotate 后抛错。
export async function waitForConditionWithinLoadSensitiveTwoTierDeadline(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	deadline: LoadSensitiveWallClockTwoTierDeadline,
	condition: () => boolean | Promise<boolean>,
	options: {
		pollIntervalMs?: number;
		describeLastObservedStateForFailureMessage?: () => string;
		dependencies?: LoadSensitiveTwoTierDeadlineWaitDependencies;
	} = {},
): Promise<LoadSensitiveTwoTierDeadlineJudgement> {
	const now = options.dependencies?.now ?? (() => performance.now());
	const sleepMs = options.dependencies?.sleepMs ?? sleepMsWithRealTimer;
	const startCancellableTimerGuardingAgainstHungConditionCheck =
		options.dependencies?.startCancellableTimerGuardingAgainstHungConditionCheck ??
		startCancellableRealTimerGuardingAgainstHungConditionCheck;
	const pollIntervalMs = options.pollIntervalMs ?? 25;
	const isStrictInContinuousIntegration =
		deadline.strictAtSoftDeadlineWhenRunningInContinuousIntegration === true &&
		(
			options.dependencies?.isRunningInGitHubActionsContinuousIntegration ??
			isRunningInGitHubActionsContinuousIntegration
		)();
	const effectiveGiveUpDeadlineMs = isStrictInContinuousIntegration
		? deadline.softDeadlineMsExpectedOnUncontendedHost
		: deadline.hardDeadlineMsOnlyExplainedByRealHangOrRegression;
	const hostCpuContentionDiagnosticsWindow = startHostCpuContentionDiagnosticsWindow();
	const waitStartedAt = now();
	const readElapsedMsSinceWaitStarted = () => now() - waitStartedAt;
	let conditionCheckItselfHungDescription: string | undefined;

	for (;;) {
		const elapsedMsWhenConditionCheckStarted = readElapsedMsSinceWaitStarted();
		const conditionCheckOutcome = await checkConditionOnceGuardedAgainstHangPastGiveUpBoundary({
			condition,
			readElapsedMsSinceWaitStarted,
			effectiveGiveUpDeadlineMs,
			startCancellableTimerGuardingAgainstHungConditionCheck,
		});
		if (conditionCheckOutcome === "condition_satisfied") {
			return await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
				testContext,
				deadline,
				readElapsedMsSinceWaitStarted(),
				{
					hostCpuContentionDiagnosticsWindow,
					dependencies: options.dependencies,
				},
			);
		}
		if (conditionCheckOutcome === "condition_check_still_pending_after_give_up_boundary_exceeded") {
			conditionCheckItselfHungDescription = `条件检查本身挂起：等待开始后 ${formatElapsedMs(elapsedMsWhenConditionCheckStarted)} 发起的这一轮检查，到已等 ${formatElapsedMs(readElapsedMsSinceWaitStarted())}（超过放弃边界 ${effectiveGiveUpDeadlineMs}ms）仍未返回，已放弃等待`;
			break;
		}
		// 与判定口径一致：「超过」指严格大于期限。
		if (readElapsedMsSinceWaitStarted() > effectiveGiveUpDeadlineMs) {
			break;
		}
		await sleepMs(pollIntervalMs);
		// 睡醒时已超过放弃边界就不再发起新一轮检查：此时即便条件成立，实测也已超过放弃边界、判定必然失败；
		// 而新发起的检查已无剩余时间可给，挂起保护只会把一次正常的慢检查误报成挂起。
		if (readElapsedMsSinceWaitStarted() > effectiveGiveUpDeadlineMs) {
			break;
		}
	}

	const lastObservedStateText = options.describeLastObservedStateForFailureMessage
		? `\n最后观察到的状态：${options.describeLastObservedStateForFailureMessage()}`
		: "";
	try {
		// 条件始终未成立（或检查本身挂起）：CI 严格模式下按「超过软档」判（会抛错），否则按「未测到 = 超过硬档」判。
		await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			testContext,
			deadline,
			isStrictInContinuousIntegration ? readElapsedMsSinceWaitStarted() : null,
			{
				hostCpuContentionDiagnosticsWindow,
				dependencies: options.dependencies,
				conditionCheckItselfHungDescriptionForAnnotationAndFailureMessage: conditionCheckItselfHungDescription,
			},
		);
	} catch (deadlineFailure) {
		if (deadlineFailure instanceof Error) {
			deadlineFailure.message += lastObservedStateText;
		}
		throw deadlineFailure;
	}
	// CI 严格模式下 elapsed 超过软档必然抛错；走到这里说明软档设置有误（软档 ≥ 硬档等）。
	throw new Error(
		`等待条件始终未成立：${deadline.waitedForDescription}${conditionCheckItselfHungDescription ? `；${conditionCheckItselfHungDescription}` : ""}${lastObservedStateText}`,
	);
}
